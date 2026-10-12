package app

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io/fs"
	"math"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/botnick/telegram-media-downloader/core-service/internal/ws"
)

// The file integrity sweep is 2.x's catch-all for rows whose file vanished
// (a crash mid-write, a manual delete, a partial restore): every catalog row
// is stat'ed, rows whose file is missing or empty are pruned and stale
// file_size values are corrected. Maintenance → Verify files runs it by hand;
// runIntegritySweeper runs it 30 s after boot and every
// advanced.integrity.intervalMin minutes (60 at least).
// First automatic pass after boot; tests push it out of their way.
var integrityBootDelay = 30 * time.Second

const (
	integrityMinPeriod = 60 // minutes; the documented floor of intervalMin
	// Automatic runs refuse to prune when more than half of the library
	// looks missing at once: an unmounted disk or a stale network share is
	// far likelier than real deletions.
	integrityAutoMaxShare = 0.5
	integrityAutoMinRows  = 20
	integrityDeleteChunk  = 500
)

type integrityResult struct {
	Scanned   int    `json:"scanned"`
	Pruned    int    `json:"pruned"`
	SizeFixed int    `json:"sizeFixed"`
	Missing   int    `json:"missing,omitempty"`
	Skipped   bool   `json:"skipped,omitempty"`
	Reason    string `json:"reason,omitempty"`
}

type integrityRow struct {
	id   int64
	path string
	size sql.NullInt64
	abs  string
}

// integrityProgress receives processed/total for the current stage
// ("scanning", "fixing_sizes", "pruning").
type integrityProgress func(processed, total int, stage string, r integrityResult)

// integrityTarget maps a stored path to the file to stat. Rows that point
// at a cluster peer's copy have nothing local to check.
func integrityTarget(root, stored string) (string, bool) {
	rel := strings.ReplaceAll(stored, "\\", "/")
	for strings.HasPrefix(rel, "data/downloads/") {
		rel = strings.TrimPrefix(rel, "data/downloads/")
	}
	if rel == "" || strings.HasPrefix(rel, "_clusterref/") || strings.ContainsRune(rel, 0) {
		return "", false
	}
	// A custom download path outside the root is checked where it points;
	// only rows are ever pruned here, never files.
	if filepath.IsAbs(filepath.FromSlash(rel)) {
		return filepath.Clean(filepath.FromSlash(rel)), true
	}
	return filepath.Join(root, filepath.FromSlash(rel)), true
}

// fileGone reports the stat errors that mean "deleted". EACCES, EIO,
// ENOTCONN, ESTALE and the like are an unreadable disk, not a missing file.
func fileGone(err error) bool {
	return errors.Is(err, fs.ErrNotExist) || errors.Is(err, syscall.ENOTDIR)
}

type integrityVerdict int

const (
	integrityKeep integrityVerdict = iota
	integrityPrune
	integrityFixSize
)

func integrityCheck(row integrityRow) (integrityVerdict, int64) {
	st, err := os.Stat(row.abs)
	switch {
	case err != nil:
		if fileGone(err) {
			return integrityPrune, 0
		}
		return integrityKeep, 0
	case !st.Mode().IsRegular():
		return integrityKeep, 0
	case st.Size() <= 0:
		return integrityPrune, 0
	case !row.size.Valid || row.size.Int64 != st.Size():
		return integrityFixSize, st.Size()
	}
	return integrityKeep, 0
}

func (a *App) integrityBatchSize(ctx context.Context) int {
	cfg, _ := a.config.Load(ctx)
	return int(clampConfigInt(objectAt(cfg, "advanced", "integrity")["batchSize"], 1, 1024, 64))
}

