package backup

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// A dashboard restore never touches live state. It is verified into
// <data>/restore/pending while the app runs and swapped in at the next start,
// before the database is opened:
//
//  1. stash:   the current state files move to restore/previous-<time>/
//  2. install: the verified files move from restore/pending/ into <data>/
//
// Both steps are renames on the same volume and the phase is journaled in
// restore/apply.json, so a crash or power loss mid-way resumes on the next
// start. A failure rolls back to the previous state and the app boots with
// it; the outcome is kept in restore/last-result.json for the dashboard.

// stateItems are the data-dir entries a full backup replaces. Media, logs,
// backups and everything else stay untouched.
var stateItems = []string{"db.sqlite", "db.sqlite-wal", "db.sqlite-shm", "db.sqlite-journal", "config.json", "secret.key", "sessions"}

const (
	restoreDirName    = "restore"
	pendingDirName    = "pending"
	pendingInfoName   = "pending.json"
	applyStateName    = "apply.json"
	lastResultName    = "last-result.json"
	previousPrefix    = "previous-"
	restoreUploadGlob = "upload-*"
)

// PendingRestore is a verified backup waiting for the next start.
type PendingRestore struct {
	VerifiedAt time.Time `json:"verifiedAt"`
	Manifest   Manifest  `json:"manifest"`
	Files      int       `json:"files"`
	Bytes      int64     `json:"bytes"`
}

// RestoreOutcome is the result of the last swap at startup.
type RestoreOutcome struct {
	At       time.Time `json:"at"`
	OK       bool      `json:"ok"`
	Error    string    `json:"error,omitempty"`
	Previous string    `json:"previous,omitempty"`
	Manifest *Manifest `json:"manifest,omitempty"`
}

type applyState struct {
	Phase    string `json:"phase"`
	Previous string `json:"previous"`
}

// RestoreDir is where uploads, the pending restore and the previous state live.
func RestoreDir(dataDir string) string { return filepath.Join(dataDir, restoreDirName) }

func writeJSONAtomic(path string, v any) error {
	raw, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".tmp-")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err = tmp.Write(raw); err != nil {
		tmp.Close()
		return err
	}
	if err = tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err = tmp.Close(); err != nil {
		return err
	}
	if err = os.Rename(tmp.Name(), path); err != nil {
		return err
	}
	syncDir(filepath.Dir(path))
	return nil
}

func syncDir(dir string) {
	if f, err := os.Open(dir); err == nil {
		_ = f.Sync()
		_ = f.Close()
	}
}

func readJSON(path string, v any) (bool, error) {
	raw, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, json.Unmarshal(raw, v)
}

func exists(path string) bool {
	_, err := os.Lstat(path)
	return err == nil
}

// StageRestore verifies the uploaded full backup and keeps it for the next
// start. It replaces an earlier pending restore only after the new one has
// been verified completely.
func StageRestore(ctx context.Context, dataDir, upload, passphrase string, maxSchema int) (PendingRestore, error) {
	dir := RestoreDir(dataDir)
	var pending PendingRestore
	if exists(filepath.Join(dir, applyStateName)) {
		return pending, errors.New("a restore is being applied; restart the app first")
	}
	if err := os.MkdirAll(dir, 0700); err != nil {
		return pending, err
	}
	candidate := filepath.Join(dir, fmt.Sprintf(".verify-%d", time.Now().UnixNano()))
	defer os.RemoveAll(candidate)
	result, err := RestoreFullBackup(ctx, upload, candidate, passphrase, maxSchema)
	if err != nil {
		if IsWrongPassphrase(err) {
			return pending, ErrWrongPassphrase
		}
		return pending, err
	}
	if err = CancelRestore(dataDir); err != nil {
		return pending, err
	}
	if err = os.Rename(candidate, filepath.Join(dir, pendingDirName)); err != nil {
		return pending, err
	}
	pending = PendingRestore{VerifiedAt: time.Now().UTC().Truncate(time.Second), Manifest: *result.Manifest, Files: len(result.Manifest.Files), Bytes: result.Bytes}
	if err = writeJSONAtomic(filepath.Join(dir, pendingInfoName), pending); err != nil {
		_ = os.RemoveAll(filepath.Join(dir, pendingDirName))
		return pending, err
	}
	return pending, nil
}

