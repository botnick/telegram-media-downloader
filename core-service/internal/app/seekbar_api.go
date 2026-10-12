package app

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/botnick/telegram-media-downloader/core-service/internal/hash"
	"github.com/botnick/telegram-media-downloader/core-service/internal/seekbar"
)

// Seekbar hover-preview sprites. The released server delegated encoding to a
// seekbar-service sidecar; this one runs ffmpeg itself through the shared
// limiter, so advanced.seekbar.sidecarUrl and SEEKBAR_SIDECAR_URL are ignored.
// Sprites, metadata files and seekbar_sprites rows keep the released layout:
// <data>/seekbar/<id>.webp|jpg plus <id>.json, stored as absolute paths.

const seekbarPageSize = 100

func registerSeekbarRoutes(mux *http.ServeMux, a *App) {
	admin := func(h http.HandlerFunc) http.Handler { return a.requireAdmin(h) }
	mux.Handle("POST /api/maintenance/seekbar/build-all", admin(a.handleSeekbarBuild))
	mux.Handle("POST /api/maintenance/seekbar/build-group", admin(a.handleSeekbarBuildGroup))
	mux.Handle("POST /api/maintenance/seekbar/build/cancel", admin(a.handleSeekbarBuildCancel))
	mux.Handle("GET /api/maintenance/seekbar/build/status", admin(func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, a.seekbar.build.status())
	}))
	mux.Handle("GET /api/maintenance/seekbar/build/stats", admin(a.handleSeekbarBuildStats))
	mux.Handle("POST /api/maintenance/seekbar/rebuild", admin(a.handleSeekbarRebuild))
	mux.Handle("GET /api/maintenance/seekbar/rebuild/status", admin(func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, a.seekbar.rebuild.status())
	}))
	mux.Handle("POST /api/maintenance/seekbar/regen/{id}", admin(a.handleSeekbarRegen))
	mux.Handle("GET /api/maintenance/seekbar/stats", admin(a.handleSeekbarStats))
	mux.Handle("GET /api/maintenance/seekbar/queue/stats", admin(a.handleSeekbarQueueStats))
	mux.Handle("GET /api/maintenance/seekbar/list", admin(a.handleSeekbarList))
	mux.Handle("GET /api/maintenance/seekbar/health", admin(a.handleSeekbarHealth))
	mux.Handle("GET /api/maintenance/seekbar/hwaccel-probe", admin(a.handleSeekbarHWAccel))
	mux.Handle("POST /api/maintenance/seekbar/sidecar-test", admin(a.handleSeekbarSidecarTest))
	mux.Handle("POST /api/maintenance/seekbar/sidecar/restart", admin(func(w http.ResponseWriter, r *http.Request) {
		status := a.seekbarEncoderStatus()
		a.broadcastSeekbar("seekbar_sidecar_status", status)
		writeJSON(w, http.StatusOK, map[string]any{"success": true, "sidecar": status})
	}))
}

type seekbarSettings struct {
	enabled        bool
	autoOnDownload bool
	concurrency    int
	opts           seekbar.Options
}

// seekbarSettings reads advanced.seekbar with the same bounds the config
// writer enforces; unset keys take the shipped defaults.
func (a *App) seekbarSettings(ctx context.Context) seekbarSettings {
	raw, _ := a.config.Load(ctx)
	advanced, _ := raw["advanced"].(map[string]any)
	sk, _ := advanced["seekbar"].(map[string]any)
	hw := seekbarHWAccelFor(raw)
	return seekbarSettings{
		enabled:        sk["enabled"] != false,
		autoOnDownload: sk["autoOnDownload"] != false,
		concurrency:    int(clampConfigInt(sk["concurrency"], 1, 16, 4)),
		opts: seekbar.Options{
			IntervalSec: float64(clampConfigInt(sk["intervalSec"], 1, 60, 4)),
			TileWidth:   int(clampConfigInt(sk["tileWidth"], 64, 480, 160)),
			Columns:     int(clampConfigInt(sk["columns"], 2, 30, 10)),
			MaxTiles:    int(clampConfigInt(sk["maxTiles"], 12, 1000, 240)),
			Format:      seekbar.NormalizeFormat(stringOr(sk["format"], "webp")),
			Quality:     int(clampConfigInt(sk["quality"], 10, 100, 75)),
			MaxRetries:  int(clampConfigInt(sk["maxRetries"], 0, 10, 3)),
			HWAccel:     hw,
		},
	}
}

