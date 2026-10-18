import hashlib
import json
import re
import sqlite3
import unicodedata
import uuid
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional

import uvicorn
from fastapi import FastAPI, File, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import llm
from config import BASE, llm_config
from db import DB_PATH, PDF_DIR, db, init_db, now_str, today_str

STATIC_DIR = BASE / "static"

app = FastAPI(title="ReadVocab")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

KIND_LABELS = {
    "p": "过去式",
    "d": "过去分词",
    "i": "现在分词",
    "3": "第三人称单数",
    "s": "复数",
    "r": "比较级",
    "t": "最高级",
}


def row_to_dict(row):
    return dict(row) if row is not None else None


def normalize_query(text):
    value = unicodedata.normalize("NFKC", text or "")
    value = value.replace("\u00ad", "")
    value = re.sub(r"-\s*\n\s*", "", value)
    value = re.sub(r"\s+", " ", value).strip()
    value = value.strip(" \t\r\n\"'“”‘’()[]{}<>.,;:!?，。；：！？")
    return value


def kind_label(kind):
    if not kind:
        return ""
    labels = []
    for ch in kind:
        label = KIND_LABELS.get(ch)
        if label and label not in labels:
            labels.append(label)
    return " / ".join(labels)


def clean_text(text, limit=500):
    value = re.sub(r"\s+", " ", (text or "").strip())
    return value[:limit]


def clean_multiline(text, limit=800):
    value = (text or "").replace("\r\n", "\n").replace("\r", "\n").strip()
    value = re.sub(r"[ \t]+", " ", value)
    value = re.sub(r"\n{3,}", "\n\n", value)
    return value[:limit]


def log_lookup(conn, text):
    if " " in text or len(text) > 40:
        return
    conn.execute(
        "INSERT INTO lookups (text, day, n) VALUES (?, ?, 1) "
        "ON CONFLICT(text, day) DO UPDATE SET n = n + 1",
        (text.lower(), today_str()),
    )


@app.get("/")
async def index():
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/api/health")
async def health():
    with db() as conn:
        dict_count = conn.execute("SELECT COUNT(*) FROM dict").fetchone()[0]
        form_count = conn.execute("SELECT COUNT(*) FROM forms").fetchone()[0]
    cfg = llm_config()
    return {
        "ok": True,
        "dict_count": dict_count,
        "form_count": form_count,
        "llm_configured": bool(cfg["api_key"]),
        "llm_model": cfg["model"],
    }


class LookupIn(BaseModel):
    text: str


