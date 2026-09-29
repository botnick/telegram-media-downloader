package front

import (
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// sendPlan is the response `send` (behind res.sendFile and
// express.static) would produce for a regular file.
type sendPlan struct {
	status  int
	headers hdrList
	start   int64
	length  int64
	body    bool
}

var (
	bytesRangeRE = regexp.MustCompile(`^ *bytes=`)
	noCacheRE    = regexp.MustCompile(`(?:^|,)\s*?no-cache\s*?(?:,|$)`)
)

// planSend mirrors SendStream#send (send 0.19) for a regular file of the
// given size and mtime. preset holds the headers already on the response
// when the route called res.sendFile; typePath is the path send was given
// (its extension picks the Content-Type).
//
// ok is false for every branch the fast path leaves to Node: If-Match /
// If-Unmodified-Since (412 handling), an unsatisfiable range (send's 416
// becomes the app's error handler's 500), and validators or dates whose
// JavaScript parsing it doesn't reproduce.
func planSend(r *http.Request, preset hdrList, size int64, mtime time.Time, typePath string) (sendPlan, bool) {
	h := preset.clone()
	lastMod, mtimeMs := sendTimes(mtime)
	h.setIfMissing("Accept-Ranges", "bytes")
	h.setIfMissing("Cache-Control", "public, max-age=0")
	h.setIfMissing("Last-Modified", lastMod)
	h.setIfMissing("ETag", statETag(size, mtimeMs))
	h.setIfMissing("Content-Type", sendContentType(typePath))

	ifMatch, ok1 := nodeHeader(r.Header, "If-Match")
	ifUnmod, ok2 := nodeHeader(r.Header, "If-Unmodified-Since")
	inm, ok3 := nodeHeader(r.Header, "If-None-Match")
	ims, ok4 := nodeHeader(r.Header, "If-Modified-Since")
	if !ok1 || !ok2 || !ok3 || !ok4 || ifMatch != "" || ifUnmod != "" {
		return sendPlan{}, false
	}
	if inm != "" || ims != "" {
		fresh, ok := isFresh(r, h, inm, ims)
		if !ok {
			return sendPlan{}, false
		}
		if fresh {
			for _, k := range []string{"Content-Encoding", "Content-Language", "Content-Length", "Content-Range", "Content-Type"} {
				h.del(k)
			}
			return sendPlan{status: http.StatusNotModified, headers: h}, true
		}
	}

	status, start, length := http.StatusOK, int64(0), size
	rangeHdr, ok := nodeHeader(r.Header, "Range")
	if !ok {
		return sendPlan{}, false
	}
	if rangeHdr != "" && bytesRangeRE.MatchString(rangeHdr) {
		ranges, st := parseRange(float64(size), rangeHdr)
		fresh, ok := isRangeFresh(r, h)
		if !ok {
			return sendPlan{}, false
		}
		if !fresh {
			st = rangeMalformed
		}
		if st == rangeUnsatisfiable {
			return sendPlan{}, false
		}
		if st == 0 && len(ranges) == 1 {
			a, b := int64(ranges[0].start), int64(ranges[0].end)
			status = http.StatusPartialContent
			h.set("Content-Range", "bytes "+strconv.FormatInt(a, 10)+"-"+strconv.FormatInt(b, 10)+"/"+strconv.FormatInt(size, 10))
			start, length = a, b-a+1
		}
	}
	h.set("Content-Length", strconv.FormatInt(length, 10))
	return sendPlan{status: status, headers: h, start: start, length: length, body: r.Method != http.MethodHead}, true
}

// isFresh mirrors fresh 0.5 (send's isCachable is always true here: the
// status is still 200). ok is false when a date can't be compared the way
// Date.parse would.
func isFresh(r *http.Request, h hdrList, inm, ims string) (fresh bool, ok bool) {
	cc, ok := nodeHeader(r.Header, "Cache-Control")
	if !ok {
		return false, false
	}
	if cc != "" && noCacheRE.MatchString(cc) {
		return false, true
	}
	if inm != "" && inm != "*" {
		etag, _ := h.get("ETag")
		if etag == "" {
			return false, true
		}
		stale := true
		for _, m := range parseTokenList(inm) {
			if m == etag || m == "W/"+etag || "W/"+m == etag {
				stale = false
				break
			}
		}
		if stale {
			return false, true
		}
	}
	if ims != "" {
		lm, has := h.get("Last-Modified")
		if !has || lm == "" {
			return false, true
		}
		a, okA := parseHTTPDateStrict(lm)
		b, okB := parseHTTPDateStrict(ims)
		if !okA || !okB {
			return false, false
		}
		if !(a <= b) {
			return false, true
		}
	}
	return true, true
}

// isRangeFresh mirrors SendStream#isRangeFresh (If-Range).
func isRangeFresh(r *http.Request, h hdrList) (fresh bool, ok bool) {
	ifRange, ok := nodeHeader(r.Header, "If-Range")
	if !ok {
		return false, false
	}
	if ifRange == "" {
		return true, true
	}
	if strings.Contains(ifRange, `"`) {
		etag, _ := h.get("ETag")
		return etag != "" && strings.Contains(ifRange, etag), true
	}
	lm, _ := h.get("Last-Modified")
	a, okA := parseHTTPDateStrict(lm)
	b, okB := parseHTTPDateStrict(ifRange)
	if !okA || !okB {
		return false, false
	}
	return a <= b, true
}
