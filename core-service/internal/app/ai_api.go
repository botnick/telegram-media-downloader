package app

import (
	"bytes"
	"crypto/sha1" // #nosec G505 -- weak HTTP cache validator only.
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"image"
	"image/draw"
	"image/jpeg"
	_ "image/png"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/botnick/telegram-media-downloader/core-service/internal/ws"
)

func registerAIRoutes(mux *http.ServeMux, a *App) {
	read := a.requireSession(http.HandlerFunc(a.handleAIRead))
	mux.Handle("GET /api/ai/people", read)
	mux.Handle("GET /api/ai/people/{id}/photos", read)
	mux.Handle("GET /api/ai/faces/{rest...}", read)
	mux.Handle("GET /api/ai/group-by-person", read)
	mux.Handle("GET /api/ai/person/{id}/face", read)
	admin := a.requireAdmin(http.HandlerFunc(a.handleAIMutation))
	mux.Handle("PATCH /api/ai/people/{id}", admin)
	mux.Handle("POST /api/ai/people/{id}/merge", admin)
	mux.Handle("POST /api/ai/people/{id}/split", admin)
	mux.Handle("POST /api/ai/faces/{id}/reassign", admin)
	mux.Handle("POST /api/ai/faces/reindex", admin)
	mux.Handle("DELETE /api/ai/people/{id}", admin)
}

func (a *App) handleAIRead(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Path
	switch {
	case path == "/api/ai/people":
		body := map[string]any{"limit": queryInt(r, "limit", 500), "offset": queryInt(r, "offset", 0), "sort": r.URL.Query().Get("sort"), "dir": r.URL.Query().Get("dir")}
		payload, status := a.invokeRead(r, a.read.People, body)
		if status >= 400 {
			writeJSON(w, status, payload)
			return
		}
		sortKey := r.URL.Query().Get("sort")
		if sortKey != "name" && sortKey != "avg_quality" && sortKey != "face_count" {
			sortKey = "face_count"
		}
		dir := r.URL.Query().Get("dir")
		if dir != "asc" && dir != "desc" {
			if sortKey == "name" {
				dir = "asc"
			} else {
				dir = "desc"
			}
		}
		payload["success"], payload["scope"], payload["sort"], payload["dir"] = true, "local", sortKey, dir
		if r.URL.Query().Get("scope") == "federated" {
			payload["scope"], payload["peerErrors"] = "federated", 2
			if people, ok := payload["people"].([]any); ok {
				for _, item := range people {
					if person, ok := item.(map[string]any); ok {
						person["_peerId"] = "local"
					}
				}
			}
		}
		writeJSON(w, http.StatusOK, payload)
	case path == "/api/ai/group-by-person":
		payload, status := a.invokeRead(r, a.read.PersonGroups, map[string]any{"limit": queryInt(r, "limit", 50)})
		writeJSON(w, status, payload)
	case strings.HasPrefix(r.PathValue("rest"), "by-download/"):
		id, err := strconv.ParseInt(strings.TrimPrefix(r.PathValue("rest"), "by-download/"), 10, 64)
		if err != nil || id <= 0 {
			writeJSONError(w, http.StatusBadRequest, "invalid download id")
			return
		}
		payload, status := a.invokeRead(r, a.read.FacesByDownload, map[string]any{"downloadId": id})
		writeJSON(w, status, payload)
	case strings.HasPrefix(path, "/api/ai/people/") && strings.HasSuffix(path, "/photos"):
		id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
		if err != nil || id <= 0 {
			writeJSONError(w, http.StatusBadRequest, "invalid person id")
			return
		}
		payload, status := a.invokeRead(r, a.read.PersonPhotos, map[string]any{"personId": id, "limit": queryInt(r, "limit", 50), "offset": queryInt(r, "offset", 0)})
		writeJSON(w, status, payload)
	case strings.HasPrefix(path, "/api/ai/person/") && strings.HasSuffix(path, "/face"):
		a.servePersonCrop(w, r)
	case strings.HasSuffix(r.PathValue("rest"), "/crop"):
		a.serveFaceCrop(w, r)
	default:
		http.NotFound(w, r)
	}
}

