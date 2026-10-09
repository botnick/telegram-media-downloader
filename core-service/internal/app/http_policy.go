package app

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"
)

// HTTPOptions are process settings. The web policy itself is read from SQLite
// on each request, so an acknowledged config change takes effect immediately.
type HTTPOptions struct {
	TrustProxy       *string
	CompressionLevel *int
	DisableCSP       bool
}

func HTTPOptionsFromEnv(lookup func(string) (string, bool)) (HTTPOptions, error) {
	var out HTTPOptions
	if raw, set := lookup("TRUST_PROXY"); set {
		out.TrustProxy = &raw
	}
	if _, err := parseProxyPolicy(out.TrustProxy); err != nil {
		return out, err
	}
	if raw, set := lookup("COMPRESSION_LEVEL"); set && raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n < 0 || n > 9 {
			return out, errors.New("COMPRESSION_LEVEL must be 0-9")
		}
		out.CompressionLevel = &n
	}
	raw, _ := lookup("TGDL_CSP")
	out.DisableCSP = strings.EqualFold(raw, "off")
	return out, nil
}

var defaultCSP = []struct {
	name    string
	sources []string
}{
	{"default-src", []string{"'self'"}}, {"base-uri", []string{"'self'"}},
	{"font-src", []string{"'self'", "data:", "https://fonts.gstatic.com", "https://cdn.jsdelivr.net"}},
	{"form-action", []string{"'self'"}}, {"frame-ancestors", []string{"'self'"}},
	{"img-src", []string{"'self'", "data:", "blob:"}}, {"object-src", []string{"'none'"}},
	{"script-src", []string{"'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net", "https://cdnjs.cloudflare.com"}},
	{"script-src-attr", []string{"'unsafe-inline'"}},
	{"style-src", []string{"'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net", "https://cdnjs.cloudflare.com", "https://fonts.googleapis.com"}},
	{"style-src-attr", []string{"'unsafe-inline'"}}, {"media-src", []string{"'self'", "blob:"}},
	{"connect-src", []string{"'self'", "ws:", "wss:"}}, {"frame-src", []string{"'self'"}},
}
var cspName = regexp.MustCompile(`^[a-z][a-z0-9-]{0,63}$`)

func normalizeCSP(raw any) (map[string]any, error) {
	input, ok := raw.(map[string]any)
	if !ok || input == nil {
		return nil, errors.New("csp must be an object")
	}
	out := map[string]any{"enabled": input["enabled"] != false, "reportOnly": input["reportOnly"] == true}
	dirs := map[string]any{}
	out["directives"] = dirs
	if input["directives"] == nil {
		return out, nil
	}
	values, ok := input["directives"].(map[string]any)
	if !ok {
		return nil, errors.New("csp.directives must be an object")
	}
	if len(values) > 64 {
		return nil, errors.New("too many CSP directives (max 64)")
	}
	total := 0
	for name, rawList := range values {
		if !cspName.MatchString(name) {
			return nil, errors.New("invalid CSP directive name")
		}
		list, ok := rawList.([]any)
		if !ok {
			return nil, fmt.Errorf("%s: sources must be an array", name)
		}
		if len(list) > 100 {
			return nil, fmt.Errorf("%s: too many sources (max 100)", name)
		}
		clean := []any{}
		seen := map[string]bool{}
		for _, rawSource := range list {
			s, ok := rawSource.(string)
			if !ok {
				return nil, fmt.Errorf("%s: sources must be strings", name)
			}
			if !utf8.ValidString(s) {
				return nil, fmt.Errorf("%s: source must be valid UTF-8", name)
			}
			if strings.ContainsAny(s, ";,") || strings.ContainsFunc(s, func(r rune) bool { return r < 32 || r == 127 }) {
				return nil, fmt.Errorf("%s: source contains a forbidden character", name)
			}
			s = strings.TrimSpace(s)
			if s == "" {
				continue
			}
			if len(s) > 300 || strings.ContainsFunc(s, unicode.IsSpace) {
				return nil, fmt.Errorf("%s: source is too long or contains whitespace", name)
			}
			if !seen[s] {
				clean = append(clean, s)
				seen[s] = true
				total += len(s) + 1
			}
		}
		total += len(name) + 1
		if total > 16<<10 {
			return nil, errors.New("CSP directives exceed 16 KiB")
		}
		dirs[name] = clean
	}
	return out, nil
}

type webPolicy struct {
	forceHTTPS, rateEnabled         bool
	perMinute                       int
	cspName, cspValue, frameOptions string
}
type webPolicyCache struct {
	mu     sync.Mutex
	raw    string
	policy webPolicy
	valid  bool
}