@app.post("/api/lookup")
async def lookup(body: LookupIn):
    query = normalize_query(body.text)
    if not query:
        raise HTTPException(400, "没有可查询的文本")
    if len(query) > 120:
        raise HTTPException(400, "查询文本过长")
    kind = "word" if " " not in query else "phrase"
    result = {
        "query": query,
        "kind": kind,
        "found": False,
        "lemma": query,
        "form": query,
        "phonetic": "",
        "translation": "",
        "definition": "",
        "pos": "",
        "exchange": "",
        "tag": "",
        "note": "",
        "source": "none",
    }
    with db() as conn:
        row = conn.execute(
            "SELECT * FROM dict WHERE word = ? COLLATE NOCASE LIMIT 1", (query,)
        ).fetchone()
        mapping = None
        if kind == "word":
            mapping = conn.execute(
                "SELECT f.lemma, f.kind FROM forms f "
                "JOIN dict d ON d.word = f.lemma COLLATE NOCASE "
                "WHERE f.form = ? LIMIT 1",
                (query.lower(),),
            ).fetchone()
        if row is None and mapping is not None:
            row = conn.execute(
                "SELECT * FROM dict WHERE word = ? COLLATE NOCASE LIMIT 1",
                (mapping["lemma"],),
            ).fetchone()
        if row is None:
            log_lookup(conn, query)
            return result
        translation = (row["translation"] or "").replace("\\n", "\n").strip()
        definition = (row["definition"] or "").replace("\\n", "\n").strip()
        phonetic = row["phonetic"] or ""
        note = ""
        if mapping is not None:
            label = kind_label(mapping["kind"])
            note = f"原形：{mapping['lemma']}" + (f"（{label}）" if label else "")
            only_inflection = bool(
                re.search(r"的(复数|过去式|过去分词|第三人称单数|现在分词|比较级|最高级)", translation)
            ) and len(translation) < 80
            if query.lower() != mapping["lemma"].lower() and only_inflection:
                lemma_row = conn.execute(
                    "SELECT * FROM dict WHERE word = ? COLLATE NOCASE LIMIT 1",
                    (mapping["lemma"],),
                ).fetchone()
                if lemma_row is not None:
                    translation = (lemma_row["translation"] or "").replace("\\n", "\n").strip()
                    definition = (lemma_row["definition"] or "").replace("\\n", "\n").strip()
                    phonetic = phonetic or lemma_row["phonetic"] or ""
        log_lookup(conn, query)
        result.update(
            {
                "found": True,
                "lemma": mapping["lemma"] if mapping is not None else row["word"],
                "form": query,
                "phonetic": phonetic,
                "translation": translation,
                "definition": definition,
                "pos": row["pos"] or "",
                "exchange": row["exchange"] or "",
                "tag": row["tag"] or "",
                "note": note,
                "source": "dict",
            }
        )
    return result


class TranslateIn(BaseModel):
    text: str
    mode: str = "sentence"
    context: str = ""


@app.post("/api/translate")
async def translate(body: TranslateIn):
    text = clean_text(body.text, 2000)
    if not text:
        raise HTTPException(400, "没有可翻译的文本")
    mode = body.mode if body.mode in ("word", "sentence") else "sentence"
    context = clean_text(body.context, 600)
    cfg = llm_config()
    if not cfg["api_key"]:
        raise HTTPException(400, "未配置 DeepSeek API Key，请在 .env 中填写 DEEPSEEK_API_KEY")
    key = hashlib.sha256(
        f"{cfg['model']}|{mode}|{text}|{context}".encode("utf-8")
    ).hexdigest()
    with db() as conn:
        cached = conn.execute(
            "SELECT result FROM llm_cache WHERE key = ?", (key,)
        ).fetchone()
        if cached is not None:
            return {"ok": True, "cached": True, "mode": mode, "text": text, "result": json.loads(cached[0])}
    try:
        if mode == "word":
            result = await llm.explain_word(text, context)
        else:
            result = await llm.translate_sentence(text)
    except llm.LLMError as exc:
        raise HTTPException(502, str(exc)) from exc
    with db() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO llm_cache (key, result, created_at) VALUES (?, ?, ?)",
            (key, json.dumps(result, ensure_ascii=False), now_str()),
        )
    return {"ok": True, "cached": False, "mode": mode, "text": text, "result": result}


class VocabIn(BaseModel):
    lemma: str
    form: str = ""
    phonetic: str = ""
    senses: str = ""
    definition: str = ""
    source: str = "dict"
    doc_id: Optional[int] = None
    page: Optional[int] = None
    sentence: str = ""


