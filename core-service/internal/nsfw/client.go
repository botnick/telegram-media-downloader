// Package nsfw talks to the external NSFW classification sidecar
// (nsfw-service/main.py). The Go server has no in-process model, so every
// score comes from the sidecar over HTTP.
//
// Wire format:
//
//	GET  /health          → { ok, model, ready, version, device, features, auth_required, path_mode, max_upload_bytes }
//	POST /classify        { path | image_b64 } → { score, label } | { error: "file_not_found" }
//	                      → 403 { code: "path_not_allowed" } when path mode is off
//	POST /classify/upload raw image bytes → { score, label }
//
// Every route but /health answers 401 when the sidecar has a token and the
// `X-API-Token` header does not match it.
package nsfw

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"slices"
	"sync"
	"time"
)

// TokenHeader carries the shared sidecar token.
const TokenHeader = "X-API-Token"

const (
	healthTTL            = 5 * time.Second
	healthTimeout        = 5 * time.Second
	healthAttempts       = 3
	defaultTimeout       = 30 * time.Second
	defaultRetries       = 3
	defaultMaxUpload     = 50 << 20
	uploadMinBytesPerSec = 128 << 10
	maxResponseBytes     = 1 << 20
)

var defaultBackoff = []time.Duration{300 * time.Millisecond, 600 * time.Millisecond, 1200 * time.Millisecond}

var (
	// ErrNotConfigured means no sidecar URL is set.
	ErrNotConfigured = errors.New("NSFW sidecar is not configured")
	// ErrUnauthorized means the sidecar rejected the API token.
	ErrUnauthorized = errors.New("NSFW sidecar rejected the API token")
	// ErrUnavailable wraps transport failures after retries were exhausted.
	ErrUnavailable = errors.New("NSFW sidecar unavailable")
)

// Settings is the live sidecar configuration. Zero durations and retries
// fall back to the 2.x defaults.
type Settings struct {
	URL            string
	Token          string
	PathMap        string
	RequestTimeout time.Duration
	MaxRetries     int
	Backoff        []time.Duration
}

// Health is the parsed /health answer.
type Health struct {
	OK           bool     `json:"ok"`
	Version      any      `json:"version"`
	Model        any      `json:"model"`
	Ready        bool     `json:"ready"`
	Device       any      `json:"device"`
	Features     []string `json:"features"`
	AuthRequired *bool    `json:"authRequired"`
	PathMode     *bool    `json:"pathMode"`
	Error        string   `json:"error,omitempty"`
}

// Image is one file to classify. Path is the absolute app-side path used
// for path mode ("" skips it); Load returns the bytes for the upload
// fallback.
type Image struct {
	Path string
	Load func() ([]byte, error)
}

// Client is safe for concurrent use. Path-mode rejection and the probed
// feature list are remembered per configured URL, like the 2.x client.
type Client struct {
	hc *http.Client

	mu           sync.Mutex
	settings     Settings
	rules        []Rule
	features     []string
	probed       bool
	maxUpload    int64
	pathRejected bool
	health       Health
	healthAt     time.Time
}

// NewClient returns a client using hc (http.DefaultClient when nil).
func NewClient(hc *http.Client) *Client {
	if hc == nil {
		hc = http.DefaultClient
	}
	return &Client{hc: hc, maxUpload: defaultMaxUpload}
}

// Configure applies s. Changing the URL resets everything learned about the
// previous sidecar; changing the token or path map resets only what they
// affect.
func (c *Client) Configure(s Settings) {
	s.URL = NormalizeURL(s.URL)
	c.mu.Lock()
	defer c.mu.Unlock()
	old := c.settings
	if s.URL != old.URL {
		c.features, c.probed, c.maxUpload, c.pathRejected, c.healthAt = nil, false, defaultMaxUpload, false, time.Time{}
	}
	if s.Token != old.Token {
		c.healthAt = time.Time{}
	}
	if s.PathMap != old.PathMap || c.rules == nil {
		c.rules, c.pathRejected = ParsePathMap(s.PathMap), false
	}
	c.settings = s
}

// Info is a dashboard snapshot; it never includes the token itself.
func (c *Client) Info() map[string]any {
	c.mu.Lock()
	defer c.mu.Unlock()
	var url, transfer any
	if c.settings.URL != "" {
		url, transfer = c.settings.URL, "path"
		if c.pathRejected {
			transfer = "upload"
		}
	}
	var features any
	if c.probed {
		features = slices.Clone(c.features)
	}
	return map[string]any{"url": url, "tokenSet": c.settings.Token != "", "pathMapRules": len(c.rules), "features": features, "transfer": transfer}
}

func (c *Client) snapshot() Settings {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.settings
}

