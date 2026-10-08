package front

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// The fast path only ever answers "allowed". Every other outcome of
// checkAuth — redirect to /login.html, 401, 503 setup-required, deleting an
// expired row, a malformed cookie turning into a 500 — is produced by Node,
// because the request is proxied whenever the front server is not certain.
// The sliding renewal is the exception: Go serves, and tells Node (notify.go).

const sessionCookie = "tg_dl_session"

// Safety margin: close to expiry, let Node decide (a request is never
// answered by Go where Node, a few milliseconds later, would have refused).
const (
	expiryMarginMs = 5_000
	tokenMarginSec = 2
)

func nowMs() float64 { return float64(time.Now().UnixMilli()) }

// sessionCookieValue returns the tg_dl_session value as Node's cookie
// middleware would put it in req.cookies: pairs split on ';', the name
// trimmed, the value everything after the first '=', later pairs winning.
// ok is false when that can't be reproduced exactly (decodeURI would
// change or reject a value containing '%', non-ASCII bytes).
func sessionCookieValue(h http.Header) (value string, present bool, ok bool) {
	raw, ok := nodeHeader(h, "Cookie")
	if !ok {
		return "", false, false
	}
	if raw == "" {
		return "", false, true
	}
	for _, part := range strings.Split(raw, ";") {
		name, val, _ := strings.Cut(part, "=")
		if strings.ContainsRune(val, '%') {
			return "", false, false
		}
		if strings.Trim(name, " ") == sessionCookie {
			value, present = val, true
		}
	}
	return value, present, true
}

// cookieAllows reports whether the session cookie authenticates the
// request: the row exists and is not expired. A session in the last quarter
// of its lifetime is served too; Node is told to extend it (Node would have
// renewed it and sent the cookie again). role is "admin" or "guest".
func (s *Server) cookieAllows(r *http.Request) (role string, allowed bool) {
	token, present, ok := sessionCookieValue(r.Header)
	if !ok || !present || token == "" || s.sessions == nil {
		return "", false
	}
	sess, found, err := s.sessions.lookup(r.Context(), token)
	if err != nil {
		s.stats.dbErrors.Add(1)
		return "", false
	}
	if !found {
		return "", false
	}
	now := nowMs()
	if sess.expiresAt <= now+expiryMarginMs {
		return "", false // expired (Node deletes the row) or about to
	}
	if ttl := sess.expiresAt - sess.issuedAt; ttl > 0 && sess.expiresAt-now < ttl*0.25 {
		s.notify("renew", token)
	}
	if sess.role == "guest" {
		return "guest", true
	}
	return "admin", true
}

// queryParam returns the single value of a query parameter the way
// Express's qs-based parser would hand it to the route as a string. ok is
// false when the query is outside what the fast path reproduces (qs's
// bracket / array syntax, ';', bad escapes, more than 1000 pairs).
type query struct {
	vals url.Values
}

func parseNodeQuery(raw string) (query, bool) {
	if raw == "" {
		return query{vals: url.Values{}}, true
	}
	if strings.ContainsAny(raw, "[];") || strings.Contains(strings.ToLower(raw), "%5b") ||
		strings.Contains(strings.ToLower(raw), "%5d") || strings.Count(raw, "&") >= 999 {
		return query{}, false
	}
	v, err := url.ParseQuery(raw)
	if err != nil {
		return query{}, false
	}
	for k := range v {
		if strings.ContainsAny(k, "[]") {
			return query{}, false
		}
	}
	return query{vals: v}, true
}

// str is req.query[name] when it is a string: exactly one occurrence.
func (q query) str(name string) (string, bool) {
	vs := q.vals[name]
	if len(vs) != 1 {
		return "", false
	}
	return vs[0], true
}

func (q query) has(name string) bool {
	_, ok := q.vals[name]
	return ok
}

// fileTokenRole mirrors verifyFileToken in src/core/share.js for tokens
// in the form the app mints ("<exp>.<base64url HMAC>", exp a decimal
// integer, leading zeros as Number() reads them). Other spellings Number()
// would also accept (hex, exponent, fractions) are not tokens here.
func fileTokenRole(secret []byte, token string) (string, bool) {
	if len(secret) == 0 {
		return "", false
	}
	dot := strings.IndexByte(token, '.')
	if dot < 1 {
		return "", false
	}
	expStr, sig := token[:dot], token[dot+1:]
	if !isDigits(expStr) {
		return "", false
	}
	expStr = strings.TrimLeft(expStr, "0") // Number("0123") is 123: the signature covers that
	if expStr == "" || len(expStr) > 15 {
		return "", false
	}
	exp, err := strconv.ParseInt(expStr, 10, 64)
	if err != nil || float64(time.Now().UnixMilli())/1000+tokenMarginSec > float64(exp) {
		return "", false
	}
	for _, role := range []string{"admin", "guest"} {
		if hmac.Equal([]byte(sig), []byte(fileTokenSig(secret, "filetoken:"+role+"|"+expStr))) {
			return role, true
		}
	}
	// Tokens minted before role binding (v2.24.5 and older): guest.
	if hmac.Equal([]byte(sig), []byte(fileTokenSig(secret, "filetoken|"+expStr))) {
		return "guest", true
	}
	return "", false
}

// FileTokenRole verifies the bearer token used by the public media handler.
// It is exported so the application gateway and the standalone front server
// share exactly the same signature, expiry, and legacy-token rules.
func FileTokenRole(secret []byte, token string) (string, bool) {
	return fileTokenRole(secret, token)
}

func fileTokenSig(secret []byte, payload string) string {
	m := hmac.New(sha256.New, secret)
	m.Write([]byte(payload))
	return base64.RawURLEncoding.EncodeToString(m.Sum(nil))
}
