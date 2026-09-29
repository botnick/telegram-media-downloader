package front

import (
	"crypto/sha1"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"io"
	"io/fs"
	"math"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"unicode/utf8"
)

// thumbWidth is the only thumbnail width the cache key covers here
// (GET /api/thumbs/:id without ?w=).
const thumbWidth = 320

const filesPrefix = "/files/"

// serveFast answers the request itself when it can; false means "proxy it".
func (s *Server) serveFast(w http.ResponseWriter, r *http.Request) bool {
	rawPath, rawQuery, ok := splitTarget(r.RequestURI)
	if !ok {
		return false
	}
	switch {
	case len(rawPath) > len(filesPrefix) && strings.EqualFold(rawPath[:len(filesPrefix)], filesPrefix):
		// Express matches the mount point case-insensitively; the cache
		// policy and the file token only apply to the exact spelling.
		return s.fastFiles(w, r, rawPath[len(filesPrefix):], rawQuery, rawPath[:len(filesPrefix)] == filesPrefix)
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
// the dashboard's auth configured and — with forceHttps on — a request that
// is secure or comes from the machine itself. It returns the state and the
// headers Node's middleware chain and the route put first (pushed by Node
// for exactly this case). anyMethod is /files: Express hands every method
// to its handler, which ignores the body. Everything else is GET / HEAD
// without a body.
func (s *Server) precheck(r *http.Request, route string, anyMethod bool) (*State, hdrList, bool) {
	if !anyMethod {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			return nil, nil, false
		}
		if r.ContentLength != 0 || len(r.TransferEncoding) > 0 {
			return nil, nil, false
		}
	}
	st := s.state.Load()
	if st == nil || !st.AuthReady {
		return nil, nil, false
	}
	if st.ForceHTTPS {
		xfp, ok := nodeHeader(r.Header, "X-Forwarded-Proto")
		proto, exact := s.trust.protocol(s.clientAddr(r), xfp, ok)
		if !exact {
			return nil, nil, false
		}
		if proto != "https" {
			// Node redirects — except a request from the machine itself,
			// which it lets through over plain HTTP (no HSTS then: its own
			// header set).
			if !s.isDirectLoopback(r) {
				return nil, nil, false
			}
			route += ".local"
		}
	}
	h, ok := st.routeHeaders(route)
	if !ok {
		return nil, nil, false
	}
	return st, h, true
}

// isDirectLoopback is Node's isLocalRequest for a request that carries no
// X-Forwarded-For: req.ip is then the socket address whatever `trust proxy`
// says.
func (s *Server) isDirectLoopback(r *http.Request) bool {
	if len(r.Header.Values("X-Forwarded-For")) > 0 {
		return false
	}
	switch s.clientAddr(r) {
	case "127.0.0.1", "::1", "::ffff:127.0.0.1":
		return true
	}
	return false
}

// openResult is what looking for a file under a root found.
type openResult int

const (
	opened openResult = iota
	notFound
	notRegular // a directory, a device …
	forbidden
)

// openUnder opens dir/rel for a regular file inside the allowed roots
// (TGDL_CORE_ALLOW_ROOTS), symlinks and junctions resolved: a link that
// leaves every root is refused. real is the file's real path — what Node's
// fs.realpath returned — whose name and extension the response uses.
func (s *Server) openUnder(d *rootDir, rel string) (*os.File, os.FileInfo, string, openResult) {
	if d.lex == "" || !filepath.IsLocal(filepath.FromSlash(rel)) {
		return nil, nil, "", forbidden
	}
	resolved, err := s.roots.Resolve(filepath.Join(d.lex, filepath.FromSlash(rel)))
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, nil, "", notFound
		}
		return nil, nil, "", forbidden
	}
	if st, err := os.Stat(resolved); err == nil && !st.Mode().IsRegular() {
		return nil, nil, "", notRegular
	}
	f, err := openShared(resolved)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, nil, "", notFound
		}
		return nil, nil, "", forbidden
	}
	fi, err := f.Stat()
	if err != nil {
		_ = f.Close()
		return nil, nil, "", forbidden
	}
	real, err := realPathOfFile(f, resolved)
	if err != nil {
		real = resolved
	}
	return f, fi, real, opened
}

