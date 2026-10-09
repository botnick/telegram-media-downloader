package app

import (
	"context"
	"testing"
	"time"
)

func TestVacuumReportsActualPagesIncludingSmallDatabaseGrowth(t *testing.T) {
	a, err := newConfiguredTestApp(context.Background(), Config{DataDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	var before, after, size int64
	if err = a.db.Writer.QueryRow(`PRAGMA page_count`).Scan(&before); err != nil {
		t.Fatal(err)
	}
	if err = a.db.Writer.QueryRow(`PRAGMA page_size`).Scan(&size); err != nil {
		t.Fatal(err)
	}
	a.runDBVacuum(maintenanceIdleStatus("dbVacuum"), time.Now(), 2)
	if err = a.db.Writer.QueryRow(`PRAGMA page_count`).Scan(&after); err != nil {
		t.Fatal(err)
	}
	status := a.vacuumStatus
	result, ok := status["result"].(map[string]any)
	if !ok || status["stage"] != "done" || status["successes"] != 3 {
		t.Fatalf("vacuum status %v", status)
	}
	if result["beforeBytes"] != before*size || result["afterBytes"] != after*size || result["reclaimedBytes"] != maxInt64(0, (before-after)*size) {
		t.Fatalf("invented vacuum metrics: %v, SQLite %d -> %d pages", result, before, after)
	}
	t.Logf("SQLite logical pages: %d -> %d (page size %d)", before, after, size)
}
func TestVacuumDatabaseFailureDoesNotReportSuccess(t *testing.T) {
	a, err := newConfiguredTestApp(context.Background(), Config{DataDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	if err = a.db.Writer.Close(); err != nil {
		t.Fatal(err)
	}
	a.runDBVacuum(maintenanceIdleStatus("dbVacuum"), time.Now(), 2)
	s := a.vacuumStatus
	if s["stage"] != "error" || s["error"] == nil || s["result"] != nil || s["successes"] != 2 || s["failures"] != 1 {
		t.Fatalf("database failure reported success: %v", s)
	}
}
