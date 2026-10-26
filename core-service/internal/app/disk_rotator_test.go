package app

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestParseDiskSize(t *testing.T) {
	for in, want := range map[any]int64{
		"10 GB": 10 << 30, "500MB": 500 << 20, "1.5 TB": 3 << 39, "2k": 2048, "7": 7, "7 b": 7,
		float64(1234): 1234, "": 0, "ten GB": 0, "-5GB": 0, "5 PB": 0, "1e3": 0, float64(-1): 0, nil: 0, true: 0,
	} {
		if got := parseDiskSize(in); got != want {
			t.Errorf("parseDiskSize(%v) = %d, want %d", in, got, want)
		}
	}
}

func setDiskRotation(t *testing.T, a *App, enabled bool, maxTotal any, adv map[string]any) {
	t.Helper()
	cfg, err := a.config.Load(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	cfg["diskManagement"] = map[string]any{"enabled": enabled, "maxTotalSize": maxTotal, "sweepIntervalMin": float64(10)}
	if adv != nil {
		cfg["advanced"] = map[string]any{"diskRotator": adv}
	}
	if err = a.config.Save(context.Background(), cfg); err != nil {
		t.Fatal(err)
	}
}

// rotationRow inserts a 4-byte download created `age` hours ago.
func rotationRow(t *testing.T, a *App, id, age int, path string) {
	t.Helper()
	rescueInsert(t, a, id, path, nil, nil, 0)
	if _, err := a.db.Writer.Exec(`UPDATE downloads SET created_at=datetime('now',?) WHERE id=?`, -age*3600, id); err != nil {
		t.Fatal(err)
	}
}

func exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

func TestDiskRotatorOffUnlessEnabledWithCap(t *testing.T) {
	a, _ := socketTestApp(t)
	file := rescueFile(t, a, "old.bin")
	for id := 1; id <= 3; id++ {
		rotationRow(t, a, id, 10-id, "old.bin")
	}
	for _, tc := range []struct {
		enabled bool
		cap     any
	}{{false, "1B"}, {true, nil}, {true, ""}, {true, "0"}, {true, "lots"}} {
		setDiskRotation(t, a, tc.enabled, tc.cap, nil)
		res, active, err := a.sweepDiskRotator(context.Background())
		if err != nil || active || res.Deleted != 0 || rowCount(t, a, "1") != 3 || !exists(file) {
			t.Fatalf("enabled=%v cap=%v rotated: %+v active=%v %v", tc.enabled, tc.cap, res, active, err)
		}
	}
	// Three rows share one 4-byte file: the disk holds 4 bytes, not 12.
	setDiskRotation(t, a, true, "4B", nil) // exactly the total
	if res, active, err := a.sweepDiskRotator(context.Background()); err != nil || !active || res.Deleted != 0 || res.Before != 4 {
		t.Fatalf("at the cap: %+v %v", res, err)
	}
}

func TestDiskRotatorDeletesOldestUnprotectedUntilUnderCap(t *testing.T) {
	a, _ := socketTestApp(t)
	ctx := context.Background()
	outside := filepath.Join(t.TempDir(), "elsewhere.bin")
	if err := os.WriteFile(outside, []byte("live"), 0o600); err != nil {
		t.Fatal(err)
	}
	files := map[string]string{}
	for _, name := range []string{"pinned.bin", "rescued.bin", "inflight.bin", "shared.bin", "oldest.bin", "old.bin", "newer.bin", "newest.bin"} {
		files[name] = rescueFile(t, a, name)
	}
	rotationRow(t, a, 1, 100, "pinned.bin")
	rotationRow(t, a, 2, 99, "rescued.bin")
	rotationRow(t, a, 3, 98, "inflight.bin")
	rotationRow(t, a, 4, 97, "shared.bin") // shares its file with row 9
	rotationRow(t, a, 5, 96, outside)      // a path outside the downloads root
	rotationRow(t, a, 6, 95, "../escape.bin")
	rotationRow(t, a, 7, 94, "oldest.bin")
	rotationRow(t, a, 8, 93, "old.bin")
	rotationRow(t, a, 9, 2, "shared.bin")
	rotationRow(t, a, 10, 1, "newer.bin")
	rotationRow(t, a, 11, 0, "newest.bin")
	if _, err := a.db.Writer.Exec(`UPDATE downloads SET pinned=1 WHERE id=1; UPDATE downloads SET rescued_at=1 WHERE id=2;
		INSERT INTO tgdl_ingest_files(path,item,generation) VALUES('inflight.bin','{}',1)`); err != nil {
		t.Fatal(err)
	}
	client := a.hub.Add("admin")
	defer a.hub.Remove(client)
	// 10 files × 4 bytes = 40 (rows 4 and 9 share one); a 26-byte cap needs
	// 16 bytes gone: row 4 frees nothing while row 9 keeps its file, so the
	// oldest five rows go.
	setDiskRotation(t, a, true, "26B", map[string]any{"sweepBatch": float64(2)})
	res, active, err := a.sweepDiskRotator(ctx)
	if err != nil || !active || res != (diskRotatorResult{Before: 40, Deleted: 5, After: 24, CapBytes: 26}) {
		t.Fatalf("sweep %+v active=%v %v", res, active, err)
	}
	for _, id := range []int{4, 5, 6, 7, 8} {
		if rowCount(t, a, "id=?", id) != 0 {
			t.Fatalf("row %d not rotated", id)
		}
	}
	for _, id := range []int{1, 2, 3, 9, 10, 11} {
		if rowCount(t, a, "id=?", id) != 1 {
			t.Fatalf("row %d rotated", id)
		}
	}
	for name, path := range files {
		gone := name == "oldest.bin" || name == "old.bin"
		if exists(path) == gone {
			t.Fatalf("%s exists=%v after rotation", name, !gone)
		}
	}
	if !exists(outside) {
		t.Fatal("rotation deleted a file outside the downloads root")
	}
	deleted := map[float64]bool{}
	for len(client.Events()) > 0 {
		for _, e := range (<-client.Events()).Frames() {
			if e.Type == "file_deleted" {
				p := e.Payload.(map[string]any)
				if p["source"] != "disk_rotator" {
					t.Fatalf("event %+v", p)
				}
				deleted[float64(p["id"].(int64))] = true
			}
		}
	}
	if len(deleted) != 5 {
		t.Fatalf("file_deleted events for %v", deleted)
	}
	// Everything left above the cap is protected or newer: a second pass
	// keeps deleting oldest-first and never touches the protected rows.
	setDiskRotation(t, a, true, "1B", nil)
	if res, _, err = a.sweepDiskRotator(ctx); err != nil || res.Deleted != 3 || rowCount(t, a, "1") != 3 {
		t.Fatalf("second sweep %+v %v", res, err)
	}
	if !exists(files["pinned.bin"]) || !exists(files["rescued.bin"]) || !exists(files["inflight.bin"]) || exists(files["shared.bin"]) {
		t.Fatal("protected files removed, or the shared file outlived its last row")
	}
}

func TestDiskRotatorStopsAtMaxDeletesPerSweep(t *testing.T) {
	a, _ := socketTestApp(t)
	for id := 1; id <= 6; id++ {
		rescueFile(t, a, "f"+string(rune('0'+id))+".bin")
		rotationRow(t, a, id, 10-id, "f"+string(rune('0'+id))+".bin")
	}
	setDiskRotation(t, a, true, "1B", map[string]any{"sweepBatch": float64(50), "maxDeletesPerSweep": float64(4)})
	res, _, err := a.sweepDiskRotator(context.Background())
	if err != nil || res.Deleted != 4 || rowCount(t, a, "1") != 2 || rowCount(t, a, "id IN (5,6)") != 2 {
		t.Fatalf("budgeted sweep %+v %v", res, err)
	}
}

func TestDiskRotatorLoopAppliesSettingsChange(t *testing.T) {
	saved := diskRotatorStartDelay
	diskRotatorStartDelay = 10 * time.Millisecond
	// Registered before socketTestApp: restore only after its cleanup has
	// closed the app and joined the background rotator.
	t.Cleanup(func() { diskRotatorStartDelay = saved })
	a, _ := socketTestApp(t)
	rescueFile(t, a, "a.bin")
	rotationRow(t, a, 1, 1, "a.bin")
	setDiskRotation(t, a, true, "1B", nil)
	a.wakeDiskRotator()
	deadline := time.Now().Add(5 * time.Second)
	for {
		a.maintenanceMu.Lock()
		status := cloneConfigValue(a.diskRotatorStatus).(map[string]any)
		a.maintenanceMu.Unlock()
		if status["lastRotation"] != nil {
			if status["enabled"] != true || rowCount(t, a, "1") != 0 {
				t.Fatalf("status %+v", status)
			}
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("enabling rotation did not trigger a sweep")
		}
		time.Sleep(10 * time.Millisecond)
	}
}
