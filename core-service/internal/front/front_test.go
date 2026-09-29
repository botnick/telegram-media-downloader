package front

import (
	"bufio"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

const (
	tokAdmin   = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	tokGuest   = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	tokRenew   = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
	tokExpired = "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
	secretHex  = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90"
)

var testMtime = time.Date(2024, 5, 6, 7, 8, 9, 123_600_000, time.UTC)

const fakeNodeRaw = "X-Fake-Node-Raw"

type upstreamCall struct {
	method, uri, host string
	header            http.Header
}

type harness struct {
	t         *testing.T
	root      string
	downloads string
	photos    string
	thumbs    string
	outside   string
	front     *Server
	srv       *httptest.Server
	upstream  *httptest.Server

	mu    sync.Mutex
	calls []upstreamCall
	reply func(w http.ResponseWriter, r *http.Request)
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	root := t.TempDir()
	h := &harness{
		t:         t,
		root:      root,
		downloads: filepath.Join(root, "downloads"),
		photos:    filepath.Join(root, "photos"),
		thumbs:    filepath.Join(root, "thumbs"),
		outside:   filepath.Join(root, "outside"),
	}
	for _, d := range []string{h.downloads, h.photos, h.thumbs, h.outside} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	h.put(h.downloads, "G1/videos/clip.mp4", pattern(10000))
	h.put(h.downloads, "G1/docs/.hidden", []byte("x"))
	h.put(h.photos, "-100123.jpg", []byte("jpegbytes"))
	h.put(h.thumbs, thumbName(1), []byte("RIFFwebpbytes"))
	h.put(h.outside, "secret.txt", []byte("secret"))

	db := filepath.Join(root, "db.sqlite")
	h.seedSessions(db)

	// The fake Node takes any request target, as Node's parser does.
	h.upstream = httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		uri := r.RequestURI
		if raw := r.Header.Get(fakeNodeRaw); raw != "" {
			uri = raw
			r.Header.Del(fakeNodeRaw)
		}
		h.mu.Lock()
		h.calls = append(h.calls, upstreamCall{r.Method, uri, r.Host, r.Header.Clone()})
		reply := h.reply
		h.mu.Unlock()
		if reply != nil {
			reply(w, r)
			return
		}
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		fmt.Fprint(w, "from node")
	}))
	h.upstream.Listener = &rawTargetListener{Listener: h.upstream.Listener, header: fakeNodeRaw}
	h.upstream.Start()
	t.Cleanup(h.upstream.Close)

	cfg := Config{
		Token:         "ctl",
		Listen:        "127.0.0.1:0",
		Upstream:      strings.TrimPrefix(h.upstream.URL, "http://"),
		UpstreamToken: "front-token",
		TrustProxy:    "loopback",
		DBPath:        db,
		DownloadsDir:  h.downloads,
		PhotosDir:     h.photos,
		ThumbsDir:     h.thumbs,
		AllowRoots:    []string{h.downloads, h.photos, h.thumbs},
	}
	h.front = New(cfg, slog.New(slog.NewTextHandler(io.Discard, nil)))
	h.setState(State{AuthReady: true, ShareSecret: secretHex})
	h.srv = httptest.NewServer(h.front)
	t.Cleanup(func() {
		h.srv.Close()
		h.front.sessions.close()
	})
	return h
}

func pattern(n int) []byte {
	b := make([]byte, n)
	for i := range b {
		b[i] = byte(i * 31 % 251)
	}
	return b
}

func thumbName(id int) string {
	sum := sha256Hex(strconv.Itoa(id) + ":320")
	return sum[:32] + ".webp"
}

func (h *harness) put(dir, rel string, data []byte) string {
	p := filepath.Join(dir, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		h.t.Fatal(err)
	}
	if err := os.WriteFile(p, data, 0o644); err != nil {
		h.t.Fatal(err)
	}
	if err := os.Chtimes(p, testMtime, testMtime); err != nil {
		h.t.Fatal(err)
	}
	return p
}

