package telegram

import (
	"bytes"
	"context"
	"errors"
	"math/rand"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gotd/td/tg"
)

type partServer struct {
	data     []byte
	failAt   int64
	inflight atomic.Int32
	peak     atomic.Int32
	mu       sync.Mutex
	offsets  []int64
}

func (s *partServer) UploadGetFile(ctx context.Context, req *tg.UploadGetFileRequest) (tg.UploadFileClass, error) {
	n := s.inflight.Add(1)
	defer s.inflight.Add(-1)
	for {
		peak := s.peak.Load()
		if n <= peak || s.peak.CompareAndSwap(peak, n) {
			break
		}
	}
	s.mu.Lock()
	s.offsets = append(s.offsets, req.Offset)
	s.mu.Unlock()
	if req.Limit != downloadPartSize || req.Offset%downloadPartSize != 0 {
		return nil, errors.New("invalid part request")
	}
	select {
	case <-time.After(time.Duration(rand.Intn(3)) * time.Millisecond):
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	if s.failAt >= 0 && req.Offset == s.failAt {
		return nil, errors.New("part refused")
	}
	start := min(req.Offset, int64(len(s.data)))
	end := min(start+int64(req.Limit), int64(len(s.data)))
	return &tg.UploadFile{Type: &tg.StorageFileMp4{}, Bytes: s.data[start:end]}, nil
}

func testFile(size int) []byte {
	data := make([]byte, size)
	rand.New(rand.NewSource(int64(size))).Read(data)
	return data
}

func TestFetchParallelWritesPartsInOrder(t *testing.T) {
	loc := &tg.InputDocumentFileLocation{ID: 1}
	for _, tc := range []struct {
		name     string
		size     int
		reported int64
		threads  int
	}{
		{"uneven", 5*downloadPartSize + 1234, 5*downloadPartSize + 1234, 4},
		{"exact parts", 6 * downloadPartSize, 6 * downloadPartSize, 4},
		{"more threads than parts", 2*downloadPartSize + 1, 2*downloadPartSize + 1, 8},
		{"reported too large", 2*downloadPartSize + 10, 7 * downloadPartSize, 4},
		{"reported too small", 6*downloadPartSize + 10, 2 * downloadPartSize, 3},
		{"one thread", 3*downloadPartSize + 7, 3*downloadPartSize + 7, 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := &partServer{data: testFile(tc.size), failAt: -1}
			var out bytes.Buffer
			if err := fetchParallel(context.Background(), s, loc, tc.reported, tc.threads, &out); err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(out.Bytes(), s.data) {
				t.Fatalf("output %d bytes, want %d identical bytes", out.Len(), len(s.data))
			}
			if peak := int(s.peak.Load()); peak > tc.threads {
				t.Fatalf("%d requests in flight, limit %d", peak, tc.threads)
			}
		})
	}
}

func TestFetchParallelUsesThreads(t *testing.T) {
	s := &partServer{data: testFile(16 * downloadPartSize), failAt: -1}
	slow := &slowParts{partServer: s, delay: 20 * time.Millisecond}
	if err := fetchParallel(context.Background(), slow, &tg.InputDocumentFileLocation{ID: 1}, int64(len(s.data)), 4, &bytes.Buffer{}); err != nil {
		t.Fatal(err)
	}
	if peak := s.peak.Load(); peak != 4 {
		t.Fatalf("peak in flight=%d, want 4", peak)
	}
}

type slowParts struct {
	*partServer
	delay time.Duration
}

func (s *slowParts) UploadGetFile(ctx context.Context, req *tg.UploadGetFileRequest) (tg.UploadFileClass, error) {
	n := s.inflight.Add(1)
	for {
		peak := s.peak.Load()
		if n <= peak || s.peak.CompareAndSwap(peak, n) {
			break
		}
	}
	time.Sleep(s.delay)
	s.inflight.Add(-1)
	start := min(req.Offset, int64(len(s.data)))
	end := min(start+int64(req.Limit), int64(len(s.data)))
	return &tg.UploadFile{Bytes: s.data[start:end]}, nil
}

func TestFetchParallelStopsOnPartError(t *testing.T) {
	s := &partServer{data: testFile(8 * downloadPartSize), failAt: 3 * downloadPartSize}
	var out bytes.Buffer
	err := fetchParallel(context.Background(), s, &tg.InputDocumentFileLocation{ID: 1}, int64(len(s.data)), 4, &out)
	if err == nil || err.Error() != "part refused" {
		t.Fatalf("err=%v", err)
	}
	if out.Len() > 3*downloadPartSize || !bytes.Equal(out.Bytes(), s.data[:out.Len()]) {
		t.Fatalf("wrote %d bytes past or around the failed part", out.Len())
	}
}

type failingWriter struct{ after int }

func (w *failingWriter) Write(p []byte) (int, error) {
	if w.after <= 0 {
		return 0, errors.New("disk full")
	}
	w.after--
	return len(p), nil
}

func TestFetchParallelStopsOnWriteError(t *testing.T) {
	s := &partServer{data: testFile(8 * downloadPartSize), failAt: -1}
	err := fetchParallel(context.Background(), s, &tg.InputDocumentFileLocation{ID: 1}, int64(len(s.data)), 4, &failingWriter{after: 2})
	if err == nil || err.Error() != "disk full" {
		t.Fatalf("err=%v", err)
	}
}

func TestThreadTunerBacksOffAndRecovers(t *testing.T) {
	tuner := newThreadTuner(4)
	tuner.record(true)
	if got := tuner.threads(); got != 2 {
		t.Fatalf("after flood threads=%d", got)
	}
	tuner.record(true)
	tuner.record(true)
	if got := tuner.threads(); got != 1 {
		t.Fatalf("floor threads=%d", got)
	}
	for i := 0; i < threadRecoveryFiles-1; i++ {
		tuner.record(false)
	}
	if got := tuner.threads(); got != 1 {
		t.Fatalf("recovered early: %d", got)
	}
	tuner.record(false)
	if got := tuner.threads(); got != 2 {
		t.Fatalf("not recovered: %d", got)
	}
	for i := 0; i < 10*threadRecoveryFiles; i++ {
		tuner.record(false)
	}
	if got := tuner.threads(); got != 4 {
		t.Fatalf("ceiling threads=%d", got)
	}
}

func TestDownloadThreadsFromEnv(t *testing.T) {
	for value, want := range map[string]int{"": defaultDownloadThreads, "x": defaultDownloadThreads, "0": defaultDownloadThreads, "1": 1, "6": 6, "99": 16} {
		if got := downloadThreadsFromEnv(value); got != want {
			t.Fatalf("%q -> %d, want %d", value, got, want)
		}
	}
}
