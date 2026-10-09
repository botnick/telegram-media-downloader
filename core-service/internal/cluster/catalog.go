package cluster

import (
	"context"
	"strings"
)

type CatalogRow struct {
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
	NSFWScore *float64 `json:"nsfw_score"`
}

func (s Store) Catalog(ctx context.Context, since int64, query string, limit int) ([]CatalogRow, error) {
	limit = max(1, min(2000, limit))
	where := "id>?"
	args := []any{max(0, since)}
	order := "id ASC"
	if query != "" {
		where = `(file_name LIKE ? ESCAPE '\' OR group_name LIKE ? ESCAPE '\')`
		pattern := "%" + strings.NewReplacer(`\`, `\\`, "%", `\%`, "_", `\_`).Replace(query) + "%"
		args = []any{pattern, pattern}
		order = "created_at DESC,id DESC"
	}
	args = append(args, limit)
	rows, err := s.Reader.QueryContext(ctx, `SELECT id,CAST(group_id AS TEXT),group_name,message_id,file_name,file_size,file_type,file_path,file_hash,status,CAST(created_at AS TEXT),nsfw_score FROM downloads WHERE `+where+` ORDER BY `+order+` LIMIT ?`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]CatalogRow, 0, limit)
	for rows.Next() {
		var r CatalogRow
		if err = rows.Scan(&r.ID, &r.GroupID, &r.GroupName, &r.MessageID, &r.FileName, &r.FileSize, &r.FileType, &r.FilePath, &r.FileHash, &r.Status, &r.CreatedAt, &r.NSFWScore); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}
