// Package config reads tgdl-core's settings from the environment.
//
// The Node parent passes a minimal environment (never argv, so the token
// does not show up in `ps`):
//
//	TGDL_CORE_TOKEN         shared secret for every route except /health (required)
//	TGDL_CORE_PORT          listen port on 127.0.0.1; 0 or unset = pick a free one
//	TGDL_CORE_WATCH_STDIN   "1" = exit when stdin reaches EOF (parent died)
//	TGDL_CORE_LOG_LEVEL     debug | info (default) | warn | error
//	HASH_WORKER_POOL_SIZE   hash concurrency, same rules as the Node worker pool
package config

import (
	"errors"
	"fmt"
	"strconv"
	"strings"
	"unicode"
)

// Config is the effective runtime configuration.
type Config struct {
	Port            int
	Token           string
	HashConcurrency int
	WatchStdin      bool
	LogLevel        string
}

// ErrNoToken is returned by FromEnv when TGDL_CORE_TOKEN is empty.
var ErrNoToken = errors.New("TGDL_CORE_TOKEN is required")

// FromEnv builds a Config. getenv is os.Getenv in production; numCPU is
// runtime.NumCPU().
func FromEnv(getenv func(string) string, numCPU int) (Config, error) {
	cfg := Config{
		Token:           strings.TrimSpace(getenv("TGDL_CORE_TOKEN")),
		HashConcurrency: PoolSize(getenv("HASH_WORKER_POOL_SIZE"), numCPU),
		WatchStdin:      isTrue(getenv("TGDL_CORE_WATCH_STDIN")),
		LogLevel:        strings.ToLower(strings.TrimSpace(getenv("TGDL_CORE_LOG_LEVEL"))),
	}
	if cfg.LogLevel == "" {
		cfg.LogLevel = "info"
	}
	if raw := strings.TrimSpace(getenv("TGDL_CORE_PORT")); raw != "" {
		p, err := strconv.Atoi(raw)
		if err != nil || p < 0 || p > 65535 {
			return cfg, fmt.Errorf("TGDL_CORE_PORT: invalid port %q", raw)
		}
		cfg.Port = p
	}
	if cfg.Token == "" {
		return cfg, ErrNoToken
	}
	return cfg, nil
}

func isTrue(s string) bool {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "1", "true", "yes", "on":
		return true
	}
	return false
}

// PoolSize mirrors resolvePoolSize() in src/core/hash-worker.js so one
// HASH_WORKER_POOL_SIZE value means the same thing on both sides:
//
//	parseInt(env, 10) >= 1  -> min(env, 32)
//	otherwise               -> min(max(2, floor(cpus / 2)), 8)
//
// parseInt is lenient: leading whitespace and a sign are skipped and
// parsing stops at the first non-digit ("4abc" is 4, "1e3" is 1).
func PoolSize(raw string, numCPU int) int {
	if n, ok := jsParseInt(raw); ok && n >= 1 {
		if n > 32 {
			return 32
		}
		return int(n)
	}
	if numCPU <= 0 {
		numCPU = 2 // os.cpus()?.length || 2
	}
	def := numCPU / 2
	if def < 2 {
		def = 2
	}
	if def > 8 {
		def = 8
	}
	return def
}

// jsParseInt implements JavaScript's parseInt(s, 10) for the integer
// range we care about. Values past int64 saturate, which is fine because
// the caller caps at 32.
func jsParseInt(s string) (int64, bool) {
	s = strings.TrimLeftFunc(s, func(r rune) bool {
		return unicode.IsSpace(r) || r == 0xFEFF
	})
	neg := false
	if s != "" && (s[0] == '+' || s[0] == '-') {
		neg = s[0] == '-'
		s = s[1:]
	}
	var n int64
	digits := 0
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c < '0' || c > '9' {
			break
		}
		digits++
		if n < 1<<62 {
			n = n*10 + int64(c-'0')
		}
	}
	if digits == 0 {
		return 0, false
	}
	if neg {
		n = -n
	}
	return n, true
}
