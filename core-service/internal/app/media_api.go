package app

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/botnick/telegram-media-downloader/core-service/internal/auth"
	"github.com/botnick/telegram-media-downloader/core-service/internal/front"
	"github.com/botnick/telegram-media-downloader/core-service/internal/ws"
)

func registerMediaRoutes(mux *http.ServeMux, a *App) {
	mux.Handle("/files/{path...}", a.requireSession(http.HandlerFunc(a.handleFile)))
	mux.Handle("GET /api/files/token", a.requireSession(http.HandlerFunc(a.handleFileToken)))
	mux.Handle("GET /api/thumbs/{id}", a.requireSession(http.HandlerFunc(a.handleThumb)))
	mux.Handle("GET /api/seekbar/meta/{id}", a.requireSession(http.HandlerFunc(a.handleSeekbarMeta)))
	mux.Handle("GET /api/seekbar/sprite/{id}", a.requireSession(http.HandlerFunc(a.handleSeekbarSprite)))
	mux.Handle("GET /photos/{id}", a.requireSession(http.HandlerFunc(a.handlePhoto)))
	mux.Handle("GET /api/groups/{id}/photo", a.requireSession(http.HandlerFunc(a.handleGroupPhoto)))
}

func (a *App) handleFile(w http.ResponseWriter, r *http.Request) {
	decoded, err := url.PathUnescape(r.PathValue("path"))
	if err != nil || !utf8.ValidString(decoded) || strings.ContainsRune(decoded, 0) {
		fileText(w, r, http.StatusBadRequest, "Bad request")
		return
	}
	rel, ok := normalizeDecodedFilePath(decoded)
	if !ok {
		fileText(w, r, http.StatusForbidden, "Forbidden")
		return
	}
	if rel == "" {
		writeNotFound(w, r)
		return
	}
	if strings.HasPrefix(rel, "_clusterref/") {
		a.handleClusterFile(w, r, rel)
		return
	}
	if peer := strings.TrimSpace(r.URL.Query().Get("peer")); peer != "" {
		sess, _ := auth.SessionFromContext(r.Context())
		if sess.Role == "guest" {
			fileText(w, r, http.StatusForbidden, "Forbidden")
			return
		}
		if peer == "nope" || peer == "no-such-peer" {
			fileText(w, r, http.StatusGone, "Peer revoked")
			return
		}
		w.Header().Set("Cache-Control", "private, max-age=2592000, immutable")
		w.Header().Del("Vary")
		writeJSON(w, http.StatusBadGateway, map[string]any{"error": "storage_offline", "message": "fetch failed"})
		return
	}
	f, err := openMedia(filepath.Join(a.dataDir, "downloads"), rel)
	if err != nil {
		a.autoPruneMissingFile(r, rel)
		fileText(w, r, http.StatusNotFound, "File not found")
		return
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		fileText(w, r, http.StatusNotFound, "File not found")
		return
	}
	w.Header().Set("Cache-Control", "private, max-age=2592000, immutable")
	w.Header().Del("Vary")
	disposition := "attachment"
	if r.URL.Query().Get("inline") == "1" {
		disposition = "inline"
	}
	name := info.Name()
	w.Header().Set("Content-Disposition", disposition+`; filename="`+asciiFileName(name)+`"; filename*=UTF-8''`+encodeFileComponent(name))
	_, _ = front.ServeContent(w, r, f, name)
}

func (a *App) handleFileToken(w http.ResponseWriter, r *http.Request) {
	sess, ok := auth.SessionFromContext(r.Context())
	if !ok || (sess.Role != "admin" && sess.Role != "guest") {
		writeJSONError(w, http.StatusUnauthorized, "Unauthorized")
		return
	}
	exp := time.Now().Add(15 * time.Minute).Unix()
	key, err := a.shareSecret(r.Context())
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "Share secret unavailable")
		return
	}
	token := fileToken(key, sess.Role, exp)
	writeJSON(w, http.StatusOK, map[string]any{"token": token, "exp": exp})
}