// ---- /files ---------------------------------------------------------------

// fastFiles is the local branch of app.use('/files', …): token or session,
// safeResolveDownload, Content-Disposition, res.sendFile — and the error
// answers of each step. What Node keeps is not local: the cluster bridge,
// ?peer= fetches and inline HEIC transcoding (sharp) are proxied; so is
// anything the checkAuth middleware refuses.
func (s *Server) fastFiles(w http.ResponseWriter, r *http.Request, rawRel, rawQuery string, exact bool) bool {
	st, h, ok := s.precheck(r, "files", true)
	if !ok {
		return false
	}
	q, ok := parseNodeQuery(rawQuery)
	if !ok || q.has("peer") {
		return false // federated ?peer= fetches go to Node
	}
	allowed := false
	if tok, ok := q.str("token"); ok && exact {
		_, allowed = fileTokenRole(st.secret, tok)
	}
	if !allowed {
		_, allowed = s.cookieAllows(r)
	}
	if !allowed {
		return false
	}
	if !exact {
		h.del("Cache-Control") // the cache policy didn't match this spelling
	}

	// Express drops one of two leading slashes when it trims the mount point
	// ("/files//a" reaches the handler as "/a").
	rawRel = strings.TrimPrefix(rawRel, "/")
	dec, err := url.PathUnescape(rawRel)
	if err != nil || !utf8.ValidString(dec) {
		s.textReply(w, r, h, http.StatusBadRequest, "Bad request")
		return true
	}
	if dec == "" {
		return false // bare /files/: not a file, Node's 404 page
	}
	if strings.ContainsRune(dec, 0) {
		s.textReply(w, r, h, http.StatusBadRequest, "Bad request")
		return true
	}
	if strings.HasPrefix(dec, "_clusterref") {
		return false // cluster bridge
	}
	rel, ok := normalizeRel(dec)
	if !ok {
		s.textReply(w, r, h, http.StatusForbidden, "Forbidden")
		return true
	}
	f, fi, real, res := s.openUnder(&s.downloads, rel)
	switch res {
	case notFound:
		s.notify("missing", dec)
		s.textReply(w, r, h, http.StatusNotFound, "File not found")
		return true
	case notRegular:
		s.textReply(w, r, h, http.StatusNotFound, "File not found")
		return true
	case forbidden:
		s.textReply(w, r, h, http.StatusForbidden, "Forbidden")
		return true
	}
	base := filepath.Base(real)
	inline := false
	if v, ok := q.str("inline"); ok && v == "1" {
		inline = true
	}
	ext := strings.ToLower(filepath.Ext(real))
	if inline && (ext == ".heic" || ext == ".heif") {
		_ = f.Close()
		return false // Node transcodes to JPEG
	}
	if strings.HasPrefix(base, ".") {
		_ = f.Close()
		s.textReply(w, r, h, http.StatusNotFound, "File not found")
		return true
	}
	kind := "attachment"
	if inline {
		kind = "inline"
	}
	h = append(h,
		hdr{"Content-Disposition", kind + `; filename="` + asciiFilename(base) + `"; filename*=UTF-8''` + encodeURIComponent(base)},
	)
	plan, ok := planSend(r, h, fi.Size(), fi.ModTime(), real)
	if !ok {
		// A header whose JavaScript parsing isn't reproduced: serve the
		// whole file, as if the request had no validators or range.
		plan, _ = planSend(&http.Request{Method: r.Method, Header: http.Header{}}, h, fi.Size(), fi.ModTime(), real)
	}
	s.stats.fastFiles.Add(1)
	s.serve(w, r, plan, f)
	return true
}

