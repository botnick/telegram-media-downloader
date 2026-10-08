package dbread

import (
	"net/http"

	"github.com/botnick/telegram-media-downloader/core-service/internal/hash"
)

// IntegrityCheck serves the read-only SQLite integrity check used by the
// maintenance page. Running it in the Go read process keeps the Node event
// loop responsive while SQLite scans a large database.
func (h *Handler) IntegrityCheck(w http.ResponseWriter, r *http.Request) {
	if err := decodeEmptyBody(w, r); err != nil {
		return
	}
	db, err := h.open()
	if err != nil {
		h.unavailable(w, err)
		return
	}
	rows, err := db.QueryContext(r.Context(), `PRAGMA integrity_check`)
	if err != nil {
		h.queryError(w, err, "database integrity check failed")
		return
	}
	defer rows.Close()
	messages := make([]string, 0, 1)
	for rows.Next() {
		var message string
		if err := rows.Scan(&message); err != nil {
			h.queryError(w, err, "database integrity check scan failed")
			return
		}
		if message != "" {
			messages = append(messages, message)
		}
	}
	if err := rows.Err(); err != nil {
		h.queryError(w, err, "database integrity check read failed")
		return
	}
	ok := len(messages) == 1 && messages[0] == "ok"
	hash.WriteJSON(w, http.StatusOK, map[string]any{"ok": ok, "messages": messages})
}