@app.post("/api/vocab")
async def add_vocab(body: VocabIn):
    lemma = clean_text(body.lemma, 120).lower()
    if not lemma:
        raise HTTPException(400, "缺少单词")
    form = clean_text(body.form, 120) or lemma
    phonetic = clean_text(body.phonetic, 120)
    senses = clean_multiline(body.senses)
    definition = clean_multiline(body.definition)
    sentence = clean_text(body.sentence, 600)
    timestamp = now_str()
    with db() as conn:
        existing = conn.execute(
            "SELECT * FROM vocab WHERE lemma = ? COLLATE NOCASE LIMIT 1", (lemma,)
        ).fetchone()
        created = existing is None
        if created:
            cursor = conn.execute(
                "INSERT INTO vocab (lemma, form, phonetic, senses, definition, source, status, first_seen_at, last_seen_at) "
                "VALUES (?, ?, ?, ?, ?, ?, 'new', ?, ?)",
                (lemma, form, phonetic, senses, definition, body.source, timestamp, timestamp),
            )
            vocab_id = cursor.lastrowid
        else:
            vocab_id = existing["id"]
            conn.execute(
                "UPDATE vocab SET last_seen_at = ?, phonetic = CASE WHEN phonetic = '' THEN ? ELSE phonetic END, "
                "senses = CASE WHEN senses = '' THEN ? ELSE senses END, "
                "definition = CASE WHEN definition = '' THEN ? ELSE definition END WHERE id = ?",
                (timestamp, phonetic, senses, definition, vocab_id),
            )
        if sentence:
            conn.execute(
                "INSERT OR IGNORE INTO contexts (vocab_id, doc_id, page, sentence, created_at) VALUES (?, ?, ?, ?, ?)",
                (vocab_id, body.doc_id, body.page, sentence, timestamp),
            )
        total = conn.execute("SELECT COUNT(*) FROM vocab").fetchone()[0]
        today = conn.execute(
            "SELECT COUNT(*) FROM vocab WHERE substr(first_seen_at, 1, 10) = ?", (today_str(),)
        ).fetchone()[0]
    return {"id": vocab_id, "created": created, "total": total, "today": today}


class VocabPatch(BaseModel):
    status: Optional[str] = None
    senses: Optional[str] = None


@app.patch("/api/vocab/{vocab_id}")
async def patch_vocab(vocab_id: int, body: VocabPatch):
    with db() as conn:
        row = conn.execute("SELECT id FROM vocab WHERE id = ?", (vocab_id,)).fetchone()
        if row is None:
            raise HTTPException(404, "生词不存在")
        if body.status is not None:
            if body.status not in ("new", "learning", "known"):
                raise HTTPException(400, "状态无效")
            conn.execute("UPDATE vocab SET status = ? WHERE id = ?", (body.status, vocab_id))
        if body.senses is not None:
            conn.execute(
                "UPDATE vocab SET senses = ? WHERE id = ?",
                (clean_multiline(body.senses), vocab_id),
            )
    return {"ok": True}


@app.delete("/api/vocab/{vocab_id}")
async def delete_vocab(vocab_id: int):
    with db() as conn:
        conn.execute("DELETE FROM vocab WHERE id = ?", (vocab_id,))
    return {"ok": True}


@app.get("/api/vocab")
async def list_vocab(
    status: str = Query("all"),
    q: str = Query(""),
    limit: int = Query(100, ge=1, le=300),
    offset: int = Query(0, ge=0),
):
    filters = []
    params = []
    if status in ("new", "learning", "known"):
        filters.append("status = ?")
        params.append(status)
    if q.strip():
        filters.append("lemma LIKE ? COLLATE NOCASE")
        params.append(f"%{q.strip()}%")
    where = ("WHERE " + " AND ".join(filters)) if filters else ""
    with db() as conn:
        total = conn.execute(f"SELECT COUNT(*) FROM vocab {where}", params).fetchone()[0]
        rows = conn.execute(
            f"SELECT * FROM vocab {where} ORDER BY last_seen_at DESC, id DESC LIMIT ? OFFSET ?",
            params + [limit, offset],
        ).fetchall()
        items = []
        ids = [r["id"] for r in rows]
        contexts = {}
        if ids:
            placeholders = ",".join("?" * len(ids))
            for row in conn.execute(
                f"SELECT c.vocab_id, c.sentence, c.page, d.id AS doc_id, d.title "
                f"FROM contexts c LEFT JOIN documents d ON d.id = c.doc_id "
                f"WHERE c.vocab_id IN ({placeholders}) ORDER BY c.id DESC",
                ids,
            ):
                contexts.setdefault(row["vocab_id"], []).append(row_to_dict(row))
        for row in rows:
            item = row_to_dict(row)
            item["contexts"] = contexts.get(row["id"], [])[:4]
            items.append(item)
    return {"total": total, "items": items}


