package app

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sync"
	"time"

	"github.com/botnick/telegram-media-downloader/core-service/internal/backup"
	"github.com/botnick/telegram-media-downloader/core-service/internal/store"
	"github.com/botnick/telegram-media-downloader/core-service/internal/version"
)

// Whole-app state backup and restore from the dashboard: one encrypted file
// with the database, settings and Telegram sessions (no media). Restore is
// verified while the app runs and swapped in at the next start (see
// backup.ApplyPendingRestore).

const (
	fullBackupTTL            = time.Hour
	maxRestoreUpload   int64 = 16 << 30
	restoreSpareBytes        = 256 << 20
	fullBackupDirName        = "full"
	restoreRestartWait       = time.Second
)

var fullBackupID = regexp.MustCompile(`^[0-9a-f]{32}$`)

type fullBackupFile struct {
	path, name string
	created    time.Time
}

// fullBackupDownloads holds built backups until they are fetched or expire,
// and lets one heavy full-backup operation run at a time.
type fullBackupDownloads struct {
	busy  sync.Mutex
	mu    sync.Mutex
	files map[string]fullBackupFile
}

func (d *fullBackupDownloads) put(id string, f fullBackupFile) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.files == nil {
		d.files = map[string]fullBackupFile{}
	}
	d.sweepLocked()
	d.files[id] = f
}
func (d *fullBackupDownloads) get(id string) (fullBackupFile, bool) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.sweepLocked()
	f, ok := d.files[id]
	return f, ok
}
func (d *fullBackupDownloads) sweepLocked() {
	for id, f := range d.files {
		if time.Since(f.created) > fullBackupTTL {
			_ = os.Remove(f.path)
			delete(d.files, id)
		}
	}
}

func randomID() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(b[:]), nil
}

func registerFullBackupRoutes(mux *http.ServeMux, a *App) {
	// Built backups never outlive the process that made them.
	_ = os.RemoveAll(filepath.Join(a.dataDir, "backups", fullBackupDirName))
	admin := func(h http.HandlerFunc) http.Handler { return a.requireAdmin(h) }
	mux.Handle("POST /api/backup/full", admin(a.handleFullBackupBuild))
	mux.Handle("GET /api/backup/full/{id}", admin(a.handleFullBackupDownload))
	mux.Handle("GET /api/backup/full/restore/status", admin(a.handleRestoreStatus))
	mux.Handle("POST /api/backup/full/restore/upload", admin(a.handleRestoreUpload))
	mux.Handle("POST /api/backup/full/restore/verify", admin(a.handleRestoreVerify))
	mux.Handle("POST /api/backup/full/restore/cancel", admin(a.handleRestoreCancel))
	mux.Handle("POST /api/backup/full/restore/restart", admin(a.handleRestoreRestart))
}

// checkFree refuses work that would fill the data volume.
func (a *App) checkFree(need int64) error {
	free, err := backup.FreeBytes(a.dataDir)
	if err != nil {
		return nil // unknown: let the write itself fail if it must
	}
	if need < 0 || free < uint64(need) {
		return fmt.Errorf("not enough free disk space: %s needed, %s free", formatBytes(need), formatBytes(int64(free)))
	}
	return nil
}

