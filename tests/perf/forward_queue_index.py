"""SQLite regression for forward Queue pagination index and ordering.
Run: python3 tests/perf/forward_queue_index.py (stdlib only).
The index DDL is extracted from the Go migration so the test checks source.
"""
from pathlib import Path
import re
import sqlite3

root = Path(__file__).resolve().parents[2]
migration = (root / "core-service/internal/store/migrate.go").read_text()
source = (root / "core-service/internal/app/forward.go").read_text()
match = re.search(r"CREATE INDEX IF NOT EXISTS idx_tgdl_forward_queue_page[\s\S]*?uncertain'\)", migration)
assert match, "pagination index is missing from migration"
assert "ORDER BY CASE status WHEN 'pending' THEN 0 WHEN 'processing' THEN 1 WHEN 'uncertain' THEN 2 ELSE 3 END,id DESC LIMIT ? OFFSET ?" in source
conn = sqlite3.connect(":memory:")
conn.execute("CREATE TABLE tgdl_forward_queue (id INTEGER PRIMARY KEY, status TEXT NOT NULL)")
conn.execute(match.group(0))
statuses = ["pending", "processing", "failed", "interrupted", "uncertain", "forwarded"]
conn.executemany("INSERT INTO tgdl_forward_queue (id,status) VALUES (?,?)", ((i, statuses[i % 6]) for i in range(1, 12001)))
query = """SELECT id,status FROM tgdl_forward_queue
 WHERE status IN ('pending','processing','failed','interrupted','uncertain')
 ORDER BY CASE status WHEN 'pending' THEN 0 WHEN 'processing' THEN 1 WHEN 'uncertain' THEN 2 ELSE 3 END,id DESC LIMIT ? OFFSET ?"""
plan = conn.execute("EXPLAIN QUERY PLAN " + query, (50, 500)).fetchall()
assert any("idx_tgdl_forward_queue_page" in str(row) for row in plan), plan
assert not any("TEMP B-TREE" in str(row) for row in plan), plan
rows = conn.execute(query, (50, 500)).fetchall()
priority = {"pending": 0, "processing": 1, "uncertain": 2, "failed": 3, "interrupted": 3}
reference = sorted(((i, statuses[i % 6]) for i in range(1, 12001) if statuses[i % 6] != "forwarded"), key=lambda row: (priority[row[1]], -row[0]))[500:550]
assert rows == reference, (rows[:3], reference[:3])
print("PASS: forward Queue index chosen with correct stable pagination order (12k rows)")
