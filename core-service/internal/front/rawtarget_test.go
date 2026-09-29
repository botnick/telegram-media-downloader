package front

import (
	"bufio"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"
)

// rawServer serves h.front behind the raw-target listener, as Run does.
func (h *harness) rawServer() string {
	ts := httptest.NewUnstartedServer(h.front)
	ts.Listener = &rawTargetListener{Listener: ts.Listener, header: h.front.rawHeader}
	ts.Start()
	h.t.Cleanup(ts.Close)
	return ts.Listener.Addr().String()
}

// send writes raw bytes on one connection and reads n responses.
func sendRaw(t *testing.T, addr, raw string, n int) []*http.Response {
	t.Helper()
	c, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	_ = c.SetDeadline(time.Now().Add(10 * time.Second))
	if _, err := io.WriteString(c, raw); err != nil {
		t.Fatal(err)
	}
	br := bufio.NewReader(c)
	var out []*http.Response
	for i := 0; i < n; i++ {
		res, err := http.ReadResponse(br, nil)
		if err != nil {
			t.Fatalf("response %d: %v", i, err)
		}
		_, _ = io.Copy(io.Discard, res.Body)
		_ = res.Body.Close()
		out = append(out, res)
	}
	return out
}

func TestRawTargetReachesNodeVerbatim(t *testing.T) {
	h := newHarness(t)
	addr := h.rawServer()
	body := "GET /files/%zz HTTP/1.1\r\n\r\n" // a body that looks like a request line
	raw := "GET /files/%E0%A4%A?x=%zz HTTP/1.1\r\nHost: a\r\nCookie: tg_dl_session=" + tokAdmin + "\r\n\r\n" +
		"POST /api/x/%4 HTTP/1.1\r\nHost: a\r\nContent-Length: " + strconv.Itoa(len(body)) + "\r\n\r\n" + body +
		"GET /files/G1/videos/clip.mp4 HTTP/1.1\r\nHost: a\r\nX-Tgdl-Raw-0000: /evil\r\n\r\n" +
		"GET /api/q?b=2;a=1&c=%zz&d HTTP/1.1\r\nHost: a\r\n\r\n" +
		"GET /api/\xc3\xa4/%2F HTTP/1.1\r\nHost: a\r\n\r\n"
	res := sendRaw(t, addr, raw, 5)
	for i, r := range res {
		if r.StatusCode != 200 {
			t.Fatalf("response %d: %d", i, r.StatusCode)
		}
	}
	if h.upstreamCalls() != 5 {
		t.Fatalf("%d upstream calls, want 5", h.upstreamCalls())
	}
	want := []string{"/files/%E0%A4%A?x=%zz", "/api/x/%4", "/files/G1/videos/clip.mp4", "/api/q?b=2;a=1&c=%zz&d", "/api/\xc3\xa4/%2F"}
	for i, w := range want {
		h.mu.Lock()
		c := h.calls[i]
		h.mu.Unlock()
		if c.uri != w {
			t.Errorf("call %d: Node got %q, want %q", i, c.uri, w)
		}
		for k := range c.header {
			if strings.HasPrefix(k, "X-Tgdl-Raw") {
				t.Errorf("call %d: private header %s reached Node", i, k)
			}
		}
	}
}

func TestRawTargetFixPercents(t *testing.T) {
	for in, want := range map[string]string{
		"/a/%E0%A4%A":   "/a/%E0%A4%25A",
		"/%":            "/%25",
		"/%4g?q=%zz":    "/%254g?q=%zz",
		"/ok/%20?q=%zz": "",
		"//x/%":         "",
		"*":             "",
	} {
		got, changed := fixPercents([]byte(in))
		if want == "" {
			if changed {
				t.Errorf("%q: changed to %q", in, got)
			}
			continue
		}
		if string(got) != want {
			t.Errorf("%q: %q, want %q", in, got, want)
		}
	}
}

// Framing the listener can't follow switches the connection to plain
// pass-through: a later bad target gets net/http's own 400.
func TestRawTargetPassThroughAfterChunked(t *testing.T) {
	h := newHarness(t)
	addr := h.rawServer()
	raw := "POST /api/x HTTP/1.1\r\nHost: a\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n0\r\n\r\n" +
		"GET /files/%E0%A4%A HTTP/1.1\r\nHost: a\r\n\r\n"
	res := sendRaw(t, addr, raw, 2)
	if res[0].StatusCode != 200 || res[1].StatusCode != 400 || h.upstreamCalls() != 1 {
		t.Fatalf("statuses %d %d, %d upstream calls", res[0].StatusCode, res[1].StatusCode, h.upstreamCalls())
	}
}
