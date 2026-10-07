package dbread

import (
	"database/sql"
	"net/http"

	"github.com/botnick/telegram-media-downloader/core-service/internal/hash"
)

type updateHistoryRequest struct {
	Limit int `json:"limit"`
}

type updateHistoryRow struct {
	ID             int64   `json:"id"`
	FromVersion    *string `json:"from_version"`
	ToVersion      *string `json:"to_version"`
	FromInstanceID *string `json:"from_instance_id"`
	StartedAt      int64   `json:"started_at"`
	FinishedAt     *int64  `json:"finished_at"`
	Status         string  `json:"status"`
	ErrorCode      *string `json:"error_code"`
	ErrorMsg       *string `json:"error_msg"`
	BackupPath     *string `json:"backup_path"`
	BackupBytes    *int64  `json:"backup_bytes"`
}

type updateHistoryResponse struct {
	History []updateHistoryRow `json:"history"`
}

// UpdateHistory serves POST /v1/db/update-history for the admin audit panel.
func (h *Handler) UpdateHistory(w http.ResponseWriter, r *http.Request) {
	var req updateHistoryRequest
	if err := decodeJSON(w, r, &req); err != nil {
		return
	}
	limit := req.Limit
	if limit == 0 {
		limit = 25
	} else if limit < 1 {
		limit = 1
	}
	if limit > 200 {
		limit = 200
	}
	db, err := h.open()
	if err != nil {
		h.unavailable(w, err)
		return
	}
	rows, err := db.QueryContext(r.Context(), `
		SELECT id, from_version, to_version, from_instance_id, started_at, finished_at,
		       status, error_code, error_msg, backup_path, backup_bytes
		  FROM update_history
		 ORDER BY id DESC
		 LIMIT ?
	`, limit)
	if err != nil {
		h.queryError(w, err, "database update history query failed")
		return
	}
	result, err := scanUpdateHistory(rows, limit)
	if err != nil {
		h.queryError(w, err, "database update history read failed")
		return
	}
	hash.WriteJSON(w, http.StatusOK, updateHistoryResponse{History: result})
}

func scanUpdateHistory(rows *sql.Rows, capHint int) ([]updateHistoryRow, error) {
	defer rows.Close()
	out := make([]updateHistoryRow, 0, capHint)
	for rows.Next() {
		var row updateHistoryRow
		var fromVersion, toVersion, fromInstanceID, errorCode, errorMsg, backupPath sql.NullString
		var finishedAt, backupBytes sql.NullInt64
		if err := rows.Scan(
			&row.ID, &fromVersion, &toVersion, &fromInstanceID, &row.StartedAt, &finishedAt,
			&row.Status, &errorCode, &errorMsg, &backupPath, &backupBytes,
		); err != nil {
			return nil, err
		}
		setString := func(src sql.NullString, dst **string) {
			if src.Valid {
				v := src.String
				*dst = &v
			}
		}
		setString(fromVersion, &row.FromVersion)
		setString(toVersion, &row.ToVersion)
		setString(fromInstanceID, &row.FromInstanceID)
		setString(errorCode, &row.ErrorCode)
		setString(errorMsg, &row.ErrorMsg)
		setString(backupPath, &row.BackupPath)
		if finishedAt.Valid {
			v := finishedAt.Int64
			row.FinishedAt = &v
		}
		if backupBytes.Valid {
			v := backupBytes.Int64
			row.BackupBytes = &v
		}
		out = append(out, row)
	}
	return out, rows.Err()
}