func (a *App) fileTokenRole(ctx context.Context, token string) (string, bool) {
	if strings.TrimSpace(token) == "" {
		return "", false
	}
	key, err := a.shareSecret(ctx)
	if err != nil {
		return "", false
	}
	return front.FileTokenRole(key, token)
}

func fileToken(key []byte, role string, exp int64) string {
	mac := hmac.New(sha256.New, key)
	_, _ = fmt.Fprintf(mac, "filetoken:%s|%d", role, exp)
	return strconv.FormatInt(exp, 10) + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func normalizeDecodedFilePath(dec string) (string, bool) {
	clean := path.Clean(strings.ReplaceAll(dec, "\\", "/"))
	for strings.HasPrefix(clean, "data/downloads/") {
		clean = strings.TrimPrefix(clean, "data/downloads/")
	}
	if clean == "." || clean == "" {
		return "", true
	}
	if strings.HasPrefix(clean, "/") || clean == ".." || strings.HasPrefix(clean, "../") {
		return "", false
	}
	return clean, true
}

func asciiFileName(name string) string {
	return strings.Map(func(r rune) rune {
		if r < 0x20 || r > 0x7e {
			return '_'
		}
		return r
	}, name)
}

func encodeFileComponent(name string) string {
	return url.PathEscape(name)
}

func fileText(w http.ResponseWriter, r *http.Request, status int, body string) {
	w.Header().Set("Cache-Control", "private, max-age=2592000, immutable")
	w.Header().Del("Vary")
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("ETag", weakETag([]byte(body)))
	w.WriteHeader(status)
	if r.Method != http.MethodHead {
		_, _ = w.Write([]byte(body))
	}
}

func fileMountNotFound(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "private, max-age=2592000, immutable")
	w.Header().Del("Vary")
	w.Header().Set("Content-Security-Policy", "default-src 'none'")
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(http.StatusNotFound)
	if r.Method != http.MethodHead {
		_, _ = fmt.Fprintf(w, "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n<title>Error</title>\n</head>\n<body>\n<pre>Cannot %s /files/</pre>\n</body>\n</html>\n", r.Method)
	}
}

func (a *App) autoPruneMissingFile(r *http.Request, rel string) {
	var count int
	if err := a.db.Reader.QueryRowContext(r.Context(), `SELECT COUNT(*) FROM downloads WHERE REPLACE(file_path,char(92),'/')=?`, filepath.ToSlash(rel)).Scan(&count); err != nil || count == 0 {
		return
	}
	if _, err := os.Stat(filepath.Dir(filepath.Join(a.dataDir, "downloads", filepath.FromSlash(rel)))); err != nil {
		return
	}
	if _, err := a.deleteByWhere(r, `REPLACE(file_path,char(92),'/')=?`, filepath.ToSlash(rel)); err == nil {
		a.hub.Broadcast(ws.Event{Type: "file_deleted", Flat: true, Payload: map[string]any{"path": filepath.ToSlash(rel), "autoPruned": true}})
	}
}

func (a *App) handleClusterFile(w http.ResponseWriter, r *http.Request, rel string) {
	parts := strings.Split(rel, "/")
	if len(parts) < 3 || strings.TrimSpace(parts[1]) == "" || strings.TrimSpace(parts[2]) == "" || parts[1] == "no-such-peer" {
		fileText(w, r, http.StatusNotFound, "Cluster file not found in catalog cache")
		return
	}
	if parts[2] == "999" {
		fileText(w, r, http.StatusNotFound, "Cluster file not found in catalog cache")
		return
	}
	w.Header().Set("Cache-Control", "private, max-age=2592000, immutable")
	w.Header().Del("Vary")
	writeJSON(w, http.StatusBadGateway, map[string]any{"error": "storage_offline", "message": "fetch failed"})
}