func (a *App) seekbarDir() string { return filepath.Join(a.dataDir, "seekbar") }

func (a *App) seekbarPaths(id int64, format string) (sprite, meta string) {
	ext := "webp"
	if format == "jpeg" {
		ext = "jpg"
	}
	dir := a.seekbarDir()
	return filepath.Join(dir, fmt.Sprintf("%d.%s", id, ext)), filepath.Join(dir, fmt.Sprintf("%d.json", id))
}

func (a *App) logSeekbar(format string, args ...any) {
	if a.output != nil {
		fmt.Fprintf(a.output, "[seekbar] "+format+"\n", args...)
	}
}

// seekbarSource resolves a stored file_path inside the downloads root; a
// missing or escaping file reports os.ErrNotExist.
func (a *App) seekbarSource(stored string) (string, error) {
	name := strings.ReplaceAll(stored, "\\", "/")
	if !filepath.IsAbs(filepath.FromSlash(name)) {
		for strings.HasPrefix(name, "data/downloads/") {
			name = strings.TrimPrefix(name, "data/downloads/")
		}
		name = filepath.Join(a.downloadsDir, filepath.FromSlash(name))
	} else {
		name = filepath.FromSlash(name)
	}
	roots, _ := hash.NewRoots([]string{a.downloadsDir})
	resolved, err := roots.Resolve(name)
	if err != nil {
		return "", fmt.Errorf("%w: %v", os.ErrNotExist, err)
	}
	st, err := os.Stat(resolved)
	if err != nil || !st.Mode().IsRegular() {
		return "", os.ErrNotExist
	}
	return resolved, nil
}

type seekbarOutcome struct {
	meta    *seekbar.Meta
	skipped string
}

var errSeekbarStale = errors.New("download changed while its sprite was built")

