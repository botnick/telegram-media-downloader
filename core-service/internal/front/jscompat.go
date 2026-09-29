package front

import (
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// This file holds the few pieces of JavaScript / Node semantics the fast
// path has to reproduce bit for bit. Anything these helpers can't answer
// with certainty is reported as "not sure" and the request goes to Node.

// jsParseInt mirrors parseInt(s, 10) on an ASCII string: leading JS
// whitespace is skipped, one sign is allowed, and the longest run of
// digits is converted to a double (correctly rounded, like V8). ok is
// false where parseInt returns NaN.
func jsParseInt(s string) (float64, bool) {
	s = strings.TrimLeft(s, " \t\n\v\f\r")
	neg := false
	if s != "" && (s[0] == '+' || s[0] == '-') {
		neg = s[0] == '-'
		s = s[1:]
	}
	n := 0
	for n < len(s) && s[n] >= '0' && s[n] <= '9' {
		n++
	}
	if n == 0 {
		return math.NaN(), false
	}
	v, err := strconv.ParseFloat(s[:n], 64)
	if err != nil && !math.IsInf(v, 0) {
		return math.NaN(), false
	}
	if neg {
		v = -v
	}
	return v, true
}

// jsRound is Math.round for the magnitudes used here (exact for |x| < 2^52).
func jsRound(x float64) float64 {
	r := math.Floor(x)
	if x-r >= 0.5 {
		r++
	}
	return r
}

// statMtimeMs is fs.Stats#mtimeMs: sec * 1000 + nsec / 1e6, in doubles,
// from the same seconds / nanoseconds split libuv reports.
func statMtimeMs(t time.Time) float64 {
	return float64(t.Unix())*1000 + float64(t.Nanosecond())/1e6
}

// dateMs is `new Date(ms).getTime()` (TimeClip truncates toward zero).
func dateMs(ms float64) int64 { return int64(ms) }

// utcString is Date#toUTCString for a time value in milliseconds.
func utcString(ms int64) string {
	return time.UnixMilli(ms).UTC().Format(http.TimeFormat)
}

// sendTimes returns the Last-Modified value and the mtime used in the stat
// ETag, as send computes them: fs.Stats#mtime is new Date(Math.round(mtimeMs)).
func sendTimes(mtime time.Time) (lastModified string, mtimeMsInt int64) {
	ms := int64(jsRound(statMtimeMs(mtime)))
	return utcString(ms), ms
}

// statETag is the etag package's weak stat tag: W/"<size hex>-<mtime hex>".
func statETag(size, mtimeMs int64) string {
	return `W/"` + strconv.FormatInt(size, 16) + "-" + strconv.FormatInt(mtimeMs, 16) + `"`
}

// parseHTTPDateStrict returns the time of an IMF-fixdate ("Mon, 06 May
// 2024 07:08:09 GMT") written exactly the way Date#toUTCString writes it.
// Date.parse accepts far more; anything else is "not sure".
func parseHTTPDateStrict(s string) (int64, bool) {
	t, err := time.Parse(http.TimeFormat, s)
	if err != nil || t.UTC().Format(http.TimeFormat) != s {
		return 0, false
	}
	return t.UnixMilli(), true
}

// parseTokenList mirrors the helper in fresh / send: comma-separated,
// spaces around items dropped.
func parseTokenList(str string) []string {
	var list []string
	start, end := 0, 0
	for i := 0; i < len(str); i++ {
		switch str[i] {
		case ' ':
			if start == end {
				start = i + 1
				end = start
			}
		case ',':
			list = append(list, str[start:end])
			start = i + 1
			end = start
		default:
			end = i + 1
		}
	}
	return append(list, str[start:end])
}

// isASCIIPrintable reports whether s only has bytes 0x20..0x7e. Node reads
// header bytes as latin1 and JS string functions treat some of the upper
// half as whitespace, so the fast path only reasons about plain ASCII.
func isASCIIPrintable(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] < 0x20 || s[i] > 0x7e {
			return false
		}
	}
	return true
}

// nodeHeader returns a request header the way Node's IncomingMessage
// exposes it in req.headers: several lines are joined with ", " (cookie:
// "; "), and for the fields Node de-duplicates only the first line counts.
// ok is false when the value isn't plain ASCII.
func nodeHeader(h http.Header, name string) (string, bool) {
	vals := h.Values(name)
	if len(vals) == 0 {
		return "", true
	}
	var v string
	switch strings.ToLower(name) {
	case "if-modified-since", "if-unmodified-since", "content-type", "content-length",
		"authorization", "host", "referer", "user-agent":
		v = vals[0]
	case "cookie":
		v = strings.Join(vals, "; ")
	default:
		v = strings.Join(vals, ", ")
	}
	if !isASCIIPrintable(v) {
		return "", false
	}
	return v, true
}
