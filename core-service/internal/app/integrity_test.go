package app

import (
	"context"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"
)

func rowCount(t *testing.T, a *App, where string, args ...any) int {
	t.Helper()
	var n int
	if err := a.db.Reader.QueryRow(`SELECT count(*) FROM downloads WHERE `+where, args...).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func TestIntegritySweepPrunesMissingAndFixesSizes(t *testing.T) {
	a, _ := socketTestApp(t)
	ctx := context.Background()
	rescueFile(t, a, "ok.bin")                 // 4 bytes, stored 4
	rescueFile(t, a, "resized.bin")            // 4 bytes, stored 9
	rescueFile(t, a, "legacy.bin")             // stored as data/downloads/legacy.bin
	rescueFile(t, a, "notdir.bin")             // a file used as a directory
	empty := rescueFile(t, a, "empty.bin")     // truncated to 0 below
	outside := filepath.Join(t.TempDir(), "x") // a custom download path
	if err := os.WriteFile(outside, []byte("live"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Truncate(empty, 0); err != nil {
		t.Fatal(err)
	}
	for id, path := range map[int]string{1: "ok.bin", 2: "resized.bin", 3: "data/downloads/legacy.bin", 4: "notdir.bin/child.bin", 5: "empty.bin", 6: "gone.bin", 7: "_clusterref/peer/9", 8: outside, 9: outside + ".missing"} {
		rescueInsert(t, a, id, path, nil, nil, 0)
	}
	if _, err := a.db.Writer.Exec(`UPDATE downloads SET file_size=9 WHERE id=2`); err != nil {
		t.Fatal(err)
	}
	if _, err := a.db.Writer.Exec(`INSERT INTO seekbar_sprites(download_id,sprite_path,meta_path,generated_at) VALUES(6,'6.webp','6.json',1)`); err != nil {
		t.Fatal(err)
	}
	res, err := a.sweepIntegrity(ctx, true, nil)
	if err != nil || res.Pruned != 4 || res.SizeFixed != 1 || res.Scanned != 9 || res.Skipped {
		t.Fatalf("sweep %+v %v", res, err)
	}
	for _, id := range []int{4, 5, 6, 9} {
		if rowCount(t, a, "id=?", id) != 0 {
			t.Fatalf("row %d with a missing or empty file kept", id)
		}
	}
	for _, id := range []int{1, 2, 3, 7, 8} {
		if rowCount(t, a, "id=?", id) != 1 {
			t.Fatalf("row %d pruned", id)
		}
	}
	if rowCount(t, a, "id=2 AND file_size=4") != 1 {
		t.Fatal("stale file_size not corrected")
	}
	if _, err := os.Stat(empty); err != nil {
		t.Fatal("the sweep prunes rows, never files:", err)
	}
	var sprites int
	if err := a.db.Reader.QueryRow(`SELECT count(*) FROM seekbar_sprites WHERE download_id=6`).Scan(&sprites); err != nil || sprites != 0 {
		t.Fatalf("derived data of a pruned row kept: %d %v", sprites, err)
	}
}

func TestIntegrityAutoSweepRefusesMassPrune(t *testing.T) {
	a, _ := socketTestApp(t)
	ctx := context.Background()
	rescueFile(t, a, "present.bin")
	rescueInsert(t, a, 1, "present.bin", nil, nil, 0)
	for id := 2; id <= 25; id++ {
		rescueInsert(t, a, id, "missing-"+strconv.Itoa(id)+".bin", nil, nil, 0)
	}
	res, err := a.sweepIntegrity(ctx, true, nil)
	if err != nil || !res.Skipped || res.Reason != "too_many_missing" || res.Missing != 24 || res.Pruned != 0 {
		t.Fatalf("automatic sweep %+v %v", res, err)
	}
	if rowCount(t, a, "1") != 25 {
		t.Fatal("automatic sweep pruned a mostly-missing library")
	}
	// The operator's explicit Verify files run still prunes.
	res, err = a.sweepIntegrity(ctx, false, nil)
	if err != nil || res.Pruned != 24 || rowCount(t, a, "1") != 1 {
		t.Fatalf("manual sweep %+v %v", res, err)
	}
}

func TestIntegritySweepSkipsUnavailableDownloadsAndConcurrentRun(t *testing.T) {
	a, _ := socketTestApp(t)
	ctx := context.Background()
	rescueInsert(t, a, 1, "gone.bin", nil, nil, 0)
	if err := os.RemoveAll(a.downloadsDir); err != nil {
		t.Fatal(err)
	}
	res, err := a.sweepIntegrity(ctx, false, nil)
	if err != nil || !res.Skipped || res.Reason != "downloads_dir_unavailable" || rowCount(t, a, "1") != 1 {
		t.Fatalf("unmounted downloads %+v %v", res, err)
	}
	if err := os.MkdirAll(a.downloadsDir, 0o700); err != nil {
		t.Fatal(err)
	}
	a.filesSweeping.Store(true)
	res, err = a.sweepIntegrity(ctx, true, nil)
	a.filesSweeping.Store(false)
	if err != nil || res.Reason != "already_running" || rowCount(t, a, "1") != 1 {
		t.Fatalf("overlapping sweep %+v %v", res, err)
	}
}

func TestIntegrityPruneRechecksRowAndFile(t *testing.T) {
	a, _ := socketTestApp(t)
	ctx := context.Background()
	rescueInsert(t, a, 1, "moved.bin", nil, nil, 0)
	rescueInsert(t, a, 2, "back.bin", nil, nil, 0)
	stale := []integrityRow{{id: 1, path: "old.bin", abs: filepath.Join(a.downloadsDir, "old.bin")}, {id: 2, path: "back.bin", abs: rescueFile(t, a, "back.bin")}}
	n, err := a.pruneMissingRows(ctx, stale)
	if err != nil || n != 0 || rowCount(t, a, "1") != 2 {
		t.Fatalf("pruned a re-published row or a reappeared file: %d %v", n, err)
	}
}

func TestIntegritySweeperRunsAfterBoot(t *testing.T) {
	saved := integrityBootDelay
	integrityBootDelay = 300 * time.Millisecond // room to seed the row first
	defer func() { integrityBootDelay = saved }()
	a, err := newConfiguredTestApp(context.Background(), Config{DataDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	if err := os.MkdirAll(a.downloadsDir, 0o700); err != nil {
		t.Fatal(err)
	}
	rescueInsert(t, a, 1, "gone.bin", nil, nil, 0)
	deadline := time.Now().Add(5 * time.Second)
	for rowCount(t, a, "1") != 0 {
		if time.Now().After(deadline) {
			t.Fatal("the periodic sweep did not prune the dead row")
		}
		time.Sleep(10 * time.Millisecond)
	}
}
