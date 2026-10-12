package app

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	_ "image/jpeg" // sprite sheets stored as JPEG
	_ "image/png"  // ffmpeg's WebP → PNG conversion
	"io"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/botnick/telegram-media-downloader/core-service/internal/nsfw"
	"github.com/botnick/telegram-media-downloader/core-service/internal/ws"
)

var (
	errNSFWScanRunning = errors.New("nsfw scan already running")
	errNSFWStopping    = errors.New("server is stopping")
	// errNSFWNoSprite marks a video without a seekbar sprite yet. The row is
	// left unchecked so a later scan scores it once the sprite exists.
	errNSFWNoSprite = errors.New("no seekbar sprite")
)

const nsfwMaxImageBytes = 256 << 20

// nsfwScanState is broadcast verbatim as nsfw_progress / nsfw_done.
type nsfwScanState struct {
	Running    bool    `json:"running"`
	Scanned    int64   `json:"scanned"`
	Total      int64   `json:"total"`
	Candidates int64   `json:"candidates"`
	Keep       int64   `json:"keep"`
	StartedAt  *int64  `json:"startedAt"`
	FinishedAt *int64  `json:"finishedAt"`
	Error      *string `json:"error"`
}

type nsfwRow struct {
	id       int64
	path     string
	fileType string
}

// startNSFWScan claims the single scan slot and runs the scan in the
// background. Cancel via the stored CancelFunc; app shutdown cancels a.ctx.
func (a *App) startNSFWScan(cfg nsfwConfig) error {
	a.nsfw.mu.Lock()
	if a.nsfw.scan.Running {
		a.nsfw.mu.Unlock()
		return errNSFWScanRunning
	}
	ctx, cancel := context.WithCancel(a.ctx)
	now := time.Now().UnixMilli()
	a.nsfw.scan = nsfwScanState{Running: true, StartedAt: &now}
	a.nsfw.scanCancel = cancel
	a.nsfw.mu.Unlock()
	if !a.launchMaintenance(func() { defer cancel(); a.runNSFWScan(ctx, cfg) }) {
		cancel()
		a.nsfw.mu.Lock()
		a.nsfw.scan.Running, a.nsfw.scanCancel = false, nil
		a.nsfw.mu.Unlock()
		return errNSFWStopping
	}
	return nil
}

func (a *App) runNSFWScan(ctx context.Context, cfg nsfwConfig) {
	a.logf("NSFW scan starting: sidecar=%s fileTypes=%s threshold=%.2f concurrency=%d", cfg.Sidecar.URL, strings.Join(cfg.FileTypes, ","), cfg.Threshold, cfg.Concurrency)
	var scanErr error
	if base, err := a.nsfwStats(ctx, cfg); err == nil {
		a.nsfwUpdate(func(s *nsfwScanState) {
			s.Total = max(0, base["totalEligible"].(int64)-base["scanned"].(int64))
			s.Candidates, s.Keep = base["candidates"].(int64), base["keep"].(int64)
		}, true)
	} else {
		scanErr = err
	}
	if scanErr == nil {
		if h := a.nsfw.client.Health(ctx); ctx.Err() != nil {
			scanErr = ctx.Err()
		} else if !h.OK {
			reason := h.Error
			if reason == "" {
				reason = "model not ready"
			}
			scanErr = fmt.Errorf("sidecar unreachable: %s", reason)
		}
	}
	if scanErr == nil {
		scanErr = a.nsfwScanLoop(ctx, cfg)
	}
	finished := time.Now().UnixMilli()
	// Counters are refreshed from the database: rows whitelisted or deleted
	// mid-scan would otherwise drift.
	fresh, _ := a.nsfwStats(context.WithoutCancel(ctx), cfg)
	a.nsfw.mu.Lock()
	s := &a.nsfw.scan
	s.Running, s.FinishedAt = false, &finished
	if scanErr != nil && !errors.Is(scanErr, context.Canceled) {
		msg := scanErr.Error()
		s.Error = &msg
	}
	if fresh != nil {
		s.Candidates, s.Keep = fresh["candidates"].(int64), fresh["keep"].(int64)
	}
	// Release the slot in the same critical section that clears Running, so
	// a scan started right after this one keeps its own CancelFunc.
	a.nsfw.scanCancel = nil
	done := *s
	a.nsfw.mu.Unlock()
	a.hub.Broadcast(ws.Event{Type: "nsfw_progress", Flat: true, Payload: done})
	a.hub.Broadcast(ws.Event{Type: "nsfw_done", Flat: true, Payload: done})
	if done.Error != nil {
		a.logf("NSFW scan finished with error: %s", *done.Error)
	} else {
		a.logf("NSFW scan done: scanned=%d candidates=%d keep=%d", done.Scanned, done.Candidates, done.Keep)
	}
}