func (h *harness) seedSessions(path string) {
	db, err := sql.Open("sqlite", path)
	if err != nil {
		h.t.Fatal(err)
	}
	defer db.Close()
	now := time.Now().UnixMilli()
	day := int64(24 * time.Hour / time.Millisecond)
	stmts := []string{
		`PRAGMA journal_mode=WAL`,
		`CREATE TABLE web_sessions (token TEXT PRIMARY KEY, role TEXT NOT NULL, issued_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, last_seen INTEGER NOT NULL)`,
		fmt.Sprintf(`INSERT INTO web_sessions VALUES ('%s','admin',%d,%d,%d)`, tokAdmin, now-day, now+29*day, now),
		fmt.Sprintf(`INSERT INTO web_sessions VALUES ('%s','guest',%d,%d,%d)`, tokGuest, now-day, now+29*day, now),
		fmt.Sprintf(`INSERT INTO web_sessions VALUES ('%s','admin',%d,%d,%d)`, tokRenew, now-29*day, now+day, now),
		fmt.Sprintf(`INSERT INTO web_sessions VALUES ('%s','admin',%d,%d,%d)`, tokExpired, now-31*day, now-day, now),
	}
	for _, s := range stmts {
		if _, err := db.Exec(s); err != nil {
			h.t.Fatal(s, err)
		}
	}
}

func (h *harness) setState(st State) {
	if st.ShareSecret != "" {
		st.secret, _ = hex.DecodeString(st.ShareSecret)
	}
	if st.Headers == nil {
		st.Headers = testHeaders(st.ForceHTTPS)
	}
	h.front.state.Store(&st)
}

// Stand-ins for what Node pushes (captured from its own middlewares).
const (
	testFilesCC  = "private, max-age=2592000, immutable"
	testPhotosCC = "private, max-age=86400"
	testThumbCC  = "private, max-age=3600"
)

func testHeaders(forceHTTPS bool) map[string][][2]string {
	hsts, csp := "max-age=0", "default-src 'self'"
	if forceHTTPS {
		hsts, csp = "max-age=31536000; includeSubDomains", csp+";upgrade-insecure-requests"
	}
	with := func(extra ...[2]string) [][2]string {
		return append([][2]string{{"Strict-Transport-Security", hsts}, {"Content-Security-Policy", csp}, {"X-DNS-Prefetch-Control", "off"}}, extra...)
	}
	return map[string][][2]string{
		"files":  with([2]string{"Cache-Control", testFilesCC}),
		"photos": with([2]string{"Cache-Control", testPhotosCC}),
		"thumbs": with([2]string{"Cache-Control", testThumbCC}, [2]string{"Pragma", "no-cache"}, [2]string{"Vary", "Cookie"}),
	}
}

func (h *harness) upstreamCalls() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.calls)
}

func (h *harness) lastCall() upstreamCall {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.calls[len(h.calls)-1]
}

