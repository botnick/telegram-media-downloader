package app

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"math"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/botnick/telegram-media-downloader/core-service/internal/ws"
)

// The disk rotator enforces diskManagement.maxTotalSize the way 2.x did.
// While diskManagement.enabled is true, every sweepIntervalMin minutes it
// compares the bytes of the files on disk (each shared file once) with the
// cap and, above it,
// deletes the oldest rows (created_at, then id) until the total is back
// under the cap, at most advanced.diskRotator.maxDeletesPerSweep per sweep,
// advanced.diskRotator.sweepBatch rows per transaction.
//
// Never rotated: pinned rows, rescued rows (their source was deleted on
// Telegram, so this copy is the only one), and rows whose file is still
// being published by a download. Deleting a row goes through the durable
// file-cleanup outbox, which removes the file only when no other row still
// references it and only inside the downloads root.
const (
	diskRotatorDefaultInterval = 10 // minutes
	diskRotatorDefaultBatch    = 50
	diskRotatorDefaultMax      = 5000
)

// diskRotatorStartDelay is the first pass after start or a settings change,
// so a freshly enabled cap does not wait a whole interval.
var diskRotatorStartDelay = 5 * time.Second

type diskRotatorSettings struct {
	enabled    bool
	capBytes   int64
	interval   time.Duration
	batch      int
	maxDeletes int
}

type diskRotatorResult struct {
	Before   int64 `json:"before"`
	Deleted  int   `json:"deleted"`
	After    int64 `json:"after"`
	CapBytes int64 `json:"capBytes"`
}

var diskSizePattern = regexp.MustCompile(`(?i)^(\d+(?:\.\d+)?)\s*([KMGT]?B?)$`)

// parseDiskSize reads "10 GB", "500MB", "1.5 TB" or a byte count (binary
// units, as the settings page and 2.x use). Anything unparsable is 0, which
// means no cap: the rotator never deletes on a value it cannot read.
func parseDiskSize(value any) int64 {
	switch v := value.(type) {
	case float64:
		if math.IsNaN(v) || math.IsInf(v, 0) || v <= 0 || v > math.MaxInt64/2 {
			return 0
		}
		return int64(v)
	case string:
		m := diskSizePattern.FindStringSubmatch(strings.TrimSpace(v))
		if m == nil {
			return 0
		}
		n, err := strconv.ParseFloat(m[1], 64)
		if err != nil || n < 0 {
			return 0
		}
		unit := strings.TrimSuffix(strings.ToUpper(m[2]), "B")
		mult := map[string]float64{"": 1, "K": 1 << 10, "M": 1 << 20, "G": 1 << 30, "T": 1 << 40}[unit]
		if bytes := n * mult; bytes < math.MaxInt64/2 {
			return int64(bytes)
		}
	}
	return 0
}

func diskRotatorConfig(cfg map[string]any) diskRotatorSettings {
	dm, _ := cfg["diskManagement"].(map[string]any)
	adv := objectAt(cfg, "advanced", "diskRotator")
	minutes := int64(number(dm["sweepIntervalMin"], 0))
	if minutes == 0 {
		minutes = diskRotatorDefaultInterval
	}
	return diskRotatorSettings{
		enabled:    dm["enabled"] == true,
		capBytes:   parseDiskSize(dm["maxTotalSize"]),
		interval:   time.Duration(max(1, min(1440, minutes))) * time.Minute,
		batch:      int(clampConfigInt(adv["sweepBatch"], 1, 1000, diskRotatorDefaultBatch)),
		maxDeletes: int(clampConfigInt(adv["maxDeletesPerSweep"], 1, 100000, diskRotatorDefaultMax)),
	}
}

type rotatedRow struct {
	id    int64
	group string
	path  sql.NullString
	size  int64
}

