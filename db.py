import sqlite3
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path

BASE = Path(__file__).resolve().parent
DATA_DIR = BASE / "data"
PDF_DIR = DATA_DIR / "pdfs"
DB_PATH = DATA_DIR / "readvocab.db"

SCHEMA = """
CREATE TABLE IF NOT EXISTS dict (
    word TEXT PRIMARY KEY,
    phonetic TEXT,
    translation TEXT,
    definition TEXT,
    exchange TEXT,
    bnc INTEGER DEFAULT 0,
    frq INTEGER DEFAULT 0,
    collins INTEGER DEFAULT 0,
    tag TEXT,
    pos TEXT
);

CREATE TABLE IF NOT EXISTS forms (
    form TEXT PRIMARY KEY,
    lemma TEXT NOT NULL,
    kind TEXT
);

CREATE INDEX IF NOT EXISTS idx_forms_lemma ON forms(lemma);

CREATE TABLE IF NOT EXISTS documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    file TEXT NOT NULL,
    pages INTEGER NOT NULL DEFAULT 0,
    added_at TEXT NOT NULL,
    last_page INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS vocab (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lemma TEXT NOT NULL UNIQUE,
    form TEXT NOT NULL,
    phonetic TEXT DEFAULT '',
    senses TEXT DEFAULT '',
    definition TEXT DEFAULT '',
    source TEXT DEFAULT 'dict',
    status TEXT NOT NULL DEFAULT 'new',
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS contexts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    vocab_id INTEGER NOT NULL REFERENCES vocab(id) ON DELETE CASCADE,
    doc_id INTEGER,
    page INTEGER,
    sentence TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(vocab_id, doc_id, sentence)
);

CREATE TABLE IF NOT EXISTS lookups (
    text TEXT NOT NULL,
    day TEXT NOT NULL,
    n INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (text, day)
);

CREATE TABLE IF NOT EXISTS llm_cache (
    key TEXT PRIMARY KEY,
    result TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_vocab_status ON vocab(status);
CREATE INDEX IF NOT EXISTS idx_vocab_first_seen ON vocab(first_seen_at);
CREATE INDEX IF NOT EXISTS idx_contexts_vocab ON contexts(vocab_id);
CREATE INDEX IF NOT EXISTS idx_contexts_doc ON contexts(doc_id);
"""


def connect():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    PDF_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


@contextmanager
def db():
    conn = connect()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_db():
    with db() as conn:
        conn.executescript(SCHEMA)


def now_str():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def today_str():
    return datetime.now().strftime("%Y-%m-%d")
