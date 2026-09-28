package front

import (
	"net/http"
	"strings"
)

// hdr is one response header with the spelling Node gives its name.
type hdr struct{ name, value string }

// hdrList is an ordered, case-insensitive header list — the fast path
// builds responses in it (in the order Node's middleware sets them) and
// writes the names verbatim, so "ETag" stays "ETag" rather than Go's
// canonical "Etag".
type hdrList []hdr

func (h hdrList) get(name string) (string, bool) {
	for _, x := range h {
		if strings.EqualFold(x.name, name) {
			return x.value, true
		}
	}
	return "", false
}

func (h hdrList) has(name string) bool {
	_, ok := h.get(name)
	return ok
}

func (h *hdrList) set(name, value string) {
	for i, x := range *h {
		if strings.EqualFold(x.name, name) {
			(*h)[i].value = value
			return
		}
	}
	*h = append(*h, hdr{name, value})
}

func (h *hdrList) setIfMissing(name, value string) {
	if !h.has(name) {
		h.set(name, value)
	}
}

func (h *hdrList) del(name string) {
	out := (*h)[:0]
	for _, x := range *h {
		if !strings.EqualFold(x.name, name) {
			out = append(out, x)
		}
	}
	*h = out
}

func (h hdrList) clone() hdrList { return append(hdrList(nil), h...) }

// writeTo copies the list into w's header map. Names Go's server acts on
// (Content-Length, Content-Type, …) are already canonical in Node's
// spelling; everything else is stored as spelled.
func (h hdrList) writeTo(w http.ResponseWriter) {
	m := w.Header()
	for _, x := range h {
		m[x.name] = append(m[x.name], x.value)
	}
}

// Response header names whose spelling Node keeps but Go's HTTP client
// canonicalises when it reads a proxied response. Restored on the way out
// so proxied and fast-path responses spell them like Node did.
var nodeSpelling = map[string]string{
	"Etag":                   "ETag",
	"X-Dns-Prefetch-Control": "X-DNS-Prefetch-Control",
	"X-Xss-Protection":       "X-XSS-Protection",
	"Www-Authenticate":       "WWW-Authenticate",
	"Ratelimit":              "RateLimit",
	"Ratelimit-Policy":       "RateLimit-Policy",
	"Ratelimit-Limit":        "RateLimit-Limit",
	"Ratelimit-Remaining":    "RateLimit-Remaining",
	"Ratelimit-Reset":        "RateLimit-Reset",
	"X-Ratelimit-Limit":      "X-RateLimit-Limit",
	"X-Ratelimit-Remaining":  "X-RateLimit-Remaining",
	"X-Ratelimit-Reset":      "X-RateLimit-Reset",
	"Content-Md5":            "Content-MD5",
}

func respellHeaders(h http.Header) {
	for canon, node := range nodeSpelling {
		if v, ok := h[canon]; ok {
			delete(h, canon)
			h[node] = v
		}
	}
}

// keepAliveTimeoutSec is Node's server.keepAliveTimeout (65 s), announced
// in the Keep-Alive header of every response on a kept-alive connection.
const keepAliveTimeoutSec = "65"

// setConnectionHeaders adds the Connection / Keep-Alive pair Node writes
// on every response to a request that keeps the connection open. (For a
// request that closes it, Go's server writes "Connection: close" itself.)
func setConnectionHeaders(w http.ResponseWriter, r *http.Request) {
	if r.Close {
		return
	}
	m := w.Header()
	m["Connection"] = []string{"keep-alive"}
	m["Keep-Alive"] = []string{"timeout=" + keepAliveTimeoutSec}
}