func (a *App) handleFullBackupBuild(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Password   string `json:"password"`
		Passphrase string `json:"passphrase"`
	}
	if err := decodeBody(w, r, &body); err != nil {
		writeJSONError(w, 400, "Invalid body")
		return
	}
	if err := a.verifyAdminPassword(r.Context(), body.Password); err != nil {
		writeJSON(w, 403, map[string]any{"error": "Wrong dashboard password", "code": "BAD_PASSWORD"})
		return
	}
	if !a.fullBackups.busy.TryLock() {
		writeJSONError(w, 409, "Another full backup or restore is running")
		return
	}
	defer a.fullBackups.busy.Unlock()
	var dbSize int64
	if info, err := os.Stat(filepath.Join(a.dataDir, "db.sqlite")); err == nil {
		dbSize = info.Size()
	}
	if err := a.checkFree(2*dbSize + restoreSpareBytes); err != nil {
		writeJSON(w, 507, map[string]any{"error": err.Error(), "code": "NO_SPACE"})
		return
	}
	dir := filepath.Join(a.dataDir, "backups", fullBackupDirName)
	path, manifest, err := backup.BuildFullBackup(r.Context(), dir, backup.FullBackupOptions{
		DB: a.db.Writer, DataDir: a.dataDir, AppVersion: version.AppVersion, SchemaVersion: store.SchemaVersion(),
		Passphrase: body.Passphrase, Lock: func() func() { a.configMu.Lock(); return a.configMu.Unlock },
	})
	if err != nil {
		writeJSONError(w, 400, err.Error())
		return
	}
	id, err := randomID()
	if err != nil {
		_ = os.Remove(path)
		writeJSONError(w, 500, err.Error())
		return
	}
	info, err := os.Stat(path)
	if err != nil {
		writeJSONError(w, 500, err.Error())
		return
	}
	name := "tgdl-" + manifest.CreatedAt.Format("20060102-150405") + backup.FullBackupExt
	a.fullBackups.put(id, fullBackupFile{path: path, name: name, created: time.Now()})
	writeJSON(w, 200, map[string]any{"id": id, "name": name, "size": info.Size(), "files": len(manifest.Files), "createdAt": manifest.CreatedAt})
}

func (a *App) handleFullBackupDownload(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	f, ok := a.fullBackups.get(id)
	if !fullBackupID.MatchString(id) || !ok {
		writeJSONError(w, 404, "This backup has expired. Make a new one.")
		return
	}
	file, err := os.Open(f.path)
	if err != nil {
		writeJSONError(w, 404, "This backup has expired. Make a new one.")
		return
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		writeJSONError(w, 500, err.Error())
		return
	}
	// A large file over a slow link must not hit a write deadline.
	_ = http.NewResponseController(w).SetWriteDeadline(time.Time{})
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", `attachment; filename="`+f.name+`"`)
	w.Header().Set("Cache-Control", "no-store")
	http.ServeContent(w, r, f.name, info.ModTime(), file)
}

func (a *App) restoreStatus() (map[string]any, error) {
	pending, err := backup.Pending(a.dataDir)
	if err != nil {
		return nil, err
	}
	last, err := backup.LastRestore(a.dataDir)
	if err != nil {
		return nil, err
	}
	return map[string]any{"pending": pending, "last": last, "canRestart": a.restart != nil, "maxUpload": maxRestoreUpload, "bootId": a.bootID}, nil
}

func (a *App) handleRestoreStatus(w http.ResponseWriter, r *http.Request) {
	status, err := a.restoreStatus()
	if err != nil {
		writeJSONError(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, status)
}

// handleRestoreUpload streams the raw request body to the data volume.
func (a *App) handleRestoreUpload(w http.ResponseWriter, r *http.Request) {
	size := r.ContentLength
	if size <= 0 {
		writeJSONError(w, 411, "Upload the backup file as the request body")
		return
	}
	if size > maxRestoreUpload {
		writeJSONError(w, 413, "This file is too large for a full backup")
		return
	}
	// The upload, its decrypted copy and the extracted files share the volume.
	if err := a.checkFree(3*size + restoreSpareBytes); err != nil {
		writeJSON(w, 507, map[string]any{"error": err.Error(), "code": "NO_SPACE"})
		return
	}
	if !a.fullBackups.busy.TryLock() {
		writeJSONError(w, 409, "Another full backup or restore is running")
		return
	}
	defer a.fullBackups.busy.Unlock()
	dir := backup.RestoreDir(a.dataDir)
	if err := os.MkdirAll(dir, 0700); err != nil {
		writeJSONError(w, 500, err.Error())
		return
	}
	backup.CleanupRestoreUploads(a.dataDir)
	id, err := randomID()
	if err != nil {
		writeJSONError(w, 500, err.Error())
		return
	}
	path := filepath.Join(dir, "upload-"+id)
	out, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		writeJSONError(w, 500, err.Error())
		return
	}
	_ = http.NewResponseController(w).SetReadDeadline(time.Time{})
	n, copyErr := io.Copy(out, http.MaxBytesReader(w, r.Body, size))
	syncErr := out.Sync()
	closeErr := out.Close()
	if err = errors.Join(copyErr, syncErr, closeErr); err != nil || n != size {
		_ = os.Remove(path)
		if err == nil {
			err = io.ErrUnexpectedEOF
		}
		writeJSONError(w, 400, "Upload failed: "+err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"uploadId": id, "size": n})
}

