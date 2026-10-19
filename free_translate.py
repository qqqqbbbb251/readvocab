import html
import re

import httpx

ENDPOINT = "https://api.mymemory.translated.net/get"
CHUNK_LIMIT = 450


class FreeTranslateError(Exception):
    pass


def split_text(text, limit=CHUNK_LIMIT):
    value = re.sub(r"\s+", " ", text or "").strip()
    if not value:
        return []
    if len(value) <= limit:
        return [value]
    sentences = re.split(r"(?<=[.!?;:])\s+", value)
    chunks = []
    current = ""
    for sentence in sentences:
        sentence = sentence.strip()
        if not sentence:
            continue
        if len(current) + len(sentence) + 1 <= limit:
            current = f"{current} {sentence}".strip()
            continue
        if current:
            chunks.append(current)
        while len(sentence) > limit:
            cut = sentence.rfind(" ", 0, limit)
            if cut < limit // 2:
                cut = limit
            chunks.append(sentence[:cut].strip())
            sentence = sentence[cut:].strip()
        current = sentence
    if current:
        chunks.append(current)
    return chunks


async def translate(text, email=""):
    chunks = split_text(text)
    if not chunks:
        raise FreeTranslateError("没有可翻译的文本")
    results = []
    headers = {"User-Agent": "ReadVocab/1.0"}
    try:
        async with httpx.AsyncClient(timeout=20, headers=headers) as client:
            for chunk in chunks:
                params = {"q": chunk, "langpair": "en|zh-CN"}
                if email:
                    params["de"] = email
                response = await client.get(ENDPOINT, params=params)
                if response.status_code != 200:
                    raise FreeTranslateError(f"免费翻译返回 {response.status_code}")
                try:
                    data = response.json()
                except ValueError as exc:
                    raise FreeTranslateError("免费翻译返回格式异常") from exc
                if data.get("quotaFinished"):
                    raise FreeTranslateError("免费翻译今日额度已用完，请明天再试或配置 DeepSeek")
                translated = html.unescape(
                    ((data.get("responseData") or {}).get("translatedText") or "")
                ).strip()
                detail = str(data.get("responseDetails") or "").strip()
                if (
                    not translated
                    or "MYMEMORY WARNING" in translated.upper()
                    or "QUERY LENGTH LIMIT" in translated.upper()
                ):
                    raise FreeTranslateError((translated or detail or "免费翻译没有返回结果")[:200])
                try:
                    status = int(data.get("responseStatus"))
                except (TypeError, ValueError):
                    status = 200
                if status != 200:
                    raise FreeTranslateError((detail or translated or "免费翻译请求失败")[:200])
                results.append(translated)
    except httpx.HTTPError as exc:
        raise FreeTranslateError(f"免费翻译连接失败：{exc}") from exc
    return " ".join(results)
