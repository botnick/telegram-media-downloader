package dbread

import (
	"database/sql"
	"net/http"
	"strings"

	"github.com/botnick/telegram-media-downloader/core-service/internal/hash"
)

type clusterRowsRequest struct {
	SinceID int64  `json:"sinceId"`
	Query   string `json:"query"`
	Limit   int    `json:"limit"`
	Offset  int    `json:"offset"`
}

type clusterRow struct {
	ID        int64    `json:"id"`
	GroupID   *string  `json:"group_id"`
	GroupName *string  `json:"group_name"`
	MessageID *int64   `json:"message_id"`
	FileName  *string  `json:"file_name"`
	FileSize  *int64   `json:"file_size"`
	FileType  *string  `json:"file_type"`
	FilePath  *string  `json:"file_path"`
	FileHash  *string  `json:"file_hash"`
	Status    *string  `json:"status"`
	CreatedAt *string  `json:"created_at"`
	NsfwScore *float64 `json:"nsfw_score"`
}

type clusterRowsResponse struct {
	Rows []clusterRow `json:"rows"`
}

// ClusterDownloads serves the local catalog page used by the cluster view.
func (h *Handler) ClusterDownloads(w http.ResponseWriter, r *http.Request) {
	var req clusterRowsRequest
	if err := decodeJSON(w, r, &req); err != nil {
		return
	}
	limit := req.Limit
	if limit < 1 {
		limit = 200
	}
	if limit > 2000 {
		limit = 2000
	}
	offset := req.Offset
	if offset < 0 {
		offset = 0
	}
	db, err := h.open()
	if err != nil {
		h.unavailable(w, err)
		return
	}
	rows, err := db.QueryContext(r.Context(), `
		SELECT id, CAST(group_id AS TEXT), group_name, message_id, file_name,
		       file_size, file_type, file_path, file_hash, status,
		       CAST(created_at AS TEXT), nsfw_score
		  FROM downloads
		 ORDER BY id DESC
		 LIMIT ? OFFSET ?`, limit, offset)
	if err != nil {
		h.queryError(w, err, "database cluster downloads query failed")
		return
	}
	out, err := scanClusterRows(rows, limit)
	if err != nil {
		h.queryError(w, err, "database cluster downloads read failed")
		return
	}
	hash.WriteJSON(w, http.StatusOK, clusterRowsResponse{Rows: out})
}

// ClusterDownloadsSince serves the local delta used by cluster catalog sync.
func (h *Handler) ClusterDownloadsSince(w http.ResponseWriter, r *http.Request) {
	var req clusterRowsRequest
	if err := decodeJSON(w, r, &req); err != nil {
		return
	}
	sinceID := req.SinceID
	if sinceID < 0 {
		sinceID = 0
	}
	limit := req.Limit
	if limit < 1 {
		limit = 500
	}
	if limit > 2000 {
		limit = 2000
	}
	db, err := h.open()
	if err != nil {
		h.unavailable(w, err)
		return
	}
	rows, err := db.QueryContext(r.Context(), `
		SELECT id, CAST(group_id AS TEXT), group_name, message_id, file_name,
		       file_size, file_type, file_path, file_hash, status,
		       CAST(created_at AS TEXT), nsfw_score
		  FROM downloads
		 WHERE id > ?
		 ORDER BY id ASC
		 LIMIT ?`, sinceID, limit)
	if err != nil {
		h.queryError(w, err, "database cluster delta query failed")
		return
	}
	out, err := scanClusterRows(rows, limit)
	if err != nil {
		h.queryError(w, err, "database cluster delta read failed")
		return
	}
	hash.WriteJSON(w, http.StatusOK, clusterRowsResponse{Rows: out})
}

// ClusterSearch serves the local LIKE search used by peer federation.
func (h *Handler) ClusterSearch(w http.ResponseWriter, r *http.Request) {
	var req clusterRowsRequest
	if err := decodeJSON(w, r, &req); err != nil {
		return
	}
	query := strings.TrimSpace(req.Query)
	if query == "" {
		hash.WriteJSON(w, http.StatusOK, clusterRowsResponse{Rows: []clusterRow{}})
		return
	}
	limit := req.Limit
	if limit < 1 {
		limit = 50
	}
	if limit > 200 {
		limit = 200
	}
	db, err := h.open()
	if err != nil {
		h.unavailable(w, err)
		return
	}
	pattern := likePattern(query)
	rows, err := db.QueryContext(r.Context(), `
		SELECT id, CAST(group_id AS TEXT), group_name, message_id, file_name,
		       file_size, file_type, file_path, file_hash, status,
		       CAST(created_at AS TEXT), nsfw_score
		  FROM downloads
		 WHERE file_name LIKE ? ESCAPE '\' OR group_name LIKE ? ESCAPE '\'
		 ORDER BY created_at DESC
		 LIMIT ?`, pattern, pattern, limit)
	if err != nil {
		h.queryError(w, err, "database cluster search query failed")
		return
	}
	out, err := scanClusterRows(rows, limit)
	if err != nil {
		h.queryError(w, err, "database cluster search read failed")
		return
	}
	hash.WriteJSON(w, http.StatusOK, clusterRowsResponse{Rows: out})
}

func scanClusterRows(rows *sql.Rows, capHint int) ([]clusterRow, error) {
	defer rows.Close()
	out := make([]clusterRow, 0, capHint)
	for rows.Next() {
		var row clusterRow
		var groupID, groupName, fileName, fileType, filePath, fileHash, status, created sql.NullString
		var messageID, fileSize sql.NullInt64
		var nsfwScore sql.NullFloat64
		if err := rows.Scan(
			&row.ID,
			&groupID,
			&groupName,
			&messageID,
			&fileName,
			&fileSize,
			&fileType,
			&filePath,
			&fileHash,
			&status,
			&created,
			&nsfwScore,
		); err != nil {
			return nil, err
		}
		row.GroupID = nullableString(groupID)
		row.GroupName = nullableString(groupName)
		row.MessageID = nullableInt64(messageID)
		row.FileName = nullableString(fileName)
		row.FileSize = nullableInt64(fileSize)
		row.FileType = nullableString(fileType)
		row.FilePath = nullableString(filePath)
		row.FileHash = nullableString(fileHash)
		row.Status = nullableString(status)
		row.CreatedAt = nullableString(created)
		row.NsfwScore = nullableFloat64(nsfwScore)
		out = append(out, row)
	}
	return out, rows.Err()
}

func nullableString(value sql.NullString) *string {
	if !value.Valid {
		return nil
	}
	out := value.String
	return &out
}

func nullableInt64(value sql.NullInt64) *int64 {
	if !value.Valid {
		return nil
	}
	out := value.Int64
	return &out
}

func nullableFloat64(value sql.NullFloat64) *float64 {
	if !value.Valid {
		return nil
	}
	out := value.Float64
	return &out
}
