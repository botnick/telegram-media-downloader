package dbread

import (
	"database/sql"
	"net/http"

	"github.com/botnick/telegram-media-downloader/core-service/internal/hash"
)

type personPhotosRequest struct {
	PersonID int64 `json:"personId"`
	Limit    int   `json:"limit"`
	Offset   int   `json:"offset"`
}

type personPhotoRow struct {
	ID        int64   `json:"id"`
	FileName  *string `json:"file_name"`
	FilePath  *string `json:"file_path"`
	FileType  *string `json:"file_type"`
	FileSize  *int64  `json:"file_size"`
	CreatedAt *string `json:"created_at"`
	GroupID   *string `json:"group_id"`
	GroupName *string `json:"group_name"`
	MessageID *int64  `json:"message_id"`
	FaceID    int64   `json:"face_id"`
	FaceX     float64 `json:"face_x"`
	FaceY     float64 `json:"face_y"`
	FaceW     float64 `json:"face_w"`
	FaceH     float64 `json:"face_h"`
}

type personPhotosResponse struct {
	Success  bool             `json:"success"`
	PersonID int64            `json:"personId"`
	Files    []personPhotoRow `json:"files"`
	Total    int64            `json:"total"`
}

// PersonPhotos serves the paginated local gallery for one face cluster.
func (h *Handler) PersonPhotos(w http.ResponseWriter, r *http.Request) {
	var req personPhotosRequest
	if err := decodeJSON(w, r, &req); err != nil {
		return
	}
	if req.PersonID <= 0 {
		hash.WriteError(w, http.StatusBadRequest, "EINVAL", "invalid person id")
		return
	}
	limit := req.Limit
	if limit == 0 {
		limit = 50
	} else if limit < 1 {
		limit = 1
	}
	if limit > 200 {
		limit = 200
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
		WITH ranked AS (
			SELECT f2.download_id, f2.id AS face_id, f2.x AS face_x,
			       f2.y AS face_y, f2.w AS face_w, f2.h AS face_h,
			       ROW_NUMBER() OVER (
				       PARTITION BY f2.download_id
				       ORDER BY COALESCE(f2.quality_score, 0) DESC, f2.w * f2.h DESC
			       ) AS rn
			  FROM faces f2
			 WHERE f2.person_id = ?
		)
		SELECT d.id, d.file_name, d.file_path, d.file_type, d.file_size,
		       CAST(d.created_at AS TEXT), d.group_id, d.group_name, d.message_id,
		       ranked.face_id, ranked.face_x, ranked.face_y, ranked.face_w, ranked.face_h
		  FROM ranked
		  JOIN downloads d ON d.id = ranked.download_id
		 WHERE ranked.rn = 1
		 ORDER BY d.created_at DESC, d.id DESC
		 LIMIT ? OFFSET ?`, req.PersonID, limit, offset)
	if err != nil {
		h.queryError(w, err, "database person photos query failed")
		return
	}
	defer rows.Close()
	files := make([]personPhotoRow, 0, limit)
	for rows.Next() {
		var row personPhotoRow
		var fileName, filePath, fileType, createdAt, groupID, groupName sql.NullString
		var fileSize, messageID sql.NullInt64
		if err := rows.Scan(
			&row.ID, &fileName, &filePath, &fileType, &fileSize, &createdAt,
			&groupID, &groupName, &messageID, &row.FaceID, &row.FaceX, &row.FaceY,
			&row.FaceW, &row.FaceH,
		); err != nil {
			h.queryError(w, err, "database person photos scan failed")
			return
		}
		row.FileName = nullStringPtr(fileName)
		row.FilePath = nullStringPtr(filePath)
		row.FileType = nullStringPtr(fileType)
		row.CreatedAt = nullStringPtr(createdAt)
		row.GroupID = nullStringPtr(groupID)
		row.GroupName = nullStringPtr(groupName)
		if fileSize.Valid {
			v := fileSize.Int64
			row.FileSize = &v
		}
		if messageID.Valid {
			v := messageID.Int64
			row.MessageID = &v
		}
		files = append(files, row)
	}
	if err := rows.Err(); err != nil {
		h.queryError(w, err, "database person photos read failed")
		return
	}
	var total int64
	if err := db.QueryRowContext(r.Context(),
		"SELECT COUNT(DISTINCT download_id) FROM faces WHERE person_id = ?", req.PersonID,
	).Scan(&total); err != nil {
		h.queryError(w, err, "database person photos count failed")
		return
	}
	hash.WriteJSON(w, http.StatusOK, personPhotosResponse{
		Success: true, PersonID: req.PersonID, Files: files, Total: total,
	})
}

func nullStringPtr(value sql.NullString) *string {
	if !value.Valid {
		return nil
	}
	v := value.String
	return &v
}
