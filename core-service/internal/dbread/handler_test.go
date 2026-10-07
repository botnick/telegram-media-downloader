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
	_, err = db.Exec(`CREATE TABLE downloads (group_id TEXT, group_name TEXT, file_size INTEGER)`)
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec(`INSERT INTO downloads(group_id,group_name,file_size) VALUES
		('-1','Unknown',10),('-1','Cool Channel',20),('-2','Group 2',NULL),('-2','unknown',NULL),('-3','',5)`)
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
