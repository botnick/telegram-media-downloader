package hash

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"math/rand"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

func write(t *testing.T, dir, name string, data []byte) string {
	t.Helper()
	p := filepath.Join(dir, name)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, data, 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

func want(data []byte) string {
	s := sha256.Sum256(data)
	return hex.EncodeToString(s[:])
}

func randBytes(n int, seed int64) []byte {
	b := make([]byte, n)
	r := rand.New(rand.NewSource(seed))
	_, _ = r.Read(b)
	return b
}

func TestKnownVectors(t *testing.T) {
	dir := t.TempDir()
	cases := map[string]string{
		"":    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
		"abc": "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
	}
	for content, digest := range cases {
		p := write(t, dir, "v"+content+".bin", []byte(content))
		res, err := File(context.Background(), p)
		if err != nil {
			t.Fatal(err)
		}
		if res.SHA256 != digest || res.Size != int64(len(content)) {
			t.Errorf("%q: got %s/%d want %s/%d", content, res.SHA256, res.Size, digest, len(content))
		}
	}
}

func TestBufferBoundaries(t *testing.T) {
	dir := t.TempDir()
	for i, n := range []int{1, BufferSize - 1, BufferSize, BufferSize + 1, 3*BufferSize + 7} {
		data := randBytes(n, int64(i))
		p := write(t, dir, "b.bin", data)
		res, err := File(context.Background(), p)
		if err != nil {
			t.Fatal(err)
		}
		if res.SHA256 != want(data) || res.Size != int64(n) {
			t.Errorf("size %d: digest mismatch", n)
		}
		if strings.ToLower(res.SHA256) != res.SHA256 || len(res.SHA256) != 64 {
			t.Errorf("digest must be 64 lowercase hex chars, got %q", res.SHA256)
		}
	}
}

func TestMtimeMatchesStat(t *testing.T) {
	dir := t.TempDir()
	p := write(t, dir, "m.bin", []byte("x"))
	mt := time.Date(2024, 5, 6, 7, 8, 9, 123_000_000, time.UTC)
	if err := os.Chtimes(p, mt, mt); err != nil {
		t.Fatal(err)
	}
	res, err := File(context.Background(), p)
	if err != nil {
		t.Fatal(err)
	}
	if got, exp := res.MtimeMs, float64(mt.UnixNano())/1e6; got != exp {
		t.Errorf("mtimeMs = %f, want %f", got, exp)
	}
}

func TestUnicodeAndLongPaths(t *testing.T) {
	dir := t.TempDir()
	data := []byte("unicode payload")
	names := []string{"ไฟล์ภาษาไทย.bin", "🎬 clip 😀.mp4", "mixed ไทย 🎉 name.jpg"}
	for _, n := range names {
		p := write(t, dir, n, data)
		res, err := File(context.Background(), p)
		if err != nil {
			t.Fatalf("%s: %v", n, err)
		}
		if res.SHA256 != want(data) {
			t.Errorf("%s: digest mismatch", n)
		}
	}
	// Past Windows' 260-char MAX_PATH.
	long := dir
	for len(long) < 320 {
		long = filepath.Join(long, strings.Repeat("d", 40))
	}
	p := write(t, long, "long-ไทย.bin", data)
	if len(p) <= 260 {
		t.Fatalf("path not long enough: %d", len(p))
	}
	res, err := File(context.Background(), p)
	if err != nil {
		t.Fatalf("long path: %v", err)
	}
	if res.SHA256 != want(data) {
		t.Error("long path: digest mismatch")
	}
}

func code(err error) string {
	var he *Error
	if errors.As(err, &he) {
		return he.Code
	}
	return ""
}

func TestErrorCodes(t *testing.T) {
	dir := t.TempDir()
	file := write(t, dir, "f.bin", []byte("x"))

	if _, err := File(context.Background(), filepath.Join(dir, "missing.bin")); code(err) != "ENOENT" {
		t.Errorf("missing file: want ENOENT, got %v", err)
	}
	if _, err := File(context.Background(), dir); code(err) != "EISDIR" {
		t.Errorf("directory: want EISDIR, got %v", err)
	}
	if _, err := File(context.Background(), "relative/path.bin"); code(err) != "EINVAL" {
		t.Errorf("relative path: want EINVAL, got %v", err)
	}
	if _, err := File(context.Background(), ""); code(err) != "EINVAL" {
		t.Errorf("empty path: want EINVAL, got %v", err)
	}
	if _, err := File(context.Background(), file+"\x00x"); code(err) != "EINVAL" {
		t.Errorf("NUL in path: want EINVAL, got %v", err)
	}
	// A file used as a directory: ENOTDIR on POSIX, ENOENT on Windows —
	// the same codes Node reports on each platform.
	_, err := File(context.Background(), filepath.Join(file, "child"))
	wantCode := "ENOTDIR"
	if runtime.GOOS == "windows" {
		wantCode = "ENOENT"
	}
	if code(err) != wantCode {
		t.Errorf("file as dir: want %s, got %v", wantCode, err)
	}
}

func TestPermissionDenied(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("chmod does not remove read access on Windows")
	}
	if os.Geteuid() == 0 {
		t.Skip("root can read anything")
	}
	dir := t.TempDir()
	p := write(t, dir, "secret.bin", []byte("x"))
	if err := os.Chmod(p, 0); err != nil {
		t.Fatal(err)
	}
	defer os.Chmod(p, 0o644)
	if _, err := File(context.Background(), p); code(err) != "EACCES" {
		t.Errorf("want EACCES, got %v", err)
	}
}