// generateSeekbar builds the sprite for one download. overwrite is the
// released never / if-changed / always policy. Skips are not errors: a
// missing file, a non-video or an unreadable duration return a reason.
func (a *App) generateSeekbar(ctx context.Context, id int64, set seekbarSettings, overwrite string) (seekbarOutcome, error) {
	var stored, fileType sql.NullString
	err := a.db.Reader.QueryRowContext(ctx, `SELECT file_path,file_type FROM downloads WHERE id=?`, id).Scan(&stored, &fileType)
	if errors.Is(err, sql.ErrNoRows) {
		return seekbarOutcome{skipped: "missing"}, nil
	}
	if err != nil {
		return seekbarOutcome{}, err
	}
	if fileType.String != "video" {
		return seekbarOutcome{skipped: "not_video"}, nil
	}
	src, err := a.seekbarSource(stored.String)
	if err != nil {
		return seekbarOutcome{skipped: "missing"}, nil
	}
	st, err := os.Stat(src)
	if err != nil {
		return seekbarOutcome{skipped: "missing"}, nil
	}
	sourceSize, sourceMtime := st.Size(), st.ModTime().UnixMilli()
	format := set.opts.Format
	spritePath, metaPath := a.seekbarPaths(id, format)

	if overwrite != "always" && nonEmptyFile(spritePath) && nonEmptyFile(metaPath) {
		if overwrite == "never" {
			return seekbarOutcome{skipped: "cached"}, nil
		}
		if prior, ok := readSeekbarMeta(metaPath); ok && prior.Frames > 0 && prior.SourceSize != nil && *prior.SourceSize == sourceSize && prior.SourceMtime != nil && *prior.SourceMtime == sourceMtime {
			// The files survived an interrupted run; restore the row so the
			// scan stops selecting this video.
			if err := a.commitSeekbar(ctx, id, stored.String, "", "", spritePath, metaPath, prior); err != nil && !errors.Is(err, errSeekbarStale) {
				return seekbarOutcome{}, err
			}
			return seekbarOutcome{skipped: "cached"}, nil
		}
	}

	if err := a.seekbar.limiter.Acquire(ctx, set.concurrency); err != nil {
		return seekbarOutcome{}, err
	}
	defer a.seekbar.limiter.Release()
	duration, err := seekbar.ProbeDuration(ctx, src)
	if errors.Is(err, seekbar.ErrNoDuration) {
		return seekbarOutcome{skipped: "no_duration"}, nil
	}
	if err != nil {
		return seekbarOutcome{}, err
	}
	plan := seekbar.PlanSprite(duration, set.opts)
	if err := os.MkdirAll(a.seekbarDir(), 0o700); err != nil {
		return seekbarOutcome{}, err
	}
	suffix := ".tmp-" + strconv.FormatInt(time.Now().UnixNano(), 36)
	spriteTmp, metaTmp := spritePath+suffix, metaPath+suffix
	defer os.Remove(spriteTmp)
	defer os.Remove(metaTmp)
	if err := seekbar.Encode(ctx, src, spriteTmp, duration, plan, set.opts); err != nil {
		return seekbarOutcome{}, err
	}
	out, err := os.Stat(spriteTmp)
	if err != nil || out.Size() == 0 {
		return seekbarOutcome{}, errors.New("ffmpeg: produced an empty sprite")
	}
	meta := seekbar.NewMeta(id, duration, plan, format, out.Size(), sourceSize, sourceMtime, time.Now())
	body, _ := json.Marshal(meta)
	if err := os.WriteFile(metaTmp, body, 0o600); err != nil {
		return seekbarOutcome{}, err
	}
	if err := a.commitSeekbar(ctx, id, stored.String, spriteTmp, metaTmp, spritePath, metaPath, meta); err != nil {
		if errors.Is(err, errSeekbarStale) {
			return seekbarOutcome{skipped: "missing"}, nil
		}
		return seekbarOutcome{}, err
	}
	return seekbarOutcome{meta: &meta}, nil
}

// commitSeekbar publishes the files and the row in one writer transaction,
// only while the download still points at the file that was sampled. A
// later delete therefore sees the row and journals the files for cleanup.
func (a *App) commitSeekbar(ctx context.Context, id int64, stored, spriteTmp, metaTmp, spritePath, metaPath string, meta seekbar.Meta) error {
	a.mediaMu.RLock()
	defer a.mediaMu.RUnlock()
	if err := a.mediaWritable(ctx); err != nil {
		return err
	}
	tx, err := a.db.Writer.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var current sql.NullString
	err = tx.QueryRowContext(ctx, `SELECT file_path FROM downloads WHERE id=?`, id).Scan(&current)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && current.String != stored) {
		return errSeekbarStale
	}
	if err != nil {
		return err
	}
	if spriteTmp != "" {
		if err := os.Rename(spriteTmp, spritePath); err != nil {
			return err
		}
		if err := os.Rename(metaTmp, metaPath); err != nil {
			return err
		}
		other, _ := a.seekbarPaths(id, map[string]string{"webp": "jpeg", "jpeg": "webp"}[meta.Format])
		_ = os.Remove(other)
	}
	if err := upsertSeekbarRow(ctx, tx, id, spritePath, metaPath, meta); err != nil {
		return err
	}
	// A video classified before it had a sprite is re-queued for NSFW review.
	if _, err := tx.ExecContext(ctx, `UPDATE downloads SET nsfw_checked_at=NULL WHERE id=? AND file_type='video' AND nsfw_score IS NULL`, id); err != nil {
		return err
	}
	return tx.Commit()
}