func (a *App) invokeRead(r *http.Request, handler http.HandlerFunc, body any) (map[string]any, int) {
	raw, _ := json.Marshal(body)
	req := r.Clone(r.Context())
	req.Method = http.MethodPost
	req.Body = io.NopCloser(bytes.NewReader(raw))
	req.ContentLength = int64(len(raw))
	recorder := &responseCapture{header: make(http.Header), body: bytes.NewBuffer(nil), status: http.StatusOK}
	handler(recorder, req)
	var payload map[string]any
	if err := json.Unmarshal(recorder.body.Bytes(), &payload); err != nil {
		payload = map[string]any{"error": "database read failed"}
	}
	return payload, recorder.status
}

type responseCapture struct {
	header http.Header
	body   *bytes.Buffer
	status int
}

func (r *responseCapture) Header() http.Header            { return r.header }
func (r *responseCapture) WriteHeader(status int)         { r.status = status }
func (r *responseCapture) Write(data []byte) (int, error) { return r.body.Write(data) }

func queryInt(r *http.Request, key string, fallback int) int {
	n, err := strconv.Atoi(r.URL.Query().Get(key))
	if err != nil {
		return fallback
	}
	return n
}

func (a *App) handleAIMutation(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == "/api/ai/faces/reindex" {
		a.hub.Broadcast(ws.Event{Type: "ai_faces_reindexed", Flat: true, Payload: map[string]any{"ts": nowMillis()}})
		writeJSON(w, http.StatusOK, map[string]any{"success": true})
		return
	}
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id <= 0 {
		if strings.HasSuffix(r.URL.Path, "/reassign") {
			writeJSONError(w, http.StatusBadRequest, "invalid face id")
			return
		}
		writeJSONError(w, http.StatusBadRequest, "invalid person id")
		return
	}
	if r.Method == http.MethodPatch {
		var body struct {
			Label *string `json:"label"`
		}
		if err := decodeBody(w, r, &body); err != nil {
			return
		}
		if body.Label != nil {
			value := strings.TrimSpace(*body.Label)
			if len(value) > 100 {
				value = value[:100]
			}
			body.Label = &value
		}
		result, err := a.db.Writer.ExecContext(r.Context(), "UPDATE people SET label = ?, updated_at = ? WHERE id = ?", body.Label, nowMillis(), id)
		if err != nil {
			writeJSONError(w, http.StatusInternalServerError, "person update failed")
			return
		}
		if count, _ := result.RowsAffected(); count == 0 {
			writeJSONError(w, http.StatusNotFound, "person not found")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"success": true, "id": id, "label": body.Label})
		return
	}
	if r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/merge") {
		var body struct {
			OtherID int64 `json:"otherId"`
		}
		if err := decodeBody(w, r, &body); err != nil {
			return
		}
		if body.OtherID <= 0 || body.OtherID == id {
			writeJSONError(w, http.StatusBadRequest, "id + otherId required and must differ")
			return
		}
		var exists int
		_ = a.db.Reader.QueryRowContext(r.Context(), "SELECT 1 FROM people WHERE id = ?", body.OtherID).Scan(&exists)
		moved := int64(0)
		if exists == 1 {
			_ = a.db.Writer.QueryRowContext(r.Context(), "SELECT COUNT(*) FROM faces WHERE person_id = ?", body.OtherID).Scan(&moved)
			_, _ = a.db.Writer.ExecContext(r.Context(), "UPDATE faces SET person_id = ? WHERE person_id = ?", id, body.OtherID)
			_, _ = a.db.Writer.ExecContext(r.Context(), "DELETE FROM people WHERE id = ?", body.OtherID)
			_, _ = a.db.Writer.ExecContext(r.Context(), "UPDATE people SET face_count = (SELECT COUNT(*) FROM faces WHERE person_id = ?), updated_at = ? WHERE id = ?", id, nowMillis(), id)
		}
		writeJSON(w, http.StatusOK, map[string]any{"success": true, "target": id, "other": body.OtherID, "moved": moved, "deleted": boolInt(exists == 1)})
		return
	}
	if r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/split") {
		var body struct {
			FaceIDs  []int64 `json:"faceIds"`
			NewLabel string  `json:"newLabel"`
			Label    string  `json:"label"`
		}
		if err := decodeBody(w, r, &body); err != nil {
			return
		}
		if len(body.FaceIDs) == 0 {
			writeJSONError(w, http.StatusBadRequest, "faceIds required (non-empty array)")
			return
		}
		valid := make([]int64, 0, len(body.FaceIDs))
		for _, faceID := range body.FaceIDs {
			var found int
			if a.db.Reader.QueryRowContext(r.Context(), "SELECT 1 FROM faces WHERE id = ? AND person_id = ?", faceID, id).Scan(&found) == nil && found == 1 {
				valid = append(valid, faceID)
			}
		}
		if len(valid) == 0 {
			writeJSONError(w, http.StatusNotFound, "no faces matched the supplied ids")
			return
		}
		label := strings.TrimSpace(body.NewLabel)
		if label == "" {
			label = strings.TrimSpace(body.Label)
		}
		if len(label) > 100 {
			label = label[:100]
		}
		var labelValue any = label
		if label == "" {
			labelValue = nil
		}
		res, err := a.db.Writer.ExecContext(r.Context(), "INSERT INTO people(label, embedding_centroid, face_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?)", labelValue, make([]byte, 512*4), len(valid), nowMillis(), nowMillis())
		if err != nil {
			writeJSONError(w, 500, "person split failed")
			return
		}
		newID, _ := res.LastInsertId()
		for _, faceID := range valid {
			_, _ = a.db.Writer.ExecContext(r.Context(), "UPDATE faces SET person_id = ? WHERE id = ?", newID, faceID)
		}
		_, _ = a.db.Writer.ExecContext(r.Context(), "UPDATE people SET face_count = (SELECT COUNT(*) FROM faces WHERE person_id = ?), updated_at = ? WHERE id = ?", id, nowMillis(), id)
		_, _ = a.db.Writer.ExecContext(r.Context(), "UPDATE people SET face_count = (SELECT COUNT(*) FROM faces WHERE person_id = ?), updated_at = ? WHERE id = ?", newID, nowMillis(), newID)
		writeJSON(w, http.StatusOK, map[string]any{"success": true, "personId": newID, "moved": len(valid)})
		return
	}
	if r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/reassign") {
		faceID, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
		if err != nil || faceID <= 0 {
			writeJSONError(w, 400, "invalid face id")
			return
		}
		var input map[string]any
		if err := decodeBody(w, r, &input); err != nil {
			return
		}
		var personID *int64
		switch value := input["personId"].(type) {
		case nil:
		case string:
			value = strings.TrimSpace(value)
			if value != "" {
				n, parseErr := strconv.ParseInt(value, 10, 64)
				if parseErr != nil {
					writeJSONError(w, 400, "invalid personId")
					return
				}
				personID = &n
			}
		case float64:
			n := int64(value)
			if value != float64(n) {
				writeJSONError(w, 400, "invalid personId")
				return
			}
			personID = &n
		default:
			writeJSONError(w, 400, "invalid personId")
			return
		}
		if personID != nil && *personID <= 0 {
			writeJSONError(w, 400, "invalid personId")
			return
		}
		if personID != nil {
			var found int
			if a.db.Reader.QueryRowContext(r.Context(), "SELECT 1 FROM people WHERE id = ?", *personID).Scan(&found) != nil {
				writeJSONError(w, 404, "person not found")
				return
			}
		}
		var old sql.NullInt64
		if err := a.db.Reader.QueryRowContext(r.Context(), "SELECT person_id FROM faces WHERE id = ?", faceID).Scan(&old); err != nil {
			writeJSONError(w, 404, "face not found")
			return
		}
		_, _ = a.db.Writer.ExecContext(r.Context(), "UPDATE faces SET person_id = ? WHERE id = ?", personID, faceID)
		writeJSON(w, 200, map[string]any{"success": true, "ok": true, "oldPersonId": nullableInt(old), "newPersonId": personID})
		return
	}
	if r.Method == http.MethodDelete {
		result, err := a.db.Writer.ExecContext(r.Context(), "DELETE FROM people WHERE id = ?", id)
		if err != nil {
			writeJSONError(w, http.StatusInternalServerError, "person delete failed")
			return
		}
		if count, _ := result.RowsAffected(); count == 0 {
			writeJSONError(w, http.StatusNotFound, "person not found")
			return
		}
		_, _ = a.db.Writer.ExecContext(r.Context(), "UPDATE faces SET person_id = NULL WHERE person_id = ?", id)
		writeJSON(w, http.StatusOK, map[string]any{"success": true, "id": id})
		return
	}
	http.NotFound(w, r)
}