// Health probes /health, cached for a few seconds.
func (c *Client) Health(ctx context.Context) Health {
	s := c.snapshot()
	if s.URL == "" {
		return Health{Error: "sidecar_url_unset"}
	}
	c.mu.Lock()
	if !c.healthAt.IsZero() && time.Since(c.healthAt) < healthTTL {
		h := c.health
		c.mu.Unlock()
		return h
	}
	c.mu.Unlock()
	var h Health
	var lastErr error
	for attempt := 0; attempt < healthAttempts && ctx.Err() == nil; attempt++ {
		var status int
		var body []byte
		status, body, lastErr = c.do(ctx, s, http.MethodGet, "/health", nil, "", healthTimeout)
		if lastErr != nil {
			continue
		}
		if status < 200 || status > 299 {
			lastErr = fmt.Errorf("http_%d", status)
			if status < 500 {
				break
			}
			continue
		}
		var raw struct {
			OK             bool     `json:"ok"`
			Version        any      `json:"version"`
			Model          any      `json:"model"`
			Ready          bool     `json:"ready"`
			Device         any      `json:"device"`
			Features       []any    `json:"features"`
			AuthRequired   *bool    `json:"auth_required"`
			PathMode       *bool    `json:"path_mode"`
			MaxUploadBytes *float64 `json:"max_upload_bytes"`
		}
		if err := json.Unmarshal(body, &raw); err != nil {
			lastErr = errors.New("not a sidecar (invalid JSON)")
			break
		}
		h = Health{OK: raw.OK, Version: raw.Version, Model: raw.Model, Ready: raw.Ready, Device: raw.Device, Features: []string{}, AuthRequired: raw.AuthRequired, PathMode: raw.PathMode}
		for _, f := range raw.Features {
			h.Features = append(h.Features, fmt.Sprint(f))
		}
		c.mu.Lock()
		if c.settings.URL == s.URL {
			c.features, c.probed = h.Features, true
			if raw.MaxUploadBytes != nil && *raw.MaxUploadBytes > 0 {
				c.maxUpload = int64(*raw.MaxUploadBytes)
			}
		}
		c.mu.Unlock()
		lastErr = nil
		break
	}
	if lastErr != nil {
		h = Health{Error: lastErr.Error()}
	} else if ctx.Err() != nil && !h.OK && h.Error == "" {
		h.Error = ctx.Err().Error()
	}
	if ctx.Err() == nil {
		c.mu.Lock()
		if c.settings.URL == s.URL {
			c.health, c.healthAt = h, time.Now()
		}
		c.mu.Unlock()
	}
	return h
}

// Classify scores one image. It tries path mode first (through the path
// map); a 403 path_not_allowed switches the session to uploads, and a
// file_not_found uploads just this file.
//
// A nil score with a nil error means this file cannot be scored (missing,
// undecodable, too large). A non-nil error means the sidecar itself is
// unusable (unconfigured, unreachable, token rejected) and the caller
// should stop rather than record the row as checked.
func (c *Client) Classify(ctx context.Context, img Image) (*float64, error) {
	s := c.snapshot()
	if s.URL == "" {
		return nil, ErrNotConfigured
	}
	c.mu.Lock()
	rejected, rules := c.pathRejected, c.rules
	c.mu.Unlock()
	if img.Path != "" && !rejected {
		payload, _ := json.Marshal(map[string]string{"path": ToSidecarPath(img.Path, rules)})
		status, body, err := c.post(ctx, s, "/classify", payload, "application/json", timeout(s))
		if err != nil {
			return nil, err
		}
		if status == http.StatusForbidden && errorCode(body) == "path_not_allowed" {
			c.mu.Lock()
			if c.settings.URL == s.URL {
				c.pathRejected = true
			}
			c.mu.Unlock()
		} else {
			score, notFound, err := readResult(status, body)
			if err != nil || !notFound {
				return score, err
			}
		}
	}
	if img.Load == nil {
		return nil, nil
	}
	data, err := img.Load()
	if err != nil || len(data) == 0 {
		return nil, nil
	}
	return c.ClassifyBytes(ctx, PrepareUpload(data))
}

