package app

import (
	"net/http"
	"path/filepath"
	"strconv"
	"strings"
)

func registerMediaRoutes(mux *http.ServeMux, a *App) {
	mux.Handle("GET /files/{path...}", a.requireSession(http.HandlerFunc(a.handleFile)))
	mux.Handle("GET /photos/{id}", a.requireSession(http.HandlerFunc(a.handlePhoto)))
	mux.Handle("GET /api/groups/{id}/photo", a.requireSession(http.HandlerFunc(a.handleGroupPhoto)))
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