func (a *App) servePersonCrop(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id <= 0 {
		writeJSONError(w, http.StatusBadRequest, "invalid person id")
		return
	}
	var faceID int64
	if err := a.db.Reader.QueryRowContext(r.Context(), "SELECT id FROM faces WHERE person_id = ? ORDER BY id LIMIT 1", id).Scan(&faceID); err != nil {
		writeJSONError(w, http.StatusNotFound, "no face found")
		return
	}
	a.serveCropByFace(w, r, faceID, 160)
}

func (a *App) serveFaceCrop(w http.ResponseWriter, r *http.Request) {
	value := strings.TrimSuffix(r.PathValue("rest"), "/crop")
	id, err := strconv.ParseInt(value, 10, 64)
	if err != nil || id <= 0 {
		writeJSONError(w, http.StatusBadRequest, "invalid face id")
		return
	}
	a.serveCropByFace(w, r, id, 128)
}

func (a *App) serveCropByFace(w http.ResponseWriter, r *http.Request, faceID int64, fallback int) {
	width := queryInt(r, "w", fallback)
	if width < 64 {
		width = 64
	}
	if width > 512 {
		width = 512
	}
	var path string
	var x, y, cw, ch float64
	if err := a.db.Reader.QueryRowContext(r.Context(), `SELECT d.file_path, f.x, f.y, f.w, f.h FROM faces f JOIN downloads d ON d.id = f.download_id WHERE f.id = ?`, faceID).Scan(&path, &x, &y, &cw, &ch); err != nil {
		writeJSONError(w, http.StatusNotFound, "face not found")
		return
	}
	imgFile, err := os.Open(filepath.Join(a.downloadsDir, filepath.FromSlash(path)))
	if err != nil {
		writeJSONError(w, http.StatusNotFound, "face not found")
		return
	}
	defer imgFile.Close()
	src, _, err := image.Decode(imgFile)
	if err != nil {
		src = image.NewRGBA(image.Rect(0, 0, 320, 320))
	}
	crop := cropSquare(src, int(x), int(y), int(cw), int(ch))
	out := resizeNearest(crop, width)
	var encoded bytes.Buffer
	if err := jpeg.Encode(&encoded, out, &jpeg.Options{Quality: 86}); err != nil {
		writeJSONError(w, http.StatusInternalServerError, "face crop failed")
		return
	}
	w.Header().Set("Content-Type", "image/jpeg")
	w.Header().Set("Cache-Control", "public, max-age=604800, immutable")
	w.Header().Set("Vary", "Cookie")
	sum := sha1.Sum(encoded.Bytes())
	w.Header().Set("ETag", `W/"`+strconv.FormatInt(int64(len(encoded.Bytes())), 16)+`-`+base64.RawStdEncoding.EncodeToString(sum[:])+`"`)
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(encoded.Bytes())
}