// Pending returns the restore waiting for the next start, if any.
func Pending(dataDir string) (*PendingRestore, error) {
	dir := RestoreDir(dataDir)
	var p PendingRestore
	ok, err := readJSON(filepath.Join(dir, pendingInfoName), &p)
	if err != nil || !ok || !exists(filepath.Join(dir, pendingDirName)) {
		return nil, err
	}
	return &p, nil
}

// LastRestore returns the outcome of the most recent swap at startup.
func LastRestore(dataDir string) (*RestoreOutcome, error) {
	var r RestoreOutcome
	ok, err := readJSON(filepath.Join(RestoreDir(dataDir), lastResultName), &r)
	if err != nil || !ok {
		return nil, err
	}
	return &r, nil
}

// CancelRestore drops a pending restore and leftover uploads.
func CancelRestore(dataDir string) error {
	dir := RestoreDir(dataDir)
	if exists(filepath.Join(dir, applyStateName)) {
		return errors.New("a restore is being applied; restart the app first")
	}
	if err := os.Remove(filepath.Join(dir, pendingInfoName)); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return os.RemoveAll(filepath.Join(dir, pendingDirName))
}

// ApplyPendingRestore swaps a pending restore in. It must run before the
// database is opened and never fails startup: on any error the previous
// state is put back and the reason is recorded.
func ApplyPendingRestore(dataDir string, logf func(format string, args ...any)) {
	if logf == nil {
		logf = func(string, ...any) {}
	}
	dir := RestoreDir(dataDir)
	statePath := filepath.Join(dir, applyStateName)
	var st applyState
	resumed, err := readJSON(statePath, &st)
	if err != nil || (resumed && (st.Phase != "stash" && st.Phase != "install" || !strings.HasPrefix(st.Previous, previousPrefix) || filepath.Base(st.Previous) != st.Previous)) {
		logf("restore: unreadable apply journal, leaving the current state: %v", err)
		recordOutcome(dir, RestoreOutcome{Error: "the restore journal was unreadable; the current data was kept"})
		_ = os.Remove(statePath)
		return
	}
	pending, _ := Pending(dataDir)
	if !resumed {
		if pending == nil {
			if exists(filepath.Join(dir, pendingInfoName)) {
				_ = os.Remove(filepath.Join(dir, pendingInfoName))
				recordOutcome(dir, RestoreOutcome{Error: "the verified backup files were missing; the current data was kept"})
			}
			return
		}
		st = applyState{Phase: "stash", Previous: previousPrefix + time.Now().UTC().Format("20060102-150405")}
		for exists(filepath.Join(dir, st.Previous)) {
			st.Previous += "x"
		}
		if err = writeJSONAtomic(statePath, st); err != nil {
			logf("restore: cannot start: %v", err)
			return
		}
		logf("restore: applying the backup from %s", pending.Manifest.CreatedAt.Format(time.RFC3339))
	} else {
		logf("restore: resuming an interrupted restore (%s)", st.Phase)
	}
	prev := filepath.Join(dir, st.Previous)
	pendingDir := filepath.Join(dir, pendingDirName)
	var manifest *Manifest
	if pending != nil {
		manifest = &pending.Manifest
	}
	fail := func(stage string, cause error) {
		rollbackErr := rollbackRestore(dataDir, prev, pendingDir, st.Phase == "install")
		msg := fmt.Sprintf("%s: %v", stage, cause)
		if rollbackErr != nil {
			msg += fmt.Sprintf("; putting the previous data back also failed: %v (it is in %s)", rollbackErr, prev)
		}
		logf("restore failed, kept the previous data: %s", msg)
		_ = os.Remove(statePath)
		_ = CancelRestore(dataDir)
		recordOutcome(dir, RestoreOutcome{Error: msg, Previous: st.Previous, Manifest: manifest})
	}
	if st.Phase == "stash" {
		if err = os.MkdirAll(prev, 0700); err != nil {
			fail("prepare", err)
			return
		}
		if err = moveItems(dataDir, prev); err != nil {
			fail("moving the current data aside", err)
			return
		}
		st.Phase = "install"
		if err = writeJSONAtomic(statePath, st); err != nil {
			fail("journal", err)
			return
		}
	}
	if err = moveItems(pendingDir, dataDir); err != nil {
		fail("installing the backup", err)
		return
	}
	syncDir(dataDir)
	_ = os.RemoveAll(pendingDir)
	_ = os.Remove(filepath.Join(dir, pendingInfoName))
	_ = os.Remove(statePath)
	pruneOlderPrevious(dir, st.Previous)
	recordOutcome(dir, RestoreOutcome{OK: true, Previous: st.Previous, Manifest: manifest})
	logf("restore: done; the previous data is kept in %s", prev)
}

