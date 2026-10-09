package app

import (
	"bytes"
	"compress/gzip"
	"compress/zlib"
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/andybalholm/brotli"
	"github.com/gorilla/websocket"
)

func decodeCompressed(t testing.TB, encoding string, body io.Reader) []byte {
	t.Helper()
	var r io.Reader = body
	var close io.Closer
	var err error
	switch encoding {
	case "gzip":
		var z *gzip.Reader
		z, err = gzip.NewReader(body)
		r, close = z, z
	case "deflate":
		var z io.ReadCloser
		z, err = zlib.NewReader(body)
		r, close = z, z
	case "br":
		r = brotli.NewReader(body)
	}
	if err != nil {
		t.Fatal(err)
	}
	if close != nil {
		defer close.Close()
	}
	b, err := io.ReadAll(r)
	if err != nil {
		t.Fatal(err)
	}
	return b
}
func TestCompressionNegotiationAndWireBytes(t *testing.T) {
	for _, tc := range []struct{ accept, want string }{
		{"gzip", "gzip"}, {"br", "br"}, {"deflate", "deflate"}, {"gzip, br", "br"},
		{"br;q=0.2, gzip;q=0.8", "gzip"}, {"br;q=0, gzip;q=0, deflate;q=0", ""},
		{"*;q=0.8, br;q=0", "gzip"}, {"gzip;q=NaN", ""}, {"gzip;q=1.1", ""}, {"gzip;q=.5", ""},
		{"GZIP;Q=0.800", "gzip"}, {"identity;q=1, gzip;q=0.5", ""}, {"gzip, gzip;q=0", ""},
	} {
		if got := acceptedEncoding(tc.accept); got != tc.want {
			t.Fatalf("%s -> %s want %s", tc.accept, got, tc.want)
		}
	}
	body := bytes.Repeat([]byte("{\"value\":\"ข้อมูลสำหรับทดสอบ\"}\n"), 4000)
	for _, encoding := range []string{"gzip", "deflate", "br"} {
		t.Run(encoding, func(t *testing.T) {
			pool := newCompressionPool(6)
			h := pool.middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				w.Header().Set("Content-Length", fmt.Sprint(len(body)))
				w.Header().Set("ETag", `"strong-fixture"`)
				w.Header().Set("Vary", "Cookie")
				w.WriteHeader(201)
				for i := 0; i < len(body); i += 37 {
					end := min(i+37, len(body))
					if _, err := w.Write(body[i:end]); err != nil {
						return
					}
				}
			}))
			server := httptest.NewServer(h)
			defer server.Close()
			client := &http.Client{Transport: &http.Transport{DisableCompression: true}}
			defer client.CloseIdleConnections()
			for i := 0; i < 3; i++ {
				r, _ := http.NewRequest("GET", server.URL, nil)
				r.Header.Set("Accept-Encoding", encoding)
				resp, err := client.Do(r)
				if err != nil {
					t.Fatal(err)
				}
				wire, err := io.ReadAll(resp.Body)
				if err != nil {
					t.Fatal(err)
				}
				actual := decodeCompressed(t, encoding, bytes.NewReader(wire))
				resp.Body.Close()
				if resp.StatusCode != 201 || resp.Header.Get("Content-Encoding") != encoding || (resp.ContentLength >= 0 && resp.ContentLength != int64(len(wire))) || resp.Header.Get("ETag") != `W/"strong-fixture"` || resp.Header.Get("Vary") != "Cookie, Accept-Encoding" || !bytes.Equal(actual, body) {
					t.Fatal("wire mismatch", resp.StatusCode, resp.Header, len(actual))
				}
			}
			if len(pool.slots) != 0 {
				t.Fatal("compressor lease leaked")
			}
		})
	}
}

