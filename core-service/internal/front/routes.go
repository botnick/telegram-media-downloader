package front

import (
	"crypto/sha256"
	"encoding/hex"
	"math"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"
)

// Response headers src/web/server.js sets per path prefix (the cache
// policy middleware) and per route. The parity suite
// (tests/front-parity.e2e.test.js) fails when these drift from Node.
const (
	filesCacheControl  = "private, max-age=2592000, immutable"
	photosCacheControl = "private, max-age=86400, stale-while-revalidate=604800"
	thumbCacheControl  = "private, max-age=3600, stale-while-revalidate=2592000" // THUMB_CACHE_CONTROL
	thumbWidth         = 320                                                     // the only cached width
)

// serveFast answers the request itself when it can; false means "proxy it".
func (s *Server) serveFast(w http.ResponseWriter, r *http.Request) bool {
	rawPath, rawQuery, ok := splitTarget(r.RequestURI)
	if !ok {
		return false
	}
	switch {
	case strings.HasPrefix(rawPath, "/files/"):
		return s.fastFiles(w, r, rawPath[len("/files/"):], rawQuery)
	case strings.HasPrefix(rawPath, "/photos/"):
		return s.fastPhotos(w, r, rawPath[len("/photos/"):])
	case strings.HasPrefix(rawPath, "/api/thumbs/"):
		return s.fastThumbs(w, r, rawPath[len("/api/thumbs/"):])
	}
	return false
}

// splitTarget splits an origin-form request target into path and query.
func splitTarget(uri string) (path, query string, ok bool) {
	if !strings.HasPrefix(uri, "/") || strings.ContainsRune(uri, '#') {
		return "", "", false
	}
	path, query, _ = strings.Cut(uri, "?")
	return path, query, true
}

// precheck covers what every middleware in front of the route agrees on:
// a GET/HEAD without a body, the dashboard's auth configured, and — with
// forceHttps on — a request that is already secure. It returns the state
// and the headers Node's middleware chain puts first.
func (s *Server) precheck(r *http.Request) (*State, hdrList, bool) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		return nil, nil, false
	}
	if r.ContentLength != 0 || len(r.TransferEncoding) > 0 {
		return nil, nil, false
	}
	st := s.state.Load()
	if st == nil || !st.AuthReady {
		return nil, nil, false
	}
	secure := false
	if st.ForceHTTPS {
		xfp, ok := nodeHeader(r.Header, "X-Forwarded-Proto")
		proto, exact := s.trust.protocol(s.clientAddr(r), xfp, ok)
		if !exact || proto != "https" {
			return nil, nil, false // Node redirects, refuses, or lets a local request through
		}
		secure = true
	}
	return st, st.baseHeaders(secure), true
}

// ---- /files ---------------------------------------------------------------

// fastFiles is the local branch of app.use('/files', …): token or session,
// safeResolveDownload, Content-Disposition, res.sendFile.
func (s *Server) fastFiles(w http.ResponseWriter, r *http.Request, rawRel, rawQuery string) bool {
	st, h, ok := s.precheck(r)
	if !ok {
		return false
	}
	rel, ok := decodeRel(rawRel)
	if !ok || strings.HasPrefix(rel, "_clusterref") || strings.HasPrefix(rel, "data/") {
		return false // cluster bridge, legacy "data/downloads/" prefix: Node
	}
	q, ok := parseNodeQuery(rawQuery)
	if !ok || q.has("peer") {
		return false // federated ?peer= fetches go to Node
	}
	allowed := false
	if tok, ok := q.str("token"); ok {
		_, allowed = fileTokenRole(st.secret, tok)
	}
	if !allowed {
		_, allowed = s.cookieAllows(r)
	}
	if !allowed {
		return false
	}
	inline := false
	if v, ok := q.str("inline"); ok && v == "1" {
		inline = true
	}
	ext := strings.ToLower(filepath.Ext(rel))
	if inline && (ext == ".heic" || ext == ".heif") {
		return false // Node transcodes to JPEG
	}
	f, fi, real, ok := s.openUnder(&s.downloads, rel)
	if !ok {
		return false // missing (Node auto-prunes and answers 404), not a file, symlinked, …
	}
	base := filepath.Base(real)
	kind := "attachment"
	if inline {
		kind = "inline"
	}
	h = append(h,
		hdr{"Cache-Control", filesCacheControl},
		hdr{"Content-Disposition", kind + `; filename="` + asciiFilename(base) + `"; filename*=UTF-8''` + encodeURIComponent(base)},
	)
	plan, ok := planSend(r, h, fi.Size(), fi.ModTime(), real)
	if !ok {
		_ = f.Close()
		return false
	}
	s.stats.fastFiles.Add(1)
	s.serve(w, r, plan, f)
	return true
}