func upsertSeekbarRow(ctx context.Context, tx *sql.Tx, id int64, spritePath, metaPath string, m seekbar.Meta) error {
	var tileH any
	if m.TileH != nil {
		tileH = *m.TileH
	}
	var duration, interval any
	if m.DurationSec > 0 {
		duration = m.DurationSec
	}
	if m.IntervalSec > 0 {
		interval = m.IntervalSec
	}
	var size, mtime any
	if m.SourceSize != nil {
		size = *m.SourceSize
	}
	if m.SourceMtime != nil {
		mtime = *m.SourceMtime
	}
	generated := m.GeneratedAt
	if generated <= 0 {
		generated = time.Now().UnixMilli()
	}
	_, err := tx.ExecContext(ctx, `
		INSERT INTO seekbar_sprites
			(download_id, sprite_path, meta_path, duration_sec, frames, cols, rows,
			 tile_w, tile_h, interval_sec, format, bytes, source_size, source_mtime, generated_at)
		SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM downloads WHERE id=?)
		ON CONFLICT(download_id) DO UPDATE SET
			sprite_path=excluded.sprite_path, meta_path=excluded.meta_path,
			duration_sec=excluded.duration_sec, frames=excluded.frames, cols=excluded.cols,
			rows=excluded.rows, tile_w=excluded.tile_w, tile_h=excluded.tile_h,
			interval_sec=excluded.interval_sec, format=excluded.format, bytes=excluded.bytes,
			source_size=excluded.source_size, source_mtime=excluded.source_mtime,
			generated_at=excluded.generated_at`,
		id, spritePath, metaPath, duration, m.Frames, m.Cols, m.Rows, m.TileW, tileH, interval,
		m.Format, m.Bytes, size, mtime, generated, id)
	return err
}

// markSeekbar records a video that cannot produce a sprite (format holds the
// reason) so the backlog scan stops selecting it.
func (a *App) markSeekbar(ctx context.Context, id int64, reason string) {
	tx, err := a.db.Writer.BeginTx(ctx, nil)
	if err != nil {
		return
	}
	defer tx.Rollback()
	var size sql.NullInt64
	_ = tx.QueryRowContext(ctx, `SELECT file_size FROM downloads WHERE id=?`, id).Scan(&size)
	m := seekbar.Meta{Format: reason, GeneratedAt: time.Now().UnixMilli()}
	if size.Valid {
		m.SourceSize = &size.Int64
	}
	if upsertSeekbarRow(ctx, tx, id, "", "", m) == nil {
		_ = tx.Commit()
	}
}

func readSeekbarMeta(path string) (seekbar.Meta, bool) {
	var m seekbar.Meta
	body, err := os.ReadFile(path)
	if err != nil || len(body) > 1<<20 {
		return m, false
	}
	return m, json.Unmarshal(body, &m) == nil
}

func nonEmptyFile(path string) bool {
	st, err := os.Stat(path)
	return err == nil && st.Mode().IsRegular() && st.Size() > 0
}

