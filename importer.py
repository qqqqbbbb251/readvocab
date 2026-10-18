import csv
import os
import sys
import time
import urllib.request
from pathlib import Path

from db import BASE, DB_PATH, db, init_db

ECDICT_URL = "https://raw.githubusercontent.com/skywind3000/ECDICT/master/ecdict.csv"
BATCH = 5000
INFLECTIONS = {"p", "d", "i", "3", "s", "r", "t"}


def to_int(value):
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


def parse_exchange(raw):
    result = {}
    last_key = None
    for part in (raw or "").split("/"):
        part = part.strip()
        if not part:
            continue
        if ":" in part:
            key, value = part.split(":", 1)
            key = key.strip()
            value = value.strip()
            if key and value:
                if key in result:
                    result[key] = result[key] + "," + value
                else:
                    result[key] = value
                last_key = key
        elif last_key and part:
            result[last_key] = result[last_key] + "," + part
    return result


def flush(conn, dict_rows, form_rows):
    if dict_rows:
        conn.executemany(
            "INSERT OR IGNORE INTO dict "
            "(word, phonetic, translation, definition, exchange, bnc, frq, collins, tag, pos) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            dict_rows,
        )
        dict_rows.clear()
    for sql, rows in form_rows:
        if rows:
            conn.executemany(sql, rows)
            rows.clear()


def run(csv_path):
    init_db()
    start = time.time()
    dict_rows = []
    explicit_rows = []
    inferred_rows = []
    total = 0
    with db() as conn:
        conn.execute("DELETE FROM forms")
        conn.execute("DELETE FROM dict")
        with open(csv_path, encoding="utf-8-sig", newline="") as handle:
            reader = csv.DictReader(handle)
            for row in reader:
                word = (row.get("word") or "").strip()
                if not word:
                    continue
                total += 1
                dict_rows.append(
                    (
                        word,
                        (row.get("phonetic") or "").strip(),
                        (row.get("translation") or "").strip(),
                        (row.get("definition") or "").strip(),
                        (row.get("exchange") or "").strip(),
                        to_int(row.get("bnc")),
                        to_int(row.get("frq")),
                        to_int(row.get("collins")),
                        (row.get("tag") or "").strip(),
                        (row.get("pos") or "").strip(),
                    )
                )
                lower_word = word.lower()
                exchange = parse_exchange(row.get("exchange") or "")
                lemma = (exchange.get("0") or "").strip().lower()
                if lemma and lemma != lower_word:
                    explicit_rows.append((lower_word, lemma, (exchange.get("1") or "").strip()))
                for code in INFLECTIONS:
                    for form in (exchange.get(code) or "").split(","):
                        form = form.strip().lower()
                        if form and form != lower_word:
                            inferred_rows.append((form, lower_word, code))
                if total % BATCH == 0:
                    flush(
                        conn,
                        dict_rows,
                        [
                            ("INSERT OR REPLACE INTO forms (form, lemma, kind) VALUES (?, ?, ?)", explicit_rows),
                            ("INSERT OR IGNORE INTO forms (form, lemma, kind) VALUES (?, ?, ?)", inferred_rows),
                        ],
                    )
                    if total % 100000 == 0:
                        print(f"  read {total} rows, {time.time() - start:.0f}s", flush=True)
        flush(
            conn,
            dict_rows,
            [
                ("INSERT OR REPLACE INTO forms (form, lemma, kind) VALUES (?, ?, ?)", explicit_rows),
                ("INSERT OR IGNORE INTO forms (form, lemma, kind) VALUES (?, ?, ?)", inferred_rows),
            ],
        )
        print("  building indexes ...", flush=True)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_dict_word_nocase ON dict(word COLLATE NOCASE)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_dict_frq ON dict(frq)")
        conn.execute("DELETE FROM forms WHERE lemma = form")
        conn.execute(
            "DELETE FROM forms WHERE lemma NOT IN (SELECT lower(word) FROM dict)"
        )
        conn.execute("ANALYZE")
        dict_count = conn.execute("SELECT COUNT(*) FROM dict").fetchone()[0]
        form_count = conn.execute("SELECT COUNT(*) FROM forms").fetchone()[0]
    db_size = DB_PATH.stat().st_size
    wal_path = Path(str(DB_PATH) + "-wal")
    if wal_path.exists():
        db_size += wal_path.stat().st_size
    print(f"dict rows: {dict_count}")
    print(f"form mappings: {form_count}")
    print(f"db size: {db_size / 1048576:.1f} MB")
    print(f"done in {time.time() - start:.1f}s")


def resolve_csv(cli_path):
    if cli_path:
        return Path(cli_path)
    env_path = os.getenv("ECDICT_CSV")
    if env_path:
        return Path(env_path)
    candidates = [BASE / "data" / "ecdict.csv", Path(r"C:\dev\downloads\ecdict.csv")]
    for candidate in candidates:
        if candidate.exists():
            return candidate
    target = BASE / "data" / "ecdict.csv"
    target.parent.mkdir(parents=True, exist_ok=True)
    print(f"ECDICT csv not found, downloading to {target} ...", flush=True)
    try:
        urllib.request.urlretrieve(ECDICT_URL, target)
    except Exception as exc:
        raise SystemExit(
            f"download failed: {exc}\n"
            "please download ecdict.csv manually from "
            f"{ECDICT_URL} and pass its path as the first argument"
        ) from exc
    return target


if __name__ == "__main__":
    path = resolve_csv(sys.argv[1] if len(sys.argv) > 1 else None)
    if not path.exists():
        raise SystemExit(f"ECDICT csv not found: {path}")
    print(f"importing {path} ({path.stat().st_size / 1048576:.1f} MB)")
    run(path)
