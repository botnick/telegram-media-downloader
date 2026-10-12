package nsfw

import (
	"net/url"
	"sort"
	"strings"
)

// Rule rewrites an app-side path prefix to the path the sidecar sees, so a
// shared mount at a different location keeps the fast path mode.
type Rule struct {
	From string
	To   string
}

// NormalizeURL returns the canonical base URL for a sidecar or "" when unset.
// A reverse-proxy path prefix is kept; query, fragment and trailing slashes
// are dropped, and a missing scheme defaults to http (matches 2.x).
func NormalizeURL(raw string) string {
	s := strings.TrimSpace(raw)
	if s == "" || len(s) > 2048 {
		return ""
	}
	if !strings.Contains(s, "://") {
		s = "http://" + s
	}
	u, err := url.Parse(s)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return strings.TrimRight(s, "/")
	}
	return u.Scheme + "://" + u.Host + strings.TrimRight(u.Path, "/")
}

// ParsePathMap parses `appPath=sidecarPath` rules separated by newlines or
// `;` (`=>` also works as the separator). Lines starting with # are
// ignored. The longest prefix is tried first so nested mounts map correctly.
func ParsePathMap(raw string) []Rule {
	var rules []Rule
	for _, line := range strings.FieldsFunc(raw, func(r rune) bool { return r == '\n' || r == '\r' || r == ';' }) {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		from, to, ok := strings.Cut(line, "=>")
		if !ok {
			from, to, ok = strings.Cut(line, "=")
		}
		from, to = strings.TrimSpace(from), strings.TrimSpace(to)
		if ok && from != "" && to != "" {
			rules = append(rules, Rule{From: from, To: to})
		}
	}
	sort.SliceStable(rules, func(i, j int) bool { return len(canon(rules[i].From)) > len(canon(rules[j].From)) })
	return rules
}

// ToSidecarPath rewrites p through the first matching rule; p is returned
// unchanged when no rule applies.
func ToSidecarPath(p string, rules []Rule) string {
	for _, r := range rules {
		if out, ok := rewrite(p, r.From, r.To); ok {
			return out
		}
	}
	return p
}

func isWinPath(s string) bool {
	if strings.HasPrefix(s, `\\`) {
		return true
	}
	return len(s) >= 2 && s[1] == ':' && ((s[0] >= 'a' && s[0] <= 'z') || (s[0] >= 'A' && s[0] <= 'Z')) && (len(s) == 2 || s[2] == '/' || s[2] == '\\')
}

func canon(s string) string {
	c := strings.ReplaceAll(s, `\`, "/")
	for len(c) > 1 && strings.HasSuffix(c, "/") && !(len(c) == 3 && c[1] == ':') {
		c = c[:len(c)-1]
	}
	return c
}

func rewrite(p, from, to string) (string, bool) {
	src, base := canon(p), canon(from)
	a, b := src, base
	if isWinPath(from) || isWinPath(p) {
		a, b = strings.ToLower(a), strings.ToLower(b)
	}
	var rest string
	switch {
	case a == b:
	case strings.HasPrefix(a, strings.TrimSuffix(b, "/")+"/"):
		rest = strings.TrimLeft(src[len(base):], "/")
	default:
		return "", false
	}
	target := canon(to)
	out := target
	if rest != "" {
		out = strings.TrimSuffix(target, "/") + "/" + rest
	}
	if isWinPath(to) {
		out = strings.ReplaceAll(out, "/", `\`)
	}
	return out, true
}