func compileWebPolicy(raw string, off bool) (webPolicy, error) {
	p := webPolicy{perMinute: 10000, frameOptions: "SAMEORIGIN"}
	var web map[string]any
	if err := json.Unmarshal([]byte(raw), &web); err != nil {
		return p, err
	}
	p.forceHTTPS = web["forceHttps"] == true
	if rl, ok := web["rateLimit"].(map[string]any); ok {
		p.rateEnabled = rl["enabled"] == true
		if n := number(rl["perMinute"], 0); n >= 10 {
			p.perMinute = int(min(n, 1000000))
		}
	}
	if off {
		return p, nil
	}
	csp := map[string]any{}
	if web["csp"] != nil {
		var err error
		csp, err = normalizeCSP(web["csp"])
		if err != nil {
			return p, err
		}
	}
	custom, _ := csp["directives"].(map[string]any)
	if fa, ok := custom["frame-ancestors"]; ok {
		list := fa.([]any)
		if len(list) != 1 || list[0] != "'self'" {
			p.frameOptions = ""
		}
	}
	if csp["enabled"] == false {
		return p, nil
	}
	parts, names, known := []string{}, []string{}, map[string]bool{}
	for _, d := range defaultCSP {
		names = append(names, d.name)
		known[d.name] = true
	}
	extra := []string{}
	for k := range custom {
		if !known[k] {
			extra = append(extra, k)
		}
	}
	sort.Strings(extra)
	names = append(names, extra...)
	defaults := map[string][]string{}
	for _, d := range defaultCSP {
		defaults[d.name] = d.sources
	}
	for _, name := range names {
		list := defaults[name]
		if raw, ok := custom[name]; ok {
			list = nil
			for _, item := range raw.([]any) {
				list = append(list, item.(string))
			}
		}
		if len(list) > 0 {
			parts = append(parts, name+" "+strings.Join(list, " "))
		}
	}
	p.cspName = "Content-Security-Policy"
	if csp["reportOnly"] == true {
		p.cspName += "-Report-Only"
	}
	p.cspValue = strings.Join(parts, ";")
	return p, nil
}
func (a *App) requestPolicy(r *http.Request) (webPolicy, error) {
	var raw string
	err := a.db.Reader.QueryRowContext(r.Context(), `SELECT json_object('forceHttps',value -> '$.web.forceHttps','csp',json_extract(value,'$.web.csp'),'rateLimit',json_extract(value,'$.web.rateLimit')) FROM kv WHERE key='config'`).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		raw, err = "{}", nil
	}
	if err != nil {
		return webPolicy{}, err
	}
	a.webPolicy.mu.Lock()
	defer a.webPolicy.mu.Unlock()
	if a.webPolicy.valid && a.webPolicy.raw == raw {
		return a.webPolicy.policy, nil
	}
	p, err := compileWebPolicy(raw, a.httpOptions.DisableCSP)
	if err == nil {
		a.webPolicy.raw, a.webPolicy.policy, a.webPolicy.valid = raw, p, true
	}
	return p, err
}

func (a *App) transportPolicy(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n, err := a.proxyPolicy.resolve(r)
		if err != nil {
			writeJSONError(w, 400, "Invalid forwarded client address")
			return
		}
		r = withNetwork(r, n)
		p, err := a.requestPolicy(r)
		if err != nil {
			writeJSONError(w, 503, "Web security configuration unavailable")
			return
		}
		if p.forceHTTPS && !n.secure && !n.client.IsLoopback() {
			if r.Method != "GET" && r.Method != "HEAD" {
				writeJSONError(w, 403, "HTTPS required")
				return
			}
			u, err := url.Parse("//" + r.Host)
			if err != nil || u.Host == "" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" || strings.Contains(r.Host, "\\") {
				w.WriteHeader(400)
				return
			}
			location := "https://" + r.Host + r.URL.RequestURI()
			w.Header().Set("Location", location)
			w.Header().Set("Vary", "Accept")
			w.Header().Set("Content-Type", "text/plain; charset=utf-8")
			w.WriteHeader(308)
			if r.Method != "HEAD" {
				fmt.Fprint(w, "Permanent Redirect. Redirecting to "+location)
			}
			return
		}
		if !p.forceHTTPS {
			w.Header().Set("Strict-Transport-Security", "max-age=0")
		} else if n.secure {
			w.Header().Set("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
		}
		setSecurityHeaders(w.Header())
		if p.frameOptions != "" {
			w.Header().Set("X-Frame-Options", p.frameOptions)
		}
		if p.cspName != "" {
			value := p.cspValue
			if p.forceHTTPS && n.secure {
				value += ";upgrade-insecure-requests"
			}
			w.Header().Set(p.cspName, value)
		}
		if strings.HasPrefix(r.URL.Path, "/api/") && p.rateEnabled {
			allowed, remaining, reset := a.apiRL.allowPolicy(clientKey(r), time.Now(), p.perMinute, time.Minute)
			seconds := int((reset + time.Second - 1) / time.Second)
			w.Header().Set("RateLimit", fmt.Sprintf("limit=%d, remaining=%d, reset=%d", p.perMinute, remaining, seconds))
			w.Header().Set("RateLimit-Policy", fmt.Sprintf("%d;w=60", p.perMinute))
			if !allowed {
				w.Header().Set("Retry-After", strconv.Itoa(seconds))
				w.Header().Set("Cache-Control", "no-store, max-age=0")
				w.Header().Set("Pragma", "no-cache")
				w.Header().Set("Vary", a.apiVary(r))
				body := []byte("Too many requests, please try again later.")
				w.Header().Set("Content-Type", "text/html; charset=utf-8")
				w.Header().Set("ETag", weakETag(body))
				w.WriteHeader(429)
				if r.Method != "HEAD" {
					_, _ = w.Write(body)
				}
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

func setSecurityHeaders(h http.Header) {
	for k, v := range map[string]string{"Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Resource-Policy": "same-origin", "Origin-Agent-Cluster": "?1", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff", "X-DNS-Prefetch-Control": "off", "X-Download-Options": "noopen", "X-Permitted-Cross-Domain-Policies": "none", "X-XSS-Protection": "0"} {
		h.Set(k, v)
	}
}
