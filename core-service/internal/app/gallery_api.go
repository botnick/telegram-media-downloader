package app

import (
	"database/sql"
	"errors"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/botnick/telegram-media-downloader/core-service/internal/auth"
)

func (a *App) handleAPIDownloadsAll(w http.ResponseWriter, r *http.Request) {
	page, limit := galleryPageLimit(r.URL.Query(), 500, false)
	files, total, err := a.queryGalleryFiles(r, galleryQuery{typeName: r.URL.Query().Get("type"), pinnedOnly: truthy(r.URL.Query().Get("pinned")), pinnedFirst: truthy(r.URL.Query().Get("pinnedFirst")), limit: limit, offset: (page - 1) * limit})
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "database downloads query failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"files": files, "total": total, "page": page, "totalPages": pages(total, limit)})
}

func (a *App) handleAPIDownloadsGroup(w http.ResponseWriter, r *http.Request) {
	groupID := strings.TrimSpace(r.PathValue("id"))
	if groupID == "" || groupID == "all" || groupID == "search" {
		http.NotFound(w, r)
		return
	}
	page, limit := galleryPageLimit(r.URL.Query(), 500, true)
	files, total, err := a.queryGalleryFiles(r, galleryQuery{perGroup: true, groupID: groupID, typeName: r.URL.Query().Get("type"), pinnedOnly: truthy(r.URL.Query().Get("pinned")), pinnedFirst: truthy(r.URL.Query().Get("pinnedFirst")), limit: limit, offset: max(0, (page-1)*limit)})
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "database downloads query failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"files": files, "total": total, "page": page, "totalPages": pages(total, limit)})
}

func (a *App) handleAPIDownloadsSearch(w http.ResponseWriter, r *http.Request) {
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	page, limit := galleryPageLimit(r.URL.Query(), 200, false)
	if q == "" {
		writeJSON(w, http.StatusOK, map[string]any{"files": []any{}, "total": 0, "page": page, "totalPages": 0})
		return
	}
	files, total, err := a.queryGalleryFiles(r, galleryQuery{newest: r.URL.Query().Get("order") == "newest", search: q, groupID: r.URL.Query().Get("groupId"), typeName: r.URL.Query().Get("type"), pinnedOnly: truthy(r.URL.Query().Get("pinned")), pinnedFirst: truthy(r.URL.Query().Get("pinnedFirst")), limit: limit, offset: (page - 1) * limit})
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "database search query failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"files": files, "total": total, "page": page, "totalPages": pages(total, limit), "q": q})
}

type galleryQuery struct {
	groupID, search, typeName                 string
	pinnedOnly, pinnedFirst, newest, perGroup bool
	limit, offset                             int
}

func galleryPageLimit(values url.Values, cap int, allowNegative bool) (int, int) {
	page, err := strconv.Atoi(values.Get("page"))
	if err != nil || page < 1 {
		page = 1
	}
	limit, err := strconv.Atoi(values.Get("limit"))
	if err != nil || limit == 0 {
		limit = 50
	}
	if allowNegative && limit < 0 {
		return page, -1
	}
	if limit < 1 {
		limit = 50
	}
	if limit > cap {
		limit = cap
	}
	return page, limit
}
func truthy(value string) bool { return value == "1" || strings.EqualFold(value, "true") }