// moveItems renames every state item present in from into to. An item that
// already moved is skipped, which makes a resumed step idempotent.
func moveItems(from, to string) error {
	for _, item := range stateItems {
		src, dst := filepath.Join(from, item), filepath.Join(to, item)
		if !exists(src) {
			continue
		}
		if exists(dst) {
			return fmt.Errorf("%s exists in both %s and %s", item, from, to)
		}
		if err := os.Rename(src, dst); err != nil {
			return err
		}
	}
	syncDir(from)
	syncDir(to)
	return nil
}

// rollbackRestore puts the stashed items back in the data dir. When the
// install step had started (installed is true), every state item in the data
// dir came from pending, so all of them go back to pending first, including
// ones with no stashed counterpart. During the stash step the data dir still
// holds the current, not-yet-moved items, which stay where they are.
func rollbackRestore(dataDir, prev, pendingDir string, installed bool) error {
	var errs []error
	if installed {
		for _, item := range stateItems {
			data := filepath.Join(dataDir, item)
			if !exists(data) {
				continue
			}
			if err := os.MkdirAll(pendingDir, 0700); err != nil {
				errs = append(errs, err)
				break
			}
			if err := os.Rename(data, filepath.Join(pendingDir, item)); err != nil {
				errs = append(errs, err)
			}
		}
	}
	if !exists(prev) {
		syncDir(dataDir)
		return errors.Join(errs...)
	}
	for _, item := range stateItems {
		data, old := filepath.Join(dataDir, item), filepath.Join(prev, item)
		if !exists(old) {
			continue
		}
		if exists(data) {
			errs = append(errs, fmt.Errorf("%s exists in both %s and %s", item, dataDir, prev))
			continue
		}
		if err := os.Rename(old, data); err != nil {
			errs = append(errs, err)
		}
	}
	syncDir(dataDir)
	if err := errors.Join(errs...); err != nil {
		return err
	}
	return os.Remove(prev)
}

func recordOutcome(dir string, r RestoreOutcome) {
	r.At = time.Now().UTC().Truncate(time.Second)
	_ = os.MkdirAll(dir, 0700)
	_ = writeJSONAtomic(filepath.Join(dir, lastResultName), r)
}

// pruneOlderPrevious keeps only the newest previous state.
func pruneOlderPrevious(dir, keep string) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	var names []string
	for _, e := range entries {
		if e.IsDir() && strings.HasPrefix(e.Name(), previousPrefix) && e.Name() != keep {
			names = append(names, e.Name())
		}
	}
	sort.Strings(names)
	for _, name := range names {
		_ = os.RemoveAll(filepath.Join(dir, name))
	}
}

// CleanupRestoreUploads removes unfinished uploads and verification folders.
func CleanupRestoreUploads(dataDir string) {
	dir := RestoreDir(dataDir)
	for _, pattern := range []string{restoreUploadGlob, ".verify-*"} {
		matches, _ := filepath.Glob(filepath.Join(dir, pattern))
		for _, m := range matches {
			_ = os.RemoveAll(m)
		}
	}
}