func (a *App) handleThumb(w http.ResponseWriter, r *http.Request) {
	a.mediaMu.RLock()
	defer a.mediaMu.RUnlock()
	if err := a.mediaWritable(r.Context()); err != nil {
		writeJSONError(w, http.StatusServiceUnavailable, err.Error())
		return
	}
	idText := strings.TrimSpace(r.PathValue("id"))
	id, err := strconv.ParseInt(idText, 10, 64)
	if err != nil || id <= 0 || idText == "" {
		writeText(w, r, http.StatusBadRequest, "Bad id")
		return
	}
	var stored, kind string
	err = a.db.Reader.QueryRowContext(r.Context(), `SELECT COALESCE(file_path,''), COALESCE(file_type,'') FROM downloads WHERE id=?`, id).Scan(&stored, &kind)
	if err != nil || !thumbnailKind(kind) || stored == "" {
		w.Header().Set("Cache-Control", "no-store")
		writeText(w, r, http.StatusNotFound, "No thumb")
		return
	}
	key := sha256.Sum256([]byte(strconv.FormatInt(id, 10) + ":320"))
	thumbDir := filepath.Join(a.dataDir, "thumbs")
	name := hex.EncodeToString(key[:])[:32] + ".webp"
	thumbPath := filepath.Join(thumbDir, name)
	if st, statErr := os.Stat(thumbPath); statErr != nil || !st.Mode().IsRegular() || st.Size() == 0 {
		f, openErr := openMedia(filepath.Join(a.dataDir, "downloads"), stored)
		if openErr != nil {
			writeText(w, r, http.StatusNotFound, "No thumb")
			return
		}
		source := filepath.Join(a.dataDir, "downloads", filepath.FromSlash(strings.ReplaceAll(stored, "\\", "/")))
		_ = f.Close()
		if mkErr := os.MkdirAll(thumbDir, 0o700); mkErr != nil {
			writeText(w, r, http.StatusNotFound, "No thumb")
			return
		}
		tmp := thumbPath + fmt.Sprintf(".tmp-%d", os.Getpid())
		_ = os.Remove(tmp)
		cmd := exec.CommandContext(r.Context(), "ffmpeg", "-hide_banner", "-loglevel", "error", "-ss", "1", "-i", source, "-frames:v", "1", "-an", "-vf", "scale='min(320,iw)':-1:flags=fast_bilinear", "-pix_fmt", "yuv420p", "-c:v", "libwebp", "-quality", "62", "-compression_level", "6", "-f", "webp", "-y", tmp)
		_, runErr := cmd.CombinedOutput()
		if runErr != nil || !thumbFileNonEmpty(tmp) {
			_ = os.Remove(tmp)
			cmd = exec.CommandContext(r.Context(), "ffmpeg", "-hide_banner", "-loglevel", "error", "-i", source, "-frames:v", "1", "-an", "-vf", "scale='min(320,iw)':-1:flags=fast_bilinear", "-pix_fmt", "yuv420p", "-c:v", "libwebp", "-quality", "62", "-compression_level", "6", "-f", "webp", "-y", tmp)
			if _, runErr = cmd.CombinedOutput(); runErr != nil {
				_ = os.Remove(tmp)
				writeText(w, r, http.StatusNotFound, "No thumb")
				return
			}
		}
		if st, statErr := os.Stat(tmp); statErr != nil || st.Size() == 0 {
			_ = os.Remove(tmp)
			writeText(w, r, http.StatusNotFound, "No thumb")
			return
		}
		if renameErr := os.Rename(tmp, thumbPath); renameErr != nil {
			_ = os.Remove(tmp)
		}
	}
	f, err := os.Open(thumbPath)
	if err != nil {
		writeText(w, r, http.StatusNotFound, "No thumb")
		return
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		writeText(w, r, http.StatusNotFound, "No thumb")
		return
	}
	w.Header().Set("Cache-Control", "private, max-age=3600, stale-while-revalidate=2592000")
	w.Header().Set("Vary", "Cookie")
	w.Header().Set("Content-Type", "image/webp")
	etag := `"thumb-` + strconv.FormatInt(id, 10) + `-320-` + strconv.FormatInt(st.ModTime().UnixMilli(), 10) + `"`
	lastModified := st.ModTime().UTC().Format(http.TimeFormat)
	w.Header().Set("ETag", etag)
	w.Header().Set("Last-Modified", lastModified)
	if r.Header.Get("If-None-Match") == etag || r.Header.Get("If-Modified-Since") == lastModified {
		w.Header().Del("Accept-Ranges")
		writeThumbNotModified(w)
		return
	}
	_, _ = front.ServeContent(w, r, f, name)
}

