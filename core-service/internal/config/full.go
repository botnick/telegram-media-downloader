package config

import (
	"errors"
	"fmt"
	"net"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// FullConfig is the strict process configuration for the Go application.
type FullConfig struct {
	DataDir string
	// DownloadsDir is TGDL_DOWNLOADS_DIR (split-disk installs); empty means
	// <data>/downloads, the same default as the Node releases.
	DownloadsDir string
	DBPath       string
	Port         int
	BindHost     string
	CookieName   string
	SessionTTL   time.Duration
}

func FromFullEnv(getenv func(string) string) (FullConfig, error) {
	dataDir := strings.TrimSpace(getenv("TGDL_DATA_DIR"))
	if dataDir == "" {
		return FullConfig{}, errors.New("TGDL_DATA_DIR is required")
	}
	port := 3000
	bindHost := strings.TrimSpace(getenv("TGDL_BIND_HOST"))
	if bindHost != "" && net.ParseIP(bindHost) == nil {
		return FullConfig{}, errors.New("TGDL_BIND_HOST must be a literal IPv4 or IPv6 address")
	}
	if raw := strings.TrimSpace(getenv("PORT")); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n < 1 || n > 65535 {
			return FullConfig{}, fmt.Errorf("PORT: invalid port %q", raw)
		}
		port = n
	}
	ttlDays := 7
	if raw := strings.TrimSpace(getenv("TGDL_SESSION_TTL_DAYS")); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n < 1 || n > 3650 {
			return FullConfig{}, fmt.Errorf("TGDL_SESSION_TTL_DAYS: invalid value %q", raw)
		}
		ttlDays = n
	}
	downloadsDir := strings.TrimSpace(getenv("TGDL_DOWNLOADS_DIR"))
	if downloadsDir != "" {
		abs, err := filepath.Abs(downloadsDir)
		if err != nil {
			return FullConfig{}, fmt.Errorf("TGDL_DOWNLOADS_DIR: %w", err)
		}
		downloadsDir = abs
	}
	return FullConfig{DataDir: dataDir, DownloadsDir: downloadsDir, DBPath: filepath.Join(dataDir, "db.sqlite"), Port: port, BindHost: bindHost, CookieName: "tg_dl_session", SessionTTL: time.Duration(ttlDays) * 24 * time.Hour}, nil
}