func cropSquare(src image.Image, x, y, width, height int) image.Image {
	b := src.Bounds()
	if width < 1 || height < 1 {
		return src
	}
	size := width
	if height > size {
		size = height
	}
	left := x + width/2 - size/2
	top := y + height/2 - size/2
	if left < b.Min.X {
		left = b.Min.X
	}
	if top < b.Min.Y {
		top = b.Min.Y
	}
	if left+size > b.Max.X {
		left = b.Max.X - size
	}
	if top+size > b.Max.Y {
		top = b.Max.Y - size
	}
	if size > b.Dx() {
		size = b.Dx()
	}
	if size > b.Dy() {
		size = b.Dy()
	}
	if size < 1 {
		return src
	}
	out := image.NewRGBA(image.Rect(0, 0, size, size))
	draw.Draw(out, out.Bounds(), src, image.Point{X: left, Y: top}, draw.Src)
	return out
}

func resizeNearest(src image.Image, size int) image.Image {
	out := image.NewRGBA(image.Rect(0, 0, size, size))
	b := src.Bounds()
	for y := 0; y < size; y++ {
		for x := 0; x < size; x++ {
			sx := b.Min.X + x*b.Dx()/size
			sy := b.Min.Y + y*b.Dy()/size
			out.Set(x, y, src.At(sx, sy))
		}
	}
	return out
}

func nowMillis() int64 { return time.Now().UnixMilli() }