// sweepDiskRotator runs one pass. It returns ok=false when rotation is off
// or no cap is configured. Passes never overlap.
func (a *App) sweepDiskRotator(ctx context.Context) (diskRotatorResult, bool, error) {
	a.diskRotatorMu.Lock()
	defer a.diskRotatorMu.Unlock()
	cfg, err := a.config.Load(ctx)
	if err != nil {
		return diskRotatorResult{}, false, err
	}
	set := diskRotatorConfig(cfg)
	if !set.enabled || set.capBytes <= 0 {
		return diskRotatorResult{}, false, nil
	}
	result := diskRotatorResult{CapBytes: set.capBytes}
	if result.Before, err = a.catalogBytes(ctx); err != nil {
		return result, true, err
	}
	result.After = result.Before
	if result.Before <= set.capBytes {
		return result, true, nil
	}
	a.mediaMu.RLock()
	defer a.mediaMu.RUnlock()
	if err := a.mediaWritable(ctx); err != nil {
		return result, true, err
	}
	total, budget := result.Before, set.maxDeletes
	var cleanupErr error
	for total > set.capBytes && budget > 0 {
		rows, err := a.rotateBatch(ctx, &total, set.capBytes, min(set.batch, budget))
		if err != nil {
			return result, true, errors.Join(err, cleanupErr)
		}
		if len(rows) == 0 {
			break // everything left is protected
		}
		result.Deleted += len(rows)
		budget -= len(rows)
		cleanupErr = errors.Join(cleanupErr, a.drainFileCleanup(ctx), a.library.CleanDerived(ctx))
		events := make([]ws.Event, 0, len(rows))
		for _, row := range rows {
			var path any
			if row.path.Valid && row.path.String != "" {
				path = row.path.String
			}
			events = append(events, ws.Event{Type: "file_deleted", Flat: true, Payload: map[string]any{"id": row.id, "groupId": row.group, "path": path, "source": "disk_rotator"}})
		}
		a.hub.BroadcastBatch(events)
	}
	if result.After, err = a.catalogBytes(ctx); err != nil {
		result.After = total
	}
	if result.Deleted > 0 {
		a.broadcastStatsUpdate(ctx)
	}
	return result, true, cleanupErr
}

func (a *App) catalogBytes(ctx context.Context) (int64, error) {
	var total int64
	err := a.db.Reader.QueryRowContext(ctx, catalogBytesQuery).Scan(&total)
	return total, err
}

// catalogBytesQuery sums each stored file once. Rows for the same media
// (a repost, a forward, a deduplicated download) share one file; summing
// file_size over rows counted that file once per row and made the library
// look larger than the disk, which set the rotator deleting under the cap.
const catalogBytesQuery = `SELECT COALESCE(SUM(size),0) FROM (SELECT MAX(COALESCE(file_size,0)) AS size FROM downloads WHERE file_path IS NOT NULL AND file_path<>'' GROUP BY file_path)`

