package backup

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestS3SlowUploadDoesNotUseResponseTimeoutOrSigningProgress(t *testing.T) {
	f := newFixtureS3(t)
	p := f.provider()
	client := p.client.Options().HTTPClient.(*http.Client)
	base := client.Transport.(*backupHTTPTransport)
	base.readTimeout = 100 * time.Millisecond
	p.transport.ResponseHeaderTimeout = 100 * time.Millisecond
	var sending atomic.Bool
	client.Transport = roundTripFunc(func(r *http.Request) (*http.Response, error) {
		if r.Method == "PUT" {
			sending.Store(true)
		}
		return base.RoundTrip(r)
	})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	ctx = withUploadPacer(ctx, newUploadPacer(2048))
	data := bytes.Repeat([]byte{4}, 2048)
	start := time.Now()
	var progress int64
	if _, err := p.Upload(ctx, "slow", bytes.NewReader(data), int64(len(data)), func(n int64) {
		if !sending.Load() {
			t.Error("signing emitted upload progress")
		}
		progress = n
	}); err != nil {
		t.Fatal(err)
	}
	if elapsed := time.Since(start); elapsed < 800*time.Millisecond {
		t.Fatalf("rate cap bypassed: %s", elapsed)
	}
	if progress != int64(len(data)) {
		t.Fatalf("progress=%d", progress)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if !bytes.Equal(f.objects[p.prefix+"/slow"].data, data) {
		t.Fatal("wire bytes changed")
	}
}

func TestUploadPacerIsSharedAcrossConcurrentBodiesAndCancellation(t *testing.T) {
	pacer := newUploadPacer(1024)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	start := time.Now()
	var wg sync.WaitGroup
	for range 4 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			n, err := io.Copy(io.Discard, pacedReader{ctx, strings.NewReader(strings.Repeat("x", 256)), pacer})
			if err != nil || n != 256 {
				t.Errorf("paced body: %d %v", n, err)
			}
		}()
	}
	wg.Wait()
	if elapsed := time.Since(start); elapsed < 800*time.Millisecond {
		t.Fatalf("parallel bodies multiplied configured bandwidth: %s", elapsed)
	}
	slow := newUploadPacer(1)
	r := pacedReader{ctx, strings.NewReader("abc"), slow}
	var b [1]byte
	if _, err := r.Read(b[:]); err != nil {
		t.Fatal(err)
	}
	result := make(chan error, 1)
	go func() { _, err := r.Read(b[:]); result <- err }()
	cancel()
	select {
	case err := <-result:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("wait cancellation: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("pacer ignored cancellation")
	}
}

func TestHTTPResponseBodyStallIsStillBounded(t *testing.T) {
	stopped := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer close(stopped)
		w.Header().Set("Content-Length", "10")
		w.WriteHeader(200)
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	}))
	defer server.Close()
	base := http.DefaultTransport.(*http.Transport).Clone()
	defer base.CloseIdleConnections()
	client := &http.Client{Transport: &backupHTTPTransport{base: base, readTimeout: 100 * time.Millisecond}}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "GET", server.URL, nil)
	response, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	start := time.Now()
	_, err = io.ReadAll(response.Body)
	if err == nil || time.Since(start) > time.Second {
		t.Fatalf("silent response was not bounded: %v", err)
	}
	select {
	case <-stopped:
	case <-time.After(time.Second):
		t.Fatal("stalled request socket remained open")
	}
}

func TestSFTPSlowUploadAndIdleConnectionDoNotExpire(t *testing.T) {
	f := newFixtureSFTP(t)
	p := f.provider()
	p.rpcTimeout = 200 * time.Millisecond
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	ctx = withUploadPacer(ctx, newUploadPacer(32<<10))
	data := bytes.Repeat([]byte{9}, 32<<10)
	start := time.Now()
	if _, err := p.Upload(ctx, "slow", bytes.NewReader(data), int64(len(data)), nil); err != nil {
		t.Fatal("pacing caused remote timeout", err)
	}
	if time.Since(start) < 800*time.Millisecond {
		t.Fatal("SFTP ignored rate cap")
	}
	time.Sleep(2 * p.rpcTimeout)
	if _, err := p.List(ctx, ""); err != nil {
		t.Fatal("idle session expired", err)
	}
	if f.handshakes.Load() != 1 {
		t.Fatalf("idle connection was replaced: %d", f.handshakes.Load())
	}
	b, err := os.ReadFile(filepath.Join(f.root, "backup", "slow"))
	if err != nil || !bytes.Equal(b, data) {
		t.Fatal("remote payload", err)
	}
}

