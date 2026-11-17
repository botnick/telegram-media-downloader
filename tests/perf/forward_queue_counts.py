"""Queue status aggregate plan / semantics, no external dependencies.
Run: python3 tests/perf/forward_queue_counts.py
"""
from pathlib import Path
import sqlite3

root = Path(__file__).resolve().parents[2]
source = (root / "core-service/internal/app/forward.go").read_text()
query = "SELECT status, COUNT(*) FROM tgdl_forward_queue GROUP BY status"
assert query in source, "production Queue query changed; review this regression"

db = sqlite3.connect(":memory:")
db.execute("CREATE TABLE tgdl_forward_queue (id INTEGER PRIMARY KEY, status TEXT NOT NULL, payload TEXT)")
db.execute("CREATE INDEX idx_tgdl_forward_queue_status ON tgdl_forward_queue(status,id)")
statuses = ["pending", "processing", "forwarded", "failed", "interrupted", "uncertain", "not_applicable", "custom"]
db.executemany(
    "INSERT INTO tgdl_forward_queue (id,status,payload) VALUES (?,?,?)",
    ((i, statuses[i % len(statuses)], "large-value" * 100) for i in range(1, 12001)),
)
plan = db.execute("EXPLAIN QUERY PLAN " + query).fetchall()
assert any("COVERING INDEX idx_tgdl_forward_queue_status" in str(row) for row in plan), plan
assert not any("TEMP B-TREE" in str(row) for row in plan), plan
counts = dict(db.execute(query).fetchall())
reference = db.execute("""SELECT COUNT(*), COALESCE(SUM(status='pending'),0),
 COALESCE(SUM(status='processing'),0), COALESCE(SUM(status='forwarded'),0),
 COALESCE(SUM(status='failed'),0), COALESCE(SUM(status='interrupted'),0),
 COALESCE(SUM(status='uncertain'),0), COALESCE(SUM(status='not_applicable'),0)
 FROM tgdl_forward_queue""").fetchone()
actual = (sum(counts.values()), *(counts.get(s, 0) for s in statuses[:7]))
assert actual == reference, (actual, reference)
print("PASS: queue status counts match baseline and use covering index (12k rows)")