// nsfwScanLoop walks unscanned rows by id so a row that cannot be scored
// yet (video without a sprite) is visited once per run, never in a loop.
// Rows are classified by cfg.Concurrency workers; the first sidecar-level
// failure stops the scan and leaves the remaining rows unchecked.
func (a *App) nsfwScanLoop(ctx context.Context, cfg nsfwConfig) error {
	in := strings.TrimSuffix(strings.Repeat("?,", len(cfg.FileTypes)), ",")
	var cursor int64
	for ctx.Err() == nil {
		rows, err := a.nsfwBatch(ctx, in, cfg, cursor)
		if err != nil {
			return err
		}
		if len(rows) == 0 {
			return nil
		}
		cursor = rows[len(rows)-1].id
		work := make(chan nsfwRow)
		errs := make(chan error, cfg.Concurrency)
		batchCtx, stop := context.WithCancel(ctx)
		var wg sync.WaitGroup
		for range cfg.Concurrency {
			wg.Add(1)
			go func() {
				defer wg.Done()
				for row := range work {
					score, err := a.nsfwClassifyRow(batchCtx, cfg, row)
					if errors.Is(err, errNSFWNoSprite) {
						continue
					}
					if err == nil {
						err = a.nsfwRecord(batchCtx, row.id, score)
					}
					if err != nil {
						if batchCtx.Err() == nil {
							errs <- err
						}
						stop()
						return
					}
					a.nsfwUpdate(func(s *nsfwScanState) {
						s.Scanned++
						switch {
						case score == nil:
						case *score >= cfg.Threshold:
							s.Keep++
						default:
							s.Candidates++
						}
					}, false)
				}
			}()
		}
	feed:
		for _, row := range rows {
			select {
			case work <- row:
			case <-batchCtx.Done():
				break feed
			}
		}
		close(work)
		wg.Wait()
		stop()
		select {
		case err := <-errs:
			return err
		default:
		}
	}
	return ctx.Err()
}