@app.get("/api/vocab/check")
async def check_vocab(lemma: str = Query("")):
    word = clean_text(lemma, 120).lower()
    if not word:
        return {"found": False, "id": None, "status": None}
    with db() as conn:
        row = conn.execute(
            "SELECT id, status FROM vocab WHERE lemma = ? COLLATE NOCASE LIMIT 1", (word,)
        ).fetchone()
    return {
        "found": row is not None,
        "id": row["id"] if row is not None else None,
        "status": row["status"] if row is not None else None,
    }


@app.get("/api/stats")
async def stats():
    today = datetime.now().date()
    week_start = (today - timedelta(days=6)).strftime("%Y-%m-%d")
    year_start = (today - timedelta(days=364)).strftime("%Y-%m-%d")
    with db() as conn:
        status_rows = conn.execute(
            "SELECT status, COUNT(*) AS n FROM vocab GROUP BY status"
        ).fetchall()
        status_counts = {"new": 0, "learning": 0, "known": 0}
        for row in status_rows:
            status_counts[row["status"]] = row["n"]
        total = sum(status_counts.values())
        today_new = conn.execute(
            "SELECT COUNT(*) FROM vocab WHERE substr(first_seen_at, 1, 10) = ?",
            (today.strftime("%Y-%m-%d"),),
        ).fetchone()[0]
        week_new = conn.execute(
            "SELECT COUNT(*) FROM vocab WHERE substr(first_seen_at, 1, 10) >= ?",
            (week_start,),
        ).fetchone()[0]
        date_rows = conn.execute(
            "SELECT substr(first_seen_at, 1, 10) AS d, COUNT(*) AS n FROM vocab "
            "WHERE substr(first_seen_at, 1, 10) >= ? GROUP BY d",
            (year_start,),
        ).fetchall()
        counts = {row["d"]: row["n"] for row in date_rows}
        active_dates = sorted(counts.keys(), reverse=True)
        streak = 0
        if active_dates:
            latest = datetime.strptime(active_dates[0], "%Y-%m-%d").date()
            if latest in (today, today - timedelta(days=1)):
                cursor = latest
                while counts.get(cursor.strftime("%Y-%m-%d")):
                    streak += 1
                    cursor -= timedelta(days=1)
        days = []
        for i in range(364, -1, -1):
            day = today - timedelta(days=i)
            key = day.strftime("%Y-%m-%d")
            days.append({"date": key, "n": counts.get(key, 0)})
        lookups_today = conn.execute(
            "SELECT COALESCE(SUM(n), 0) FROM lookups WHERE day = ?", (today.strftime("%Y-%m-%d"),)
        ).fetchone()[0]
        lookups_week = conn.execute(
            "SELECT COALESCE(SUM(n), 0) FROM lookups WHERE day >= ?", (week_start,)
        ).fetchone()[0]
        by_doc = [
            row_to_dict(row)
            for row in conn.execute(
                "SELECT d.id, d.title, COUNT(DISTINCT c.vocab_id) AS n "
                "FROM contexts c JOIN documents d ON d.id = c.doc_id "
                "GROUP BY d.id ORDER BY n DESC, d.id DESC LIMIT 20"
            )
        ]
    return {
        "total": total,
        "today_new": today_new,
        "week_new": week_new,
        "streak": streak,
        "status": status_counts,
        "days": days,
        "lookups_today": lookups_today,
        "lookups_week": lookups_week,
        "by_doc": by_doc,
    }


class DocumentPatch(BaseModel):
    last_page: Optional[int] = None
    title: Optional[str] = None