// decodeRel is decodeURIComponent(req.path) without the leading slash,
// accepted only when the result is a plain relative path that
// safeResolveDownload would join as is on every platform: UTF-8, no NUL /
// control characters, no backslash or colon, no empty, "." or ".."
// segment, and no dotfile name (send refuses those).
func decodeRel(raw string) (string, bool) {
	if raw == "" {
		return "", false
	}
	rel, err := url.PathUnescape(raw)
	if err != nil || !utf8.ValidString(rel) || rel == "" {
		return "", false
	}
	for _, c := range rel {
		if c < 0x20 || c == 0x7f || c == '\\' || c == ':' {
			return "", false
		}
	}
	segs := strings.Split(rel, "/")
	for _, seg := range segs {
		if seg == "" || seg == "." || seg == ".." || strings.HasSuffix(seg, ".") || strings.HasSuffix(seg, " ") {
			return "", false
		}
	}
	if strings.HasPrefix(segs[len(segs)-1], ".") {
		return "", false
	}
	return rel, true
}

// openUnder opens dir/rel for the fast path. It succeeds only for a
// regular file inside the allowed roots whose real path (what Node's
// fs.realpath returns) is exactly dir's real path + rel — no symlink or
// junction on the way, and on Windows the request's spelling matches the
// on-disk case.
func (s *Server) openUnder(d *rootDir, rel string) (*os.File, os.FileInfo, string, bool) {
	realRoot, ok := d.realPath()
	if !ok || !filepath.IsLocal(filepath.FromSlash(rel)) {
		return nil, nil, "", false
	}
	expected := filepath.Join(realRoot, filepath.FromSlash(rel))
	resolved, err := s.roots.Resolve(filepath.Join(d.lex, filepath.FromSlash(rel)))
	if err != nil {
		return nil, nil, "", false
	}
	f, err := openShared(resolved)
	if err != nil {
		return nil, nil, "", false
	}
	fi, err := f.Stat()
	if err != nil || !fi.Mode().IsRegular() {
		_ = f.Close()
		return nil, nil, "", false
	}
	real, err := realPathOfFile(f, resolved)
	if err != nil || real != expected || !isUnder(realRoot, real) {
		_ = f.Close()
		return nil, nil, "", false
	}
	return f, fi, real, true
}

// asciiFilename is baseName.replace(/[^\x20-\x7e]/g, '_'): one '_' per
// UTF-16 code unit.
func asciiFilename(s string) string {
	var b strings.Builder
	for _, c := range s {
		switch {
		case c >= 0x20 && c <= 0x7e:
			b.WriteRune(c)
		case c > 0xffff:
			b.WriteString("__")
		default:
			b.WriteByte('_')
		}
	}
	return b.String()
}

// encodeURIComponent escapes everything but A-Z a-z 0-9 - _ . ! ~ * ' ( ).
func encodeURIComponent(s string) string {
	const hexd = "0123456789ABCDEF"
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || c >= '0' && c <= '9' ||
			strings.IndexByte("-_.!~*'()", c) >= 0 {
			b.WriteByte(c)
			continue
		}
		b.WriteByte('%')
		b.WriteByte(hexd[c>>4])
		b.WriteByte(hexd[c&15])
	}
	return b.String()
}

// ---- /photos --------------------------------------------------------------

var photoNameRE = regexp.MustCompile(`^[A-Za-z0-9_-][A-Za-z0-9_.-]*$`)

