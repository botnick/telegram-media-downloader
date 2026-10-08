package dbread

import (
	"fmt"
	"net/http"
	"strings"

	"github.com/botnick/telegram-media-downloader/core-service/internal/hash"
)

type aiPendingRequest struct {
	FileTypes []string `json:"fileTypes"`
}

type aiPendingResponse struct {
	Pending int64 `json:"pending"`
}

// AIPending serves the small queue counter used by the face scan progress
// bar. Keeping this aggregate separate from the richer AI status projection
// avoids recounting embeddings, tags and people on every scan batch.
func (h *Handler) AIPending(w http.ResponseWriter, r *http.Request) {
	var req aiPendingRequest
	if err := decodeJSON(w, r, &req); err != nil {
		return
	}
	types := make([]string, 0, len(req.FileTypes))
	for _, value := range req.FileTypes {
		value = strings.TrimSpace(value)
		if value != "" {
			types = append(types, value)
		}
	}
	if len(types) == 0 {
		types = []string{"photo"}
	}
	if len(types) > 32 {
		types = types[:32]
	}
	placeholders := strings.TrimSuffix(strings.Repeat("?,", len(types)), ",")
	args := make([]any, 0, len(types))
	for _, value := range types {
		args = append(args, value)
	}
	db, err := h.open()
	if err != nil {
		h.unavailable(w, err)
		return
	}
	var out aiPendingResponse
	if err := db.QueryRowContext(
		r.Context(),
		fmt.Sprintf(
			"SELECT COUNT(*) FROM downloads WHERE file_type IN (%s) AND ai_indexed_at IS NULL",
			placeholders,
		),
		args...,
	).Scan(&out.Pending); err != nil {
		h.queryError(w, err, "database AI pending count failed")
		return
	}
	hash.WriteJSON(w, http.StatusOK, out)
}