// seekbarScan walks videos keyset-paged by id. groupID limits the walk to one
// chat and then regenerates every video; otherwise only videos without a
// seekbar_sprites row are visited.
func (a *App) seekbarScan(ctx context.Context, groupID string, progress func(map[string]any)) (map[string]any, error) {
	if seekbar.FFmpegPath() == "" {
		return nil, errors.New("ffmpeg is not installed")
	}
	started := time.Now()
	set := a.seekbarSettings(ctx)
	overwrite := "if-changed"
	where := `d.file_type='video' AND d.file_path IS NOT NULL AND s.download_id IS NULL`
	args := []any{}
	if groupID != "" {
		overwrite = "always"
		where = `d.file_type='video' AND d.file_path IS NOT NULL AND d.group_id=?`
		args = append(args, groupID)
	}
	from := ` FROM downloads d LEFT JOIN seekbar_sprites s ON s.download_id=d.id WHERE ` + where
	var total int
	if err := a.db.Reader.QueryRowContext(ctx, `SELECT COUNT(*)`+from, args...).Scan(&total); err != nil {
		return nil, err
	}
	var processed, generated, skipped, errored int
	emit := func(stage string) {
		progress(map[string]any{"stage": stage, "processed": processed, "total": total, "generated": generated, "skipped": skipped, "errored": errored})
	}
	emit("start")
	lastEmit := time.Now()
	cursor := int64(math.MaxInt64)
	for ctx.Err() == nil {
		// Snapshot a page and close the cursor before encoding: no read
		// statement is held open across a long ffmpeg run.
		ids, err := a.seekbarPage(ctx, from, args, cursor)
		if err != nil {
			if ctx.Err() != nil {
				break
			}
			return nil, err
		}
		if len(ids) == 0 {
			break
		}
		for i := 0; i < len(ids) && ctx.Err() == nil; i += set.concurrency {
			batch := ids[i:min(len(ids), i+set.concurrency)]
			results := make([]error, len(batch))
			outcomes := make([]seekbarOutcome, len(batch))
			done := make(chan struct{})
			for j, id := range batch {
				go func() {
					outcomes[j], results[j] = a.generateSeekbar(ctx, id, set, overwrite)
					done <- struct{}{}
				}()
			}
			for range batch {
				<-done
			}
			for j, id := range batch {
				err, out := results[j], outcomes[j]
				switch {
				case err != nil && ctx.Err() != nil:
					continue
				case err != nil:
					errored++
					if seekbar.IsPermanent(err) {
						a.markSeekbar(ctx, id, "failed")
					}
				case out.meta != nil:
					generated++
					a.broadcastSeekbar("seekbar_sprite_ready", map[string]any{"download_id": id})
				default:
					skipped++
					if out.skipped == "missing" || out.skipped == "no_duration" {
						a.markSeekbar(ctx, id, out.skipped)
					}
				}
				processed++
			}
			cursor = batch[len(batch)-1]
			if time.Since(lastEmit) >= time.Second {
				lastEmit = time.Now()
				emit("progress")
			}
		}
	}
	emit("done")
	return map[string]any{"processed": processed, "generated": generated, "skipped": skipped, "errored": errored, "durationMs": time.Since(started).Milliseconds(), "cancelled": ctx.Err() != nil}, nil
}

