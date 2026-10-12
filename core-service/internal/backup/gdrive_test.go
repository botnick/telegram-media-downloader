package backup

import (
	"bytes"
	"context"
	"crypto/md5"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

type fixtureDriveFile struct {
	id, name, parent, mime string
	data                   []byte
	props                  map[string]string
	trashed                bool
	created, modified      time.Time
}
type fixtureDriveSession struct {
	target       string // existing file for PATCH, or "" for create
	name, parent string
	size         int64
	data         []byte
}

// fixtureDrive models the Drive v3 REST surface the provider uses: files.list
// queries, folder creation, resumable sessions with 308 Resume Incomplete and
// status queries, deletes and about.get.
type fixtureDrive struct {
	t        *testing.T
	server   *httptest.Server
	oauth    *fixtureOAuth
	mu       sync.Mutex
	files    map[string]*fixtureDriveFile
	sessions map[string]*fixtureDriveSession
	next     int
	pageSize int
	clock    time.Time

	sessionStarts, chunkPuts, statusQueries, cancels, deletes, lists int
	hook                                                             func(w http.ResponseWriter, r *http.Request) bool
	afterChunk                                                       func(w http.ResponseWriter, s *fixtureDriveSession) bool
	finalize                                                         func(f *fixtureDriveFile)
}

func newFixtureDrive(t *testing.T) *fixtureDrive {
	t.Helper()
	f := &fixtureDrive{t: t, oauth: newFixtureOAuth("client.apps.googleusercontent.com", "client-secret", "refresh-secret"), files: map[string]*fixtureDriveFile{}, sessions: map[string]*fixtureDriveSession{}, pageSize: 2, clock: time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)}
	f.server = httptest.NewServer(http.HandlerFunc(f.serve))
	t.Cleanup(f.server.Close)
	return f
}
func (f *fixtureDrive) config() map[string]any {
	return map[string]any{"clientId": "client.apps.googleusercontent.com", "clientSecret": "client-secret", "refreshToken": "refresh-secret", "folderName": "tgdl-backup"}
}
func (f *fixtureDrive) endpoints() gdriveEndpoints {
	return gdriveEndpoints{token: f.server.URL + "/token", api: f.server.URL + "/drive/v3", upload: f.server.URL + "/upload/drive/v3"}
}
func (f *fixtureDrive) provider(cfg map[string]any) *gdriveProvider {
	f.t.Helper()
	p, err := newGDriveAt(cfg, f.endpoints())
	if err != nil {
		f.t.Fatal(err)
	}
	p.chunk = 256 << 10
	fastRetries(p.api)
	f.t.Cleanup(func() { _ = p.Close() })
	return p
}
func (f *fixtureDrive) id() string {
	f.next++
	return fmt.Sprintf("id_%04d", f.next)
}
func (f *fixtureDrive) tick() time.Time {
	f.clock = f.clock.Add(time.Second)
	return f.clock
}
func driveJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
func driveFail(w http.ResponseWriter, status int, reason string) {
	driveJSON(w, status, map[string]any{"error": map[string]any{"code": status, "message": "server-private-detail must not leak", "errors": []map[string]string{{"reason": reason, "message": "server-private-detail"}}}})
}
func (f *fixtureDrive) resource(file *fixtureDriveFile) map[string]any {
	out := map[string]any{"id": file.id, "name": file.name, "mimeType": file.mime, "modifiedTime": file.modified.Format(time.RFC3339Nano), "trashed": file.trashed}
	if file.mime != gdriveFolderMime {
		sha := sha256.Sum256(file.data)
		sum := md5.Sum(file.data)
		out["size"] = strconv.Itoa(len(file.data))
		out["sha256Checksum"] = hex.EncodeToString(sha[:])
		out["md5Checksum"] = hex.EncodeToString(sum[:])
	}
	return out
}

// driveQuery parses the clause grammar the provider emits.
type driveQuery struct {
	name, parent, mime string
	notMime, trashed   bool
	hasName, hasMime   bool
}

