package front

import (
	"errors"
	"fmt"
	"net"
	"path/filepath"
	"strings"
)

// Config is the environment of `tgdl-core front`. The Node app passes all
// of it (never argv); nothing here is a long-lived secret — the share
// secret the file tokens need arrives later over the control channel.
//
//	TGDL_CORE_TOKEN            control-channel token (X-API-Token), required
//	TGDL_FRONT_LISTEN          public address, e.g. ":3000" (the app's PORT)
//	TGDL_FRONT_UPSTREAM        the Node server, "127.0.0.1:<port>"
//	TGDL_FRONT_UPSTREAM_TOKEN  sent to Node as X-Tgdl-Front on every request
//	TGDL_FRONT_TRUST_PROXY     Express `trust proxy` in effect ("" = none)
//	TGDL_FRONT_DB              db.sqlite (read-only: web_sessions)
//	TGDL_FRONT_DOWNLOADS_DIR   what /files/* resolves against
//	TGDL_FRONT_PHOTOS_DIR      /photos/*
//	TGDL_FRONT_THUMBS_DIR      /api/thumbs/:id cache
//	TGDL_CORE_ALLOW_ROOTS      every file served must be inside one of these
//	TGDL_CORE_PORT             control port on 127.0.0.1 (0 = any)
//	TGDL_CORE_WATCH_STDIN      1 = exit when the parent closes stdin
//	TGDL_CORE_LOG_LEVEL        debug | info | warn | error
type Config struct {
	Token         string
	Listen        string
	Upstream      string
	UpstreamToken string
	TrustProxy    string
	DBPath        string
	DownloadsDir  string
	PhotosDir     string
	ThumbsDir     string
	AllowRoots    []string
	ControlPort   int
	WatchStdin    bool
	LogLevel      string
}

// FromEnv reads the front server's settings.
func FromEnv(getenv func(string) string) (Config, error) {
	c := Config{
		Token:         strings.TrimSpace(getenv("TGDL_CORE_TOKEN")),
		Listen:        strings.TrimSpace(getenv("TGDL_FRONT_LISTEN")),
		Upstream:      strings.TrimSpace(getenv("TGDL_FRONT_UPSTREAM")),
		UpstreamToken: strings.TrimSpace(getenv("TGDL_FRONT_UPSTREAM_TOKEN")),
		TrustProxy:    getenv("TGDL_FRONT_TRUST_PROXY"),
		DBPath:        strings.TrimSpace(getenv("TGDL_FRONT_DB")),
		DownloadsDir:  strings.TrimSpace(getenv("TGDL_FRONT_DOWNLOADS_DIR")),
		PhotosDir:     strings.TrimSpace(getenv("TGDL_FRONT_PHOTOS_DIR")),
		ThumbsDir:     strings.TrimSpace(getenv("TGDL_FRONT_THUMBS_DIR")),
		WatchStdin:    isTrue(getenv("TGDL_CORE_WATCH_STDIN")),
		LogLevel:      strings.ToLower(strings.TrimSpace(getenv("TGDL_CORE_LOG_LEVEL"))),
	}
	for _, d := range filepath.SplitList(getenv("TGDL_CORE_ALLOW_ROOTS")) {
		if d = strings.TrimSpace(d); d != "" {
			c.AllowRoots = append(c.AllowRoots, d)
		}
	}
	if p := strings.TrimSpace(getenv("TGDL_CORE_PORT")); p != "" {
		if _, err := fmt.Sscanf(p, "%d", &c.ControlPort); err != nil || c.ControlPort < 0 || c.ControlPort > 65535 {
			return c, fmt.Errorf("TGDL_CORE_PORT: invalid port %q", p)
		}
	}
	if c.LogLevel == "" {
		c.LogLevel = "info"
	}
	switch {
	case c.Token == "":
		return c, errors.New("TGDL_CORE_TOKEN is required")
	case c.UpstreamToken == "":
		return c, errors.New("TGDL_FRONT_UPSTREAM_TOKEN is required")
	case c.Listen == "":
		return c, errors.New("TGDL_FRONT_LISTEN is required")
	}
	if _, _, err := net.SplitHostPort(c.Listen); err != nil {
		return c, fmt.Errorf("TGDL_FRONT_LISTEN: %w", err)
	}
	host, _, err := net.SplitHostPort(c.Upstream)
	if err != nil {
		return c, fmt.Errorf("TGDL_FRONT_UPSTREAM: %w", err)
	}
	if ip := net.ParseIP(host); ip == nil || !ip.IsLoopback() {
		return c, errors.New("TGDL_FRONT_UPSTREAM must be a loopback address")
	}
	for _, d := range []*string{&c.DownloadsDir, &c.PhotosDir, &c.ThumbsDir, &c.DBPath} {
		if *d != "" && !filepath.IsAbs(*d) {
			return c, fmt.Errorf("%q must be absolute", *d)
		}
	}
	return c, nil
}

func isTrue(s string) bool {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "1", "true", "yes", "on":
		return true
	}
	return false
}
