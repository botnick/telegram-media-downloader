package front

import (
	"crypto/sha1"
	"encoding/base64"
	"encoding/hex"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestNormalizeRel(t *testing.T) {
	for raw, want := range map[string]string{
		"G1/videos/clip.mp4":              "G1/videos/clip.mp4",
		"G1//videos/./clip.mp4":           "G1/videos/clip.mp4",
		"G1/a/../clip.mp4":                "G1/clip.mp4",
		"data/downloads/G1/clip.mp4":      "G1/clip.mp4",
		"data/downloads/data/downloads/x": "x",
		"G1/sub.dir/x.mp4":                "G1/sub.dir/x.mp4",
		"G1/ü 名.jpg":                      "G1/ü 名.jpg",
	} {
		got, ok := normalizeRel(raw)
		if !ok || got != want {
			t.Errorf("normalizeRel(%q) = %q, %v; want %q", raw, got, ok, want)
		}
	}
	for _, raw := range []string{"../x", "G1/../../x", "/etc/passwd"} {
		if got, ok := normalizeRel(raw); ok {
			t.Errorf("normalizeRel(%q) = %q, want refused", raw, got)
		}
	}
	if runtime.GOOS == "windows" {
		for _, raw := range []string{`G1\a`, "C:/a", "G1/a."} {
			if _, ok := normalizeRel(raw); ok {
				t.Errorf("normalizeRel(%q) accepted on Windows", raw)
			}
		}
	}
}

func TestBodyETag(t *testing.T) {
	// The etag package's tag of "File not found", as Express sends it.
	if got := bodyETag("File not found"); got != `W/"e-oi6cO2qfXHDeT3akZIEOy6H7l8M"` {
		t.Errorf("bodyETag = %s", got)
	}
	sum := sha1.Sum([]byte("x"))
	if want := `W/"1-` + base64.StdEncoding.EncodeToString(sum[:])[:27] + `"`; bodyETag("x") != want {
		t.Errorf("bodyETag(x) = %s", bodyETag("x"))
	}
}

func TestFilesErrorAnswers(t *testing.T) {
	h := newHarness(t)
	c := cookie(tokAdmin)
	for _, tc := range []struct {
		name, target string
		status       int
		body         string
	}{
		{"traversal", "/files/G1/..%2F..%2Fdb.sqlite", 403, "Forbidden"},
		{"absolute", "/files/%2Fetc%2Fpasswd", 403, "Forbidden"},
		{"NUL", "/files/G1/a%00.jpg", 400, "Bad request"},
		{"missing", "/files/G1/videos/gone.mp4", 404, "File not found"},
		{"directory", "/files/G1", 404, "File not found"},
		{"dotfile", "/files/G1/docs/.hidden", 404, "File not found"},
	} {
		res, body := h.do("GET", tc.target, c)
		if res.StatusCode != tc.status || string(body) != tc.body {
			t.Errorf("%s: %d %q, want %d %q", tc.name, res.StatusCode, body, tc.status, tc.body)
			continue
		}
		if res.Header.Get("Content-Type") != "text/html; charset=utf-8" || res.Header.Get("ETag") != bodyETag(tc.body) ||
			res.Header.Get("Cache-Control") != testFilesCC {
			t.Errorf("%s: headers %v", tc.name, res.Header)
		}
	}
	// The Go client refuses to send a bad escape; write it on the wire.
	raw := rawGet(t, h.srv.URL, "/files/G1/%E0%A4%A", "Cookie: tg_dl_session="+tokAdmin)
	if !strings.HasPrefix(raw, "HTTP/1.1 400") {
		t.Errorf("bad escape: %.40q", raw)
	}
	if h.upstreamCalls() != 0 {
		t.Fatal("an error answer reached Node")
	}
	// Only the missing file is reported to Node, once, with the decoded path.
	got := h.waitNotes(1)
	if len(got) != 1 || got[0] != "missing G1/videos/gone.mp4" {
		t.Errorf("notify posts: %v", got)
	}
}

func TestSessionRenewalIsNotified(t *testing.T) {
	h := newHarness(t)
	for i := 0; i < 3; i++ {
		res, body := h.do("GET", "/files/G1/videos/clip.mp4", cookie(tokRenew))
		if res.StatusCode != 200 || len(body) != 10000 || res.Header.Get("Set-Cookie") != "" {
			t.Fatalf("renewal window: %d %d bytes", res.StatusCode, len(body))
		}
	}
	got := h.waitNotes(1)
	// A video is many requests; Node hears about the session once.
	if len(got) != 1 || got[0] != "renew "+tokRenew {
		t.Errorf("notify posts: %v", got)
	}
	if h.upstreamCalls() != 0 {
		t.Fatal("request reached Node")
	}
	// A healthy session is never reported.
	h.do("GET", "/files/G1/videos/clip.mp4", cookie(tokAdmin))
	if n := len(h.waitNotes(1)); n != 1 {
		t.Errorf("%d notify posts after a healthy session", n)
	}
}

func TestSymlinks(t *testing.T) {
	h := newHarness(t)
	in := filepath.Join(h.photos, "-100123.jpg")
	if err := os.Symlink(in, filepath.Join(h.downloads, "G1", "photo-link.jpg")); err != nil {
		t.Skip("symlinks unavailable:", err)
	}
	if err := os.Symlink(filepath.Join(h.outside, "secret.txt"), filepath.Join(h.downloads, "G1", "escape.txt")); err != nil {
		t.Fatal(err)
	}
	// Inside the allowed roots: served, under the link's target name.
	res, body := h.do("GET", "/files/G1/photo-link.jpg", cookie(tokAdmin))
	if res.StatusCode != 200 || string(body) != "jpegbytes" ||
		!strings.Contains(res.Header.Get("Content-Disposition"), `filename="-100123.jpg"`) {
		t.Errorf("symlink inside roots: %d %q %v", res.StatusCode, body, res.Header)
	}
	// Leaving every root: refused, and nothing leaks.
	res, body = h.do("GET", "/files/G1/escape.txt", cookie(tokAdmin))
	if res.StatusCode != 403 || strings.Contains(string(body), "secret") {
		t.Errorf("symlink outside roots: %d %q", res.StatusCode, body)
	}
	if h.upstreamCalls() != 0 {
		t.Fatal("request reached Node")
	}
}

func TestForceHTTPSFromTheMachineItself(t *testing.T) {
	h := newHarness(t)
	h.setState(State{AuthReady: true, ForceHTTPS: true, ShareSecret: secretHex})
	// The test client is on loopback: Node lets it through over plain HTTP,
	// with the header set it pushed for that case.
	res, _ := h.do("GET", "/files/G1/videos/clip.mp4", cookie(tokAdmin))
	if res.StatusCode != 200 || res.Header.Get("X-Local") != "1" || res.Header.Get("Strict-Transport-Security") != "" {
		t.Errorf("loopback over http: %d %v", res.StatusCode, res.Header)
	}
	// Behind a proxy (X-Forwarded-For) it is not "the machine itself".
	before := h.upstreamCalls()
	h.do("GET", "/files/G1/videos/clip.mp4", map[string]string{"Cookie": cookie(tokAdmin)["Cookie"], "X-Forwarded-For": "203.0.113.9"})
	if h.upstreamCalls() != before+1 {
		t.Error("a forwarded plain-HTTP request must go to Node (redirect)")
	}
}

func TestPrivateNotifyHeaderNeverReachesNode(t *testing.T) {
	h := newHarness(t)
	h.do("POST", "/x", map[string]string{hdrNotify: "front-token"})
	if got := h.lastCall().header.Get(hdrNotify); got != "" {
		t.Errorf("client-sent %s reached Node: %q", hdrNotify, got)
	}
}

func TestFileTokenLeadingZeros(t *testing.T) {
	secret, _ := hex.DecodeString(secretHex)
	exp := strconv.FormatInt(time.Now().Unix()+600, 10)
	sig := fileTokenSig(secret, "filetoken:guest|"+exp)
	// Number("0<exp>") === exp: the signature covers the canonical value.
	if role, ok := fileTokenRole(secret, "0"+exp+"."+sig); !ok || role != "guest" {
		t.Errorf("padded token: %q %v", role, ok)
	}
	for _, bad := range []string{"0x1f." + sig, "1e3." + sig, "0." + sig, exp + ".", "." + sig} {
		if _, ok := fileTokenRole(secret, bad); ok {
			t.Errorf("%q accepted", bad)
		}
	}
}