func parseDriveQuery(q string) (driveQuery, error) {
	var out driveQuery
	quoted := func(s string) (string, string, error) {
		if !strings.HasPrefix(s, "'") {
			return "", "", errors.New("expected quote")
		}
		var b strings.Builder
		for i := 1; i < len(s); i++ {
			switch s[i] {
			case '\\':
				if i+1 >= len(s) {
					return "", "", errors.New("dangling escape")
				}
				i++
				b.WriteByte(s[i])
			case '\'':
				return b.String(), s[i+1:], nil
			default:
				b.WriteByte(s[i])
			}
		}
		return "", "", errors.New("unterminated quote")
	}
	rest := q
	for rest != "" {
		var err error
		var v string
		switch {
		case strings.HasPrefix(rest, "name="):
			v, rest, err = quoted(rest[5:])
			out.name, out.hasName = v, true
		case strings.HasPrefix(rest, "mimeType!="):
			v, rest, err = quoted(rest[10:])
			out.mime, out.notMime, out.hasMime = v, true, true
		case strings.HasPrefix(rest, "mimeType="):
			v, rest, err = quoted(rest[9:])
			out.mime, out.hasMime = v, true
		case strings.HasPrefix(rest, "trashed=false"):
			rest = rest[len("trashed=false"):]
		case strings.HasPrefix(rest, "'"):
			v, rest, err = quoted(rest)
			if err == nil {
				var ok bool
				if rest, ok = strings.CutPrefix(rest, " in parents"); !ok {
					err = errors.New("expected in parents")
				}
			}
			out.parent = v
		default:
			return out, fmt.Errorf("unexpected clause %q", rest)
		}
		if err != nil {
			return out, err
		}
		if rest != "" {
			var ok bool
			if rest, ok = strings.CutPrefix(rest, " and "); !ok {
				return out, fmt.Errorf("expected and: %q", rest)
			}
		}
	}
	return out, nil
}