func (h *harness) do(method, target string, hdr map[string]string) (*http.Response, []byte) {
	h.t.Helper()
	req, err := http.NewRequest(method, h.srv.URL+target, nil)
	if err != nil {
		h.t.Fatal(err)
	}
	for k, v := range hdr {
		if strings.EqualFold(k, "Host") {
			req.Host = v
			continue
		}
		req.Header.Set(k, v)
	}
	res, err := http.DefaultTransport.RoundTrip(req)
	if err != nil {
		h.t.Fatal(err)
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(res.Body)
	return res, body
}

func cookie(tok string) map[string]string { return map[string]string{"Cookie": "tg_dl_session=" + tok} }

// ---- fast path --------------------------------------------------------------

func TestFastFile(t *testing.T) {
	h := newHarness(t)
	res, body := h.do("GET", "/files/G1/videos/clip.mp4?inline=1", cookie(tokAdmin))
	if h.upstreamCalls() != 0 {
		t.Fatal("request reached Node")
	}
	if res.StatusCode != 200 || len(body) != 10000 {
		t.Fatalf("status %d, %d bytes", res.StatusCode, len(body))
	}
	lm, ms := sendTimes(testMtime)
	want := map[string]string{
		"Strict-Transport-Security": "max-age=0",
		"Content-Security-Policy":   "default-src 'self'",
		"X-DNS-Prefetch-Control":    "off",
		"Cache-Control":             testFilesCC,
		"Content-Disposition":       `inline; filename="clip.mp4"; filename*=UTF-8''clip.mp4`,
		"Accept-Ranges":             "bytes",
		"Last-Modified":             lm,
		"ETag":                      statETag(10000, ms),
		"Content-Type":              "video/mp4",
		"Content-Length":            "10000",
		"Connection":                "keep-alive",
		"Keep-Alive":                "timeout=65",
	}
	for k, v := range want {
		if got := res.Header.Get(k); got != v {
			t.Errorf("%s = %q, want %q", k, got, v)
		}
	}
	// Node's spelling, not Go's canonical form.
	if _, ok := res.Header["X-DNS-Prefetch-Control"]; !ok {
		// net/http's client canonicalises on read; check the raw wire instead.
		raw := rawGet(t, h.srv.URL, "/files/G1/videos/clip.mp4", "Cookie: tg_dl_session="+tokAdmin)
		for _, name := range []string{"\r\nETag: ", "\r\nX-DNS-Prefetch-Control: "} {
			if !strings.Contains(raw, name) {
				t.Errorf("response lacks %q spelling:\n%s", name, raw)
			}
		}
	}
	// ms rounding: 123.6 ms rounds up, as fs.Stats#mtime does.
	if ms%1000 != 124 {
		t.Errorf("mtime ms %d, want …124 (Math.round)", ms)
	}
}

func rawGet(t *testing.T, base, path, extra string) string {
	t.Helper()
	u, _ := url.Parse(base)
	c, err := net.Dial("tcp", u.Host)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	fmt.Fprintf(c, "GET %s HTTP/1.1\r\nHost: x\r\n%s\r\nConnection: close\r\n\r\n", path, extra)
	b, _ := io.ReadAll(c)
	s := string(b)
	if i := strings.Index(s, "\r\n\r\n"); i >= 0 {
		s = s[:i+2]
	}
	return s
}

func TestFastFileRanges(t *testing.T) {
	h := newHarness(t)
	c := cookie(tokAdmin)
	for _, tc := range []struct {
		rng, want string
		status    int
		n         int
	}{
		{"bytes=0-99", "bytes 0-99/10000", 206, 100},
		{"bytes=-500", "bytes 9500-9999/10000", 206, 500},
		{"bytes=9990-", "bytes 9990-9999/10000", 206, 10},
		{"bytes=0-1,5-9", "", 200, 10000},
		{"bytes=0-99,100-199", "bytes 0-199/10000", 206, 200},
		{"items=0-5", "", 200, 10000},
	} {
		hdr := map[string]string{"Cookie": c["Cookie"], "Range": tc.rng}
		res, body := h.do("GET", "/files/G1/videos/clip.mp4", hdr)
		if res.StatusCode != tc.status || res.Header.Get("Content-Range") != tc.want || len(body) != tc.n {
			t.Errorf("%s: %d %q %d bytes", tc.rng, res.StatusCode, res.Header.Get("Content-Range"), len(body))
		}
		if tc.status == 206 {
			start, _ := strconv.Atoi(strings.Split(strings.TrimPrefix(tc.want, "bytes "), "-")[0])
			if string(body) != string(pattern(10000)[start:start+tc.n]) {
				t.Errorf("%s: wrong bytes", tc.rng)
			}
		}
	}
	if h.upstreamCalls() != 0 {
		t.Fatal("request reached Node")
	}
	// Unsatisfiable (Node's error handler answers) and If-Match: Node.
	h.do("GET", "/files/G1/videos/clip.mp4", map[string]string{"Cookie": c["Cookie"], "Range": "bytes=99999-"})
	h.do("GET", "/files/G1/videos/clip.mp4", map[string]string{"Cookie": c["Cookie"], "If-Match": `"x"`})
	if h.upstreamCalls() != 2 {
		t.Fatalf("416 / 412 cases: %d upstream calls, want 2", h.upstreamCalls())
	}
}

func TestFastFileHeadAnd304(t *testing.T) {
	h := newHarness(t)
	c := cookie(tokAdmin)["Cookie"]
	res, body := h.do("HEAD", "/files/G1/videos/clip.mp4", map[string]string{"Cookie": c})
	if res.StatusCode != 200 || len(body) != 0 || res.Header.Get("Content-Length") != "10000" {
		t.Errorf("HEAD: %d len %d CL %q", res.StatusCode, len(body), res.Header.Get("Content-Length"))
	}
	_, ms := sendTimes(testMtime)
	res, _ = h.do("GET", "/files/G1/videos/clip.mp4", map[string]string{"Cookie": c, "If-None-Match": statETag(10000, ms)})
	if res.StatusCode != 304 || res.Header.Get("Content-Type") != "" || res.Header.Get("ETag") == "" {
		t.Errorf("304: %d type %q", res.StatusCode, res.Header.Get("Content-Type"))
	}
	if h.upstreamCalls() != 0 {
		t.Fatal("request reached Node")
	}
}

func TestAuthDecisions(t *testing.T) {
	h := newHarness(t)
	secret, _ := hex.DecodeString(secretHex)
	exp := strconv.FormatInt(time.Now().Unix()+600, 10)
	good := exp + "." + fileTokenSig(secret, "filetoken:guest|"+exp)
	for _, tc := range []struct {
		name   string
		target string
		hdr    map[string]string
		fast   bool
	}{
		{"admin cookie", "/files/G1/videos/clip.mp4", cookie(tokAdmin), true},
		{"guest cookie", "/files/G1/videos/clip.mp4", cookie(tokGuest), true},
		{"file token", "/files/G1/videos/clip.mp4?token=" + url.QueryEscape(good), nil, true},
		{"no auth", "/files/G1/videos/clip.mp4", nil, false},
		{"renewal window", "/files/G1/videos/clip.mp4", cookie(tokRenew), false},
		{"expired", "/files/G1/videos/clip.mp4", cookie(tokExpired), false},
		{"unknown token", "/files/G1/videos/clip.mp4", cookie(strings.Repeat("e", 64)), false},
		{"escaped cookie", "/files/G1/videos/clip.mp4", map[string]string{"Cookie": "tg_dl_session=%61" + tokAdmin[1:]}, false},
		{"bad file token", "/files/G1/videos/clip.mp4?token=" + exp + ".nope", nil, false},
		{"token twice", "/files/G1/videos/clip.mp4?token=" + url.QueryEscape(good) + "&token=x", nil, false},
		{"peer", "/files/G1/videos/clip.mp4?peer=x", cookie(tokAdmin), false},
		{"clusterref", "/files/_clusterref/p/1", cookie(tokAdmin), false},
		{"dotfile", "/files/G1/docs/.hidden", cookie(tokAdmin), false},
		{"traversal", "/files/G1/..%2F..%2Fdb.sqlite", cookie(tokAdmin), false},
		{"missing (Node prunes)", "/files/G1/videos/gone.mp4", cookie(tokAdmin), false},
		{"directory", "/files/G1", cookie(tokAdmin), false},
		{"heic inline", "/files/G1/x.heic?inline=1", cookie(tokAdmin), false},
		{"legacy prefix", "/files/data/downloads/G1/videos/clip.mp4", cookie(tokAdmin), false},
		{"upper-case prefix", "/FILES/G1/videos/clip.mp4", cookie(tokAdmin), false},
		{"POST", "/files/G1/videos/clip.mp4", cookie(tokAdmin), false},
	} {
		before := h.upstreamCalls()
		method := "GET"
		if tc.name == "POST" {
			method = "POST"
		}
		h.do(method, tc.target, tc.hdr)
		proxied := h.upstreamCalls() > before
		if proxied == tc.fast {
			t.Errorf("%s: proxied=%v, want fast=%v", tc.name, proxied, tc.fast)
		}
	}
}

func TestNoFastPathWithoutState(t *testing.T) {
	h := newHarness(t)
	h.front.state.Store(nil)
	h.do("GET", "/files/G1/videos/clip.mp4", cookie(tokAdmin))
	h.setState(State{AuthReady: false, ShareSecret: secretHex})
	h.do("GET", "/files/G1/videos/clip.mp4", cookie(tokAdmin))
	if h.upstreamCalls() != 2 {
		t.Fatalf("%d upstream calls, want 2", h.upstreamCalls())
	}
}

func TestForceHTTPS(t *testing.T) {
	h := newHarness(t)
	h.setState(State{AuthReady: true, ForceHTTPS: true, ShareSecret: secretHex})
	h.do("GET", "/files/G1/videos/clip.mp4", cookie(tokAdmin))
	if h.upstreamCalls() != 1 {
		t.Fatal("plain HTTP with forceHttps must go to Node")
	}
	res, _ := h.do("GET", "/files/G1/videos/clip.mp4", map[string]string{"Cookie": cookie(tokAdmin)["Cookie"], "X-Forwarded-Proto": "https"})
	if h.upstreamCalls() != 1 {
		t.Fatal("secure request should be answered by the front server")
	}
	if res.Header.Get("Strict-Transport-Security") != "max-age=31536000; includeSubDomains" ||
		res.Header.Get("Content-Security-Policy") != "default-src 'self';upgrade-insecure-requests" {
		t.Errorf("secure headers: %v", res.Header)
	}
}

// Headers are Node's: a route it pushed none for is never answered here.
func TestNoPushedHeadersProxies(t *testing.T) {
	h := newHarness(t)
	h.setState(State{AuthReady: true, ShareSecret: secretHex, Headers: map[string][][2]string{}})
	h.do("GET", "/files/G1/videos/clip.mp4", cookie(tokAdmin))
	h.do("GET", "/photos/-100123.jpg", cookie(tokAdmin))
	h.do("GET", "/api/thumbs/1", cookie(tokAdmin))
	if h.upstreamCalls() != 3 {
		t.Fatalf("%d of 3 requests reached Node", h.upstreamCalls())
	}
}

func TestPhotosAndThumbs(t *testing.T) {
	h := newHarness(t)
	c := cookie(tokGuest)["Cookie"]
	res, body := h.do("GET", "/photos/-100123.jpg", map[string]string{"Cookie": c})
	if res.StatusCode != 200 || string(body) != "jpegbytes" || res.Header.Get("Cache-Control") != testPhotosCC ||
		res.Header.Get("Content-Type") != "image/jpeg" {
		t.Errorf("photo: %d %q %v", res.StatusCode, body, res.Header)
	}
	res, body = h.do("GET", "/api/thumbs/1", map[string]string{"Cookie": c})
	ms := statMtimeMs(testMtime)
	etag := fmt.Sprintf(`"thumb-1-320-%d"`, int64(ms))
	if res.StatusCode != 200 || string(body) != "RIFFwebpbytes" || res.Header.Get("ETag") != etag ||
		res.Header.Get("Content-Type") != "image/webp" || res.Header.Get("Cache-Control") != testThumbCC ||
		res.Header.Get("Pragma") != "no-cache" || res.Header.Get("Vary") != "Cookie" ||
		res.Header.Get("Last-Modified") != utcString(int64(ms)) {
		t.Errorf("thumb: %d %v", res.StatusCode, res.Header)
	}
	res, _ = h.do("GET", "/api/thumbs/1", map[string]string{"Cookie": c, "If-None-Match": etag})
	// Node's thumbnail route keeps its Content-Type on the 304.
	if res.StatusCode != 304 || res.Header.Get("Accept-Ranges") != "" || res.Header.Get("Content-Type") != "image/webp" {
		t.Errorf("thumb 304: %d %v", res.StatusCode, res.Header)
	}
	if h.upstreamCalls() != 0 {
		t.Fatal("request reached Node")
	}
	h.do("GET", "/photos/nope.jpg", map[string]string{"Cookie": c})
	h.do("GET", "/api/thumbs/2", map[string]string{"Cookie": c})
	h.do("GET", "/api/thumbs/abc", map[string]string{"Cookie": c})
	h.setState(State{AuthReady: true, RateLimit: true, ShareSecret: secretHex})
	h.do("GET", "/api/thumbs/1", map[string]string{"Cookie": c})
	if h.upstreamCalls() != 4 {
		t.Fatalf("misses / bad id / rate limit: %d upstream calls, want 4", h.upstreamCalls())
	}
}

// ---- proxying ---------------------------------------------------------------

func TestProxyForwardsClientView(t *testing.T) {
	h := newHarness(t)
	res, body := h.do("GET", "/api/x?a=1%2Fb", map[string]string{
		"Host":               "dash.example:8443",
		"X-Forwarded-For":    "203.0.113.9",
		"X-Forwarded-Proto":  "https",
		"X-Tgdl-Client-Addr": "127.0.0.1",
		"X-Tgdl-Front":       "guess",
	})
	if res.StatusCode != 200 || string(body) != "from node" {
		t.Fatalf("%d %q", res.StatusCode, body)
	}
	c := h.lastCall()
	if c.uri != "/api/x?a=1%2Fb" || c.host != "dash.example:8443" {
		t.Errorf("target %q host %q", c.uri, c.host)
	}
	if got := c.header.Get("X-Tgdl-Front"); got != "front-token" {
		t.Errorf("X-Tgdl-Front %q", got)
	}
	if got := c.header.Values("X-Tgdl-Client-Addr"); len(got) != 1 || got[0] != "127.0.0.1" {
		t.Errorf("X-Tgdl-Client-Addr %v", got)
	}
	if c.header.Get("X-Forwarded-For") != "203.0.113.9" || c.header.Get("X-Forwarded-Proto") != "https" {
		t.Errorf("X-Forwarded-* not passed through: %v", c.header)
	}
	if res.Header.Get("Connection") != "keep-alive" || res.Header.Get("Keep-Alive") != "timeout=65" {
		t.Errorf("connection headers: %v", res.Header)
	}
}

func TestAccel(t *testing.T) {
	h := newHarness(t)
	target := filepath.Join(h.downloads, "G1", "videos", "clip.mp4")
	h.reply = func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "video/mp4")
		w.Header().Set("ETag", `W/"x"`)
		w.Header().Set(hdrAccel, url.PathEscape(target))
		w.Header().Set(hdrAccelRange, "10-20")
		w.Header().Set("Content-Range", "bytes 10-29/10000")
		w.WriteHeader(206)
	}
	res, body := h.do("GET", "/share/1?s=x", nil)
	if res.StatusCode != 206 || string(body) != string(pattern(10000)[10:30]) || res.Header.Get("Content-Length") != "20" {
		t.Fatalf("accel: %d %d bytes %v", res.StatusCode, len(body), res.Header)
	}
	for k := range res.Header {
		if strings.HasPrefix(strings.ToLower(k), "x-tgdl") {
			t.Errorf("private header leaked: %s", k)
		}
	}
	// Outside the allowed roots: refused.
	outside := filepath.Join(h.outside, "secret.txt")
	h.reply = func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set(hdrAccel, url.PathEscape(outside))
		w.Header().Set(hdrAccelRange, "0-6")
		w.WriteHeader(200)
	}
	res, body = h.do("GET", "/share/2?s=x", nil)
	if res.StatusCode != 500 || strings.Contains(string(body), "secret") {
		t.Fatalf("outside root: %d %q", res.StatusCode, body)
	}
	// Past the end of the file: refused.
	h.reply = func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set(hdrAccel, url.PathEscape(target))
		w.Header().Set(hdrAccelRange, "9990-100")
		w.WriteHeader(200)
	}
	if res, _ = h.do("GET", "/share/3?s=x", nil); res.StatusCode != 500 {
		t.Fatalf("range past EOF: %d", res.StatusCode)
	}
}

