package backup

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"
)

type fixtureDropboxFile struct {
	display string
	folder  bool
	data    []byte
	mtime   time.Time
}
type fixtureDropboxSession struct {
	data   []byte
	closed bool
}

// fixtureDropbox models the Dropbox v2 RPC and content endpoints with
// case-insensitive paths, implicit parent creation, upload sessions,
// cursor-paginated recursive listings and the documented error shapes.
type fixtureDropbox struct {
	t        *testing.T
	server   *httptest.Server
	oauth    *fixtureOAuth
	mu       sync.Mutex
	entries  map[string]*fixtureDropboxFile // lower-case path → entry
	sessions map[string]*fixtureDropboxSession
	cursors  map[string][]map[string]any
	next     int
	pageSize int

	uploads, starts, appends, finishes, nonASCIIHeaders int
	hook                                                func(w http.ResponseWriter, r *http.Request, op string) bool
	afterStore                                          func(w http.ResponseWriter, op string) bool
}

func newFixtureDropbox(t *testing.T) *fixtureDropbox {
	t.Helper()
	f := &fixtureDropbox{t: t, oauth: newFixtureOAuth("app-key", "app-secret", "dropbox-refresh"), entries: map[string]*fixtureDropboxFile{}, sessions: map[string]*fixtureDropboxSession{}, cursors: map[string][]map[string]any{}, pageSize: 2}
	f.server = httptest.NewServer(http.HandlerFunc(f.serve))
	t.Cleanup(f.server.Close)
	return f
}
func (f *fixtureDropbox) config() map[string]any {
	return map[string]any{"appKey": "app-key", "appSecret": "app-secret", "refreshToken": "dropbox-refresh", "remoteRoot": "/TGDL-Backup/"}
}
func (f *fixtureDropbox) endpoints() dropboxEndpoints {
	return dropboxEndpoints{token: f.server.URL + "/oauth2/token", api: f.server.URL + "/2", content: f.server.URL + "/content/2"}
}
func (f *fixtureDropbox) provider(cfg map[string]any) *dropboxProvider {
	f.t.Helper()
	p, err := newDropboxAt(cfg, f.endpoints())
	if err != nil {
		f.t.Fatal(err)
	}
	p.chunk = dropboxBlock
	fastRetries(p.api)
	f.t.Cleanup(func() { _ = p.Close() })
	return p
}

// fixtureContentHash is an independent implementation of Dropbox's documented
// content hash: SHA-256 of the concatenated SHA-256 digests of 4 MiB blocks.
func fixtureContentHash(b []byte) string {
	var blocks []byte
	for len(b) > 0 {
		n := min(len(b), 4<<20)
		h := sha256.Sum256(b[:n])
		blocks = append(blocks, h[:]...)
		b = b[n:]
	}
	h := sha256.Sum256(blocks)
	return hex.EncodeToString(h[:])
}
func dropboxFail(w http.ResponseWriter, status int, summary string, detail map[string]any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	body := map[string]any{"error_summary": summary + "/...", "user_message": "server-private-detail"}
	if detail != nil {
		body["error"] = detail
	}
	_ = json.NewEncoder(w).Encode(body)
}
func dropboxReply(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}
func (f *fixtureDropbox) meta(e *fixtureDropboxFile) map[string]any {
	name := e.display[strings.LastIndex(e.display, "/")+1:]
	if e.folder {
		return map[string]any{".tag": "folder", "name": name, "path_display": e.display, "path_lower": strings.ToLower(e.display)}
	}
	return map[string]any{".tag": "file", "name": name, "path_display": e.display, "path_lower": strings.ToLower(e.display), "size": len(e.data), "server_modified": e.mtime.Format(time.RFC3339), "content_hash": fixtureContentHash(e.data)}
}
func (f *fixtureDropbox) mkdirs(p string) {
	acc := ""
	for _, segment := range strings.Split(strings.Trim(p, "/"), "/") {
		if segment == "" {
			continue
		}
		acc += "/" + segment
		if f.entries[strings.ToLower(acc)] == nil {
			f.entries[strings.ToLower(acc)] = &fixtureDropboxFile{display: acc, folder: true}
		}
	}
}
func (f *fixtureDropbox) commit(target string, data []byte) map[string]any {
	parent := target[:strings.LastIndex(target, "/")]
	f.mkdirs(parent)
	e := f.entries[strings.ToLower(target)]
	if e == nil {
		e = &fixtureDropboxFile{display: target}
		f.entries[strings.ToLower(target)] = e
	}
	e.data, e.mtime = append([]byte(nil), data...), time.Date(2026, 2, 3, 4, 5, 6, 0, time.UTC)
	return f.meta(e)
}