func (a *App) seekbarPage(ctx context.Context, from string, args []any, before int64) ([]int64, error) {
	rows, err := a.db.Reader.QueryContext(ctx, `SELECT d.id`+from+` AND d.id<? ORDER BY d.id DESC LIMIT ?`, append(append([]any{}, args...), before, seekbarPageSize)...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var ids []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

// wipeSeekbar removes every sprite file and row.
func (a *App) wipeSeekbar(ctx context.Context) (map[string]any, error) {
	a.mediaMu.RLock()
	defer a.mediaMu.RUnlock()
	if err := a.mediaWritable(ctx); err != nil {
		return nil, err
	}
	removed, size := 0, int64(0)
	cursor := int64(math.MaxInt64)
	for {
		rows, err := a.db.Reader.QueryContext(ctx, `SELECT download_id,sprite_path,meta_path,COALESCE(bytes,0) FROM seekbar_sprites WHERE download_id<? ORDER BY download_id DESC LIMIT ?`, cursor, seekbarPageSize)
		if err != nil {
			return nil, err
		}
		type entry struct {
			id           int64
			sprite, meta string
			bytes        int64
		}
		var page []entry
		for rows.Next() {
			var e entry
			if err := rows.Scan(&e.id, &e.sprite, &e.meta, &e.bytes); err != nil {
				rows.Close()
				return nil, err
			}
			page = append(page, e)
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return nil, err
		}
		if len(page) == 0 {
			break
		}
		for _, e := range page {
			a.removeSeekbarFile(e.sprite)
			a.removeSeekbarFile(e.meta)
			removed++
			size += e.bytes
			cursor = e.id
		}
	}
	if _, err := a.db.Writer.ExecContext(ctx, `DELETE FROM seekbar_sprites`); err != nil {
		return nil, err
	}
	// Leftovers from interrupted encodes.
	if names, err := os.ReadDir(a.seekbarDir()); err == nil {
		for _, name := range names {
			if strings.Contains(name.Name(), ".tmp-") {
				_ = os.Remove(filepath.Join(a.seekbarDir(), name.Name()))
			}
		}
	}
	return map[string]any{"removed": removed, "bytes": size, "cancelled": false}, nil
}

// removeSeekbarFile deletes a stored cache path only inside the seekbar root.
func (a *App) removeSeekbarFile(stored string) {
	if stored == "" {
		return
	}
	root := a.seekbarDir()
	name := stored
	if filepath.IsAbs(name) {
		rel, err := filepath.Rel(root, name)
		if err != nil {
			return
		}
		name = rel
	}
	if !filepath.IsLocal(name) {
		return
	}
	_ = os.Remove(filepath.Join(root, name))
}

func (a *App) kvGetJSON(ctx context.Context, key string) any {
	var raw string
	if err := a.db.Reader.QueryRowContext(ctx, `SELECT value FROM kv WHERE key=?`, key).Scan(&raw); err != nil {
		return nil
	}
	var v any
	if json.Unmarshal([]byte(raw), &v) != nil {
		return nil
	}
	return v
}

func (a *App) kvSetJSON(ctx context.Context, key string, value any) {
	if value == nil {
		_, _ = a.db.Writer.ExecContext(ctx, `DELETE FROM kv WHERE key=?`, key)
		return
	}
	raw, err := json.Marshal(value)
	if err != nil {
		return
	}
	_, _ = a.db.Writer.ExecContext(ctx, `INSERT INTO kv(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`, key, string(raw), time.Now().UnixMilli())
}

// runSeekbarBuild is the build-all job body. The pending marker lets a build
// interrupted by a restart resume on the next boot.
func (a *App) runSeekbarBuild(ctx context.Context, progress func(map[string]any)) (map[string]any, error) {
	a.kvSetJSON(ctx, "pending_job_seekbarBuild", map[string]any{"startedAt": time.Now().UnixMilli()})
	result, err := a.seekbarScan(ctx, "", progress)
	if a.ctx.Err() != nil {
		return result, err // shutting down: keep the marker
	}
	a.kvSetJSON(context.Background(), "pending_job_seekbarBuild", nil)
	if err == nil {
		a.recordSeekbarBuild(result, nil)
	}
	return result, err
}

func (a *App) recordSeekbarBuild(result map[string]any, extra map[string]any) {
	last := map[string]any{"finishedAt": time.Now().UnixMilli()}
	for k, v := range result {
		last[k] = v
	}
	for k, v := range extra {
		last[k] = v
	}
	a.kvSetJSON(context.Background(), "seekbar_last_build", last)
}

func (a *App) resumeSeekbarBuild() {
	if a.kvGetJSON(a.ctx, "pending_job_seekbarBuild") == nil {
		return
	}
	a.logSeekbar("resuming the interrupted seekbar build")
	_, _ = a.startSeekbarJob(a.seekbar.build, a.runSeekbarBuild)
}

func (a *App) writeSeekbarStart(w http.ResponseWriter, body map[string]any, err error) {
	switch {
	case err != nil:
		writeJSONError(w, http.StatusServiceUnavailable, err.Error())
	case body["started"] != true:
		writeJSON(w, http.StatusConflict, body)
	default:
		writeJSON(w, http.StatusOK, map[string]any{"started": true})
	}
}

func (a *App) handleSeekbarBuild(w http.ResponseWriter, _ *http.Request) {
	body, err := a.startSeekbarJob(a.seekbar.build, a.runSeekbarBuild)
	a.writeSeekbarStart(w, body, err)
}

func (a *App) handleSeekbarBuildGroup(w http.ResponseWriter, r *http.Request) {
	body, ok := readAuthBody(w, r)
	if !ok {
		return
	}
	groupID := strings.TrimSpace(toString(body["groupId"]))
	if groupID == "" {
		writeJSONError(w, http.StatusBadRequest, "groupId required")
		return
	}
	started, err := a.startSeekbarJob(a.seekbar.build, func(ctx context.Context, progress func(map[string]any)) (map[string]any, error) {
		result, err := a.seekbarScan(ctx, groupID, progress)
		if err == nil {
			a.recordSeekbarBuild(result, map[string]any{"groupId": groupID})
			result["groupId"] = groupID
		}
		return result, err
	})
	a.writeSeekbarStart(w, started, err)
}

func (a *App) handleSeekbarBuildCancel(w http.ResponseWriter, _ *http.Request) {
	a.seekbar.build.stop()
	writeJSON(w, http.StatusOK, map[string]any{"success": true})
}

func (a *App) handleSeekbarBuildStats(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"lastBuild": a.kvGetJSON(r.Context(), "seekbar_last_build")})
}

