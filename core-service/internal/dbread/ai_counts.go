package dbread

import (
	"fmt"
	"net/http"
	"strings"

	"github.com/botnick/telegram-media-downloader/core-service/internal/hash"
)

type aiCountsRequest struct {
	FileTypes []string `json:"fileTypes"`
}

type aiCountsResponse struct {
	TotalEligible  int64 `json:"totalEligible"`
	Indexed        int64 `json:"indexed"`
	Unindexed      int64 `json:"unindexed"`
	WithEmbedding  int64 `json:"withEmbedding"`
	WithFaces      int64 `json:"withFaces"`
	WithTags       int64 `json:"withTags"`
	PeopleCount    int64 `json:"peopleCount"`
	TotalFaces     int64 `json:"totalFaces"`
	NoiseFaces     int64 `json:"noiseFaces"`
	QualityPending int64 `json:"qualityPending"`
}

// AICounts serves the aggregate counters polled by the AI maintenance page.
func (h *Handler) AICounts(w http.ResponseWriter, r *http.Request) {
	var req aiCountsRequest
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
	args := make([]any, len(types))
	for i, value := range types {
		args[i] = value
	}
	db, err := h.open()
	if err != nil {
		h.unavailable(w, err)
		return
	}
	var out aiCountsResponse
	query := fmt.Sprintf(`
		WITH eligible AS (
			SELECT ai_indexed_at FROM downloads WHERE file_type IN (%s)
		)
		SELECT
			(SELECT COUNT(*) FROM eligible),
			(SELECT COUNT(*) FROM eligible WHERE ai_indexed_at IS NULL),
			(SELECT COUNT(*) FROM image_embeddings),
			(SELECT COUNT(DISTINCT download_id) FROM faces),
			(SELECT COUNT(DISTINCT download_id) FROM image_tags),
			(SELECT COUNT(*) FROM people),
			(SELECT COUNT(*) FROM faces),
			(SELECT COUNT(*) FROM faces WHERE person_id IS NULL OR person_id = -1),
			(SELECT COUNT(*) FROM faces WHERE quality_score IS NULL)`, placeholders)
	if err := db.QueryRowContext(r.Context(), query, args...).Scan(
		&out.TotalEligible, &out.Unindexed, &out.WithEmbedding, &out.WithFaces,
		&out.WithTags, &out.PeopleCount, &out.TotalFaces, &out.NoiseFaces, &out.QualityPending,
	); err != nil {
		h.queryError(w, err, "database AI counts query failed")
		return
	}
	out.Indexed = out.TotalEligible - out.Unindexed
	if out.Indexed < 0 {
		out.Indexed = 0
	}
	hash.WriteJSON(w, http.StatusOK, out)
}
