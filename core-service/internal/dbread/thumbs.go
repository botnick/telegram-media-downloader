package dbread

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/botnick/telegram-media-downloader/core-service/internal/hash"
)

type thumbsListRequest struct {
	Limit      int    `json:"limit"`
	Cursor     int64  `json:"cursor"`
	Kind       string `json:"kind"`
	CachedOnly bool   `json:"cachedOnly"`
	CacheRoot  string `json:"cacheRoot"`
}

type thumbsListRow struct {
	ID        int64   `json:"id"`
	FileName  *string `json:"file_name"`
	FileType  *string `json:"file_type"`
	FileSize  *int64  `json:"file_size"`
	FilePath  *string `json:"file_path"`
	CreatedAt *string `json:"created_at"`
	Cached    bool    `json:"cached"`
}

type thumbsListResponse struct {
	Rows       []thumbsListRow `json:"rows"`
	NextCursor *int64          `json:"nextCursor"`
	HasMore    bool            `json:"hasMore"`
	Total      *int64          `json:"total"`
}

// ThumbsList serves the paginated thumbnail maintenance catalog. The query
// and cache-file probes happen off Node's event loop; the response shape is
// the same as /api/maintenance/thumbs/list.
func (h *Handler) ThumbsList(w http.ResponseWriter, r *http.Request) {
	var req thumbsListRequest
	if err := decodeJSON(w, r, &req); err != nil {
		return
	}
	limit := req.Limit
	if limit == 0 {
		limit = 60
	} else if limit < 1 {
		limit = 1
	}
	if limit > 200 {
		limit = 200
	}
	cursor := req.Cursor
	if cursor < 0 {
		cursor = 0
	}

	types := thumbTypes(req.Kind)
	placeholders := make([]string, len(types))
	args := make([]any, 0, len(types)+2)
	for i, typ := range types {
		placeholders[i] = "?"
		args = append(args, typ)
	}
	where := "file_type IN (" + strings.Join(placeholders, ",") + ") AND file_path IS NOT NULL"
	if cursor > 0 {
		where += " AND id < ?"
		args = append(args, cursor)
	}
	db, err := h.open()
	if err != nil {
		h.unavailable(w, err)
		return
	}

	out := thumbsListResponse{}
	if cursor == 0 {
		var total int64
		if err := db.QueryRowContext(r.Context(), "SELECT COUNT(*) FROM downloads WHERE "+where, args...).Scan(&total); err != nil {
			h.queryError(w, err, "database thumbnail count failed")
			return
		}
		out.Total = &total
	}
	rows, err := db.QueryContext(r.Context(), `
		SELECT id, file_name, file_type, file_size, file_path, CAST(created_at AS TEXT)
		  FROM downloads
		 WHERE `+where+`
		 ORDER BY id DESC
		 LIMIT ?`, append(args, limit)...)
	if err != nil {
		h.queryError(w, err, "database thumbnail query failed")
		return
	}
	defer rows.Close()
	out.Rows = make([]thumbsListRow, 0, limit)
	var rawCount int
	var rawLastID int64
	for rows.Next() {
		var row thumbsListRow
		var fileName, fileType, filePath, created sql.NullString
		var fileSize sql.NullInt64
		if err := rows.Scan(&row.ID, &fileName, &fileType, &fileSize, &filePath, &created); err != nil {
			h.queryError(w, err, "database thumbnail scan failed")
			return
		}
		if fileName.Valid {
			v := fileName.String
			row.FileName = &v
		}
		if fileType.Valid {
			v := fileType.String
			row.FileType = &v
		}
		if fileSize.Valid {
			v := fileSize.Int64
			row.FileSize = &v
		}
		if filePath.Valid {
			v := filePath.String
			row.FilePath = &v
		}
		if created.Valid {
			v := created.String
			row.CreatedAt = &v
		}
		rawCount++
		rawLastID = row.ID
		row.Cached = cachedThumb(req.CacheRoot, row.ID)
		if !req.CachedOnly || row.Cached {
			out.Rows = append(out.Rows, row)
		}
	}
	if err := rows.Err(); err != nil {
		h.queryError(w, err, "database thumbnail read failed")
		return
	}
	if rawCount == limit {
		// The cursor is based on the unfiltered SQL page, just as Node's
		// cachedOnly path is.
		out.NextCursor = &rawLastID
		out.HasMore = true
	}
	hash.WriteJSON(w, http.StatusOK, out)
}

func thumbTypes(kind string) []string {
	switch strings.ToLower(strings.TrimSpace(kind)) {
	case "image":
		return []string{"photo", "image", "sticker"}
	case "video":
		return []string{"video"}
	case "audio":
		return []string{"audio"}
	default:
		return []string{"photo", "image", "sticker", "video", "audio"}
	}
}

func cachedThumb(root string, id int64) bool {
	if id <= 0 || strings.TrimSpace(root) == "" {
		return false
	}
	root = filepath.Clean(root)
	sum := sha256.Sum256([]byte(strconvInt64(id) + ":320"))
	name := hex.EncodeToString(sum[:])[:32] + ".webp"
	_, err := os.Stat(filepath.Join(root, name))
	return err == nil
}

func strconvInt64(v int64) string {
	// Avoid fmt allocations in the per-row cache probe.
	return strconv.FormatInt(v, 10)
}