func (a *App) handleRestoreVerify(w http.ResponseWriter, r *http.Request) {
	var body struct {
		UploadID   string `json:"uploadId"`
		Password   string `json:"password"`
		Passphrase string `json:"passphrase"`
	}
	if err := decodeBody(w, r, &body); err != nil || !fullBackupID.MatchString(body.UploadID) {
		writeJSONError(w, 400, "Invalid body")
		return
	}
	if err := a.verifyAdminPassword(r.Context(), body.Password); err != nil {
		writeJSON(w, 403, map[string]any{"error": "Wrong dashboard password", "code": "BAD_PASSWORD"})
		return
	}
	if !a.fullBackups.busy.TryLock() {
		writeJSONError(w, 409, "Another full backup or restore is running")
		return
	}
	defer a.fullBackups.busy.Unlock()
	upload := filepath.Join(backup.RestoreDir(a.dataDir), "upload-"+body.UploadID)
	if _, err := os.Stat(upload); err != nil {
		writeJSONError(w, 404, "The uploaded file is gone. Upload it again.")
		return
	}
	pending, err := backup.StageRestore(r.Context(), a.dataDir, upload, body.Passphrase, store.SchemaVersion())
	if err != nil {
		// A wrong password keeps the upload for another try.
		code := "RESTORE_REFUSED"
		switch {
		case errors.Is(err, backup.ErrWrongPassphrase):
			code = "WRONG_BACKUP_PASSWORD"
		case errors.Is(err, backup.ErrNotFullBackup):
			code = "NOT_A_BACKUP"
		case errors.Is(err, backup.ErrNewerBackup):
			code = "NEWER_BACKUP"
		}
		writeJSON(w, 400, map[string]any{"error": err.Error(), "code": code})
		return
	}
	_ = os.Remove(upload)
	status, err := a.restoreStatus()
	if err != nil {
		writeJSONError(w, 500, err.Error())
		return
	}
	status["verified"] = pending
	writeJSON(w, 200, status)
}

func (a *App) handleRestoreCancel(w http.ResponseWriter, r *http.Request) {
	if !a.fullBackups.busy.TryLock() {
		writeJSONError(w, 409, "Another full backup or restore is running")
		return
	}
	defer a.fullBackups.busy.Unlock()
	backup.CleanupRestoreUploads(a.dataDir)
	if err := backup.CancelRestore(a.dataDir); err != nil {
		writeJSONError(w, 409, err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}

func (a *App) handleRestoreRestart(w http.ResponseWriter, r *http.Request) {
	pending, err := backup.Pending(a.dataDir)
	if err != nil {
		writeJSONError(w, 500, err.Error())
		return
	}
	if pending == nil {
		writeJSONError(w, 409, "There is no verified backup waiting to be restored")
		return
	}
	if a.restart == nil {
		writeJSON(w, 409, map[string]any{"error": "This server cannot restart itself. Stop and start it to finish the restore.", "code": "NO_RESTART"})
		return
	}
	writeJSON(w, 202, map[string]any{"ok": true, "bootId": a.bootID})
	if f, ok := w.(http.Flusher); ok {
		f.Flush()
	}
	restart := a.restart
	time.AfterFunc(restoreRestartWait, restart)
}
