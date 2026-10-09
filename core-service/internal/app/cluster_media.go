package app

import (
	"context"
	"database/sql"
	"errors"
	"io"
	"net/http"
	"net/url"
	"path/filepath"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/botnick/telegram-media-downloader/core-service/internal/auth"
	"github.com/botnick/telegram-media-downloader/core-service/internal/front"
)

type streamResponse struct {
	http.ResponseWriter
	ctx context.Context
}

func (w streamResponse) Write(p []byte) (int, error) {
	if err := w.ctx.Err(); err != nil {
		return 0, err
	}
	if err := http.NewResponseController(w.ResponseWriter).SetWriteDeadline(time.Now().Add(30 * time.Second)); err != nil && !errors.Is(err, http.ErrNotSupported) {
		return 0, err
	}
	if err := w.ctx.Err(); err != nil {
		return 0, err
	}
	return w.ResponseWriter.Write(p)
}
func (w streamResponse) Unwrap() http.ResponseWriter { return w.ResponseWriter }
func boundStream(w http.ResponseWriter, ctx context.Context) (http.ResponseWriter, func()) {
	done := make(chan struct{})
	stop := context.AfterFunc(ctx, func() { defer close(done); _ = http.NewResponseController(w).SetWriteDeadline(time.Now()) })
	return streamResponse{w, ctx}, func() {
		if !stop() {
			<-done
		}
		_ = http.NewResponseController(w).SetWriteDeadline(time.Time{})
	}
}

func (a *App) handlePeerFile(w http.ResponseWriter, r *http.Request) {
	decoded := r.PathValue("path")
	if !utf8.ValidString(decoded) || strings.ContainsRune(decoded, 0) {
		fileText(w, r, 400, "Bad request")
		return
	}
	rel, ok := normalizeDecodedFilePath(decoded)
	if !ok || strings.HasPrefix(rel, "_clusterref/") {
		fileText(w, r, 403, "Forbidden")
		return
	}
	if rel == "" {
		fileText(w, r, 400, "Bad request")
		return
	}
	f, err := openMedia(a.downloadsDir, rel)
	if err != nil {
		fileText(w, r, 404, "File not found")
		return
	}
	defer f.Close()
	w.Header().Set("Cache-Control", "private, no-store")
	w, finish := boundStream(w, r.Context())
	defer finish()
	status, err := front.ServeContent(w, r, f, filepath.Base(rel))
	if err != nil {
		if status == 0 {
			fileText(w, r, 500, "File read failed")
			return
		}
		panic(http.ErrAbortHandler)
	}
}

func (a *App) proxyClusterFile(w http.ResponseWriter, r *http.Request, peerID, rel string) {
	sess, _ := auth.SessionFromContext(r.Context())
	if sess.Role != "admin" {
		fileText(w, r, 403, "Forbidden")
		return
	}
	var finish func()
	var ok bool
	r, finish, ok = a.beginClusterRequest(r)
	if !ok {
		fileText(w, r, 503, "Server closing")
		return
	}
	defer finish()
	w.Header().Set("Cache-Control", "private, no-store")
	p, err := a.cluster.Peer(r.Context(), peerID)
	if errors.Is(err, sql.ErrNoRows) || err == nil && p.Status == "revoked" {
		fileText(w, r, 410, "Peer revoked")
		return
	}
	if err != nil {
		writeJSONError(w, 500, "Peer registry read failed")
		return
	}
	if p.StreamMode != "proxy" {
		writeJSON(w, 501, map[string]any{"error": "unsupported_stream_mode", "message": "Peer direct streaming is not implemented"})
		return
	}
	res, err := a.clusterHTTP.Stream(r.Context(), p, r.Method, "/api/cluster/files/"+url.PathEscape(rel), r.Header)
	if err != nil {
		writeJSON(w, 502, map[string]any{"error": "storage_offline", "message": "Peer stream unavailable"})
		return
	}
	defer res.Body.Close()
	if res.StatusCode != 200 && res.StatusCode != 206 && res.StatusCode != 304 && res.StatusCode != 416 {
		if res.StatusCode == 404 {
			fileText(w, r, 404, "File not found")
		} else {
			writeJSON(w, 502, map[string]any{"error": "storage_offline", "message": "Peer refused file request"})
		}
		return
	}
	for _, key := range []string{"Content-Type", "Content-Length", "Content-Range", "Accept-Ranges", "ETag", "Last-Modified"} {
		if v := res.Header.Get(key); v != "" {
			w.Header().Set(key, v)
		}
	}
	w.Header().Set("Cache-Control", "private, no-store")
	w, finishWrite := boundStream(w, r.Context())
	defer finishWrite()
	w.WriteHeader(res.StatusCode)
	if r.Method != "HEAD" {
		if _, err := io.CopyBuffer(w, res.Body, make([]byte, 32<<10)); err != nil {
			// A failed upstream stream must not become a complete, truncated
			// HTTP body when the peer omitted Content-Length.
			panic(http.ErrAbortHandler)
		}
	}
}

func (a *App) handleClusterFile(w http.ResponseWriter, r *http.Request, rel string) {
	parts := strings.Split(rel, "/")
	if len(parts) != 3 || parts[1] == "" {
		fileText(w, r, 404, "Cluster file not found in catalog cache")
		return
	}
	id, err := strconv.ParseInt(parts[2], 10, 64)
	if err != nil || id <= 0 {
		fileText(w, r, 404, "Cluster file not found in catalog cache")
		return
	}
	var path string
	err = a.db.Reader.QueryRowContext(r.Context(), `SELECT d.file_path FROM peer_downloads d JOIN peers p ON p.peer_id=d.peer_id WHERE d.peer_id=? AND d.remote_id=? AND p.status<>'revoked'`, parts[1], id).Scan(&path)
	if errors.Is(err, sql.ErrNoRows) {
		fileText(w, r, 404, "Cluster file not found in catalog cache")
		return
	}
	if err != nil {
		writeJSONError(w, 500, "Peer catalog read failed")
		return
	}
	path, ok := normalizeDecodedFilePath(path)
	if !ok || path == "" || strings.HasPrefix(path, "_clusterref/") {
		fileText(w, r, 403, "Forbidden")
		return
	}
	a.proxyClusterFile(w, r, parts[1], path)
}