// fastPhotos is app.use('/photos', express.static(PHOTOS_DIR)) for a plain
// file name. Anything else (missing file → Express's 404 page, dotfiles,
// directories, encoded names) goes to Node.
func (s *Server) fastPhotos(w http.ResponseWriter, r *http.Request, name string) bool {
	_, h, ok := s.precheck(r)
	if !ok || !photoNameRE.MatchString(name) || strings.HasSuffix(name, ".") {
		return false
	}
	if _, ok := s.cookieAllows(r); !ok {
		return false
	}
	f, fi, real, ok := s.openUnder(&s.photos, name)
	if !ok {
		return false
	}
	h = append(h, hdr{"Cache-Control", photosCacheControl})
	plan, ok := planSend(r, h, fi.Size(), fi.ModTime(), real)
	if !ok {
		_ = f.Close()
		return false
	}
	s.stats.fastPhoto.Add(1)
	s.serve(w, r, plan, f)
	return true
}

// ---- /api/thumbs/:id --------------------------------------------------------

// fastThumbs answers a cache hit of GET /api/thumbs/:id. A miss is Node's:
// it generates the thumbnail (and hands the bytes back to us to stream).
func (s *Server) fastThumbs(w http.ResponseWriter, r *http.Request, rawID string) bool {
	st, h, ok := s.precheck(r)
	if !ok || st.RateLimit {
		return false // the /api limiter must count the request
	}
	if len(rawID) == 0 || len(rawID) > 15 || !isDigits(rawID) {
		return false
	}
	id, err := strconv.ParseInt(rawID, 10, 64)
	if err != nil || id <= 0 {
		return false
	}
	if _, ok := s.cookieAllows(r); !ok {
		return false
	}
	sum := sha256.Sum256([]byte(strconv.FormatInt(id, 10) + ":" + strconv.Itoa(thumbWidth)))
	name := hex.EncodeToString(sum[:])[:32] + ".webp"
	f, fi, real, ok := s.openUnder(&s.thumbs, name)
	if !ok {
		return false
	}
	// The /api cache policy, then the route's own headers.
	mtimeMs := statMtimeMs(fi.ModTime())
	etag := `"thumb-` + strconv.FormatInt(id, 10) + "-" + strconv.Itoa(thumbWidth) + "-" +
		strconv.FormatInt(int64(math.Floor(mtimeMs)), 10) + `"`
	lastMod := utcString(dateMs(mtimeMs))
	h = append(h,
		hdr{"Cache-Control", "no-store, max-age=0"},
		hdr{"Pragma", "no-cache"},
		hdr{"Vary", "Cookie"},
	)
	h.set("Content-Type", "image/webp")
	h.set("Cache-Control", thumbCacheControl)
	h.set("ETag", etag)
	h.set("Last-Modified", lastMod)
	inm, ok1 := nodeHeader(r.Header, "If-None-Match")
	ims, ok2 := nodeHeader(r.Header, "If-Modified-Since")
	if !ok1 || !ok2 {
		_ = f.Close()
		return false
	}
	if inm == etag || ims == lastMod {
		// res.status(304).end(): every header set so far stays.
		_ = f.Close()
		s.stats.fastThumb.Add(1)
		s.serve(w, r, sendPlan{status: http.StatusNotModified, headers: h}, nil)
		return true
	}
	plan, ok := planSend(r, h, fi.Size(), fi.ModTime(), real)
	if !ok {
		_ = f.Close()
		return false
	}
	s.stats.fastThumb.Add(1)
	s.serve(w, r, plan, f)
	return true
}

// serve writes a planned response and streams its byte range.
func (s *Server) serve(w http.ResponseWriter, r *http.Request, plan sendPlan, f *os.File) {
	if f != nil {
		defer f.Close()
	}
	plan.headers.writeTo(w)
	setConnectionHeaders(w, r)
	w.WriteHeader(plan.status)
	if f != nil && plan.body && plan.length > 0 {
		s.copyRange(w, f, plan.start, plan.length)
	}
}