// ClassifyBytes scores in-memory image bytes (never path mode, so a tile
// cut from a video sprite cannot switch the session away from it).
func (c *Client) ClassifyBytes(ctx context.Context, data []byte) (*float64, error) {
	s := c.snapshot()
	if s.URL == "" {
		return nil, ErrNotConfigured
	}
	if len(data) == 0 {
		return nil, nil
	}
	c.mu.Lock()
	probed := c.probed
	c.mu.Unlock()
	if !probed {
		c.Health(ctx)
	}
	c.mu.Lock()
	raw, limit := slices.Contains(c.features, "upload"), c.maxUpload
	c.mu.Unlock()
	size := int64(len(data))
	if !raw {
		size = int64(math.Ceil(float64(len(data))/3)) * 4
	}
	if size > limit {
		return nil, nil
	}
	wait := uploadTimeout(int64(len(data)), timeout(s))
	var status int
	var body []byte
	var err error
	if raw {
		status, body, err = c.post(ctx, s, "/classify/upload", data, "application/octet-stream", wait)
	} else {
		payload, _ := json.Marshal(map[string]string{"image_b64": base64.StdEncoding.EncodeToString(data)})
		status, body, err = c.post(ctx, s, "/classify", payload, "application/json", wait)
	}
	if err != nil {
		return nil, err
	}
	score, _, err := readResult(status, body)
	return score, err
}

func readResult(status int, body []byte) (score *float64, notFound bool, err error) {
	if status == http.StatusUnauthorized {
		return nil, false, ErrUnauthorized
	}
	if status < 200 || status > 299 {
		return nil, false, nil
	}
	var out struct {
		Score any    `json:"score"`
		Error string `json:"error"`
	}
	if json.Unmarshal(body, &out) != nil {
		return nil, false, nil
	}
	if out.Error == "file_not_found" {
		return nil, true, nil
	}
	if out.Error != "" {
		return nil, false, nil
	}
	v, _ := out.Score.(float64)
	if math.IsNaN(v) || math.IsInf(v, 0) {
		v = 0
	}
	v = math.Max(0, math.Min(1, v))
	return &v, false, nil
}

func errorCode(body []byte) string {
	var out struct {
		Code string `json:"code"`
	}
	_ = json.Unmarshal(body, &out)
	return out.Code
}

func timeout(s Settings) time.Duration {
	if s.RequestTimeout > 0 {
		return s.RequestTimeout
	}
	return defaultTimeout
}

// uploadTimeout allows a slow link at least uploadMinBytesPerSec.
func uploadTimeout(n int64, min time.Duration) time.Duration {
	need := time.Duration(n)*time.Second/uploadMinBytesPerSec + 10*time.Second
	return max(min, need)
}

// post retries transport failures and 5xx/408/429 with backoff. Other
// statuses are returned to the caller.
func (c *Client) post(ctx context.Context, s Settings, path string, payload []byte, contentType string, wait time.Duration) (int, []byte, error) {
	retries := s.MaxRetries
	if retries <= 0 {
		retries = defaultRetries
	}
	backoff := s.Backoff
	if len(backoff) == 0 {
		backoff = defaultBackoff
	}
	var lastErr error
	for attempt := 0; attempt < retries; attempt++ {
		status, body, err := c.do(ctx, s, http.MethodPost, path, payload, contentType, wait)
		if ctx.Err() != nil {
			return 0, nil, ctx.Err()
		}
		gone := false
		switch {
		case err != nil:
			lastErr = err
			// Don't wait out the backoff for a sidecar that is down.
			gone = attempt < retries-1 && !c.alive(ctx, s)
		case status >= 500 || status == http.StatusRequestTimeout || status == http.StatusTooManyRequests:
			lastErr = fmt.Errorf("sidecar http %d", status)
		default:
			return status, body, nil
		}
		if gone {
			break
		}
		if attempt < retries-1 {
			delay := backoff[min(attempt, len(backoff)-1)]
			select {
			case <-ctx.Done():
				return 0, nil, ctx.Err()
			case <-time.After(delay):
			}
		}
	}
	c.mu.Lock()
	c.healthAt = time.Time{}
	c.mu.Unlock()
	return 0, nil, fmt.Errorf("%w: POST %s: %v", ErrUnavailable, path, lastErr)
}

func (c *Client) alive(ctx context.Context, s Settings) bool {
	status, _, err := c.do(ctx, s, http.MethodGet, "/health", nil, "", time.Second)
	return err == nil && status >= 200 && status <= 299
}

func (c *Client) do(ctx context.Context, s Settings, method, path string, payload []byte, contentType string, wait time.Duration) (int, []byte, error) {
	ctx, cancel := context.WithTimeout(ctx, wait)
	defer cancel()
	var body io.Reader
	if payload != nil {
		body = bytes.NewReader(payload)
	}
	req, err := http.NewRequestWithContext(ctx, method, s.URL+path, body)
	if err != nil {
		return 0, nil, err
	}
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	if s.Token != "" {
		req.Header.Set(TokenHeader, s.Token)
	}
	res, err := c.hc.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer res.Body.Close()
	data, err := io.ReadAll(io.LimitReader(res.Body, maxResponseBytes))
	if err != nil {
		return 0, nil, err
	}
	return res.StatusCode, data, nil
}
