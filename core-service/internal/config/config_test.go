package config

import (
	"errors"
	"testing"
)

func TestPoolSizeMatchesNodeSemantics(t *testing.T) {
	cases := []struct {
		raw  string
		cpus int
		want int
	}{
		// Env set to a usable integer: taken as is, capped at 32.
		{"1", 8, 1},
		{"4", 8, 4},
		{"32", 8, 32},
		{"33", 8, 32},
		{"100000000000000000000000", 8, 32},
		// parseInt leniency.
		{" 7", 8, 7},
		{"\t3\n", 8, 3},
		{"+5", 8, 5},
		{"4abc", 8, 4},
		{"1e3", 8, 1},
		{"0x10", 8, 4}, // parseInt("0x10", 10) === 0 -> default
		// Unusable values fall back to the default.
		{"", 8, 4},
		{"abc", 8, 4},
		{"0", 8, 4},
		{"-3", 8, 4},
		// Default: min(max(2, floor(cpus/2)), 8).
		{"", 1, 2},
		{"", 2, 2},
		{"", 3, 2},
		{"", 4, 2},
		{"", 6, 3},
		{"", 16, 8},
		{"", 64, 8},
		{"", 0, 2},
	}
	for _, c := range cases {
		if got := PoolSize(c.raw, c.cpus); got != c.want {
			t.Errorf("PoolSize(%q, %d) = %d, want %d", c.raw, c.cpus, got, c.want)
		}
	}
}

func TestFromEnv(t *testing.T) {
	env := map[string]string{
		"TGDL_CORE_TOKEN":       " secret ",
		"TGDL_CORE_PORT":        "4567",
		"TGDL_CORE_WATCH_STDIN": "1",
		"HASH_WORKER_POOL_SIZE": "3",
	}
	cfg, err := FromEnv(func(k string) string { return env[k] }, 8)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Token != "secret" || cfg.Port != 4567 || !cfg.WatchStdin || cfg.HashConcurrency != 3 || cfg.LogLevel != "info" {
		t.Fatalf("unexpected config: %+v", cfg)
	}
}

func TestFromEnvRequiresToken(t *testing.T) {
	_, err := FromEnv(func(string) string { return "" }, 4)
	if !errors.Is(err, ErrNoToken) {
		t.Fatalf("want ErrNoToken, got %v", err)
	}
}

func TestFromEnvRejectsBadPort(t *testing.T) {
	for _, p := range []string{"-1", "65536", "abc"} {
		env := map[string]string{"TGDL_CORE_TOKEN": "t", "TGDL_CORE_PORT": p}
		if _, err := FromEnv(func(k string) string { return env[k] }, 4); err == nil {
			t.Errorf("port %q: expected an error", p)
		}
	}
}