// sweepIntegrity runs one pass. A concurrent pass (manual or automatic)
// makes it return skipped; the caller decides whether that is an error.
func (a *App) sweepIntegrity(ctx context.Context, auto bool, progress integrityProgress) (integrityResult, error) {
	var result integrityResult
	if !a.filesSweeping.CompareAndSwap(false, true) {
		result.Skipped, result.Reason = true, "already_running"
		return result, nil
	}
	defer a.filesSweeping.Store(false)
	report := func(processed, total int, stage string) {
		if progress != nil {
			progress(processed, total, stage, result)
		}
	}
	if err := a.mediaWritable(ctx); err != nil {
		return result, err
	}
	// An unmounted or unreadable downloads disk makes every file look
	// missing: never prune the library because of that.
	if _, err := os.ReadDir(a.downloadsDir); err != nil {
		result.Skipped, result.Reason = true, "downloads_dir_unavailable"
		return result, nil
	}
	var total int
	if err := a.db.Reader.QueryRowContext(ctx, `SELECT COUNT(*) FROM downloads WHERE file_path IS NOT NULL`).Scan(&total); err != nil {
		return result, err
	}
	result.Scanned = total
	report(0, total, "scanning")
	batch := a.integrityBatchSize(ctx)
	var prune []integrityRow
	type sizeFix struct {
		id   int64
		size int64
	}
	var fixes []sizeFix
	processed := 0
	// Keyset pages by id DESC: rows inserted mid-scan cannot shift the
	// window, and no statement stays open while files are stat'ed.
	before := int64(math.MaxInt64)
	for {
		page, err := a.integrityPage(ctx, before, batch)
		if err != nil {
			return result, err
		}
		if len(page) == 0 {
			break
		}
		before = page[len(page)-1].id
		verdicts := make([]integrityVerdict, len(page))
		sizes := make([]int64, len(page))
		var wg sync.WaitGroup
		for i := range page {
			abs, ok := integrityTarget(a.downloadsDir, page[i].path)
			if !ok {
				continue
			}
			page[i].abs = abs
			wg.Add(1)
			go func(i int) {
				defer wg.Done()
				verdicts[i], sizes[i] = integrityCheck(page[i])
			}(i)
		}
		wg.Wait()
		for i, verdict := range verdicts {
			switch verdict {
			case integrityPrune:
				prune = append(prune, page[i])
			case integrityFixSize:
				fixes = append(fixes, sizeFix{page[i].id, sizes[i]})
			}
		}
		processed += len(page)
		report(processed, total, "scanning")
		if err := ctx.Err(); err != nil {
			return result, err
		}
		if len(page) < batch {
			break
		}
	}
	// Writes wait for a purge in progress; the scan above does not hold it up.
	a.mediaMu.RLock()
	defer a.mediaMu.RUnlock()
	if err := a.mediaWritable(ctx); err != nil {
		return result, err
	}
	for i := 0; i < len(fixes); i += integrityDeleteChunk {
		chunk := fixes[i:min(len(fixes), i+integrityDeleteChunk)]
		tx, err := a.db.Writer.BeginTx(ctx, nil)
		if err != nil {
			return result, err
		}
		for _, fix := range chunk {
			if _, err = tx.ExecContext(ctx, `UPDATE downloads SET file_size=? WHERE id=?`, fix.size, fix.id); err != nil {
				break
			}
		}
		if err == nil {
			err = tx.Commit()
		}
		_ = tx.Rollback()
		if err != nil {
			return result, err
		}
		result.SizeFixed += len(chunk)
		report(result.SizeFixed, len(fixes), "fixing_sizes")
	}
	if auto && len(prune) >= integrityAutoMinRows && float64(len(prune)) > float64(total)*integrityAutoMaxShare {
		result.Skipped, result.Reason, result.Missing = true, "too_many_missing", len(prune)
		report(total, total, "done")
		return result, nil
	}
	if len(prune) > 0 {
		report(0, len(prune), "pruning")
		for i := 0; i < len(prune); i += integrityDeleteChunk {
			n, err := a.pruneMissingRows(ctx, prune[i:min(len(prune), i+integrityDeleteChunk)])
			result.Pruned += n
			if err != nil {
				return result, err
			}
			report(min(len(prune), i+integrityDeleteChunk), len(prune), "pruning")
		}
		if err := a.library.CleanDerived(ctx); err != nil {
			return result, err
		}
		if result.Pruned > 0 {
			a.hub.Broadcast(ws.Event{Type: "integrity_swept", Flat: true, Payload: map[string]any{"pruned": result.Pruned, "scanned": result.Scanned}})
			a.broadcastStatsUpdate(ctx)
		}
	}
	report(total, total, "done")
	return result, nil
}