// queryGalleryFiles performs counts and page reads in one SQLite snapshot.
// FTS is required: query failures are returned rather than hidden behind a
// second runtime. Substring matching is used only when a valid term has no
// prefix matches, preserving the public search semantics.
func (a *App) queryGalleryFiles(r *http.Request, q galleryQuery) ([]map[string]any, int64, error) {
	config, err := a.config.Load(r.Context())
	if err != nil {
		return nil, 0, err
	}
	groups := configuredGroups(config)
	session, _ := auth.SessionFromContext(r.Context())
	include := r.URL.Query().Get("include")
	peers := session.Role == "admin" && (include == "peers" || include == "all")
	tx, err := a.db.Reader.BeginTx(r.Context(), &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return nil, 0, err
	}
	defer tx.Rollback()

	where, args := galleryNarrowing(q)
	from := " FROM downloads d LEFT JOIN seekbar_sprites sb ON sb.download_id = d.id"
	order := "d.created_at DESC, d.id DESC"
	localColumns := `d.id, CAST(d.group_id AS TEXT) AS group_id, d.group_name, d.file_name,
        d.file_path, d.file_size, d.file_type, CAST(d.created_at AS TEXT) AS created_at,
        d.pending_until, d.rescued_at, d.pinned, sb.duration_sec, 'self' AS peer_id,
        NULL AS peer_name`
	var total int64
	prefixMatches := false
	if q.search != "" && !peers {
		terms := strings.Fields(strings.NewReplacer("'", "", "\"", "").Replace(q.search))
		for i, term := range terms {
			terms[i] = `"` + term + `"*`
		}
		if len(terms) > 0 {
			ftsFrom := from + " INNER JOIN downloads_fts fts ON fts.rowid = d.id"
			ftsWhere := "downloads_fts MATCH ? AND " + where
			ftsArgs := append([]any{strings.Join(terms, " ")}, args...)
			if err := tx.QueryRowContext(r.Context(), "SELECT COUNT(*)"+ftsFrom+" WHERE "+ftsWhere, ftsArgs...).Scan(&total); err != nil {
				return nil, 0, err
			}
			if total > 0 {
				prefixMatches = true
				from, where, args = ftsFrom, ftsWhere, ftsArgs
				if !q.newest {
					order = "fts.rank, d.id ASC"
				}
			}
		}
	}
	if q.search != "" && !prefixMatches {
		where += ` AND (d.file_name LIKE ? ESCAPE '\' OR d.group_name LIKE ? ESCAPE '\')`
		pattern := "%" + strings.NewReplacer(`\`, `\\`, "%", `\%`, "_", `\_`).Replace(q.search) + "%"
		args = append(args, pattern, pattern)
	}
	if peers {
		// The legacy merged feed omits rescue metadata on both catalog sides.
		localColumns = strings.Replace(localColumns, "d.pending_until, d.rescued_at", "NULL AS pending_until, NULL AS rescued_at", 1)
		localColumns += ", CAST(strftime('%s', d.created_at) AS INTEGER) * 1000 AS sort_ts"
		peerColumns := `d.remote_id AS id, d.group_id, d.group_name, d.file_name, d.file_path,
            d.file_size, d.file_type, d.created_at, NULL AS pending_until, NULL AS rescued_at,
            0 AS pinned, NULL AS duration_sec, d.peer_id, p.name AS peer_name,
            CAST(d.created_at AS INTEGER) AS sort_ts`
		peerWhere := strings.ReplaceAll(where, "d.pinned = 1", "0 = 1")
		peerArgs := append([]any(nil), args...)
		// Per-group routes honor peerId. All-media retains the released
		// include=peers behavior; a separate API change can narrow that later.
		if q.perGroup && r.URL.Query().Get("peerId") != "" {
			where += " AND 0 = 1"
			peerWhere += " AND d.peer_id = ?"
			peerArgs = append(peerArgs, r.URL.Query().Get("peerId"))
		}
		from = " FROM (SELECT " + localColumns + from + " WHERE " + where +
			" UNION ALL SELECT " + peerColumns + " FROM peer_downloads d LEFT JOIN peers p ON p.peer_id = d.peer_id WHERE " + peerWhere + ") d"
		where, args = "1 = 1", append(args, peerArgs...)
		localColumns = "d.id, d.group_id, d.group_name, d.file_name, d.file_path, d.file_size, d.file_type, d.created_at, d.pending_until, d.rescued_at, d.pinned, d.duration_sec, d.peer_id, d.peer_name"
		order = "d.sort_ts DESC, d.id DESC"
	}
	if q.pinnedFirst {
		order = "d.pinned DESC, " + order
	}
	from += " WHERE " + where
	if !prefixMatches {
		if err := tx.QueryRowContext(r.Context(), "SELECT COUNT(*)"+from, args...).Scan(&total); err != nil {
			return nil, 0, err
		}
	}
	query := "SELECT " + localColumns + from + " ORDER BY " + order + " LIMIT ? OFFSET ?"
	rows, err := tx.QueryContext(r.Context(), query, append(args, q.limit, q.offset)...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	out := make([]map[string]any, 0)
	var mediaRoot *os.Root
	rootChecked := false
	defer func() {
		if mediaRoot != nil {
			_ = mediaRoot.Close()
		}
	}()
	for rows.Next() {
		var id, pinned int64
		var groupID, groupName, name, filePath, kind, peerID, peerName sql.NullString
		var size, pending, rescued sql.NullInt64
		var duration sql.NullFloat64
		var created any
		if err := rows.Scan(&id, &groupID, &groupName, &name, &filePath, &size, &kind, &created, &pending, &rescued, &pinned, &duration, &peerID, &peerName); err != nil {
			return nil, 0, err
		}
		displayName := groupName.String
		if configured := toString(groups[groupID.String]["name"]); configured != "" {
			displayName = configured
		}
		fileName, folder := name.String, galleryFolder(kind.String)
		stored := strings.ReplaceAll(filePath.String, "\\", "/")
		fullPath := stored
		if !strings.Contains(fullPath, "/") {
			// Filename-only legacy rows use the group layout. If that file is
			// absent, an existing root file is authoritative (e.g. after reindex).
			// Check both within downloads/ so a root basename cannot shadow an
			// established legacy file or escape via a symlink.
			fullPath = galleryGroupFolder(displayName) + "/" + folder + "/" + fileName
			if stored != "" && peerID.String == "self" {
				if !rootChecked {
					mediaRoot, _ = os.OpenRoot(a.downloadsDir)
					rootChecked = true
				}
				if mediaRoot != nil {
					legacy, legacyErr := mediaRoot.Stat(fullPath)
					if errors.Is(legacyErr, os.ErrNotExist) || (legacyErr == nil && !legacy.Mode().IsRegular()) {
						info, err := mediaRoot.Stat(stored)
						if err == nil && info.Mode().IsRegular() {
							fullPath = stored
						}
					}
				}
			}
		}
		item := map[string]any{
			"id": id, "name": nullableString(name), "path": nullableString(filePath), "fullPath": fullPath,
			"size": nullableInt(size), "sizeFormatted": formatBytes(nullableInt64(size)), "type": folder,
			"extension": filepath.Ext(fileName), "modified": created, "pendingUntil": nullableInt(pending),
			"rescuedAt": nullableInt(rescued), "pinned": pinned == 1, "peer_id": peerID.String,
			"peer_name": nullableString(peerName), "duration": nullableFloat(duration),
		}
		if !q.perGroup {
			item["groupId"] = nullableString(groupID)
			if displayName != "" {
				item["groupName"] = displayName
			} else {
				item["groupName"] = nil
			}
		}
		out = append(out, item)
	}
	if err := rows.Err(); err != nil {
		return nil, 0, err
	}
	if err := rows.Close(); err != nil {
		return nil, 0, err
	}
	if err := tx.Commit(); err != nil {
		return nil, 0, err
	}
	return out, total, nil
}

func galleryNarrowing(q galleryQuery) (string, []any) {
	where, args := "1 = 1", []any{}
	if q.groupID != "" {
		where += " AND d.group_id = ?"
		args = append(args, q.groupID)
	}
	kinds := map[string]string{"images": "photo", "videos": "video", "audio": "audio", "documents": "document"}
	if kind := kinds[q.typeName]; kind != "" {
		where += " AND d.file_type = ?"
		args = append(args, kind)
	}
	if q.pinnedOnly {
		where += " AND d.pinned = 1"
	}
	return where, args
}

func galleryGroupFolder(name string) string {
	if name == "" {
		return "unknown"
	}
	return strings.Map(func(r rune) rune {
		if r < 32 || strings.ContainsRune(`<>:"/\|?*`, r) {
			return '_'
		}
		return r
	}, name)
}

func galleryFolder(fileType string) string {
	switch fileType {
	case "photo":
		return "images"
	case "video":
		return "videos"
	case "audio":
		return "audio"
	case "sticker":
		return "stickers"
	default:
		return "documents"
	}
}
