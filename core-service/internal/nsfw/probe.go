package nsfw

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// ProbeResult answers the dashboard's sidecar Test button.
type ProbeResult struct {
	OK           bool
	Reachable    bool
	Error        string
	Version      any
	Health       map[string]any
	Features     []string
	Auth         string // ok | failed | open | unknown
	AuthRequired *bool
}

// ProbeURL validates an admin-typed base URL for the Test button: http(s)
// only, no embedded credentials. It returns the base URL to probe or an
// error code (url_required, invalid_url, invalid_scheme).
func ProbeURL(raw string) (string, string) {
	s := strings.TrimSpace(raw)
	if s == "" {
		return "", "url_required"
	}
	if len(s) > 2048 {
		return "", "invalid_url"
	}
	u, err := url.Parse(s)
	if err != nil || u.Host == "" {
		if err == nil && u.Scheme != "" && u.Scheme != "http" && u.Scheme != "https" {
			return "", "invalid_scheme"
		}
		return "", "invalid_url"
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return "", "invalid_scheme"
	}
	if u.User != nil {
		return "", "invalid_url"
	}
	return u.Scheme + "://" + u.Host + strings.TrimRight(u.Path, "/"), ""
}

// Probe checks /health and then sends an empty /classify, which the sidecar
// answers 401 for a bad token and 400 missing_input otherwise. It never
// returns an error; failures land in ProbeResult.Error.
func Probe(ctx context.Context, hc *http.Client, base, token string) ProbeResult {
	if hc == nil {
		hc = http.DefaultClient
	}
	out := ProbeResult{Auth: "unknown", Features: []string{}}
	call := func(method, path string, body io.Reader) (int, string, []byte, error) {
		ctx, cancel := context.WithTimeout(ctx, 8*time.Second)
		defer cancel()
		req, err := http.NewRequestWithContext(ctx, method, base+path, body)
		if err != nil {
			return 0, "", nil, err
		}
		if body != nil {
			req.Header.Set("Content-Type", "application/json")
		}
		if token != "" {
			req.Header.Set(TokenHeader, token)
		}
		res, err := hc.Do(req)
		if err != nil {
			return 0, "", nil, err
		}
		defer res.Body.Close()
		data, err := io.ReadAll(io.LimitReader(res.Body, maxResponseBytes))
		return res.StatusCode, res.Header.Get("Content-Type"), data, err
	}
	status, ctype, body, err := call(http.MethodGet, "/health", nil)
	if err != nil {
		out.Error = err.Error()
		if errors.Is(err, context.DeadlineExceeded) {
			out.Error = "timeout"
		}
		return out
	}
	out.Reachable = true
	var health map[string]any
	if status < 200 || status > 299 {
		out.Error = fmt.Sprintf("http_%d", status)
		return out
	}
	if !strings.Contains(ctype, "json") || json.Unmarshal(body, &health) != nil || health == nil {
		// A proxy or tunnel page instead of the sidecar: usually a wrong
		// path prefix or a tunnel pointing at the wrong port.
		if ctype == "" {
			ctype = "no content-type"
		}
		out.Error = "not a sidecar (" + ctype + ")"
		return out
	}
	out.Health, out.Version = health, health["version"]
	if list, ok := health["features"].([]any); ok {
		for _, f := range list {
			out.Features = append(out.Features, fmt.Sprint(f))
		}
	}
	if v, ok := health["auth_required"].(bool); ok {
		out.AuthRequired = &v
	}
	if status, _, _, err := call(http.MethodPost, "/classify", strings.NewReader("{}")); err == nil {
		switch {
		case status == http.StatusUnauthorized:
			out.Auth = "failed"
			if out.AuthRequired == nil {
				v := true
				out.AuthRequired = &v
			}
		case token != "":
			out.Auth = "ok"
		default:
			out.Auth = "open"
		}
	}
	if out.Auth == "failed" {
		out.Error = "token_required"
		if token != "" {
			out.Error = "token_rejected"
		}
	}
	out.OK = health["ok"] == true && out.Auth != "failed"
	if !out.OK && out.Error == "" {
		out.Error = "unhealthy"
	}
	return out
}