func (f *fixtureDrive) serve(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == "/token" {
		f.oauth.serve(w, r)
		return
	}
	if !f.oauth.authorized(r) {
		driveFail(w, http.StatusUnauthorized, "authError")
		return
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.hook != nil && f.hook(w, r) {
		return
	}
	switch {
	case r.Method == http.MethodGet && r.URL.Path == "/drive/v3/about":
		driveJSON(w, 200, map[string]any{"user": map[string]any{"emailAddress": "owner@example.com"}})
	case r.Method == http.MethodGet && r.URL.Path == "/drive/v3/files":
		f.list(w, r)
	case r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/drive/v3/files/"):
		file := f.files[strings.TrimPrefix(r.URL.Path, "/drive/v3/files/")]
		if file == nil {
			driveFail(w, 404, "notFound")
			return
		}
		driveJSON(w, 200, f.resource(file))
	case r.Method == http.MethodPost && r.URL.Path == "/drive/v3/files":
		var meta struct {
			Name          string            `json:"name"`
			MimeType      string            `json:"mimeType"`
			Parents       []string          `json:"parents"`
			AppProperties map[string]string `json:"appProperties"`
		}
		if json.NewDecoder(r.Body).Decode(&meta) != nil || meta.MimeType != gdriveFolderMime || len(meta.Parents) != 1 {
			driveFail(w, 400, "badRequest")
			return
		}
		now := f.tick()
		file := &fixtureDriveFile{id: f.id(), name: meta.Name, parent: meta.Parents[0], mime: meta.MimeType, props: meta.AppProperties, created: now, modified: now}
		f.files[file.id] = file
		driveJSON(w, 200, map[string]any{"id": file.id})
	case r.Method == http.MethodDelete && strings.HasPrefix(r.URL.Path, "/drive/v3/files/"):
		f.deletes++
		id := strings.TrimPrefix(r.URL.Path, "/drive/v3/files/")
		if f.files[id] == nil {
			driveFail(w, 404, "notFound")
			return
		}
		delete(f.files, id)
		w.WriteHeader(http.StatusNoContent)
	case (r.Method == http.MethodPost || r.Method == http.MethodPatch) && strings.HasPrefix(r.URL.Path, "/upload/drive/v3/files"):
		f.startSession(w, r)
	case strings.HasPrefix(r.URL.Path, "/upload/session/"):
		f.sessionRequest(w, r)
	default:
		driveFail(w, 404, "notFound")
	}
}

func (f *fixtureDrive) list(w http.ResponseWriter, r *http.Request) {
	f.lists++
	q, err := parseDriveQuery(r.URL.Query().Get("q"))
	if err != nil || r.URL.Query().Get("supportsAllDrives") != "true" {
		f.t.Errorf("bad files.list query %q: %v", r.URL.Query().Get("q"), err)
		driveFail(w, 400, "invalidQuery")
		return
	}
	matches := []*fixtureDriveFile{}
	for _, file := range f.files {
		if file.trashed || file.parent != q.parent || q.hasName && file.name != q.name || q.hasMime && (file.mime == q.mime) == q.notMime {
			continue
		}
		matches = append(matches, file)
	}
	sort.Slice(matches, func(i, j int) bool {
		if r.URL.Query().Get("orderBy") == "modifiedTime desc" {
			return matches[i].modified.After(matches[j].modified)
		}
		return matches[i].created.Before(matches[j].created) || matches[i].created.Equal(matches[j].created) && matches[i].id < matches[j].id
	})
	start, _ := strconv.Atoi(r.URL.Query().Get("pageToken"))
	end := min(len(matches), start+f.pageSize)
	page := []map[string]any{}
	for _, file := range matches[start:end] {
		page = append(page, f.resource(file))
	}
	out := map[string]any{"files": page}
	if end < len(matches) {
		out["nextPageToken"] = strconv.Itoa(end)
	}
	driveJSON(w, 200, out)
}

func (f *fixtureDrive) startSession(w http.ResponseWriter, r *http.Request) {
	if r.URL.Query().Get("uploadType") != "resumable" {
		driveFail(w, 400, "badRequest")
		return
	}
	var meta struct {
		Name          string            `json:"name"`
		Parents       []string          `json:"parents"`
		AppProperties map[string]string `json:"appProperties"`
	}
	size, err := strconv.ParseInt(r.Header.Get("X-Upload-Content-Length"), 10, 64)
	if json.NewDecoder(r.Body).Decode(&meta) != nil || err != nil || meta.AppProperties["tgdl-backup"] != "1" {
		driveFail(w, 400, "badRequest")
		return
	}
	s := &fixtureDriveSession{size: size}
	if r.Method == http.MethodPatch {
		s.target = strings.TrimPrefix(r.URL.Path, "/upload/drive/v3/files/")
		if f.files[s.target] == nil {
			driveFail(w, 404, "notFound")
			return
		}
	} else {
		if len(meta.Parents) != 1 || meta.Name == "" {
			driveFail(w, 400, "badRequest")
			return
		}
		s.name, s.parent = meta.Name, meta.Parents[0]
	}
	f.sessionStarts++
	id := f.id()
	f.sessions[id] = s
	w.Header().Set("Location", f.server.URL+"/upload/session/"+id+"?upload_id=capability")
	w.WriteHeader(http.StatusOK)
}

func (f *fixtureDrive) sessionRequest(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimPrefix(r.URL.Path, "/upload/session/")
	s := f.sessions[id]
	if s == nil {
		driveFail(w, 404, "notFound")
		return
	}
	if r.Method == http.MethodDelete {
		f.cancels++
		delete(f.sessions, id)
		w.WriteHeader(499)
		return
	}
	body, err := io.ReadAll(r.Body)
	if err != nil {
		return
	}
	cr := r.Header.Get("Content-Range")
	resume := func() {
		if len(s.data) > 0 {
			w.Header().Set("Range", fmt.Sprintf("bytes=0-%d", len(s.data)-1))
		}
		w.WriteHeader(http.StatusPermanentRedirect)
	}
	if total, ok := strings.CutPrefix(cr, "bytes */"); ok {
		if len(body) != 0 || total != strconv.FormatInt(s.size, 10) {
			driveFail(w, 400, "badContentRange")
			return
		}
		f.statusQueries++
		if s.size == 0 || int64(len(s.data)) == s.size {
			f.complete(w, id, s)
			return
		}
		resume()
		return
	}
	f.chunkPuts++
	var first, last, total int64
	if _, err = fmt.Sscanf(cr, "bytes %d-%d/%d", &first, &last, &total); err != nil || total != s.size || last-first+1 != int64(len(body)) || first > int64(len(s.data)) {
		driveFail(w, 400, "badContentRange")
		return
	}
	s.data = append(s.data[:first], body...)
	if f.afterChunk != nil && f.afterChunk(w, s) {
		return
	}
	if int64(len(s.data)) == s.size {
		f.complete(w, id, s)
		return
	}
	resume()
}

func (f *fixtureDrive) complete(w http.ResponseWriter, id string, s *fixtureDriveSession) {
	delete(f.sessions, id)
	now := f.tick()
	var file *fixtureDriveFile
	if s.target != "" {
		file = f.files[s.target]
		file.data, file.modified = s.data, now
	} else {
		file = &fixtureDriveFile{id: f.id(), name: s.name, parent: s.parent, mime: "application/octet-stream", data: s.data, props: map[string]string{"tgdl-backup": "1"}, created: now, modified: now}
		f.files[file.id] = file
	}
	if f.finalize != nil {
		f.finalize(file)
	}
	driveJSON(w, 200, f.resource(file))
}

func (f *fixtureDrive) byPath(p string) *fixtureDriveFile {
	f.mu.Lock()
	defer f.mu.Unlock()
	parent := "root"
	for _, segment := range strings.Split("tgdl-backup/"+p, "/") {
		var found *fixtureDriveFile
		for _, file := range f.files {
			if file.parent == parent && file.name == segment {
				found = file
			}
		}
		if found == nil {
			return nil
		}
		parent = found.id
	}
	for _, file := range f.files {
		if file.id == parent {
			return file
		}
	}
	return nil
}

func driveSource(n int, seed byte) []byte {
	b := make([]byte, n)
	for i := range b {
		b[i] = byte(i*7) ^ seed
	}
	return b
}

func TestGDriveResumableUploadResumesDedupsListsAndDeletes(t *testing.T) {
	f := newFixtureDrive(t)
	p := f.provider(f.config())
	ctx := context.Background()
	detail, err := p.Test(ctx)
	if err != nil || !strings.Contains(detail, "owner@example.com") {
		t.Fatalf("test: %q %v", detail, err)
	}
	data := driveSource(600<<10, 1)
	interrupted := false
	f.afterChunk = func(w http.ResponseWriter, s *fixtureDriveSession) bool {
		// The second chunk is stored but its reply is lost.
		if !interrupted && len(s.data) == 512<<10 {
			interrupted = true
			driveFail(w, http.StatusServiceUnavailable, "backendError")
			return true
		}
		return false
	}
	name := "group/it's ไทย/movie.bin"
	var seen []int64
	res, err := p.Upload(ctx, name, bytes.NewReader(data), int64(len(data)), func(n int64) { seen = append(seen, n) })
	if err != nil || res.Skipped || res.Bytes != int64(len(data)) {
		t.Fatalf("upload: %+v %v", res, err)
	}
	stored := f.byPath(name)
	if stored == nil || !bytes.Equal(stored.data, data) || stored.props["tgdl-backup"] != "1" {
		t.Fatal("resumed upload did not publish exact bytes")
	}
	if f.statusQueries != 1 || f.chunkPuts != 3 || !interrupted {
		t.Fatalf("resume protocol: status=%d chunks=%d", f.statusQueries, f.chunkPuts)
	}
	for i := 1; i < len(seen); i++ {
		if seen[i] < seen[i-1] || seen[i] > int64(len(data)) {
			t.Fatalf("progress not monotonic/bounded: %v", seen)
		}
	}
	if folder := f.byPath("group"); folder == nil || folder.props["tgdl-backup"] != "1" {
		t.Fatal("intermediate folder missing its app stamp")
	}
	// Identical bytes are recognised by Drive's own sha256Checksum.
	starts := f.sessionStarts
	if res, err = p.Upload(ctx, name, bytes.NewReader(data), int64(len(data)), nil); err != nil || !res.Skipped || f.sessionStarts != starts {
		t.Fatalf("dedup: %+v %v", res, err)
	}
	// Same size, different bytes: replace the existing file in place.
	changed := driveSource(600<<10, 2)
	fresh := f.provider(f.config())
	if res, err = fresh.Upload(ctx, name, bytes.NewReader(changed), int64(len(changed)), nil); err != nil || res.Skipped {
		t.Fatalf("replace: %+v %v", res, err)
	}
	if again := f.byPath(name); again == nil || again.id != stored.id || !bytes.Equal(again.data, changed) {
		t.Fatal("same-size change was not uploaded as a new revision of the same file")
	}
	for i := range 3 {
		snap := fmt.Sprintf("snapshots/snapshot-20260101-00000%d.tar.gz", i)
		if _, err = p.Upload(ctx, snap, bytes.NewReader([]byte{byte(i)}), 1, nil); err != nil {
			t.Fatal(err)
		}
	}
	if _, err = p.Upload(ctx, "empty.txt", bytes.NewReader(nil), 0, nil); err != nil {
		t.Fatalf("empty upload: %v", err)
	}
	p.mu.Lock()
	rootID := p.folders[""]
	p.mu.Unlock()
	f.mu.Lock()
	for _, odd := range []string{"..", "a/b"} {
		id := f.id()
		f.files[id] = &fixtureDriveFile{id: id, name: odd, parent: rootID, mime: "text/plain", data: []byte("x"), created: f.tick(), modified: f.clock}
	}
	f.mu.Unlock()
	all, err := fresh.List(ctx, "")
	if err != nil || len(all) != 5 {
		t.Fatalf("list all: %v %v", all, err)
	}
	snaps, err := fresh.List(ctx, "snapshots/")
	if err != nil || len(snaps) != 3 || snaps[0].Size != 1 || snaps[0].Modified.IsZero() {
		t.Fatalf("list snapshots: %v %v", snaps, err)
	}
	if missing, err := p.List(ctx, "nothing/here/"); err != nil || len(missing) != 0 {
		t.Fatalf("missing prefix: %v %v", missing, err)
	}
	if err = p.Delete(ctx, snaps[0].Path); err != nil {
		t.Fatal(err)
	}
	if err = p.Delete(ctx, snaps[0].Path); err != nil {
		t.Fatalf("idempotent delete: %v", err)
	}
	if err = p.Delete(ctx, "never/existed.bin"); err != nil {
		t.Fatalf("delete under missing folder: %v", err)
	}
	if rest, _ := p.List(ctx, "snapshots/"); len(rest) != 2 {
		t.Fatalf("after delete: %v", rest)
	}
	if err = p.Delete(ctx, "../escape"); err == nil {
		t.Fatal("path escape accepted")
	}
}

func TestGDriveRefreshesTokenAndBacksOffOnRateLimits(t *testing.T) {
	f := newFixtureDrive(t)
	p := f.provider(f.config())
	ctx := context.Background()
	if _, err := p.Test(ctx); err != nil {
		t.Fatal(err)
	}
	f.oauth.revokeAll() // the cached access token is now rejected with 401
	limited := 0
	f.hook = func(w http.ResponseWriter, r *http.Request) bool {
		if r.URL.Path == "/drive/v3/files" && r.Method == http.MethodGet && limited < 3 {
			limited++
			switch limited {
			case 1:
				w.Header().Set("Retry-After", "0")
				driveFail(w, http.StatusTooManyRequests, "rateLimitExceeded")
			case 2:
				driveFail(w, http.StatusForbidden, "userRateLimitExceeded")
			default:
				driveFail(w, http.StatusInternalServerError, "backendError")
			}
			return true
		}
		return false
	}
	if _, err := p.Upload(ctx, "a.bin", bytes.NewReader([]byte("abc")), 3, nil); err != nil {
		t.Fatalf("upload after refresh/backoff: %v", err)
	}
	if f.oauth.count() != 2 || limited != 3 {
		t.Fatalf("refreshes=%d limited=%d", f.oauth.count(), limited)
	}
	f.hook = func(w http.ResponseWriter, r *http.Request) bool {
		driveFail(w, http.StatusForbidden, "storageQuotaExceeded")
		return true
	}
	_, err := p.Upload(ctx, "b.bin", bytes.NewReader([]byte("abc")), 3, nil)
	if err == nil || !strings.Contains(err.Error(), "storageQuotaExceeded (HTTP 403)") || strings.Contains(err.Error(), "private") {
		t.Fatalf("non-retriable 403: %v", err)
	}
	f.hook = func(w http.ResponseWriter, r *http.Request) bool {
		w.Header().Set("Retry-After", "3600")
		driveFail(w, http.StatusTooManyRequests, "rateLimitExceeded")
		return true
	}
	start := time.Now()
	if _, err = p.Upload(ctx, "c.bin", bytes.NewReader([]byte("abc")), 3, nil); err == nil || time.Since(start) > 5*time.Second {
		t.Fatalf("an excessive Retry-After must return to the durable queue: %v", err)
	}
}

func TestGDriveRejectedRefreshTokenIsExplainedWithoutSecrets(t *testing.T) {
	f := newFixtureDrive(t)
	f.oauth.reject = "invalid_grant"
	p := f.provider(f.config())
	_, err := p.Test(context.Background())
	if err == nil || !strings.Contains(err.Error(), "invalid_grant") || !strings.Contains(err.Error(), "expired or revoked") || strings.Contains(err.Error(), "refresh-secret") || strings.Contains(err.Error(), "private") {
		t.Fatalf("invalid_grant: %v", err)
	}
	for _, cfg := range []map[string]any{
		{"clientId": "x", "clientSecret": "y"},
		{"clientId": "x", "clientSecret": "y", "refreshToken": "z", "folderId": "bad' or 1=1"},
		{"clientId": "x", "clientSecret": "y", "refreshToken": "z", "folderName": "a/b"},
	} {
		if _, err := newGDrive(cfg); err == nil {
			t.Fatalf("accepted invalid config %v", cfg)
		}
	}
}

func TestGDriveConfiguredFolderIDAndExpiredSession(t *testing.T) {
	f := newFixtureDrive(t)
	f.mu.Lock()
	f.files["existingFolder_1"] = &fixtureDriveFile{id: "existingFolder_1", name: "chosen", parent: "root", mime: gdriveFolderMime, created: f.tick(), modified: f.clock}
	f.files["trashedFolder_1"] = &fixtureDriveFile{id: "trashedFolder_1", name: "old", parent: "root", mime: gdriveFolderMime, trashed: true}
	f.mu.Unlock()
	cfg := f.config()
	cfg["folderId"] = "trashedFolder_1"
	if _, err := f.provider(cfg).Test(context.Background()); err == nil {
		t.Fatal("trashed folder accepted")
	}
	cfg["folderId"] = "existingFolder_1"
	p := f.provider(cfg)
	expired := false
	f.afterChunk = func(w http.ResponseWriter, s *fixtureDriveSession) bool {
		if !expired {
			expired = true
			driveFail(w, http.StatusNotFound, "notFound")
			return true
		}
		return false
	}
	if _, err := p.Upload(context.Background(), "x/y.bin", bytes.NewReader([]byte("payload")), 7, nil); err != nil {
		t.Fatalf("restart after expired session: %v", err)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.sessionStarts != 2 {
		t.Fatalf("session starts: %d", f.sessionStarts)
	}
	for _, file := range f.files {
		if file.name == "tgdl-backup" {
			t.Fatal("folderName was created although folderId is configured")
		}
	}
}

func TestGDriveChecksumMismatchRemovesNewFileAndCancelStopsSession(t *testing.T) {
	f := newFixtureDrive(t)
	p := f.provider(f.config())
	f.finalize = func(file *fixtureDriveFile) { file.data = append([]byte(nil), file.data...); file.data[0] ^= 0xff }
	if _, err := p.Upload(context.Background(), "bad.bin", bytes.NewReader([]byte("payload")), 7, nil); err == nil || !strings.Contains(err.Error(), "checksum") {
		t.Fatalf("corrupt upload accepted: %v", err)
	}
	if f.byPath("bad.bin") != nil {
		t.Fatal("corrupt new file was left published")
	}
	f.finalize = nil
	ctx, cancel := context.WithCancel(context.Background())
	f.afterChunk = func(w http.ResponseWriter, s *fixtureDriveSession) bool { cancel(); return false }
	data := driveSource(600<<10, 3)
	if _, err := p.Upload(ctx, "cancel.bin", bytes.NewReader(data), int64(len(data)), nil); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancel: %v", err)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.cancels != 1 || len(f.sessions) != 0 {
		t.Fatalf("session was not cancelled: %d %d", f.cancels, len(f.sessions))
	}
}

func TestGDriveManagerMirrorAndConnectionTest(t *testing.T) {
	f := newFixtureDrive(t)
	factory := func(_ context.Context, name string, cfg map[string]any) (Provider, error) {
		if name != "gdrive" {
			return nil, errors.New("unexpected provider")
		}
		p, err := newGDriveAt(cfg, f.endpoints())
		if err == nil {
			fastRetries(p.api)
		}
		return p, err
	}
	m, db, dir := fixtureManager(t, factory)
	ctx := context.Background()
	d, err := m.Create(ctx, map[string]any{"name": "Drive", "provider": "gdrive", "config": f.config()})
	if err != nil {
		t.Fatal(err)
	}
	id := d["id"].(int64)
	ok, detail, err := m.Test(ctx, id)
	if err != nil || !ok || !strings.Contains(detail, "Authorised as owner@example.com") {
		t.Fatalf("connection test: %v %q %v", ok, detail, err)
	}
	public, err := m.Config(ctx, id)
	if err != nil || public["clientSecret"] != nil || public["refreshToken"] != nil || public["clientId"] != "client.apps.googleusercontent.com" {
		t.Fatalf("config redaction: %v %v", public, err)
	}
	addSource(t, db, dir, "chat/photo.jpg", "telegram photo bytes", 7)
	waitBackup(t, m, id, 1, 0)
	if file := f.byPath("chat/photo.jpg"); file == nil || string(file.data) != "telegram photo bytes" {
		t.Fatal("mirror did not publish the file")
	}
}
