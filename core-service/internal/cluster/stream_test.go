package cluster

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"
)

func TestStreamSurvivesControlTimeoutAndDoesNotForwardBrowserCredentials(t *testing.T) {
	s, close := testClusterStore(t, t.TempDir())
	defer close()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		stamp, _ := strconv.ParseInt(r.Header.Get("X-Peer-Ts"), 10, 64)
		if !signatureMatches(testSecret, r.Method, r.URL.RequestURI(), stamp, nil, r.Header.Get("X-Peer-Signature")) || r.Header.Get("Cookie") != "" || r.Header.Get("Authorization") != "" {
			http.Error(w, "invalid forwarded credentials", 400)
			return
		}
		w.Header().Set("Content-Length", "2")
		w.Write([]byte("a"))
		w.(http.Flusher).Flush()
		select {
		case <-r.Context().Done():
			return
		case <-time.After(11 * time.Second):
		}
		w.Write([]byte("b"))
	}))
	defer server.Close()
	client := NewClient(s)
	defer client.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	res, err := client.Stream(ctx, Peer{PeerID: testPeerID, URL: server.URL, Secret: []byte(testSecret)}, "GET", "/api/cluster/files/a", http.Header{"Cookie": []string{"private"}, "Authorization": []string{"private"}})
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	raw, err := io.ReadAll(res.Body)
	if err != nil || res.StatusCode != 200 || string(raw) != "ab" {
		t.Fatal(res.StatusCode, string(raw), err)
	}
}

type repeatingReader struct{}

func (repeatingReader) Read(p []byte) (int, error) { clear(p); return len(p), nil }
func BenchmarkPeerStream(b *testing.B) {
	for _, size := range []int64{1 << 20, 64 << 20} {
		b.Run(fmt.Sprintf("%dMiB", size>>20), func(b *testing.B) {
			s, close := testClusterStore(b, b.TempDir())
			defer close()
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Length", strconv.FormatInt(size, 10))
				_, _ = io.CopyN(w, repeatingReader{}, size)
			}))
			defer server.Close()
			client := NewClient(s)
			defer client.Close()
			peer := Peer{PeerID: testPeerID, URL: server.URL, Secret: []byte(testSecret)}
			buf := make([]byte, 32<<10)
			b.SetBytes(size)
			b.ReportAllocs()
			b.ResetTimer()
			for range b.N {
				res, err := client.Stream(context.Background(), peer, "GET", "/api/cluster/files/bench", nil)
				if err != nil {
					b.Fatal(err)
				}
				n, err := io.CopyBuffer(io.Discard, res.Body, buf)
				res.Body.Close()
				if err != nil || n != size {
					b.Fatal(n, err)
				}
			}
		})
	}
}
