package dbread

import (
	"net/http"
	"strings"

	"github.com/botnick/telegram-media-downloader/core-service/internal/hash"
)

type groupDownloadIDsRequest struct {
	GroupID  string `json:"groupId"`
	BeforeID int64  `json:"beforeId"`
	Limit    int    `json:"limit"`
}

type groupDownloadIDRow struct {
	ID int64 `json:"id"`
}

type groupDownloadIDsResponse struct {
	Rows []groupDownloadIDRow `json:"rows"`
}

// GroupDownloadIDs returns one keyset page of ids for a group purge. Node
// remains responsible for all writes and cache/file deletion; the paged read
// stays on Go's query-only pool so a large group never blocks the event loop.
func (h *Handler) GroupDownloadIDs(w http.ResponseWriter, r *http.Request) {
	var req groupDownloadIDsRequest
	if err := decodeJSON(w, r, &req); err != nil {
		return
	}
	groupID := req.GroupID
	if strings.TrimSpace(groupID) == "" {
		hash.WriteError(w, http.StatusBadRequest, "EINVAL", "groupId is required")
		return
	}
	beforeID := req.BeforeID
	if beforeID <= 0 {
		beforeID = 9223372036854775807
	}
	limit := req.Limit
	if limit < 1 {
		limit = 500
	}
	if limit > 500 {
		limit = 500
	}
	db, err := h.open()
	if err != nil {
		h.unavailable(w, err)
		return
	}
	rows, err := db.QueryContext(r.Context(), `
		SELECT id
		  FROM downloads
		 WHERE group_id = ? AND id < ?
		 ORDER BY id DESC
		 LIMIT ?`, groupID, beforeID, limit)
	if err != nil {
		h.queryError(w, err, "database group download ids query failed")
		return
	}
	defer rows.Close()
	out := groupDownloadIDsResponse{Rows: make([]groupDownloadIDRow, 0, limit)}
	for rows.Next() {
		var row groupDownloadIDRow
		if err := rows.Scan(&row.ID); err != nil {
			h.queryError(w, err, "database group download ids scan failed")
			return
		}
		out.Rows = append(out.Rows, row)
	}
	if err := rows.Err(); err != nil {
		h.queryError(w, err, "database group download ids read failed")
		return
	}
	hash.WriteJSON(w, http.StatusOK, out)
}
