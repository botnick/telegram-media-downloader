package dbread

import (
	"bytes"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
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
		created_at TEXT, nsfw_score REAL, nsfw_checked_at INTEGER,
		nsfw_whitelist INTEGER DEFAULT 0, pending_until INTEGER,
		rescued_at INTEGER, pinned INTEGER DEFAULT 0
	)`)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(`CREATE TABLE seekbar_sprites (
		download_id INTEGER PRIMARY KEY, sprite_path TEXT, meta_path TEXT,
		duration_sec REAL, frames INTEGER, cols INTEGER, rows INTEGER,
		tile_w INTEGER, tile_h INTEGER, interval_sec REAL, format TEXT,
		bytes INTEGER, source_size INTEGER, source_mtime INTEGER, generated_at INTEGER
	)`); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(`CREATE TABLE share_links (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		download_id INTEGER NOT NULL,
		created_at INTEGER NOT NULL,
		expires_at INTEGER NOT NULL,
		revoked_at INTEGER,
		label TEXT,
		last_accessed_at INTEGER,
		access_count INTEGER NOT NULL DEFAULT 0
	)`); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(`CREATE TABLE update_history (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		from_version TEXT, to_version TEXT, from_instance_id TEXT,
		started_at INTEGER NOT NULL, finished_at INTEGER,
		status TEXT NOT NULL DEFAULT 'pending', error_code TEXT,
		error_msg TEXT, backup_path TEXT, backup_bytes INTEGER
	)`); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(`CREATE TABLE people (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		label TEXT, embedding_centroid BLOB NOT NULL, face_count INTEGER NOT NULL DEFAULT 0,
		created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
	)`); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(`CREATE TABLE faces (
		id INTEGER PRIMARY KEY AUTOINCREMENT, download_id INTEGER NOT NULL,
		x REAL NOT NULL, y REAL NOT NULL, w REAL NOT NULL, h REAL NOT NULL,
		embedding BLOB NOT NULL, person_id INTEGER, quality_score REAL
	)`); err != nil {
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
	if _, err = db.Exec(`UPDATE downloads SET nsfw_score=0.2, nsfw_checked_at=100 WHERE id=1`); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(`UPDATE downloads SET nsfw_score=0.95, nsfw_checked_at=100 WHERE id=2`); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(`UPDATE downloads SET nsfw_score=0.8, nsfw_checked_at=100, nsfw_whitelist=1 WHERE id=3`); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(`INSERT INTO seekbar_sprites(download_id,duration_sec) VALUES (2, 12.5)`); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(`INSERT INTO share_links(download_id,created_at,expires_at,label,access_count) VALUES
		(2,200,400,'cool',3), (1,100,300,'photo',0)`); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(`INSERT INTO update_history(from_version,to_version,from_instance_id,started_at,finished_at,status,error_code,error_msg,backup_path,backup_bytes) VALUES
		('2.31.0','2.32.0','node-a',100,200,'success',NULL,NULL,'/tmp/db.sqlite',42),
		(NULL,NULL,NULL,300,NULL,'pending','WAIT',NULL,NULL,NULL)`); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(`INSERT INTO people(label,embedding_centroid,face_count,created_at,updated_at) VALUES
		('Alice',X'01',2,100,200), (NULL,X'02',1,110,210)`); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(`INSERT INTO faces(download_id,x,y,w,h,embedding,person_id,quality_score) VALUES
		(1,0.1,0.2,0.3,0.4,X'11',1,0.8),
		(2,0.2,0.3,0.4,0.5,X'12',1,0.6),
		(2,0.3,0.4,0.5,0.6,X'13',2,0.9)`); err != nil {
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

func TestAllDownloads(t *testing.T) {
	h := NewHandler(makeDB(t), nil)
	status, body := call(t, http.HandlerFunc(h.AllDownloads), map[string]any{
		"limit": 1, "offset": 0, "type": "videos", "pinnedOnly": false, "pinnedFirst": false,
	})
	if status != http.StatusOK || body["total"] != float64(1) {
		t.Fatalf("status=%d body=%v", status, body)
	}
	rows, _ := body["files"].([]any)
	if len(rows) != 1 || rows[0].(map[string]any)["file_name"] != "b.mp4" || rows[0].(map[string]any)["duration_sec"] != 12.5 {
		t.Fatalf("files=%v", body["files"])
	}
}

func TestDownloadsGroup(t *testing.T) {
	h := NewHandler(makeDB(t), nil)
	status, body := call(t, http.HandlerFunc(h.DownloadsGroup), map[string]any{
		"groupId": "-1", "limit": 1, "offset": 0, "type": "videos", "pinnedOnly": false,
	})
	if status != http.StatusOK || body["total"] != float64(1) {
		t.Fatalf("status=%d body=%v", status, body)
	}
	rows, _ := body["files"].([]any)
	if len(rows) != 1 || rows[0].(map[string]any)["file_name"] != "b.mp4" {
		t.Fatalf("files=%v", body["files"])
	}
}

func TestSearch(t *testing.T) {
	h := NewHandler(makeDB(t), nil)
	status, body := call(t, http.HandlerFunc(h.Search), map[string]any{
		"query": "Cool", "limit": 50, "offset": 0, "type": "all", "order": "relevance",
	})
	if status != http.StatusOK || body["total"] != float64(1) {
		t.Fatalf("status=%d body=%v", status, body)
	}
	rows, _ := body["files"].([]any)
	if len(rows) != 1 || rows[0].(map[string]any)["file_name"] != "b.mp4" {
		t.Fatalf("files=%v", body["files"])
	}
	status, body = call(t, http.HandlerFunc(h.Search), map[string]any{
		"query": "zzznomatch", "limit": 50, "offset": 0,
	})
	if status != http.StatusOK || body["total"] != float64(0) {
		t.Fatalf("no match status=%d body=%v", status, body)
	}
}

func TestThumbsList(t *testing.T) {
	h := NewHandler(makeDB(t), nil)
	cache := t.TempDir()
	sum := sha256.Sum256([]byte("1:320"))
	cacheFile := filepath.Join(cache, hex.EncodeToString(sum[:])[:32]+".webp")
	if err := os.WriteFile(cacheFile, []byte("thumb"), 0o644); err != nil {
		t.Fatal(err)
	}
	status, body := call(t, http.HandlerFunc(h.ThumbsList), map[string]any{
		"limit": 1, "kind": "image", "cacheRoot": cache,
	})
	if status != http.StatusOK || body["total"] != float64(1) || body["hasMore"] != true {
		t.Fatalf("status=%d body=%v", status, body)
	}
	rows, _ := body["rows"].([]any)
	if len(rows) != 1 {
		t.Fatalf("rows=%v", body["rows"])
	}
	row := rows[0].(map[string]any)
	if row["id"] != float64(1) || row["cached"] != true || row["file_name"] != "a.jpg" {
		t.Fatalf("row=%v", row)
	}
	status, body = call(t, http.HandlerFunc(h.ThumbsList), map[string]any{
		"limit": 1, "kind": "image", "cachedOnly": true, "cacheRoot": cache,
	})
	if status != http.StatusOK || body["hasMore"] != true {
		t.Fatalf("cached-only status=%d body=%v", status, body)
	}
}

func TestSeekbarList(t *testing.T) {
	h := NewHandler(makeDB(t), nil)
	status, body := call(t, http.HandlerFunc(h.SeekbarList), map[string]any{
		"limit": 1, "offset": 0,
	})
	if status != http.StatusOK || body["total"] != float64(1) || body["limit"] != float64(1) {
		t.Fatalf("status=%d body=%v", status, body)
	}
	rows, _ := body["rows"].([]any)
	if len(rows) != 1 {
		t.Fatalf("rows=%v", body["rows"])
	}
	row := rows[0].(map[string]any)
	if row["id"] != float64(2) || row["duration_sec"] != 12.5 || row["file_name"] != "b.mp4" {
		t.Fatalf("row=%v", row)
	}
}

func TestShareLinks(t *testing.T) {
	h := NewHandler(makeDB(t), nil)
	status, body := call(t, http.HandlerFunc(h.ShareLinks), map[string]any{
		"downloadId": 2, "includeRevoked": true, "limit": 50, "offset": 0, "search": "cool",
	})
	if status != http.StatusOK || body["total"] != float64(1) {
		t.Fatalf("status=%d body=%v", status, body)
	}
	rows, _ := body["rows"].([]any)
	if len(rows) != 1 || rows[0].(map[string]any)["file_name"] != "b.mp4" || rows[0].(map[string]any)["group_id"] != "-1" {
		t.Fatalf("rows=%v", body["rows"])
	}
	status, body = call(t, http.HandlerFunc(h.ShareLinks), map[string]any{
		"includeRevoked": false, "limit": 1, "offset": 1,
	})
	if status != http.StatusOK || body["total"] != float64(2) {
		t.Fatalf("paging status=%d body=%v", status, body)
	}
}

func TestUpdateHistory(t *testing.T) {
	h := NewHandler(makeDB(t), nil)
	status, body := call(t, http.HandlerFunc(h.UpdateHistory), map[string]any{"limit": 1})
	if status != http.StatusOK {
		t.Fatalf("status=%d body=%v", status, body)
	}
	rows, _ := body["history"].([]any)
	if len(rows) != 1 || rows[0].(map[string]any)["status"] != "pending" {
		t.Fatalf("history=%v", body["history"])
	}
	status, body = call(t, http.HandlerFunc(h.UpdateHistory), map[string]any{"limit": 20})
	if status != http.StatusOK {
		t.Fatalf("full status=%d body=%v", status, body)
	}
	rows, _ = body["history"].([]any)
	if len(rows) != 2 || rows[1].(map[string]any)["backup_bytes"] != float64(42) {
		t.Fatalf("full history=%v", body["history"])
	}
}

func TestNsfwTiers(t *testing.T) {
	h := NewHandler(makeDB(t), nil)
	status, body := call(t, http.HandlerFunc(h.NsfwTiers), map[string]any{"fileTypes": []string{"photo", "video"}})
	if status != http.StatusOK {
		t.Fatalf("status=%d body=%v", status, body)
	}
	tiers, _ := body["tiers"].(map[string]any)
	if tiers["def_not"] != float64(1) || tiers["def"] != float64(1) || body["scanned"] != float64(2) || body["whitelisted"] != float64(1) || body["totalEligible"] != float64(2) {
		t.Fatalf("body=%v", body)
	}
}

func TestNsfwHistogram(t *testing.T) {
	h := NewHandler(makeDB(t), nil)
	status, body := call(t, http.HandlerFunc(h.NsfwHistogram), map[string]any{"fileTypes": []string{"photo", "video"}, "bins": 4})
	if status != http.StatusOK || body["bins"] != float64(4) {
		t.Fatalf("status=%d body=%v", status, body)
	}
	counts, _ := body["counts"].([]any)
	if len(counts) != 4 || counts[0] != float64(1) || counts[3] != float64(1) {
		t.Fatalf("counts=%v", body["counts"])
	}
}

func TestNsfwList(t *testing.T) {
	h := NewHandler(makeDB(t), nil)
	status, body := call(t, http.HandlerFunc(h.NsfwList), map[string]any{
		"tier": "def_not", "fileTypes": []string{"photo", "video"}, "groupId": "-1",
		"includeWhitelisted": false, "page": 1, "limit": 1, "fileKind": "photo",
	})
	if status != http.StatusOK || body["total"] != float64(1) || body["page"] != float64(1) {
		t.Fatalf("status=%d body=%v", status, body)
	}
	rows, _ := body["rows"].([]any)
	if len(rows) != 1 || rows[0].(map[string]any)["file_name"] != "a.jpg" {
		t.Fatalf("rows=%v", body["rows"])
	}
	status, body = call(t, http.HandlerFunc(h.NsfwList), map[string]any{
		"fileTypes": []string{"photo", "video"}, "includeWhitelisted": true, "page": 1, "limit": 20,
	})
	if status != http.StatusOK || body["total"] != float64(2) {
		t.Fatalf("include whitelist status=%d body=%v", status, body)
	}
}

func TestPeople(t *testing.T) {
	h := NewHandler(makeDB(t), nil)
	status, body := call(t, http.HandlerFunc(h.People), map[string]any{"limit": 1, "offset": 0, "sort": "face_count", "dir": "desc"})
	if status != http.StatusOK || body["total"] != float64(2) {
		t.Fatalf("status=%d body=%v", status, body)
	}
	rows, _ := body["people"].([]any)
	if len(rows) != 1 || rows[0].(map[string]any)["label"] != "Alice" || rows[0].(map[string]any)["cover_face_id"] != float64(1) {
		t.Fatalf("people=%v", body["people"])
	}
	status, body = call(t, http.HandlerFunc(h.People), map[string]any{"limit": 10, "sort": "name", "dir": "asc"})
	if status != http.StatusOK {
		t.Fatalf("name status=%d body=%v", status, body)
	}
	rows, _ = body["people"].([]any)
	if len(rows) != 2 || rows[0].(map[string]any)["label"] != nil {
		t.Fatalf("name people=%v", body["people"])
	}
}