func (f *fixtureDropbox) serve(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == "/oauth2/token" {
		f.oauth.serve(w, r)
		return
	}
	if !f.oauth.authorized(r) {
		dropboxFail(w, http.StatusUnauthorized, "expired_access_token", map[string]any{".tag": "expired_access_token"})
		return
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	op := strings.TrimPrefix(strings.TrimPrefix(r.URL.Path, "/content"), "/2/")
	if f.hook != nil && f.hook(w, r, op) {
		return
	}
	if strings.HasPrefix(r.URL.Path, "/content/") {
		f.content(w, r, op)
		return
	}
	var arg map[string]any
	if err := json.NewDecoder(r.Body).Decode(&arg); err != nil || r.Header.Get("Content-Type") != "application/json" {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = io.WriteString(w, "Error in call: server-private-detail")
		return
	}
	pathArg, _ := arg["path"].(string)
	switch op {
	case "users/get_current_account":
		dropboxReply(w, map[string]any{"email": "dropbox@example.com"})
	case "files/create_folder_v2":
		if e := f.entries[strings.ToLower(pathArg)]; e != nil {
			kind := "file"
			if e.folder {
				kind = "folder"
			}
			dropboxFail(w, http.StatusConflict, "path/conflict/"+kind, nil)
			return
		}
		f.mkdirs(pathArg)
		dropboxReply(w, map[string]any{"metadata": f.meta(f.entries[strings.ToLower(pathArg)])})
	case "files/get_metadata":
		e := f.entries[strings.ToLower(pathArg)]
		if e == nil {
			dropboxFail(w, http.StatusConflict, "path/not_found", nil)
			return
		}
		dropboxReply(w, f.meta(e))
	case "files/delete_v2":
		if f.entries[strings.ToLower(pathArg)] == nil {
			dropboxFail(w, http.StatusConflict, "path_lookup/not_found", nil)
			return
		}
		delete(f.entries, strings.ToLower(pathArg))
		dropboxReply(w, map[string]any{})
	case "files/list_folder":
		root := strings.ToLower(pathArg)
		if root != "" && (f.entries[root] == nil || !f.entries[root].folder) {
			dropboxFail(w, http.StatusConflict, "path/not_found", nil)
			return
		}
		keys := []string{}
		for k := range f.entries {
			if strings.HasPrefix(k, root+"/") {
				keys = append(keys, k)
			}
		}
		sort.Strings(keys)
		all := []map[string]any{}
		for _, k := range keys {
			all = append(all, f.meta(f.entries[k]))
		}
		f.page(w, all)
	case "files/list_folder/continue":
		cursor, _ := arg["cursor"].(string)
		rest, ok := f.cursors[cursor]
		if !ok {
			dropboxFail(w, http.StatusConflict, "reset", nil)
			return
		}
		delete(f.cursors, cursor)
		f.page(w, rest)
	default:
		dropboxFail(w, http.StatusBadRequest, "unknown_endpoint", nil)
	}
}
func (f *fixtureDropbox) page(w http.ResponseWriter, entries []map[string]any) {
	n := min(len(entries), f.pageSize)
	out := map[string]any{"entries": entries[:n], "has_more": n < len(entries), "cursor": ""}
	if n < len(entries) {
		f.next++
		cursor := fmt.Sprintf("cursor-%d", f.next)
		f.cursors[cursor] = entries[n:]
		out["cursor"] = cursor
	}
	dropboxReply(w, out)
}

func (f *fixtureDropbox) content(w http.ResponseWriter, r *http.Request, op string) {
	header := r.Header.Get("Dropbox-API-Arg")
	for _, c := range []byte(header) {
		if c >= 0x7f {
			f.nonASCIIHeaders++
		}
	}
	var arg struct {
		Path        string `json:"path"`
		Mode        string `json:"mode"`
		ContentHash string `json:"content_hash"`
		Cursor      struct {
			SessionID string `json:"session_id"`
			Offset    int64  `json:"offset"`
		} `json:"cursor"`
		Commit struct {
			Path string `json:"path"`
			Mode string `json:"mode"`
		} `json:"commit"`
	}
	body, err := io.ReadAll(r.Body)
	if err != nil {
		return
	}
	if json.Unmarshal([]byte(header), &arg) != nil || r.Header.Get("Content-Type") != "application/octet-stream" {
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	if arg.ContentHash != "" && arg.ContentHash != fixtureContentHash(body) {
		dropboxFail(w, http.StatusConflict, "content_hash_mismatch", nil)
		return
	}
	session := func() *fixtureDropboxSession {
		s := f.sessions[arg.Cursor.SessionID]
		if s == nil {
			dropboxFail(w, http.StatusConflict, "lookup_failed/not_found", nil)
			return nil
		}
		if s.closed {
			dropboxFail(w, http.StatusConflict, "lookup_failed/closed", nil)
			return nil
		}
		if arg.Cursor.Offset != int64(len(s.data)) {
			dropboxFail(w, http.StatusConflict, "incorrect_offset", map[string]any{".tag": "incorrect_offset", "correct_offset": len(s.data)})
			return nil
		}
		return s
	}
	switch op {
	case "files/upload":
		f.uploads++
		if arg.Mode != "overwrite" {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		meta := f.commit(arg.Path, body)
		if f.afterStore != nil && f.afterStore(w, op) {
			return
		}
		dropboxReply(w, meta)
	case "files/upload_session/start":
		f.starts++
		f.next++
		id := fmt.Sprintf("session-%d", f.next)
		f.sessions[id] = &fixtureDropboxSession{data: body}
		dropboxReply(w, map[string]any{"session_id": id})
	case "files/upload_session/append_v2":
		s := session()
		if s == nil {
			return
		}
		f.appends++
		s.data = append(s.data, body...)
		if f.afterStore != nil && f.afterStore(w, op) {
			return
		}
		dropboxReply(w, nil)
	case "files/upload_session/finish":
		s := session()
		if s == nil {
			return
		}
		f.finishes++
		s.data = append(s.data, body...)
		s.closed = true
		meta := f.commit(arg.Commit.Path, s.data)
		if f.afterStore != nil && f.afterStore(w, op) {
			return
		}
		dropboxReply(w, meta)
	default:
		w.WriteHeader(http.StatusBadRequest)
	}
}
func (f *fixtureDropbox) exists(p string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	e := f.entries[strings.ToLower(p)]
	return e != nil && !e.folder
}
func (f *fixtureDropbox) file(p string) []byte {
	f.mu.Lock()
	defer f.mu.Unlock()
	if e := f.entries[strings.ToLower(p)]; e != nil && !e.folder {
		return e.data
	}
	return nil
}

func TestDropboxContentHashMatchesIndependentImplementation(t *testing.T) {
	for _, n := range []int{0, 1, 4 << 20, 4<<20 + 1, 9<<20 + 3} {
		data := driveSource(n, 9)
		h := newDropboxHasher()
		_, _ = io.Copy(h, io.MultiReader(bytes.NewReader(data[:n/3]), bytes.NewReader(data[n/3:])))
		h.finish()
		if got := h.rangeHash(0, int64(n)); got != fixtureContentHash(data) {
			t.Fatalf("size %d: %s", n, got)
		}
		if n > 8<<20 {
			if got := h.rangeHash(4<<20, 4<<20); got != fixtureContentHash(data[4<<20:8<<20]) {
				t.Fatal("block-aligned range hash")
			}
		}
	}
	// Dropbox's own published empty-file hash.
	if fixtureContentHash(nil) != "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" {
		t.Fatal("empty hash")
	}
}

func TestDropboxRootAndChunkConfiguration(t *testing.T) {
	for raw, want := range map[string]string{"/tgdl-backup": "/tgdl-backup", "tgdl//x/": "/tgdl/x", "/": "", "\\a\\b": "/a/b"} {
		if got, err := dropboxRoot(raw); err != nil || got != want {
			t.Fatalf("%q → %q %v", raw, got, err)
		}
	}
	if _, err := dropboxRoot("/a/../b"); err == nil {
		t.Fatal("dot-dot root accepted")
	}
	t.Setenv("BACKUP_DROPBOX_CHUNK_BYTES", "10000000")
	if dropboxChunkBytes() != 8<<20 {
		t.Fatal("chunk not aligned to 4 MiB")
	}
	t.Setenv("BACKUP_DROPBOX_CHUNK_BYTES", "1")
	if dropboxChunkBytes() != 4<<20 {
		t.Fatal("chunk not clamped up")
	}
	t.Setenv("BACKUP_DROPBOX_CHUNK_BYTES", "999999999999")
	if dropboxChunkBytes() != dropboxMaxChunk {
		t.Fatal("chunk not clamped down")
	}
	if _, err := newDropbox(map[string]any{"appKey": "k", "appSecret": "s"}); err == nil {
		t.Fatal("missing refresh token accepted")
	}
	if a, err := dropboxArg(map[string]string{"path": "/ไทย 😀"}); err != nil || strings.ContainsFunc(a, func(r rune) bool { return r >= 0x7f }) || !strings.Contains(a, "\\ud83d\\ude00") {
		t.Fatalf("header arg: %q %v", a, err)
	}
}

func TestDropboxSessionUploadResumesDedupsListsAndDeletes(t *testing.T) {
	f := newFixtureDropbox(t)
	p := f.provider(f.config())
	ctx := context.Background()
	detail, err := p.Test(ctx)
	if err != nil || !strings.Contains(detail, "dropbox@example.com") || !strings.Contains(detail, "/TGDL-Backup") {
		t.Fatalf("test: %q %v", detail, err)
	}
	if _, err = p.Test(ctx); err != nil {
		t.Fatalf("existing root: %v", err)
	}
	data := driveSource(9<<20+5, 4)
	lost := false
	f.afterStore = func(w http.ResponseWriter, op string) bool {
		// The first append is stored but its reply is lost.
		if op == "files/upload_session/append_v2" && !lost {
			lost = true
			w.WriteHeader(http.StatusInternalServerError)
			return true
		}
		return false
	}
	name := "group/ไทย/movie.bin"
	var last int64
	res, err := p.Upload(ctx, name, bytes.NewReader(data), int64(len(data)), func(n int64) {
		if n < last || n > int64(len(data)) {
			t.Errorf("progress %d after %d", n, last)
		}
		last = n
	})
	if err != nil || res.Skipped || res.ETag != fixtureContentHash(data) {
		t.Fatalf("upload: %+v %v", res, err)
	}
	if !bytes.Equal(f.file("/tgdl-backup/"+name), data) {
		t.Fatal("session upload did not commit exact bytes")
	}
	if f.starts != 1 || f.appends != 1 || f.finishes != 1 || f.nonASCIIHeaders != 0 || !lost {
		t.Fatalf("session protocol: starts=%d appends=%d finishes=%d nonASCII=%d", f.starts, f.appends, f.finishes, f.nonASCIIHeaders)
	}
	if res, err = p.Upload(ctx, name, bytes.NewReader(data), int64(len(data)), nil); err != nil || !res.Skipped || f.starts != 1 {
		t.Fatalf("dedup: %+v %v", res, err)
	}
	changed := driveSource(9<<20+5, 5)
	if res, err = p.Upload(ctx, name, bytes.NewReader(changed), int64(len(changed)), nil); err != nil || res.Skipped || !bytes.Equal(f.file("/tgdl-backup/"+name), changed) {
		t.Fatalf("same-size change: %+v %v", res, err)
	}
	for i := range 3 {
		if _, err = p.Upload(ctx, fmt.Sprintf("snapshots/snapshot-20260101-00000%d.tar.gz", i), bytes.NewReader([]byte{byte(i)}), 1, nil); err != nil {
			t.Fatal(err)
		}
	}
	if _, err = p.Upload(ctx, "empty", bytes.NewReader(nil), 0, nil); err != nil || !f.exists("/tgdl-backup/empty") {
		t.Fatalf("empty: %v", err)
	}
	all, err := p.List(ctx, "")
	if err != nil || len(all) != 5 {
		t.Fatalf("list: %v %v", all, err)
	}
	snaps, err := p.List(ctx, "snapshots/")
	if err != nil || len(snaps) != 3 || snaps[0].Path != "snapshots/snapshot-20260101-000000.tar.gz" || snaps[0].Modified.IsZero() {
		t.Fatalf("snapshots: %v %v", snaps, err)
	}
	if none, err := p.List(ctx, "absent/"); err != nil || len(none) != 0 {
		t.Fatalf("absent: %v %v", none, err)
	}
	if err = p.Delete(ctx, snaps[0].Path); err != nil {
		t.Fatal(err)
	}
	if err = p.Delete(ctx, snaps[0].Path); err != nil {
		t.Fatalf("idempotent delete: %v", err)
	}
	if err = p.Delete(ctx, "../x"); err == nil {
		t.Fatal("escape accepted")
	}
}

func TestDropboxLostFinishReplyIsVerifiedByContentHash(t *testing.T) {
	f := newFixtureDropbox(t)
	p := f.provider(f.config())
	lost := false
	f.afterStore = func(w http.ResponseWriter, op string) bool {
		if op == "files/upload_session/finish" && !lost {
			lost = true
			w.WriteHeader(http.StatusServiceUnavailable)
			return true
		}
		return false
	}
	data := driveSource(5<<20, 6)
	if _, err := p.Upload(context.Background(), "big.bin", bytes.NewReader(data), int64(len(data)), nil); err != nil || !lost {
		t.Fatalf("lost finish: %v", err)
	}
	if !bytes.Equal(f.file("/tgdl-backup/big.bin"), data) {
		t.Fatal("bytes differ")
	}
}

func TestDropboxRefreshRateLimitsAndErrors(t *testing.T) {
	f := newFixtureDropbox(t)
	p := f.provider(f.config())
	ctx := context.Background()
	if _, err := p.Upload(ctx, "a.bin", bytes.NewReader([]byte("abc")), 3, nil); err != nil {
		t.Fatal(err)
	}
	f.oauth.revokeAll()
	limited := 0
	f.hook = func(w http.ResponseWriter, r *http.Request, op string) bool {
		if op == "files/upload" && limited < 2 {
			limited++
			if limited == 1 {
				w.Header().Set("Retry-After", "0")
				dropboxFail(w, http.StatusTooManyRequests, "too_many_requests", map[string]any{"reason": map[string]any{".tag": "too_many_requests"}, "retry_after": 0})
			} else {
				dropboxFail(w, http.StatusConflict, "path/too_many_write_operations", nil)
			}
			return true
		}
		return false
	}
	if _, err := p.Upload(ctx, "b.bin", bytes.NewReader([]byte("abcd")), 4, nil); err != nil || limited != 2 || f.oauth.count() != 2 {
		t.Fatalf("refresh/backoff: %v limited=%d refreshes=%d", err, limited, f.oauth.count())
	}
	f.hook = func(w http.ResponseWriter, r *http.Request, op string) bool {
		dropboxFail(w, http.StatusConflict, "path/insufficient_space", nil)
		return true
	}
	_, err := p.Upload(ctx, "c.bin", bytes.NewReader([]byte("abc")), 3, nil)
	if err == nil || !strings.Contains(err.Error(), "path/insufficient_space (HTTP 409)") || strings.Contains(err.Error(), "private") {
		t.Fatalf("non-retriable: %v", err)
	}
	f.hook = nil
	f.oauth.reject = "invalid_grant"
	f.oauth.revokeAll()
	_, err = p.Test(ctx)
	if err == nil || !strings.Contains(err.Error(), "invalid_grant") || strings.Contains(err.Error(), "dropbox-refresh") || strings.Contains(err.Error(), "private") {
		t.Fatalf("invalid_grant: %v", err)
	}
	var ce *cloudError
	if !errors.As(err, &ce) || ce.hint == "" {
		t.Fatalf("missing hint: %v", err)
	}
}

func TestDropboxManagerMirrorAndClose(t *testing.T) {
	f := newFixtureDropbox(t)
	factory := func(_ context.Context, name string, cfg map[string]any) (Provider, error) {
		p, err := newDropboxAt(cfg, f.endpoints())
		if err == nil {
			fastRetries(p.api)
		}
		return p, err
	}
	m, db, dir := fixtureManager(t, factory)
	ctx := context.Background()
	d, err := m.Create(ctx, map[string]any{"name": "Dropbox", "provider": "dropbox", "config": f.config()})
	if err != nil {
		t.Fatal(err)
	}
	id := d["id"].(int64)
	if ok, detail, err := m.Test(ctx, id); err != nil || !ok {
		t.Fatalf("test: %v %q %v", ok, detail, err)
	}
	addSource(t, db, dir, "chat/clip.mp4", "telegram clip bytes", 9)
	waitBackup(t, m, id, 1, 0)
	if string(f.file("/tgdl-backup/chat/clip.mp4")) != "telegram clip bytes" {
		t.Fatal("mirror did not publish the file")
	}
	p, _ := newDropboxAt(f.config(), f.endpoints())
	_ = p.Close()
	if _, err = p.Test(ctx); err == nil {
		t.Fatal("closed provider accepted work")
	}
}
