package dbread

import (
	"net/http"
	"strconv"
	"strings"

	"github.com/botnick/telegram-media-downloader/core-service/internal/hash"
)

type nsfwTiersRequest struct {
	FileTypes []string `json:"fileTypes"`
}

type nsfwTiersResponse struct {
	Tiers         map[string]int64 `json:"tiers"`
	Scanned       int64            `json:"scanned"`
	Unscanned     int64            `json:"unscanned"`
	Whitelisted   int64            `json:"whitelisted"`
	TotalEligible int64            `json:"totalEligible"`
}

type nsfwTier struct {
	ID  string
	Min float64
	Max float64
}

var nsfwTierDefs = [...]nsfwTier{
	{ID: "def_not", Min: 0.0, Max: 0.3},
	{ID: "maybe_not", Min: 0.3, Max: 0.5},
	{ID: "uncertain", Min: 0.5, Max: 0.7},
	{ID: "maybe", Min: 0.7, Max: 0.9},
	{ID: "def", Min: 0.9, Max: 1.01},
}

// NsfwTiers serves POST /v1/db/nsfw-tiers for the review dashboard's
// aggregate counters. The score boundaries mirror src/core/db.js exactly.
func (h *Handler) NsfwTiers(w http.ResponseWriter, r *http.Request) {
	var req nsfwTiersRequest
	if err := decodeJSON(w, r, &req); err != nil {
		return
	}
	types := req.FileTypes
	if len(types) == 0 {
		types = []string{"photo"}
	}
	placeholders := strings.TrimSuffix(strings.Repeat("?,", len(types)), ",")
	args := make([]any, len(types))
	for i, typ := range types {
		args[i] = typ
	}
	parts := make([]string, 0, len(nsfwTierDefs)+2)
	for _, tier := range nsfwTierDefs {
		parts = append(parts, "COALESCE(SUM(CASE WHEN nsfw_score IS NOT NULL AND nsfw_whitelist = 0 AND nsfw_score >= "+formatFloat(tier.Min)+" AND nsfw_score < "+formatFloat(tier.Max)+" THEN 1 ELSE 0 END), 0)")
	}
	parts = append(parts, "COALESCE(SUM(CASE WHEN nsfw_checked_at IS NOT NULL THEN 1 ELSE 0 END), 0)", "COUNT(*)")
	db, err := h.open()
	if err != nil {
		h.unavailable(w, err)
		return
	}
	row := db.QueryRowContext(r.Context(), "SELECT "+strings.Join(parts, ", ")+" FROM downloads WHERE file_type IN ("+placeholders+")", args...)
	values := make([]int64, len(parts))
	dest := make([]any, len(values))
	for i := range values {
		dest[i] = &values[i]
	}
	if err := row.Scan(dest...); err != nil {
		h.queryError(w, err, "database nsfw tiers query failed")
		return
	}
	out := nsfwTiersResponse{Tiers: make(map[string]int64, len(nsfwTierDefs))}
	for i, tier := range nsfwTierDefs {
		out.Tiers[tier.ID] = values[i]
	}
	out.Scanned = values[len(nsfwTierDefs)]
	out.TotalEligible = values[len(nsfwTierDefs)+1]
	out.Unscanned = out.TotalEligible - out.Scanned
	if out.Unscanned < 0 {
		out.Unscanned = 0
	}
	if err := db.QueryRowContext(r.Context(), "SELECT COUNT(*) FROM downloads WHERE nsfw_whitelist = 1").Scan(&out.Whitelisted); err != nil {
		h.queryError(w, err, "database nsfw whitelist count failed")
		return
	}
	hash.WriteJSON(w, http.StatusOK, out)
}

func formatFloat(v float64) string {
	return strconv.FormatFloat(v, 'f', -1, 64)
}