func TestCompressionPreservesBinaryRangeAndStreaming(t *testing.T) {
	body := strings.Repeat("payload ", 300)
	for _, tc := range []struct {
		method, path, typ, header, value string
		status                           int
	}{
		{"GET", "/files/test.txt", "text/plain", "", "", 200},
		{"GET", "/share/1", "text/plain", "", "", 200},
		{"GET", "/photos/test", "image/jpeg", "", "", 200},
		{"GET", "/api/cluster/files/test", "text/plain", "", "", 200},
		{"GET", "/data", "text/plain", "Range", "bytes=0-100", 206},
		{"GET", "/data", "text/plain", "X-No-Compression", "1", 200},
		{"GET", "/data", "video/mp4", "", "", 200},
		{"GET", "/data", "image/svg+xml", "", "", 200},
		{"HEAD", "/data", "text/plain", "", "", 200},
		{"GET", "/data", "text/plain", "", "", 304},
	} {
		h := newCompressionPool(6).middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", tc.typ)
			w.WriteHeader(tc.status)
			if tc.method != "HEAD" && tc.status != 304 {
				_, _ = io.WriteString(w, body)
			}
		}))
		r := httptest.NewRequest(tc.method, tc.path, nil)
		r.Header.Set("Accept-Encoding", "gzip")
		if tc.header != "" {
			r.Header.Set(tc.header, tc.value)
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Header().Get("Content-Encoding") != "" || w.Code != tc.status {
			t.Fatal("unexpected compression", tc, w.Header())
		}
		if tc.method != "HEAD" && tc.status != 304 && w.Body.String() != body {
			t.Fatal("changed bytes", tc)
		}
	}
	for _, headers := range []map[string]string{{"Cache-Control": "public, no-transform"}, {"Content-Encoding": "fixture"}, {"Content-Range": "bytes 0-2000/3000"}} {
		h := newCompressionPool(6).middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			for k, v := range headers {
				w.Header().Set(k, v)
			}
			_, _ = io.WriteString(w, body)
		}))
		r := httptest.NewRequest("GET", "/", nil)
		r.Header.Set("Accept-Encoding", "gzip")
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Body.String() != body {
			t.Fatal("protected representation changed", headers)
		}
	}
	for _, size := range []int{0, 1, 1023, 1024, 1025} {
		h := newCompressionPool(6).middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "text/plain")
			_, _ = io.WriteString(w, strings.Repeat("x", size))
		}))
		r := httptest.NewRequest("GET", "/", nil)
		r.Header.Set("Accept-Encoding", "gzip")
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if (w.Header().Get("Content-Encoding") == "gzip") != (size >= 1024) {
			t.Fatal("threshold", size, w.Header())
		}
		if len(decodeCompressed(t, w.Header().Get("Content-Encoding"), w.Body)) != size {
			t.Fatal("threshold bytes", size)
		}
	}
	// Flush before reaching the threshold must be observable immediately.
	release := make(chan struct{})
	server := httptest.NewServer(newCompressionPool(6).middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		_, _ = io.WriteString(w, "first\n")
		w.(http.Flusher).Flush()
		<-release
		_, _ = io.WriteString(w, "last\n")
	})))
	defer server.Close()
	r, _ := http.NewRequest("GET", server.URL, nil)
	r.Header.Set("Accept-Encoding", "gzip")
	resp, err := http.DefaultClient.Do(r)
	if err != nil {
		close(release)
		t.Fatal(err)
	}
	first := make([]byte, 6)
	_, err = io.ReadFull(resp.Body, first)
	close(release)
	if err != nil || string(first) != "first\n" {
		t.Fatal("flush blocked", err, string(first))
	}
	rest, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if string(rest) != "last\n" || resp.Header.Get("Content-Encoding") != "" {
		t.Fatal("stream changed")
	}
}

func TestCompressionBackpressureCancellationAndWebSocket(t *testing.T) {
	pool := newCompressionPool(6)
	for i := 0; i < cap(pool.slots); i++ {
		pool.slots <- struct{}{}
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := pool.acquire(ctx, "gzip", io.Discard); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	pool.waitTimeout = 20 * time.Millisecond
	h := pool.middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		_, _ = io.WriteString(w, strings.Repeat("x", 2000))
	}))
	r := httptest.NewRequest("GET", "/data", nil)
	r.Header.Set("Accept-Encoding", "gzip")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 503 || !strings.Contains(w.Body.String(), "compression is busy") {
		t.Fatal("capacity did not fail explicitly", w.Code, w.Body.String())
	}
	for len(pool.slots) > 0 {
		<-pool.slots
	}
	up := websocket.Upgrader{}
	server := httptest.NewServer(pool.middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := up.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer c.Close()
		_ = c.WriteMessage(websocket.TextMessage, []byte("live"))
	})))
	defer server.Close()
	c, resp, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http"), http.Header{"Accept-Encoding": []string{"gzip"}})
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	_ = c.SetReadDeadline(time.Now().Add(time.Second))
	_, msg, err := c.ReadMessage()
	if err != nil || string(msg) != "live" || resp.StatusCode != 101 {
		t.Fatal(string(msg), err)
	}
}