func TestCancelledContext(t *testing.T) {
	dir := t.TempDir()
	p := write(t, dir, "c.bin", randBytes(4*BufferSize, 9))
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := File(ctx, p); code(err) != "ECANCELED" {
		t.Errorf("want ECANCELED, got %v", err)
	}
}

// While tgdl-core reads a file the app must still be able to delete it
// (download-time dedup unlinks the new copy right after hashing).
func TestOpenFileCanBeDeleted(t *testing.T) {
	dir := t.TempDir()
	p := write(t, dir, "del.bin", []byte("delete me"))
	f, err := openShared(p)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if err := os.Remove(p); err != nil {
		t.Fatalf("remove while open: %v", err)
	}
}

func TestLimiter(t *testing.T) {
	l := NewLimiter(2, 1)
	ctx := context.Background()
	if err := l.Acquire(ctx); err != nil {
		t.Fatal(err)
	}
	if err := l.Acquire(ctx); err != nil {
		t.Fatal(err)
	}
	if l.InFlight() != 2 {
		t.Fatalf("in flight = %d", l.InFlight())
	}

	// Third caller waits; a fourth is refused (queue of 1).
	var wg sync.WaitGroup
	wg.Add(1)
	acquired := make(chan struct{})
	go func() {
		defer wg.Done()
		if err := l.Acquire(ctx); err == nil {
			close(acquired)
		}
	}()
	deadline := time.Now().Add(2 * time.Second)
	for l.Waiting() != 1 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if err := l.Acquire(ctx); !errors.Is(err, ErrQueueFull) {
		t.Fatalf("want ErrQueueFull, got %v", err)
	}
	select {
	case <-acquired:
		t.Fatal("third caller got a slot while none was free")
	default:
	}
	l.Release()
	<-acquired
	wg.Wait()

	// A waiting caller gives up when its context ends.
	cctx, cancel := context.WithTimeout(ctx, 20*time.Millisecond)
	defer cancel()
	if err := l.Acquire(cctx); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("want deadline exceeded, got %v", err)
	}
	if l.Waiting() != 0 {
		t.Fatalf("waiting = %d after cancel", l.Waiting())
	}
}
