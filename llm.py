import json
import re

import httpx

from config import llm_config


class LLMError(Exception):
    pass


WORD_SYSTEM = (
    "你是一名英汉词典编辑，服务对象是阅读英文学术论文的中文读者。"
    "你只输出 JSON，不输出任何其他内容。"
)

SENTENCE_SYSTEM = (
    "你是英文学术论文翻译助手。把用户给出的英文翻译成准确、通顺的简体中文，"
    "保留专业术语，不要解释，不要加引号，只输出译文。"
)


def _endpoint():
    return f"{llm_config()['base_url']}/chat/completions"


async def _chat(messages, json_mode=False, temperature=0.2, timeout=60):
    cfg = llm_config()
    if not cfg["api_key"]:
        raise LLMError("未配置 DeepSeek API Key，请在 .env 中填写 DEEPSEEK_API_KEY")
    payload = {
        "model": cfg["model"],
        "messages": messages,
        "temperature": temperature,
        "stream": False,
    }
    if json_mode:
        payload["response_format"] = {"type": "json_object"}
    headers = {
        "Authorization": f"Bearer {cfg['api_key']}",
        "Content-Type": "application/json",
    }
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.post(_endpoint(), headers=headers, json=payload)
    except httpx.HTTPError as exc:
        raise LLMError(f"AI 接口连接失败：{exc}") from exc
    if response.status_code != 200:
        detail = response.text[:300].replace("\n", " ")
        raise LLMError(f"AI 接口返回 {response.status_code}：{detail}")
    try:
        data = response.json()
        return data["choices"][0]["message"]["content"].strip()
    except (ValueError, KeyError, IndexError) as exc:
        raise LLMError("AI 接口返回格式异常") from exc


def _parse_word_json(raw):
    text = raw.strip()
    text = re.sub(r"^```(?:json)?\s*", "", text)
    text = re.sub(r"\s*```$", "", text)
    start = text.find("{")
    end = text.rfind("}")
    if start != -1 and end > start:
        text = text[start : end + 1]
    try:
        obj = json.loads(text)
    except ValueError:
        return {
            "phonetic": "",
            "pos": "",
            "senses": [{"pos": "", "cn": raw.strip()}],
            "definition": "",
            "example": "",
        }
    senses = []
    for item in obj.get("senses") or []:
        if isinstance(item, dict):
            cn = str(item.get("cn") or "").strip()
            pos = str(item.get("pos") or "").strip()
            if cn:
                senses.append({"pos": pos, "cn": cn})
        elif isinstance(item, str) and item.strip():
            senses.append({"pos": "", "cn": item.strip()})
    if not senses:
        fallback = str(obj.get("translation") or obj.get("definition") or "").strip()
        if fallback:
            senses = [{"pos": "", "cn": fallback}]
    return {
        "phonetic": str(obj.get("phonetic") or "").strip(),
        "pos": str(obj.get("pos") or "").strip(),
        "senses": senses,
        "definition": str(obj.get("definition") or "").strip(),
        "example": str(obj.get("example") or "").strip(),
    }


async def explain_word(text, context=""):
    context_block = f"\n原文语境：{context}" if context else ""
    prompt = f"""请解释英文单词或短语：{text}{context_block}

输出 JSON 对象，字段如下：
- "phonetic": 国际音标，不带斜杠
- "pos": 主要词性缩写，如 n. / v. / adj.
- "senses": 数组，元素为 {{"pos": "词性", "cn": "中文释义"}}，按常用度排序，最多 4 条
- "definition": 一句简洁的英文释义
- "example": 一个英文例句，尽量贴合原文语境
只输出 JSON。"""
    raw = await _chat(
        [
            {"role": "system", "content": WORD_SYSTEM},
            {"role": "user", "content": prompt},
        ],
        json_mode=True,
        temperature=0.2,
    )
    return _parse_word_json(raw)


async def translate_sentence(text):
    raw = await _chat(
        [
            {"role": "system", "content": SENTENCE_SYSTEM},
            {"role": "user", "content": text},
        ],
        temperature=0.3,
    )
    return {"translation": raw}