func (a *App) nsfwBatch(ctx context.Context, in string, cfg nsfwConfig, cursor int64) ([]nsfwRow, error) {
	args := append(cfg.fileTypeArgs(), cursor, cfg.BatchSize)
	rows, err := a.db.Reader.QueryContext(ctx, `SELECT id, COALESCE(file_path,''), COALESCE(file_type,'') FROM downloads
		WHERE file_type IN (`+in+`) AND nsfw_checked_at IS NULL AND nsfw_whitelist = 0 AND id > ?
		ORDER BY id LIMIT ?`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []nsfwRow
	for rows.Next() {
		var row nsfwRow
		if err := rows.Scan(&row.id, &row.path, &row.fileType); err != nil {
			return nil, err
		}
		out = append(out, row)
	}
	return out, rows.Err()
}

// nsfwRecord persists a result like 2.x setNsfwResult: a nil score still
// stamps nsfw_checked_at so an unreadable file isn't retried forever.
func (a *App) nsfwRecord(ctx context.Context, id int64, score *float64) error {
	_, err := a.db.Writer.ExecContext(ctx, `UPDATE downloads SET nsfw_score = ?, nsfw_checked_at = ? WHERE id = ?`, score, time.Now().UnixMilli(), id)
	return err
}

// nsfwUpdate mutates the scan state and broadcasts nsfw_progress at most
// every 500 ms unless force is set.
func (a *App) nsfwUpdate(fn func(*nsfwScanState), force bool) {
	a.nsfw.mu.Lock()
	fn(&a.nsfw.scan)
	state := a.nsfw.scan
	send := force || time.Since(a.nsfw.lastProgress) >= 500*time.Millisecond
	if send {
		a.nsfw.lastProgress = time.Now()
	}
	a.nsfw.mu.Unlock()
	if send {
		a.hub.Broadcast(ws.Event{Type: "nsfw_progress", Flat: true, Payload: state})
	}
}

// nsfwClassifyRow returns (nil, nil) for a row that cannot be scored (file
// missing or undecodable) and an error when the sidecar itself failed.
func (a *App) nsfwClassifyRow(ctx context.Context, cfg nsfwConfig, row nsfwRow) (*float64, error) {
	if row.fileType == "video" {
		return a.nsfwClassifyVideo(ctx, cfg, row.id)
	}
	name, ok := a.nsfwMediaName(row.path)
	if !ok {
		return nil, nil
	}
	f, err := openMedia(a.downloadsDir, name)
	if err != nil {
		return nil, nil
	}
	f.Close()
	return a.nsfw.client.Classify(ctx, nsfw.Image{
		Path: filepath.Join(a.downloadsDir, name),
		Load: func() ([]byte, error) {
			f, err := openMedia(a.downloadsDir, name)
			if err != nil {
				return nil, err
			}
			defer f.Close()
			return io.ReadAll(io.LimitReader(f, nsfwMaxImageBytes))
		},
	})
}

// nsfwMediaName maps a stored file_path to a name under the downloads
// directory, accepting the legacy forms 2.x wrote (data/downloads/ prefix
// or an absolute path inside the downloads directory).
func (a *App) nsfwMediaName(stored string) (string, bool) {
	p := strings.ReplaceAll(stored, `\`, "/")
	for strings.HasPrefix(p, "data/downloads/") {
		p = strings.TrimPrefix(p, "data/downloads/")
	}
	if filepath.IsAbs(filepath.FromSlash(p)) {
		rel, err := filepath.Rel(a.downloadsDir, filepath.FromSlash(p))
		if err != nil {
			return "", false
		}
		p = filepath.ToSlash(rel)
	}
	name, err := mediaName(p)
	return name, err == nil
}

// nsfwClassifyVideo scores a video from tiles of its seekbar sprite: the
// sidecar gets each tile as JPEG bytes and the top-3 mean is stored.
func (a *App) nsfwClassifyVideo(ctx context.Context, cfg nsfwConfig, id int64) (*float64, error) {
	var spritePath, metaPath, format string
	err := a.db.Reader.QueryRowContext(ctx, `SELECT sprite_path, meta_path, COALESCE(format,'') FROM seekbar_sprites WHERE download_id = ?`, id).Scan(&spritePath, &metaPath, &format)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, errNSFWNoSprite
	}
	if err != nil {
		return nil, err
	}
	meta, err := a.openSeekbar(metaPath)
	if err != nil {
		return nil, errNSFWNoSprite
	}
	var m struct {
		Cols   int `json:"cols"`
		Rows   int `json:"rows"`
		TileW  int `json:"tile_w"`
		TileH  int `json:"tile_h"`
		Frames int `json:"frames"`
	}
	err = json.NewDecoder(io.LimitReader(meta, 1<<20)).Decode(&m)
	meta.Close()
	if err != nil || m.TileW <= 0 {
		return nil, nil
	}
	m.Cols, m.Rows = max(1, m.Cols), max(1, m.Rows)
	if m.Frames <= 0 {
		m.Frames = m.Cols * m.Rows
	}
	sheet, err := a.nsfwDecodeSprite(ctx, spritePath, format)
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, nil
	}
	tiles := nsfw.SpriteTiles(sheet, nsfw.Sprite{Cols: m.Cols, Rows: m.Rows, TileW: m.TileW, TileH: m.TileH, Frames: m.Frames}, nsfw.SampleTiles(m.Frames, cfg.VideoMaxTiles))
	var scores []float64
	for _, tile := range tiles {
		score, err := a.nsfw.client.ClassifyBytes(ctx, tile)
		if err != nil {
			return nil, err
		}
		if score != nil {
			scores = append(scores, *score)
		}
	}
	if len(scores) == 0 {
		// 2.x stored 0 here, which put unreadable videos in the "definitely
		// not 18+" delete tier; record "checked, no score" instead.
		return nil, nil
	}
	v := nsfw.TopKMean(scores)
	return &v, nil
}

// nsfwDecodeSprite decodes a sprite sheet. JPEG/PNG decode natively; WebP
// (the seekbar default) is converted to PNG by ffmpeg first.
func (a *App) nsfwDecodeSprite(ctx context.Context, stored, format string) (image.Image, error) {
	f, err := a.openSeekbar(stored)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, nsfwMaxImageBytes))
	if err != nil {
		return nil, err
	}
	if img, _, err := image.Decode(bytes.NewReader(data)); err == nil {
		return img, nil
	}
	if format != "" && format != "webp" {
		return nil, fmt.Errorf("unsupported sprite format %q", format)
	}
	bin, err := exec.LookPath("ffmpeg")
	if err != nil {
		return nil, err
	}
	var out bytes.Buffer
	cmd := exec.CommandContext(ctx, bin, "-hide_banner", "-loglevel", "error", "-f", "webp_pipe", "-i", "pipe:0", "-frames:v", "1", "-f", "image2pipe", "-c:v", "png", "pipe:1")
	cmd.Stdin, cmd.Stdout = bytes.NewReader(data), &out
	if err := cmd.Run(); err != nil {
		return nil, err
	}
	img, _, err := image.Decode(&out)
	return img, err
}

// queueNSFW schedules a fresh download for the background classifier (2.x
// pregenerateNsfw). It never blocks: when the queue is full the row is
// left for the next batch scan.
func (a *App) queueNSFW(id int64, key string) {
	if a.nsfw == nil || id <= 0 {
		return
	}
	select {
	case a.nsfw.queue <- nsfwJob{id: id, key: key}:
	default:
		return
	}
	a.nsfw.mu.Lock()
	defer a.nsfw.mu.Unlock()
	if a.nsfw.draining {
		return
	}
	a.nsfw.draining = a.launchMaintenance(a.drainNSFW)
}

func (a *App) drainNSFW() {
	ctx := a.ctx
	for {
		var job nsfwJob
		select {
		case job = <-a.nsfw.queue:
		case <-ctx.Done():
			a.nsfw.mu.Lock()
			a.nsfw.draining = false
			a.nsfw.mu.Unlock()
			return
		default:
			a.nsfw.mu.Lock()
			if len(a.nsfw.queue) == 0 {
				a.nsfw.draining = false
				a.nsfw.mu.Unlock()
				return
			}
			a.nsfw.mu.Unlock()
			continue
		}
		if err := a.nsfwAutoScan(ctx, job); err != nil && ctx.Err() == nil {
			// The sidecar is down or rejects the token: leave the queued
			// rows unchecked for the next batch scan instead of retrying
			// each one against a dead sidecar.
			a.logf("NSFW auto-scan paused: %v", err)
			for len(a.nsfw.queue) > 0 {
				<-a.nsfw.queue
			}
		}
	}
}

// nsfwAutoScan applies the hash blocklist and scores one new download.
func (a *App) nsfwAutoScan(ctx context.Context, job nsfwJob) error {
	cfg := a.nsfwSettings(ctx)
	if !cfg.Enabled && !cfg.BlocklistEnabled {
		return nil
	}
	var row nsfwRow
	var hash sql.NullString
	var checked sql.NullInt64
	err := a.db.Reader.QueryRowContext(ctx, `SELECT id, COALESCE(file_path,''), COALESCE(file_type,''), file_hash, nsfw_checked_at FROM downloads WHERE id = ?`, job.id).Scan(&row.id, &row.path, &row.fileType, &hash, &checked)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	allowed := false
	for _, t := range cfg.FileTypes {
		allowed = allowed || strings.EqualFold(t, row.fileType)
	}
	if checked.Valid || !allowed {
		return nil
	}
	if cfg.BlocklistEnabled {
		sum := strings.ToLower(hash.String)
		if sum == "" {
			sum = a.nsfwHashFile(ctx, row)
		}
		var hit int
		if sum != "" && a.db.Reader.QueryRowContext(ctx, `SELECT 1 FROM nsfw_hash_blocklist WHERE lower(file_hash) = ?`, sum).Scan(&hit) == nil {
			if _, err := a.deleteRows(contextRequest(ctx), []int64{row.id}, nil); err != nil {
				return err
			}
			a.hub.Broadcast(ws.Event{Type: "bulk_delete", Flat: true, Payload: map[string]any{"count": 1}})
			a.hub.Broadcast(ws.Event{Type: "nsfw_blocklist_deleted", Flat: true, Payload: map[string]any{"id": row.id, "key": job.key}})
			a.logf("NSFW blocklist: auto-deleted id=%d", row.id)
			return nil
		}
	}
	if !cfg.Enabled || cfg.Sidecar.URL == "" {
		return nil
	}
	score, err := a.nsfwClassifyRow(ctx, cfg, row)
	if errors.Is(err, errNSFWNoSprite) {
		return nil
	}
	if err != nil {
		return err
	}
	return a.nsfwRecord(ctx, row.id, score)
}

// nsfwHashFile hashes a row whose file_hash is missing and stores it, so
// later blocklist checks skip the file read.
func (a *App) nsfwHashFile(ctx context.Context, row nsfwRow) string {
	name, ok := a.nsfwMediaName(row.path)
	if !ok {
		return ""
	}
	f, err := openMedia(a.downloadsDir, name)
	if err != nil {
		return ""
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return ""
	}
	sum := hex.EncodeToString(h.Sum(nil))
	_, _ = a.db.Writer.ExecContext(ctx, `UPDATE downloads SET file_hash = ? WHERE id = ? AND file_hash IS NULL`, sum, row.id)
	return sum
}

func (a *App) logf(format string, args ...any) {
	if a.output != nil {
		fmt.Fprintf(a.output, format+"\n", args...)
	}
}