// normalizeRel is the front half of safeResolveDownload for a decoded
// request path: path.normalize, the legacy "data/downloads/" prefix, no
// absolute path and no ".." left. On Windows the characters that change
// what a path means there (backslash, drive colon, trailing dot or space)
// are refused. Slash-separated, ready for filepath.FromSlash.
func normalizeRel(dec string) (string, bool) {
	if runtime.GOOS == "windows" {
		if strings.ContainsAny(dec, `\:`) {
			return "", false
		}
		for _, seg := range strings.Split(dec, "/") {
			if seg != "" && (strings.HasSuffix(seg, ".") || strings.HasSuffix(seg, " ")) && seg != "." && seg != ".." {
				return "", false
			}
		}
	}
	rel := path.Clean(dec)
	for strings.HasPrefix(rel, "data/downloads/") {
		rel = rel[len("data/downloads/"):]
	}
	if strings.HasPrefix(rel, "/") || rel == ".." || strings.HasPrefix(rel, "../") {
		return "", false
	}
	return rel, true
}

// textReply is res.status(code).send(text): Express's text/html body with
// its weak ETag, on top of the headers the middlewares set.
func (s *Server) textReply(w http.ResponseWriter, r *http.Request, h hdrList, status int, body string) {
	h = h.clone()
	h.set("Content-Type", "text/html; charset=utf-8")
	h.set("Content-Length", strconv.Itoa(len(body)))
	h.set("ETag", bodyETag(body))
	s.serve(w, r, sendPlan{status: status, headers: h, text: body}, nil)
}

// bodyETag is the etag package's weak tag of a body: W/"<len hex>-<sha1>".
func bodyETag(body string) string {
	sum := sha1.Sum([]byte(body))
	return `W/"` + strconv.FormatInt(int64(len(body)), 16) + "-" + base64.StdEncoding.EncodeToString(sum[:])[:27] + `"`
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
// directories, encoded names, a refused precondition or range — static
// falls through on those) goes to Node, which has no /photos handler left.
func (s *Server) fastPhotos(w http.ResponseWriter, r *http.Request, name string) bool {
	_, h, ok := s.precheck(r, "photos", false)
	if !ok || !photoNameRE.MatchString(name) || strings.HasSuffix(name, ".") {
		return false
	}
	if _, ok := s.cookieAllows(r); !ok {
		return false
	}
	f, fi, real, res := s.openUnder(&s.photos, name)
	if res != opened {
		return false
	}
	plan, ok := planSend(r, h, fi.Size(), fi.ModTime(), real)
	if !ok || plan.status == http.StatusPreconditionFailed || plan.status == http.StatusRequestedRangeNotSatisfiable {
		_ = f.Close()
		return false
	}
	s.stats.fastPhoto.Add(1)
	s.serve(w, r, plan, f)
	return true
}

// ---- /api/thumbs/:id --------------------------------------------------------

// fastThumbs answers a cache hit of GET /api/thumbs/:id. A miss is Node's:
// it generates the thumbnail and sends it.
func (s *Server) fastThumbs(w http.ResponseWriter, r *http.Request, rawID string) bool {
	st, h, ok := s.precheck(r, "thumbs", false)
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
	f, fi, real, res := s.openUnder(&s.thumbs, name)
	if res != opened {
		return false
	}
	// The route's own headers on top of what Node pushed.
	mtimeMs := statMtimeMs(fi.ModTime())
	etag := `"thumb-` + strconv.FormatInt(id, 10) + "-" + strconv.Itoa(thumbWidth) + "-" +
		strconv.FormatInt(int64(math.Floor(mtimeMs)), 10) + `"`
	lastMod := utcString(dateMs(mtimeMs))
	h.set("Content-Type", "image/webp")
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
	if !ok || plan.status == http.StatusPreconditionFailed || plan.status == http.StatusRequestedRangeNotSatisfiable {
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
	keep304Headers(w.Header(), plan.status)
	setConnectionHeaders(w, r)
	w.WriteHeader(plan.status)
	if plan.text != "" && r.Method != http.MethodHead {
		if !plan.headers.has("Content-Length") {
			// res.end() after the headers went out: chunked, as Node sends it.
			if fl, ok := w.(http.Flusher); ok {
				fl.Flush()
			}
		}
		_, _ = io.WriteString(w, plan.text)
	}
	if f != nil && plan.body && plan.length > 0 {
		s.copyRange(w, f, plan.start, plan.length)
	}
}
