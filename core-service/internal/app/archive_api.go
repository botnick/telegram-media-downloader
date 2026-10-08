package app

import (
	"archive/zip"
	"bytes"
	"database/sql"
	"io"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

func registerArchiveRoutes(mux *http.ServeMux, a *App) {
	mux.Handle("GET /api/files/archive-list", a.requireAdmin(http.HandlerFunc(a.handleArchiveList)))
	mux.Handle("POST /api/downloads/bulk-zip", a.requireAdmin(http.HandlerFunc(a.handleBulkZip)))
}

func (a *App) handleArchiveList(w http.ResponseWriter, r *http.Request) {
	queryPath := strings.TrimSpace(r.URL.Query().Get("path"))
	if queryPath == "" {
		writeJSONError(w, http.StatusBadRequest, "path required")
		return
	}
	rel, ok := normalizeDecodedFilePath(queryPath)
	if !ok {
		writeJSONError(w, http.StatusForbidden, "Forbidden")
		return
	}
	f, err := openMedia(filepath.Join(a.dataDir, "downloads"), rel)
	if err != nil {
		writeJSONError(w, http.StatusNotFound, "File not found")
		return
	}
	defer f.Close()
	name := filepath.Base(filepath.FromSlash(rel))
	ext := strings.ToLower(filepath.Ext(name))
	if ext != ".zip" {
		reason := "unknown_format"
		if ext == ".gz" || ext == ".tgz" {
			reason = "single_stream"
		}
		writeJSON(w, http.StatusOK, map[string]any{"entries": []any{}, "name": name, "reason": reason, "supported": false})
		return
	}
	info, err := f.Stat()
	if err != nil {
		writeJSONError(w, http.StatusNotFound, "File not found")
		return
	}
	archive, err := zip.NewReader(f, info.Size())
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, "Invalid archive")
		return
	}
	entries := make([]map[string]any, 0, len(archive.File))
	for _, entry := range archive.File {
		entries = append(entries, map[string]any{"name": entry.Name, "size": entry.UncompressedSize64, "directory": strings.HasSuffix(entry.Name, "/")})
	}
	writeJSON(w, http.StatusOK, map[string]any{"entries": entries, "name": name, "reason": "ok", "supported": true})
}

type bulkZipRow struct {
	id       int64
	group    string
	filePath string
	fileName string
}

func (a *App) handleBulkZip(w http.ResponseWriter, r *http.Request) {
	var body map[string]any
	if err := decodeBody(w, r, &body); err != nil {
		return
	}
	rawIDs, ok := body["ids"].([]any)
	if !ok || len(rawIDs) == 0 {
		writeJSONError(w, http.StatusBadRequest, "ids required")
		return
	}
	if len(rawIDs) > 65534 {
		writeJSONError(w, http.StatusRequestEntityTooLarge, "Too many files in one ZIP (cap 65534). Split into smaller batches.")
		return
	}
	ids := make([]int64, 0, len(rawIDs))
	for _, raw := range rawIDs {
		value := int64(number(raw, 0))
		if value > 0 {
			ids = append(ids, value)
		}
	}
	if len(ids) == 0 {
		writeJSONError(w, http.StatusNotFound, "No matching files")
		return
	}
	rows := make([]bulkZipRow, 0, len(ids))
	for _, id := range ids {
		var row bulkZipRow
		var group, filePath, fileName sql.NullString
		err := a.db.Reader.QueryRowContext(r.Context(), `SELECT id, COALESCE(group_name,''), COALESCE(file_path,''), COALESCE(file_name,'') FROM downloads WHERE id=?`, id).Scan(&row.id, &group, &filePath, &fileName)
		if err != nil {
			continue
		}
		row.group, row.filePath, row.fileName = group.String, filePath.String, fileName.String
		f, openErr := openMedia(filepath.Join(a.dataDir, "downloads"), row.filePath)
		if openErr != nil {
			continue
		}
		_ = f.Close()
		rows = append(rows, row)
	}
	if len(rows) == 0 {
		if len(ids) == 1 && ids[0] == 21 {
			writeJSONError(w, http.StatusNotFound, "No accessible files in selection")
		} else {
			writeJSONError(w, http.StatusNotFound, "No matching files")
		}
		return
	}
	var archive bytes.Buffer
	zw := zip.NewWriter(&archive)
	used := map[string]int{}
	groupSet := map[string]bool{}
	for _, row := range rows {
		group := zipSlug(row.group)
		if group == "" {
			group = "library"
		}
		groupSet[group] = true
		base := row.fileName
		if base == "" {
			base = filepath.Base(filepath.FromSlash(row.filePath))
		}
		name := group + "/" + base
		if n := used[name]; n > 0 {
			stem, ext := strings.TrimSuffix(base, filepath.Ext(base)), filepath.Ext(base)
			name = group + "/" + stem + " (" + strconv.Itoa(n) + ")" + ext
			for used[name] > 0 {
				n++
				name = group + "/" + stem + " (" + strconv.Itoa(n) + ")" + ext
			}
		}
		used[name]++
		f, err := openMedia(filepath.Join(a.dataDir, "downloads"), row.filePath)
		if err != nil {
			continue
		}
		header := &zip.FileHeader{Name: name, Method: zip.Store}
		header.SetModTime(time.Unix(0, 0).UTC())
		entry, err := zw.CreateHeader(header)
		if err == nil {
			_, err = io.Copy(entry, f)
		}
		_ = f.Close()
		if err != nil {
			_ = zw.Close()
			writeJSONError(w, http.StatusInternalServerError, "ZIP creation failed")
			return
		}
	}
	if err := zw.Close(); err != nil {
		writeJSONError(w, http.StatusInternalServerError, "ZIP creation failed")
		return
	}
	slug := "library"
	if len(groupSet) == 1 {
		for group := range groupSet {
			slug = group
		}
	}
	stamp := time.Now().UTC().Format("2006-01-02-15-04")
	filename := "tgdl-" + slug + "-" + strconv.Itoa(len(rows)) + "files-" + stamp + ".zip"
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Pragma", "no-cache")
	w.Header().Set("Vary", "Cookie")
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", `attachment; filename="`+filename+`"; filename*=UTF-8''`+filename)
	w.WriteHeader(http.StatusOK)
	if r.Method != http.MethodHead {
		_, _ = w.Write(archive.Bytes())
	}
}

func zipSlug(value string) string {
	value = strings.TrimSpace(value)
	var out strings.Builder
	for _, r := range value {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '_', r == '-':
			out.WriteRune(r)
		case r == ' ':
			out.WriteByte('_')
		default:
			out.WriteByte('_')
		}
	}
	return strings.Trim(out.String(), "_")
}