func TestSymlinkNotFastPath(t *testing.T) {
	h := newHarness(t)
	link := filepath.Join(h.downloads, "G1", "link.txt")
	if err := os.Symlink(filepath.Join(h.outside, "secret.txt"), link); err != nil {
		t.Skip("symlinks unavailable:", err)
	}
	h.do("GET", "/files/G1/link.txt", cookie(tokAdmin))
	if h.upstreamCalls() != 1 {
		t.Fatal("a symlink must be left to Node")
	}
}

func TestUpgradeTunnelIsByteExact(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	gotHead := make(chan string, 1)
	go func() {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		defer c.Close()
		br := bufio.NewReader(c)
		var head strings.Builder
		for {
			line, err := br.ReadString('\n')
			head.WriteString(line)
			if err != nil || line == "\r\n" {
				break
			}
		}
		gotHead <- head.String()
		_, _ = io.WriteString(c, "HTTP/1.1 401 Unauthorized\r\n\r\n")
	}()
	s := New(Config{Upstream: ln.Addr().String(), UpstreamToken: "tok"}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	srv := httptest.NewServer(s)
	defer srv.Close()
	u, _ := url.Parse(srv.URL)
	c, err := net.Dial("tcp", u.Host)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	fmt.Fprint(c, "GET /ws HTTP/1.1\r\nHost: dash\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nX-Tgdl-Front: forged\r\nSec-WebSocket-Key: x\r\n\r\n")
	_ = c.SetDeadline(time.Now().Add(5 * time.Second))
	b, _ := io.ReadAll(c)
	if string(b) != "HTTP/1.1 401 Unauthorized\r\n\r\n" {
		t.Fatalf("client got %q", b)
	}
	head := <-gotHead
	if !strings.Contains(head, "X-Tgdl-Front: tok\r\n") || strings.Contains(head, "forged") ||
		!strings.Contains(head, "X-Tgdl-Client-Addr: 127.0.0.1\r\n") || !strings.HasPrefix(head, "GET /ws HTTP/1.1\r\nHost: dash\r\n") {
		t.Fatalf("upstream got:\n%s", head)
	}
}

// ---- pieces -----------------------------------------------------------------

func TestSessionStoreIsReadOnly(t *testing.T) {
	h := newHarness(t)
	sess, found, err := h.front.sessions.lookup(context.Background(), tokGuest)
	if err != nil || !found || sess.role != "guest" {
		t.Fatalf("lookup: %v %v %v", sess, found, err)
	}
	h.front.sessions.mu.Lock()
	db := h.front.sessions.db
	h.front.sessions.mu.Unlock()
	if _, err := db.Exec(`DELETE FROM web_sessions`); err == nil {
		t.Fatal("write through the front server's connection succeeded")
	}
}

func TestConfigFromEnv(t *testing.T) {
	env := map[string]string{
		"TGDL_CORE_TOKEN":           "t",
		"TGDL_FRONT_UPSTREAM_TOKEN": "u",
		"TGDL_FRONT_LISTEN":         ":3000",
		"TGDL_FRONT_UPSTREAM":       "127.0.0.1:1234",
	}
	get := func(k string) string { return env[k] }
	if _, err := FromEnv(get); err != nil {
		t.Fatal(err)
	}
	env["TGDL_FRONT_UPSTREAM"] = "10.0.0.1:1234"
	if _, err := FromEnv(get); err == nil {
		t.Fatal("non-loopback upstream accepted")
	}
	env["TGDL_FRONT_UPSTREAM"] = "127.0.0.1:1234"
	env["TGDL_CORE_TOKEN"] = ""
	if _, err := FromEnv(get); err == nil {
		t.Fatal("missing control token accepted")
	}
}

func TestDecodeRel(t *testing.T) {
	for raw, ok := range map[string]bool{
		"G1/videos/clip.mp4":     true,
		"G1/%C3%BC.jpg":          true,
		"G1/a%2Fb.jpg":           true,
		"G1//a.jpg":              false,
		"G1/../a.jpg":            false,
		"G1/./a.jpg":             false,
		"G1/.a":                  false,
		"G1/a.":                  false,
		"G1\\a.jpg":              false,
		"C:/a.jpg":               false,
		"G1/%E0%A4%A.jpg":        false,
		"G1/%FF.jpg":             false,
		"G1/a%00.jpg":            false,
		"G1/a%0A.jpg":            false,
		"":                       false,
		"G1/a%20b.jpg":           true,
		"G1/trailing%20/a.jpg":   false,
		"G1/sub.dir/x.mp4":       true,
		"_clusterref/abc/1":      true, // decoded fine; fastFiles sends it to Node
		"data/downloads/a.mp4":   true, // likewise (legacy prefix)
		"G1/%2e%2e/secret.txt":   false,
		"G1/..%5C..%5Csecret":    false,
		"G1/name%3Awith%3Acolon": false,
	} {
		_, got := decodeRel(raw)
		if got != ok {
			t.Errorf("decodeRel(%q) = %v, want %v", raw, got, ok)
		}
	}
}

func sha256Hex(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}
