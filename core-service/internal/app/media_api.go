package app

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

func registerMediaRoutes(mux *http.ServeMux, a *App) {
	mux.Handle("GET /files/{path...}", a.requireSession(http.HandlerFunc(a.handleFile)))
	mux.Handle("GET /photos/{id}", a.requireSession(http.HandlerFunc(a.handlePhoto)))
}

func (a *App) handleFile(w http.ResponseWriter, r *http.Request) {
	path, ok := safeDownloadPath(filepath.Join(a.dataDir, "downloads"), r.PathValue("path"))
	if !ok {
		http.NotFound(w, r)
		return
	}
	if _, err := os.Stat(path); err != nil {
		http.NotFound(w, r)
		return
	}
	http.ServeFile(w, r, path)
}

func (a *App) handlePhoto(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimSpace(r.PathValue("id"))
	if id == "" || strings.ContainsAny(id, `/\\.`) {
		http.NotFound(w, r)
		return
	}
	path := filepath.Join(a.dataDir, "photos", id+".jpg")
	if _, err := os.Stat(path); err != nil {
		http.NotFound(w, r)
		return
	}
	http.ServeFile(w, r, path)
}
