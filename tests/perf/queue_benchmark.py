"""Read-only, reproducible SQLite Queue query benchmark.

python3 tests/perf/queue_benchmark.py /path/to/database.sqlite
Never writes to the DB. Run on a *copy* of the production DB if possible.
"""
import argparse
import sqlite3
import statistics
import time
from pathlib import Path

OLD = """SELECT COUNT(*),COALESCE(SUM(status='pending'),0),
 COALESCE(SUM(status='processing'),0),COALESCE(SUM(status='forwarded'),0),
 COALESCE(SUM(status='failed'),0),COALESCE(SUM(status='interrupted'),0),
 COALESCE(SUM(status='uncertain'),0),COALESCE(SUM(status='not_applicable'),0)
 FROM tgdl_forward_queue"""
NEW = "SELECT status, COUNT(*) FROM tgdl_forward_queue GROUP BY status"
# Keep the projection aligned with forwardQueueSnapshot in app/forward.go.
# SELECT id alone can pick a different covering index and misrepresent the API.
PAGE = """SELECT id,group_id,group_name,message_id,file_name,topic_id,status,reason,created_at,forward_config_json,stage,destinations_json,attempts,retry_at FROM tgdl_forward_queue
 WHERE status IN ('pending','processing','failed','interrupted','uncertain')
 ORDER BY CASE status WHEN 'pending' THEN 0 WHEN 'processing' THEN 1
 WHEN 'uncertain' THEN 2 ELSE 3 END,id DESC LIMIT 50 OFFSET ?"""
# Diagnostic only: forcing the index may be slower on small datasets.
PAGE_FORCED = PAGE.replace("FROM tgdl_forward_queue", "FROM tgdl_forward_queue INDEXED BY idx_tgdl_forward_queue_page")
STATUSES = ("pending", "processing", "forwarded", "failed", "interrupted", "uncertain", "not_applicable")


def sample(db, query, args=(), runs=7):
    # Collect results each iteration: this measures execution/fetch, not just
    # SQLite prepare time. Order is alternated by callers to reduce drift.
    values = []
    result = None
    for _ in range(runs):
        started = time.perf_counter()
        result = db.execute(query, args).fetchall()
        values.append((time.perf_counter() - started) * 1000)
    return result, round(statistics.median(values), 3)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("db", type=Path, help="Existing SQLite database path (prefer a local copy)")
    parser.add_argument("--runs", type=int, default=7)
    parser.add_argument("--offset", type=int, default=500)
    args = parser.parse_args()
    if args.runs < 3 or args.offset < 0:
        parser.error("--runs must be >=3 and --offset nonnegative")
    path = args.db.expanduser().resolve(strict=True)
    # Immutable snapshot avoids accidentally creating WAL/SHM files or writes.
    # On an active WAL database immutable=1 may ignore uncheckpointed changes;
    # use an offline or backed-up copy, not the live DB, for reliable figures.
    from urllib.parse import quote
    db = sqlite3.connect("file:" + quote(str(path), safe="/") + "?mode=ro&immutable=1", uri=True)
    try:
        db.execute("PRAGMA query_only=ON")
        print("Rows:", db.execute("SELECT COUNT(*) FROM tgdl_forward_queue").fetchone()[0])
        print("SQLite version:", db.execute("SELECT sqlite_version()").fetchone()[0])
        indexes = db.execute("PRAGMA index_list('tgdl_forward_queue')").fetchall()
        print("Queue indexes:", ", ".join(row[1] for row in indexes))
        if not any(row[1] == "idx_tgdl_forward_queue_page" for row in indexes):
            print("NOTE: pagination expression index is absent from this snapshot; check database migration version.")
        old_result, old_ms = sample(db, OLD, runs=args.runs)
        new_result, new_ms = sample(db, NEW, runs=args.runs)
        counts = dict(new_result)
        equivalent = old_result[0] == (sum(counts.values()), *(counts.get(s, 0) for s in STATUSES))
        if not equivalent:
            raise AssertionError("Old and new counts disagree")
        page_rows, page_ms = sample(db, PAGE, (args.offset,), args.runs)
        has_page_index = any(row[1] == "idx_tgdl_forward_queue_page" for row in indexes)
        forced_ms = None
        if has_page_index:
            forced_rows, forced_ms = sample(db, PAGE_FORCED, (args.offset,), args.runs)
            assert forced_rows == page_rows, "Forced page index changed pagination results"
        plans = [("old_counts", OLD, ()), ("new_counts", NEW, ()), ("page", PAGE, (args.offset,))]
        if has_page_index:
            plans.append(("page_forced", PAGE_FORCED, (args.offset,)))
        for label, query, params in plans:
            plan = db.execute("EXPLAIN QUERY PLAN " + query, params).fetchall()
            print(label, "plan:", " | ".join(str(p[-1]) for p in plan))
        print(f"Median {args.runs} samples (ms): old_counts={old_ms} new_counts={new_ms} page={page_ms}")
        if forced_ms is not None:
            print(f"Forced page index median (ms): {forced_ms}; identical rows: PASS")
        print("Counter equivalence: PASS")
    finally:
        db.close()


if __name__ == "__main__":
    main()
