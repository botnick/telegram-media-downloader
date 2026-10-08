package app

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
)

// Stored absolute cache paths are accepted only inside this installation's
// seekbar directory. Opening through a directory handle also rejects symlink
// escapes after the database lookup.
func (a *App) openSeekbar(stored string) (*os.File, error) {
	root := filepath.Join(a.dataDir, "seekbar")
	if filepath.IsAbs(stored) {
		var err error
		stored, err = filepath.Rel(root, stored)
		if err != nil {
			return nil, err
		}
	}
	return openMedia(root, stored)
}

func (a *App) handleSeekbarMeta(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Vary", "Cookie")
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id <= 0 {
		w.WriteHeader(http.StatusNotFound)
		return
	}
	var path string
	err = a.db.Reader.QueryRowContext(r.Context(), "SELECT meta_path FROM seekbar_sprites WHERE download_id=?", id).Scan(&path)
	if err != nil {
		w.Header().Set("Cache-Control", "no-store")
		w.WriteHeader(http.StatusNotFound)
		return
	}
	f, err := a.openSeekbar(path)
	if err != nil {
		w.Header().Set("Cache-Control", "no-store")
		w.WriteHeader(http.StatusNotFound)
		return
	}
	defer f.Close()
	var meta map[string]any
	if err := json.NewDecoder(io.LimitReader(f, 1<<20)).Decode(&meta); err != nil {
		writeJSONError(w, http.StatusInternalServerError, "invalid seekbar metadata")
		return
	}
	w.Header().Set("Cache-Control", "public, max-age=300")
	w.Header().Set("Vary", "Cookie, Accept-Encoding")
	writeJSON(w, http.StatusOK, meta)
}

func (a *App) handleSeekbarSprite(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Vary", "Cookie")
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id <= 0 {
		w.WriteHeader(http.StatusNotFound)
		return
	}
	var path, format string
	var generated int64
	err = a.db.Reader.QueryRowContext(r.Context(), "SELECT sprite_path, COALESCE(format,'webp'), generated_at FROM seekbar_sprites WHERE download_id=?", id).Scan(&path, &format, &generated)
	if err != nil {
		w.Header().Set("Cache-Control", "no-store")
		w.WriteHeader(http.StatusNotFound)
		return
	}
	etag := fmt.Sprintf(`"sk-%d-%d"`, id, generated)
	w.Header().Set("ETag", etag)
	if r.Header.Get("If-None-Match") == etag {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	f, err := a.openSeekbar(path)
	if err != nil {
		w.Header().Set("Cache-Control", "no-store")
		w.WriteHeader(http.StatusNotFound)
		return
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "seekbar read failed")
		return
	}
	w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	w.Header().Set("Content-Type", "image/webp")
	if format == "jpeg" {
		w.Header().Set("Content-Type", "image/jpeg")
	}
	http.ServeContent(w, r, info.Name(), info.ModTime(), f)
}
