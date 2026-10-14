package app

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// The scan hashes whole files, so it must outlive the request that started
// it: a proxy that gives up on the request must not stop it.
func TestDedupScanRunsAfterRequestEnds(t *testing.T) {
	a, _ := socketTestApp(t)
	rescueFile(t, a, "a.bin")
	rescueFile(t, a, "b.bin")
	rescueInsert(t, a, 1, "a.bin", nil, nil, 0)
	rescueInsert(t, a, 2, "b.bin", nil, nil, 0)
	ctx, cancel := context.WithCancel(context.Background())
	req := httptest.NewRequest(http.MethodPost, "/api/maintenance/dedup/scan", strings.NewReader("{}")).WithContext(ctx)
	rec := httptest.NewRecorder()
	a.handleDedupScan(rec, req)
	cancel()
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), `"started":true`) {
		t.Fatalf("start: %d %s", rec.Code, rec.Body)
	}
	deadline := time.Now().Add(10 * time.Second)
	for {
		a.dedupMu.Lock()
		stage, running := a.dedupScanStatus["stage"], a.dedupScanCancel != nil
		a.dedupMu.Unlock()
		if stage == "done" && !running {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("scan never finished: stage=%v", stage)
		}
		time.Sleep(10 * time.Millisecond)
	}
	if n := rowCount(t, a, "file_hash IS NOT NULL"); n != 2 {
		t.Fatalf("hashed %d rows, want 2", n)
	}
	a.dedupMu.Lock()
	last := a.dedupLastScan
	a.dedupMu.Unlock()
	if last["duplicateSets"] != 1 || last["extraCopies"] != 1 {
		t.Fatalf("last scan %+v", last)
	}
}

func TestDedupScanStopEndsRunningScan(t *testing.T) {
	a, _ := socketTestApp(t)
	ctx, cancel := context.WithCancel(context.Background())
	a.dedupMu.Lock()
	a.dedupScanCancel = cancel
	a.dedupMu.Unlock()
	rec := httptest.NewRecorder()
	a.handleDedupScanStop(rec, httptest.NewRequest(http.MethodPost, "/api/maintenance/dedup/scan/stop", nil))
	if ctx.Err() == nil || !strings.Contains(rec.Body.String(), `"wasRunning":true`) {
		t.Fatalf("stop did not cancel: %s", rec.Body)
	}
	rec = httptest.NewRecorder()
	a.handleDedupScan(rec, httptest.NewRequest(http.MethodPost, "/api/maintenance/dedup/scan", nil))
	if !strings.Contains(rec.Body.String(), `"alreadyRunning":true`) {
		t.Fatalf("second scan started while one runs: %s", rec.Body)
	}
	a.dedupMu.Lock()
	a.dedupScanCancel = nil
	a.dedupMu.Unlock()
}

func TestSkipDuplicatesIsOptIn(t *testing.T) {
	a, _ := socketTestApp(t)
	ctx := context.Background()
	if a.skipDuplicates(ctx) {
		t.Fatal("skipDuplicates is on without being set")
	}
	cfg, err := a.config.Load(ctx)
	if err != nil {
		t.Fatal(err)
	}
	cfg["download"] = map[string]any{"skipDuplicates": true}
	if err := a.config.Save(ctx, cfg); err != nil {
		t.Fatal(err)
	}
	if !a.skipDuplicates(ctx) {
		t.Fatal("download.skipDuplicates=true ignored")
	}
}
