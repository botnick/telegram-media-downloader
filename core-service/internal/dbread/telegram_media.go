package dbread

import (
	"database/sql"
	"net/http"

	"github.com/botnick/telegram-media-downloader/core-service/internal/hash"
)

type telegramMediaRequest struct {
	Kind string `json:"kind"`
	ID   string `json:"id"`
	Size *int64 `json:"size"`
}

type telegramMediaRow struct {
	ID                int64   `json:"id"`
	GroupID           *string `json:"group_id"`
	GroupName         *string `json:"group_name"`
	MessageID         *int64  `json:"message_id"`
	FileName          *string `json:"file_name"`
	FileSize          *int64  `json:"file_size"`
	FileType          *string `json:"file_type"`
	FilePath          *string `json:"file_path"`
	FileHash          *string `json:"file_hash"`
	TelegramMediaKind *string `json:"telegram_media_kind"`
	TelegramMediaID   *string `json:"telegram_media_id"`
	TelegramMediaSize *int64  `json:"telegram_media_size"`
}

type telegramMediaResponse struct {
	Rows []telegramMediaRow `json:"rows"`
}

// TelegramMediaCandidates serves the bounded identity lookup used before a
// Telegram download starts. Node remains the writer; Go only reads candidates.
func (h *Handler) TelegramMediaCandidates(w http.ResponseWriter, r *http.Request) {
	var req telegramMediaRequest
	if err := decodeJSON(w, r, &req); err != nil {
		return
	}
	if req.Kind == "" || req.ID == "" {
		hash.WriteJSON(w, http.StatusOK, telegramMediaResponse{Rows: []telegramMediaRow{}})
		return
	}
	db, err := h.open()
	if err != nil {
		h.unavailable(w, err)
		return
	}
	where := `telegram_media_kind = ? AND telegram_media_id = ? AND file_path IS NOT NULL`
	args := []any{req.Kind, req.ID}
	order := "id ASC"
	if req.Size != nil && *req.Size > 0 {
		where += " AND (telegram_media_size = ? OR telegram_media_size IS NULL)"
		args = append(args, *req.Size)
		order = "CASE WHEN telegram_media_size = ? THEN 0 ELSE 1 END, id ASC"
		args = append(args, *req.Size)
	}
	rows, err := db.QueryContext(r.Context(), `
		SELECT id, CAST(group_id AS TEXT), group_name, message_id, file_name,
		       file_size, file_type, file_path, file_hash,
		       telegram_media_kind, telegram_media_id, telegram_media_size
		  FROM downloads
		 WHERE `+where+`
		 ORDER BY `+order+`
		 LIMIT 100`, args...)
	if err != nil {
		h.queryError(w, err, "database Telegram media query failed")
		return
	}
	defer rows.Close()
	out := make([]telegramMediaRow, 0, 16)
	for rows.Next() {
		var row telegramMediaRow
		var groupID, groupName, fileName, fileType, filePath, fileHash sql.NullString
		var mediaKind, mediaID sql.NullString
		var messageID, fileSize, mediaSize sql.NullInt64
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
			&mediaKind,
			&mediaID,
			&mediaSize,
		); err != nil {
			h.queryError(w, err, "database Telegram media scan failed")
			return
		}
		row.GroupID = nullableString(groupID)
		row.GroupName = nullableString(groupName)
		row.MessageID = nullableInt64(messageID)
		row.FileName = nullableString(fileName)
		row.FileSize = nullableInt64(fileSize)
		row.FileType = nullableString(fileType)
		row.FilePath = nullableString(filePath)
		row.FileHash = nullableString(fileHash)
		row.TelegramMediaKind = nullableString(mediaKind)
		row.TelegramMediaID = nullableString(mediaID)
		row.TelegramMediaSize = nullableInt64(mediaSize)
		out = append(out, row)
	}
	if err := rows.Err(); err != nil {
		h.queryError(w, err, "database Telegram media read failed")
		return
	}
	hash.WriteJSON(w, http.StatusOK, telegramMediaResponse{Rows: out})
}
