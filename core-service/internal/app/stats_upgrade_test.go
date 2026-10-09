package app

import (
	"context"
	"testing"
)

// Node releases stored telegram.apiId as a JSON number; an upgraded install
// must still report its API credentials as configured.
func TestStatsTreatsNumericNodeAPIIDAsConfigured(t *testing.T) {
	a, err := newConfiguredTestApp(context.Background(), Config{DataDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	cfg, err := a.config.Load(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	cfg["telegram"] = map[string]any{"apiId": float64(12345), "apiHash": "0123456789abcdef0123456789abcdef"}
	if err := a.config.Save(context.Background(), cfg); err != nil {
		t.Fatal(err)
	}
	stats, ok := a.statsPayload(context.Background())
	if !ok || stats["apiConfigured"] != true {
		t.Fatalf("stats=%v", stats)
	}
}