type oneConnectionListener struct {
	conn     net.Conn
	accepted bool
	closed   chan struct{}
	once     sync.Once
}

func (l *oneConnectionListener) Accept() (net.Conn, error) {
	if !l.accepted {
		l.accepted = true
		return l.conn, nil
	}
	<-l.closed
	return nil, net.ErrClosed
}
func (l *oneConnectionListener) Addr() net.Addr { return l.conn.LocalAddr() }
func (l *oneConnectionListener) Close() error   { l.once.Do(func() { close(l.closed) }); return nil }

func TestCompressionStalledSocketReleasesEncoder(t *testing.T) {
	serverConn, clientConn := net.Pipe()
	l := &oneConnectionListener{conn: serverConn, closed: make(chan struct{})}
	pool := newCompressionPool(6)
	pool.writeTimeout = 20 * time.Millisecond
	body := make([]byte, 256<<10)
	if _, err := rand.Read(body); err != nil {
		t.Fatal(err)
	}
	finished := make(chan struct{})
	h := pool.middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(body)
	}))
	server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { defer close(finished); h.ServeHTTP(w, r) })}
	served := make(chan struct{})
	go func() { defer close(served); _ = server.Serve(l) }()
	defer func() { _ = clientConn.Close(); _ = server.Close(); <-served }()
	if _, err := io.WriteString(clientConn, "GET /data HTTP/1.1\r\nHost: fixture\r\nAccept-Encoding: gzip\r\n\r\n"); err != nil {
		t.Fatal(err)
	}
	// Deliberately never read from the client. net.Pipe has no socket buffer.
	select {
	case <-finished:
	case <-time.After(time.Second):
		t.Fatal("stalled socket retained encoder")
	}
	if len(pool.slots) != 0 {
		t.Fatal("encoder leaked after network timeout")
	}
}

func TestCompressionApplicationPauseDoesNotExpireSocketDeadline(t *testing.T) {
	pool := newCompressionPool(6)
	pool.writeTimeout = 20 * time.Millisecond
	server := httptest.NewServer(pool.middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		_, _ = io.WriteString(w, strings.Repeat("before", 1024))
		w.(http.Flusher).Flush()
		time.Sleep(80 * time.Millisecond)
		_, _ = io.WriteString(w, "after")
		w.(http.Flusher).Flush()
	})))
	defer server.Close()
	r, _ := http.NewRequest("GET", server.URL, nil)
	r.Header.Set("Accept-Encoding", "gzip")
	resp, err := http.DefaultClient.Do(r)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	got := decodeCompressed(t, "gzip", resp.Body)
	if string(got) != strings.Repeat("before", 1024)+"after" {
		t.Fatal("local pause expired response")
	}
}

func BenchmarkHTTPCompression(b *testing.B) {
	body := bytes.Repeat([]byte(`{"id":123,"name":"test media","group":"gallery"}`), 4000)
	for _, encoding := range []string{"gzip", "br", "deflate"} {
		b.Run(encoding, func(b *testing.B) {
			pool := newCompressionPool(6)
			h := pool.middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write(body)
			}))
			r := httptest.NewRequest("GET", "/api/data", nil)
			r.Header.Set("Accept-Encoding", encoding)
			h.ServeHTTP(&discardHTTPWriter{h: make(http.Header)}, r)
			b.SetBytes(int64(len(body)))
			b.ReportAllocs()
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				h.ServeHTTP(&discardHTTPWriter{h: make(http.Header)}, r)
			}
		})
	}
}

type discardHTTPWriter struct{ h http.Header }

func (w *discardHTTPWriter) Header() http.Header         { return w.h }
func (w *discardHTTPWriter) WriteHeader(int)             {}
func (w *discardHTTPWriter) Write(b []byte) (int, error) { return len(b), nil }