func (a *App) integrityPage(ctx context.Context, before int64, limit int) ([]integrityRow, error) {
	rows, err := a.db.Reader.QueryContext(ctx, `SELECT id,file_path,file_size FROM downloads WHERE file_path IS NOT NULL AND id<? ORDER BY id DESC LIMIT ?`, before, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	page := make([]integrityRow, 0, limit)
	for rows.Next() {
		var row integrityRow
		if err := rows.Scan(&row.id, &row.path, &row.size); err != nil {
			return nil, err
		}
		page = append(page, row)
	}
	return page, rows.Err()
}

// pruneMissingRows deletes catalog rows (never files) whose file is still
// missing once the writer lock is held: the library publishes files under the
// same lock, so a download that lands between scan and prune keeps its row.
func (a *App) pruneMissingRows(ctx context.Context, rows []integrityRow) (int, error) {
	tx, err := a.db.Writer.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(ctx, `UPDATE tgdl_file_cleanup SET path=path WHERE 0`); err != nil {
		return 0, err
	}
	pruned := 0
	for _, row := range rows {
		if verdict, _ := integrityCheck(row); verdict != integrityPrune {
			continue
		}
		var id int64
		err = tx.QueryRowContext(ctx, `SELECT id FROM downloads WHERE id=? AND file_path=?`, row.id, row.path).Scan(&id)
		if errors.Is(err, sql.ErrNoRows) {
			continue // re-published or removed since the scan
		}
		if err != nil {
			return 0, err
		}
		if err = a.library.InvalidateDerived(ctx, tx, row.id); err != nil {
			return 0, err
		}
		if _, err = tx.ExecContext(ctx, `DELETE FROM downloads WHERE id=?`, row.id); err != nil {
			return 0, err
		}
		pruned++
	}
	if err = tx.Commit(); err != nil {
		return 0, err
	}
	return pruned, nil
}

// integrityInterval is advanced.integrity.intervalMin with 2.x's 60-minute
// floor, re-read every cycle so a saved change applies from the next pass.
func (a *App) integrityInterval(ctx context.Context) time.Duration {
	cfg, _ := a.config.Load(ctx)
	minutes := clampConfigInt(objectAt(cfg, "advanced", "integrity")["intervalMin"], 1, 10080, 60)
	return time.Duration(max(integrityMinPeriod, minutes)) * time.Minute
}

func (a *App) runIntegritySweeper(ctx context.Context) {
	timer := time.NewTimer(integrityBootDelay)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
		}
		result, err := a.sweepIntegrity(ctx, true, nil)
		if ctx.Err() != nil {
			return
		}
		if a.output != nil {
			switch {
			case err != nil:
				fmt.Fprintf(a.output, "Integrity sweep failed: %v\n", err)
			case result.Reason == "too_many_missing":
				fmt.Fprintf(a.output, "Integrity sweep: %d of %d files look missing — not pruning automatically (disk unmounted?). Run Maintenance → Verify files to prune.\n", result.Missing, result.Scanned)
			case result.Reason == "downloads_dir_unavailable":
				fmt.Fprintln(a.output, "Integrity sweep skipped: downloads folder unavailable, nothing pruned")
			case result.Pruned > 0:
				fmt.Fprintf(a.output, "Integrity sweep pruned %d dead rows out of %d\n", result.Pruned, result.Scanned)
			}
		}
		timer.Reset(a.integrityInterval(ctx))
	}
}