func TestSFTPUnansweredCommandStillTimesOutAndCleans(t *testing.T) {
	f := newFixtureSFTP(t)
	p := f.provider()
	p.rpcTimeout = 200 * time.Millisecond
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	if _, err := p.Test(ctx); err != nil {
		t.Fatal(err)
	}
	f.stallWrite.Store(true)
	start := time.Now()
	_, err := p.Upload(ctx, "stalled", bytes.NewReader([]byte("bytes")), 5, nil)
	if err == nil || ctx.Err() != nil || time.Since(start) > 2*time.Second {
		t.Fatalf("remote command not timed out independently: %v", err)
	}
	entries, err := os.ReadDir(filepath.Join(f.root, "backup"))
	if err != nil || len(entries) != 0 {
		t.Fatalf("timeout leaked temp: %v %v", entries, err)
	}
}

func TestSFTPServerDiagnosticsCannotBlockFileChannel(t *testing.T) {
	f := newFixtureSFTP(t)
	// More than the SSH channel window, before the first SFTP response.
	f.stderrBytes.Store(4 << 20)
	p := f.provider()
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	if _, err := p.Test(ctx); err != nil {
		t.Fatal("server stderr blocked SFTP", err)
	}
	if err := p.Close(); err != nil {
		t.Fatal(err)
	}
}

func sftpFixturePacket(kind byte, id uint32, payload []byte) []byte {
	b := make([]byte, 9+len(payload))
	binary.BigEndian.PutUint32(b[:4], uint32(len(b)-4))
	b[4] = kind
	binary.BigEndian.PutUint32(b[5:9], id)
	copy(b[9:], payload)
	return b
}
func TestSFTPDeadlineTracksFragmentedAndTruncatedResponses(t *testing.T) {
	client, server := net.Pipe()
	defer client.Close()
	defer server.Close()
	wire := newSFTPDeadlineChannel(client, client, 100*time.Millisecond)
	request := sftpFixturePacket(3, 42, []byte("request"))
	response := sftpFixturePacket(101, 42, []byte("response"))
	peerDone := make(chan error, 1)
	go func() {
		b := make([]byte, len(request))
		if _, err := io.ReadFull(server, b); err != nil {
			peerDone <- err
			return
		}
		for _, part := range [][]byte{response[:2], response[2:7], response[7:10], response[10:]} {
			time.Sleep(40 * time.Millisecond)
			if _, err := server.Write(part); err != nil {
				peerDone <- err
				return
			}
		}
		peerDone <- nil
	}()
	if _, err := wire.Write(request); err != nil {
		t.Fatal(err)
	}
	b := make([]byte, len(response))
	if _, err := io.ReadFull(wire, b); err != nil {
		t.Fatal("active fragmented response expired", err)
	}
	if err := <-peerDone; err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(b, response) {
		t.Fatal("observer altered payload")
	}
	// No pending command: waiting between operations must have no deadline.
	time.Sleep(150 * time.Millisecond)
	go func() { _, _ = server.Write([]byte("x")) }()
	var one [1]byte
	if _, err := client.Read(one[:]); err != nil {
		t.Fatal("idle connection retained deadline", err)
	}
	go func() {
		b := make([]byte, len(request))
		_, _ = io.ReadFull(server, b)
		_, _ = server.Write(response[:10])
	}()
	if _, err := wire.Write(request); err != nil {
		t.Fatal(err)
	}
	_, err := io.ReadFull(wire, b)
	var timeout net.Error
	if !errors.As(err, &timeout) || !timeout.Timeout() {
		t.Fatalf("partial response cleared pending request too early: %v", err)
	}
}

func TestManagerLocalRateBudgetPersistsAcrossJobs(t *testing.T) {
	m, db, dir := fixtureManager(t, nil)
	id := addLocal(t, m, filepath.Join(dir, "target"), "mirror")
	if err := m.Pause(context.Background(), id, true); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Writer.Exec(`UPDATE backup_destinations SET throttle_bps=1024 WHERE id=?`, id); err != nil {
		t.Fatal(err)
	}
	for i := range 4 {
		addSource(t, db, dir, string(rune('a'+i)), strings.Repeat("x", 256), 100+i)
	}
	start := time.Now()
	if err := m.Pause(context.Background(), id, false); err != nil {
		t.Fatal(err)
	}
	waitBackup(t, m, id, 4, 0)
	if elapsed := time.Since(start); elapsed < 800*time.Millisecond {
		t.Fatalf("per-file burst bypassed budget: %s", elapsed)
	}
}