@app.post("/api/documents")
async def upload_document(file: UploadFile = File(...)):
    name = file.filename or "document.pdf"
    if not name.lower().endswith(".pdf"):
        raise HTTPException(400, "只支持 PDF 文件")
    uid = uuid.uuid4().hex
    path = PDF_DIR / f"{uid}.pdf"
    size = 0
    try:
        with open(path, "wb") as out:
            while True:
                chunk = await file.read(1 << 20)
                if not chunk:
                    break
                size += len(chunk)
                if size > 200 * 1024 * 1024:
                    raise HTTPException(400, "PDF 不能超过 200 MB")
                out.write(chunk)
        pages = 0
        try:
            from pypdf import PdfReader

            with open(path, "rb") as handle:
                pages = len(PdfReader(handle).pages)
        except Exception as exc:
            raise HTTPException(400, "PDF 解析失败，可能文件已损坏或被加密") from exc
        title = Path(name).stem.strip()[:200] or "未命名文档"
        timestamp = now_str()
        with db() as conn:
            cursor = conn.execute(
                "INSERT INTO documents (title, file, pages, added_at, last_page) VALUES (?, ?, ?, ?, 1)",
                (title, path.name, pages, timestamp),
            )
            doc_id = cursor.lastrowid
    except Exception:
        path.unlink(missing_ok=True)
        raise
    return {
        "id": doc_id,
        "title": title,
        "pages": pages,
        "last_page": 1,
        "added_at": timestamp,
        "words": 0,
    }


@app.get("/api/documents")
async def list_documents():
    with db() as conn:
        rows = conn.execute(
            "SELECT d.*, (SELECT COUNT(DISTINCT c.vocab_id) FROM contexts c WHERE c.doc_id = d.id) AS words "
            "FROM documents d ORDER BY d.id DESC"
        ).fetchall()
    return {"items": [row_to_dict(row) for row in rows]}


@app.get("/api/documents/{doc_id}/file")
async def document_file(doc_id: int):
    with db() as conn:
        row = conn.execute("SELECT * FROM documents WHERE id = ?", (doc_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "文档不存在")
    path = PDF_DIR / row["file"]
    if not path.exists():
        raise HTTPException(404, "PDF 文件已丢失")
    return FileResponse(
        path,
        media_type="application/pdf",
        filename=f"{row['title']}.pdf",
        content_disposition_type="inline",
    )


@app.patch("/api/documents/{doc_id}")
async def patch_document(doc_id: int, body: DocumentPatch):
    with db() as conn:
        row = conn.execute("SELECT id FROM documents WHERE id = ?", (doc_id,)).fetchone()
        if row is None:
            raise HTTPException(404, "文档不存在")
        if body.last_page is not None and body.last_page >= 1:
            conn.execute(
                "UPDATE documents SET last_page = ? WHERE id = ?", (body.last_page, doc_id)
            )
        if body.title is not None and body.title.strip():
            conn.execute(
                "UPDATE documents SET title = ? WHERE id = ?", (body.title.strip()[:200], doc_id)
            )
    return {"ok": True}


@app.delete("/api/documents/{doc_id}")
async def delete_document(doc_id: int):
    with db() as conn:
        row = conn.execute("SELECT * FROM documents WHERE id = ?", (doc_id,)).fetchone()
        if row is None:
            raise HTTPException(404, "文档不存在")
        conn.execute("UPDATE contexts SET doc_id = NULL WHERE doc_id = ?", (doc_id,))
        conn.execute("DELETE FROM documents WHERE id = ?", (doc_id,))
    (PDF_DIR / row["file"]).unlink(missing_ok=True)
    return {"ok": True}


@app.exception_handler(sqlite3.Error)
async def sqlite_error_handler(request, exc):
    return JSONResponse(status_code=500, content={"detail": f"数据库错误：{exc}"})


init_db()

if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8000, log_level="info")
