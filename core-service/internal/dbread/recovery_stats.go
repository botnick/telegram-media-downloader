package dbread

import (
	"database/sql"
	"net/http"

	"github.com/botnick/telegram-media-downloader/core-service/internal/hash"
)

type recoveryStatsRow struct {
	GroupID  string  `json:"group_id"`
	Files    int64   `json:"files"`
	LastSeen *string `json:"lastSeen"`
}

type recoveryStatsResponse struct {
	Rows []recoveryStatsRow `json:"rows"`
}

// RecoveryStats serves the grouped counts used by the recovery-list page.
func (h *Handler) RecoveryStats(w http.ResponseWriter, r *http.Request) {
	if err := decodeEmptyBody(w, r); err != nil {
		return
	}
	db, err := h.open()
	if err != nil {
		h.unavailable(w, err)
		return
	}
	rows, err := db.QueryContext(r.Context(), `
		SELECT CAST(group_id AS TEXT), COUNT(*), CAST(MAX(created_at) AS TEXT)
		  FROM downloads
		 GROUP BY group_id`)
	if err != nil {
		h.queryError(w, err, "database recovery stats query failed")
		return
	}
	defer rows.Close()
	out := make([]recoveryStatsRow, 0, 64)
	for rows.Next() {
		var row recoveryStatsRow
		var groupID sql.NullString
		var lastSeen sql.NullString
		if err := rows.Scan(&groupID, &row.Files, &lastSeen); err != nil {
			h.queryError(w, err, "database recovery stats scan failed")
			return
		}
		if groupID.Valid {
			row.GroupID = groupID.String
		} else {
			// Match String(null) used by the Node fallback for nullable group_id.
			row.GroupID = "null"
		}
		if lastSeen.Valid && lastSeen.String != "" {
			value := lastSeen.String
			row.LastSeen = &value
		}
		out = append(out, row)
	}
	if err := rows.Err(); err != nil {
		h.queryError(w, err, "database recovery stats read failed")
		return
	}
	hash.WriteJSON(w, http.StatusOK, recoveryStatsResponse{Rows: out})
}