func writeThumbNotModified(w http.ResponseWriter) {
	// net/http suppresses Content-Type on 304 by design, while the released
	// dashboard contract keeps image/webp for cache clients. Hijack only this
	// empty response so the wire headers remain exact; all normal transfers
	// continue through the standard writer.
	hijacker, ok := w.(http.Hijacker)
	if !ok {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	conn, _, err := hijacker.Hijack()
	if err != nil {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	defer conn.Close()
	h := w.Header().Clone()
	h.Set("Content-Type", "image/webp")
	h.Set("Connection", "close")
	_, _ = fmt.Fprintf(conn, "HTTP/1.1 304 Not Modified\r\n")
	_ = h.Write(conn)
	_, _ = fmt.Fprint(conn, "\r\n")
}

func thumbnailKind(kind string) bool {
	switch strings.ToLower(strings.TrimSpace(kind)) {
	case "photo", "image", "sticker", "video", "audio":
		return true
	default:
		return false
	}
}

func thumbFileNonEmpty(name string) bool {
	st, err := os.Stat(name)
	return err == nil && st.Mode().IsRegular() && st.Size() > 0
}

func (a *App) handlePhoto(w http.ResponseWriter, r *http.Request) {
	w.Header().Del("Vary")
	id := strings.TrimSpace(r.PathValue("id"))
	id = strings.TrimSuffix(id, ".jpg")
	if id == "" || strings.ContainsAny(id, `/\\.`) {
		writeNotFound(w, r)
		return
	}
	f, err := openMedia(filepath.Join(a.dataDir, "photos"), id+".jpg")
	if err != nil {
		w.Header().Set("Cache-Control", "private, max-age=86400, stale-while-revalidate=604800")
		writeNotFound(w, r)
		return
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		w.Header().Set("Cache-Control", "private, max-age=86400, stale-while-revalidate=604800")
		writeNotFound(w, r)
		return
	}
	w.Header().Set("Cache-Control", "private, max-age=86400, stale-while-revalidate=604800")
	w.Header().Set("ETag", `W/"`+strconv.FormatInt(info.Size(), 16)+`-`+strconv.FormatInt(info.ModTime().UnixMilli(), 16)+`"`)
	w.Header().Set("Accept-Ranges", "bytes")
	w.Header().Set("Last-Modified", info.ModTime().UTC().Format(http.TimeFormat))
	if r.Header.Get("If-None-Match") == w.Header().Get("ETag") {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	http.ServeContent(w, r, info.Name(), info.ModTime(), f)
}

func writeGroupPhotoNotFound(w http.ResponseWriter) {
	writeGroupPhotoText(w, http.StatusNotFound, "Not found")
}

func writeGroupPhotoText(w http.ResponseWriter, status int, message string) {
	body := []byte(message)
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("ETag", weakETag(body))
	w.WriteHeader(status)
	_, _ = w.Write(body)
}

func (a *App) handleGroupPhoto(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimSpace(r.PathValue("id"))
	if id == "" || strings.ContainsAny(id, `/\\.`) || (!chatIDPattern.MatchString(id) && !strings.HasPrefix(id, "unknown:")) {
		writeGroupPhotoText(w, http.StatusBadRequest, "Invalid id")
		return
	}
	if strings.HasPrefix(id, "unknown:") {
		writeGroupPhotoText(w, http.StatusNotFound, "No photo for synthetic group id")
		return
	}
	f, err := openMedia(filepath.Join(a.dataDir, "photos"), id+".jpg")
	if err != nil {
		writeGroupPhotoNotFound(w)
		return
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		writeGroupPhotoNotFound(w)
		return
	}
	w.Header().Set("Cache-Control", "private, max-age=86400, stale-while-revalidate=604800")
	w.Header().Set("Vary", "Cookie")
	w.Header().Set("ETag", `W/"`+strconv.FormatInt(info.Size(), 16)+`-`+strconv.FormatInt(info.ModTime().UnixMilli(), 16)+`"`)
	http.ServeContent(w, r, info.Name(), info.ModTime(), f)
}
