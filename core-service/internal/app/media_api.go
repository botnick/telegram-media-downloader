package app

import (
	"net/http"
	"path/filepath"
	"strings"
)

func registerMediaRoutes(mux *http.ServeMux, a *App) {
	mux.Handle("GET /files/{path...}", a.requireSession(http.HandlerFunc(a.handleFile)))
	mux.Handle("GET /photos/{id}", a.requireSession(http.HandlerFunc(a.handlePhoto)))
}

func (a *App) handleFile(w http.ResponseWriter, r *http.Request) {
	f, err := openMedia(filepath.Join(a.dataDir, "downloads"), r.PathValue("path"))
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		http.NotFound(w, r)
		return
	}
	http.ServeContent(w, r, info.Name(), info.ModTime(), f)
}

func (a *App) handlePhoto(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimSpace(r.PathValue("id"))
	if id == "" || strings.ContainsAny(id, `/\\.`) {
		http.NotFound(w, r)
		return
	}
	f, err := openMedia(filepath.Join(a.dataDir, "photos"), id+".jpg")
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		http.NotFound(w, r)
		return
	}
	http.ServeContent(w, r, info.Name(), info.ModTime(), f)
}