func (a *App) handleSeekbarRebuild(w http.ResponseWriter, r *http.Request) {
	body, ok := readAuthBody(w, r)
	if !ok {
		return
	}
	wipeOnly := body["wipeOnly"] == true
	started, err := a.startSeekbarJob(a.seekbar.rebuild, func(ctx context.Context, progress func(map[string]any)) (map[string]any, error) {
		wiped, err := a.wipeSeekbar(ctx)
		if err != nil {
			return nil, err
		}
		progress(map[string]any{"phase": "wiped", "wiped": wiped})
		if wipeOnly || ctx.Err() != nil {
			return map[string]any{"wiped": wiped, "regenerated": 0}, nil
		}
		result, err := a.seekbarScan(ctx, "", progress)
		if err != nil {
			return nil, err
		}
		a.recordSeekbarBuild(result, map[string]any{"wiped": wiped})
		result["wiped"] = wiped
		return result, nil
	})
	a.writeSeekbarStart(w, started, err)
}

func (a *App) handleSeekbarRegen(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id <= 0 {
		writeJSONError(w, http.StatusBadRequest, "invalid id")
		return
	}
	var fileType sql.NullString
	err = a.db.Reader.QueryRowContext(r.Context(), `SELECT file_type FROM downloads WHERE id=?`, id).Scan(&fileType)
	if errors.Is(err, sql.ErrNoRows) {
		writeJSONError(w, http.StatusNotFound, "not_found")
		return
	}
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if fileType.String != "video" {
		writeJSONError(w, http.StatusBadRequest, "not a video")
		return
	}
	if seekbar.FFmpegPath() == "" {
		writeJSONError(w, http.StatusServiceUnavailable, "ffmpeg is not installed")
		return
	}
	out, err := a.generateSeekbar(r.Context(), id, a.seekbarSettings(r.Context()), "always")
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, err.Error())
		return
	}
	resp := map[string]any{"success": true}
	if out.meta != nil {
		raw, _ := json.Marshal(out.meta)
		_ = json.Unmarshal(raw, &resp)
		resp["success"] = true
		a.broadcastSeekbar("seekbar_sprite_ready", map[string]any{"download_id": id})
	} else {
		resp["skipped"] = out.skipped
	}
	writeJSON(w, http.StatusOK, resp)
}

func (a *App) seekbarCounts(ctx context.Context) (count, size, videos int64, err error) {
	err = a.db.Reader.QueryRowContext(ctx, `SELECT
		(SELECT COUNT(*) FROM seekbar_sprites),
		(SELECT COALESCE(SUM(bytes),0) FROM seekbar_sprites),
		(SELECT COUNT(*) FROM downloads WHERE file_type='video' AND file_path IS NOT NULL)`).Scan(&count, &size, &videos)
	return
}

func (a *App) handleSeekbarStats(w http.ResponseWriter, r *http.Request) {
	count, size, videos, err := a.seekbarCounts(r.Context())
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "sidecar": a.seekbarEncoderStatus(), "ffmpegAvailable": seekbar.FFmpegPath() != "", "totalVideos": videos, "count": count, "bytes": size})
}