// rotateBatch deletes, in one writer transaction, the oldest eligible rows
// until *total drops to capBytes or limit rows are gone. Selecting inside the
// transaction means a pin or rescue that commits first always wins.
func (a *App) rotateBatch(ctx context.Context, total *int64, capBytes int64, limit int) ([]rotatedRow, error) {
	tx, err := a.db.Writer.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(ctx, `UPDATE tgdl_file_cleanup SET path=path WHERE 0`); err != nil {
		return nil, err
	}
	rows, err := tx.QueryContext(ctx, `SELECT d.id,COALESCE(d.group_id,''),d.file_path,COALESCE(d.file_size,0) FROM downloads d
		WHERE d.pinned=0 AND d.rescued_at IS NULL
		  AND NOT EXISTS(SELECT 1 FROM tgdl_ingest_files i WHERE i.path=REPLACE(d.file_path,char(92),'/'))
		ORDER BY d.created_at ASC, d.id ASC LIMIT ?`, limit)
	if err != nil {
		return nil, err
	}
	var candidates []rotatedRow
	for rows.Next() {
		var row rotatedRow
		if err = rows.Scan(&row.id, &row.group, &row.path, &row.size); err != nil {
			break
		}
		candidates = append(candidates, row)
	}
	if err = errors.Join(err, rows.Err(), rows.Close()); err != nil {
		return nil, err
	}
	remaining := *total
	var deleted []rotatedRow
	for _, row := range candidates {
		if remaining <= capBytes {
			break
		}
		if err = a.library.InvalidateDerived(ctx, tx, row.id); err != nil {
			return nil, err
		}
		// Like 2.x, a path outside the downloads root (absolute or ../)
		// loses only its row; its file is never touched.
		if _, unsafe := mediaName(row.path.String); row.path.Valid && unsafe == nil {
			if _, err = tx.ExecContext(ctx, `INSERT OR IGNORE INTO tgdl_file_cleanup(path) VALUES(?)`, row.path.String); err != nil {
				return nil, err
			}
		}
		if _, err = tx.ExecContext(ctx, `DELETE FROM downloads WHERE id=?`, row.id); err != nil {
			return nil, err
		}
		// A row without a file frees nothing, and a file another row
		// still uses stays on disk.
		shared := !row.path.Valid || row.path.String == ""
		if !shared {
			if err = tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM downloads WHERE file_path=?)`, row.path.String).Scan(&shared); err != nil {
				return nil, err
			}
		}
		if !shared {
			remaining -= row.size
		}
		deleted = append(deleted, row)
	}
	if err = tx.Commit(); err != nil {
		return nil, err
	}
	*total = remaining
	return deleted, nil
}

// wakeDiskRotator applies a settings change: the next pass runs shortly.
func (a *App) wakeDiskRotator() {
	if a.diskRotatorWake == nil {
		return
	}
	select {
	case a.diskRotatorWake <- struct{}{}:
	default:
	}
}

func (a *App) runDiskRotator(ctx context.Context) {
	timer := time.NewTimer(diskRotatorStartDelay)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-a.diskRotatorWake:
			timer.Reset(diskRotatorStartDelay)
			continue
		case <-timer.C:
		}
		started := time.Now()
		result, active, err := a.sweepDiskRotator(ctx)
		if ctx.Err() != nil {
			return
		}
		interval := time.Duration(diskRotatorDefaultInterval) * time.Minute
		if cfg, cfgErr := a.config.Load(ctx); cfgErr == nil {
			interval = diskRotatorConfig(cfg).interval
		}
		a.recordDiskRotation(started, result, active, err, time.Now().Add(interval))
		timer.Reset(interval)
	}
}

func (a *App) recordDiskRotation(started time.Time, result diskRotatorResult, active bool, err error, next time.Time) {
	status := map[string]any{"enabled": active, "lastSweepAt": started.UnixMilli(), "nextSweepAt": next.UnixMilli(), "result": nil, "error": nil}
	if active {
		status["result"] = map[string]any{"before": result.Before, "deleted": result.Deleted, "after": result.After, "capBytes": result.CapBytes}
	}
	if err != nil {
		status["error"] = err.Error()
	}
	a.maintenanceMu.Lock()
	if previous, ok := a.diskRotatorStatus["lastRotation"]; ok && result.Deleted == 0 {
		status["lastRotation"] = previous
	}
	if result.Deleted > 0 {
		status["lastRotation"] = map[string]any{"at": started.UnixMilli(), "deleted": result.Deleted, "before": result.Before, "after": result.After}
	}
	a.diskRotatorStatus = status
	payload := cloneConfigValue(status)
	a.maintenanceMu.Unlock()
	if active {
		a.hub.Broadcast(ws.Event{Type: "disk_rotator_swept", Flat: true, Payload: payload, Roles: []string{"admin"}})
	}
	if a.output != nil && (err != nil || result.Deleted > 0) {
		if err != nil {
			fmt.Fprintf(a.output, "Disk rotation: %v\n", err)
		}
		if result.Deleted > 0 {
			fmt.Fprintf(a.output, "Disk rotation deleted %d oldest downloads: %s -> %s (cap %s)\n", result.Deleted, formatBytes(result.Before), formatBytes(result.After), formatBytes(result.CapBytes))
		}
	}
}

func (a *App) handleDiskRotatorStatus(w http.ResponseWriter, r *http.Request) {
	cfg, err := a.config.Load(r.Context())
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "config read failed")
		return
	}
	set := diskRotatorConfig(cfg)
	total, err := a.catalogBytes(r.Context())
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "size read failed")
		return
	}
	a.maintenanceMu.Lock()
	last := cloneConfigValue(a.diskRotatorStatus)
	a.maintenanceMu.Unlock()
	writeJSON(w, http.StatusOK, map[string]any{
		"enabled": set.enabled, "capBytes": set.capBytes, "totalBytes": total,
		"intervalMin": int(set.interval / time.Minute), "sweepBatch": set.batch, "maxDeletesPerSweep": set.maxDeletes,
		"last": last,
	})
}
