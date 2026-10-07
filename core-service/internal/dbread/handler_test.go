package dbread

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	_ "modernc.org/sqlite"
)

func makeDB(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "db.sqlite")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	_, err = db.Exec(`CREATE TABLE downloads (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		group_id TEXT, group_name TEXT, file_size INTEGER,
		message_id INTEGER, file_type TEXT, file_name TEXT, file_path TEXT,
		created_at TEXT, nsfw_score REAL
	)`)
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec(`INSERT INTO downloads(group_id,group_name,file_size,message_id,file_type,file_name,file_path,created_at,nsfw_score) VALUES
		('-1','Unknown',10,10,'photo','a.jpg','G/images/a.jpg','2026-01-01T00:00:00Z',NULL),
		('-1','Cool Channel',20,11,'video','b.mp4','G/videos/b.mp4','2026-01-02T00:00:00Z',0.25),
		('-2','Group 2',NULL,20,'document','c.pdf','G/documents/c.pdf','2026-01-03T00:00:00Z',NULL),
		('-2','unknown',NULL,21,NULL,NULL,NULL,NULL,NULL),
		('-3','',5,30,'audio','d.ogg','G/audio/d.ogg','2026-01-04T00:00:00Z',NULL)`)
	if err != nil {
		t.Fatal(err)
	}
	return path
}

func call(t *testing.T, h http.Handler, body any) (int, map[string]any) {
	t.Helper()
	b, _ := json.Marshal(body)
	req := httptest.NewRequest(http.MethodPost, "/v1/db/group-aggregates", bytes.NewReader(b))
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	var out map[string]any
	_ = json.Unmarshal(rr.Body.Bytes(), &out)
	return rr.Code, out
}

func TestGroupAggregates(t *testing.T) {
	h := NewHandler(makeDB(t), nil)
	status, body := call(t, h, map[string]any{})
	if status != http.StatusOK {
		t.Fatalf("status=%d body=%v", status, body)
	}
	rows, ok := body["rows"].([]any)
	if !ok || len(rows) != 3 {
		t.Fatalf("rows=%v", body["rows"])
	}
	first := rows[0].(map[string]any)
	if first["group_id"] != "-1" || first["best_name"] != "Cool Channel" || first["count"] != float64(2) || first["size"] != float64(30) {
		t.Fatalf("row=%v", first)
	}
}

func TestUnavailableDatabase(t *testing.T) {
	status, body := call(t, NewHandler("/missing/db.sqlite", nil), map[string]any{})
	if status != http.StatusServiceUnavailable || body["error"].(map[string]any)["code"] != "EDBUNAVAILABLE" {
		t.Fatalf("status=%d body=%v", status, body)
	}
}

func TestStats(t *testing.T) {
	h := NewHandler(makeDB(t), nil)
	status, body := call(t, http.HandlerFunc(h.Stats), map[string]any{})
	if status != http.StatusOK || body["totalFiles"] != float64(5) || body["totalSize"] != float64(35) {
		t.Fatalf("status=%d body=%v", status, body)
	}
}

func TestGroupStats(t *testing.T) {
	h := NewHandler(makeDB(t), nil)
	status, body := call(t, http.HandlerFunc(h.GroupStats), map[string]any{"groupId": "-1"})
	if status != http.StatusOK {
		t.Fatalf("status=%d body=%v", status, body)
	}
	if body["totalFiles"] != float64(2) || body["totalBytes"] != float64(30) {
		t.Fatalf("totals=%v", body)
	}
	byType, _ := body["byType"].(map[string]any)
	if byType["photo"] != float64(1) || byType["video"] != float64(1) {
		t.Fatalf("byType=%v", byType)
	}
	if body["firstMessageId"] != float64(10) || body["lastMessageId"] != float64(11) || body["lastDownloadAt"] != "2026-01-02T00:00:00Z" {
		t.Fatalf("timeline=%v", body)
	}
}

func TestGroupFiles(t *testing.T) {
	h := NewHandler(makeDB(t), nil)
	status, body := call(t, http.HandlerFunc(h.GroupFiles), map[string]any{"groupId": "-1", "limit": 1, "offset": 0, "type": "video"})
	if status != http.StatusOK || body["total"] != float64(1) || body["hasMore"] != false {
		t.Fatalf("status=%d body=%v", status, body)
	}
	rows, _ := body["rows"].([]any)
	if len(rows) != 1 || rows[0].(map[string]any)["file_name"] != "b.mp4" {
		t.Fatalf("rows=%v", body["rows"])
	}
}