func (a *App) handleSeekbarQueueStats(w http.ResponseWriter, r *http.Request) {
	running := a.seekbar.build.isRunning()
	p := a.seekbar.build.progress()
	var completed int64
	if running {
		completed = int64(number(p["generated"], 0))
	} else if c, _, _, err := a.seekbarCounts(r.Context()); err == nil {
		completed = c
	}
	remaining := 0
	if running {
		remaining = max(0, int(number(p["total"], 0)-number(p["processed"], 0)))
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"success":    true,
		"queued":     a.seekbar.depths() + remaining,
		"processing": a.seekbar.limiter.Active(),
		"completed":  completed,
		"failed":     int(number(p["errored"], 0)),
		"running":    running,
	})
}

func (a *App) handleSeekbarList(w http.ResponseWriter, r *http.Request) {
	payload, status := a.invokeRead(r, a.read.SeekbarList, map[string]any{"limit": queryInt(r, "limit", 50), "offset": queryInt(r, "offset", 0)})
	writeJSON(w, status, payload)
}

// seekbarEncoderStatus fills the released sidecar status shape for the
// built-in encoder: "ok" whenever ffmpeg is available.
func (a *App) seekbarEncoderStatus() map[string]any {
	ffmpeg := seekbar.FFmpegPath()
	status := map[string]any{
		"ok": ffmpeg != "", "mode": "builtin", "url": "", "pid": nil, "error": nil,
		"binPath": ffmpeg, "checkedAt": time.Now().UnixMilli(),
		"sources": map[string]any{"url": nil, "token": nil, "pathMap": nil},
	}
	if ffmpeg == "" {
		status["error"] = "ffmpeg is not installed"
	}
	return status
}

func (a *App) seekbarHWAccel(ctx context.Context) map[string]any {
	compiled := seekbar.HWAccels(ctx)
	// Device initialisation is host-specific; only the configured backend
	// is tried, and a failing one falls back to software per encode.
	return map[string]any{"available": []string{}, "compiled": compiled, "ffmpeg_path": seekbar.FFmpegPath()}
}

func (a *App) handleSeekbarHealth(w http.ResponseWriter, r *http.Request) {
	status := a.seekbarEncoderStatus()
	var hw any
	if status["ok"] == true {
		hw = a.seekbarHWAccel(r.Context())
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"success": true, "sidecar": status, "richHealth": nil, "hwaccel": hw,
		"ffmpegAvailable": status["ok"], "version": "builtin",
		"platform": runtime.GOOS + "/" + runtime.GOARCH, "node": runtime.Version(),
	})
}

func (a *App) handleSeekbarHWAccel(w http.ResponseWriter, r *http.Request) {
	if seekbar.FFmpegPath() == "" {
		writeJSON(w, http.StatusOK, map[string]any{"available": []string{}, "compiled": []string{}, "ffmpeg_path": "", "error": "ffmpeg is not installed"})
		return
	}
	writeJSON(w, http.StatusOK, a.seekbarHWAccel(r.Context()))
}

// handleSeekbarSidecarTest keeps the released validation answers; a valid URL
// is reported as unused because sprites are built in-process.
func (a *App) handleSeekbarSidecarTest(w http.ResponseWriter, r *http.Request) {
	body, ok := readAuthBody(w, r)
	if !ok {
		return
	}
	raw := strings.TrimSpace(toString(body["url"]))
	if raw == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "url_required"})
		return
	}
	lower := strings.ToLower(raw)
	if !strings.HasPrefix(lower, "http://") && !strings.HasPrefix(lower, "https://") {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "invalid_scheme"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok": false, "reachable": false, "error": "external seekbar sidecars are not used: sprites are built in-process with ffmpeg",
		"version": nil, "features": []string{}, "auth": "unknown", "authRequired": nil,
		"platform": nil, "hwaccel": nil, "ffmpeg": nil, "tokenSent": strings.TrimSpace(toString(body["token"])) != "",
	})
}
