package backup

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/botnick/telegram-media-downloader/core-service/internal/store"
)

const testPass = "correct horse battery"

type fullFixture struct {
	dir string
	db  *store.DB
}

func newFullFixture(t *testing.T) *fullFixture {
	t.Helper()
	dir := t.TempDir()
	db, err := store.Open(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	f := &fullFixture{dir: dir, db: db}
	t.Cleanup(f.close)
	f.setKV(t, "marker", "original")
	f.write(t, "secret.key", "original-secret")
	f.write(t, "config.json", `{"legacy":true}`)
	f.write(t, "sessions/native/alice.enc", "alice-session")
	f.write(t, "downloads/chat/video.mp4", "media bytes")
	return f
}
func (f *fullFixture) close() {
	if f.db != nil {
		f.db.Reader.Close()
		f.db.Writer.Close()
		f.db = nil
	}
}
func (f *fullFixture) write(t *testing.T, name, content string) {
	t.Helper()
	p := filepath.Join(f.dir, name)
	if err := os.MkdirAll(filepath.Dir(p), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(content), 0600); err != nil {
		t.Fatal(err)
	}
}
func (f *fullFixture) read(t *testing.T, name string) string {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(f.dir, name))
	if err != nil {
		t.Fatalf("read %s: %v", name, err)
	}
	return string(raw)
}
func (f *fullFixture) setKV(t *testing.T, key, value string) {
	t.Helper()
	if _, err := f.db.Writer.Exec(`INSERT INTO kv(key,value,updated_at) VALUES(?,?,0) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, key, value); err != nil {
		t.Fatal(err)
	}
}
func (f *fullFixture) build(t *testing.T, schema int) string {
	t.Helper()
	path, m, err := BuildFullBackup(context.Background(), filepath.Join(f.dir, "backups"), FullBackupOptions{DB: f.db.Writer, DataDir: f.dir, AppVersion: "9.9.9", SchemaVersion: schema, Passphrase: testPass})
	if err != nil {
		t.Fatal(err)
	}
	if len(m.Files) != 4 {
		t.Fatalf("manifest files: %+v", m.Files)
	}
	return path
}

func TestFullBackupRestoresStateAtNextStartAndKeepsPrevious(t *testing.T) {
	f := newFullFixture(t)
	file := f.build(t, store.SchemaVersion())
	raw, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.HasPrefix(raw, []byte("TGDLFULL\x01")) || bytes.Contains(raw, []byte("alice-session")) || bytes.Contains(raw, []byte("original-secret")) {
		t.Fatal("full backup is not an encrypted TGDLFULL file")
	}
	if bytes.Contains(raw, []byte("media bytes")) {
		t.Fatal("media was included")
	}
	if _, err = StageRestore(context.Background(), f.dir, file, "wrong password", store.SchemaVersion()); err == nil || !errors.Is(err, ErrWrongPassphrase) {
		t.Fatalf("wrong password: %v", err)
	}
	if p, _ := Pending(f.dir); p != nil {
		t.Fatal("failed verification left a pending restore")
	}
	pending, err := StageRestore(context.Background(), f.dir, file, testPass, store.SchemaVersion())
	if err != nil {
		t.Fatal(err)
	}
	if pending.Manifest.AppVersion != "9.9.9" || pending.Files != 4 {
		t.Fatalf("pending: %+v", pending)
	}
	// Live state changes after the backup; the media folder is not state.
	f.setKV(t, "marker", "changed")
	f.write(t, "secret.key", "new-secret")
	if err = os.Remove(filepath.Join(f.dir, "sessions/native/alice.enc")); err != nil {
		t.Fatal(err)
	}
	f.write(t, "downloads/chat/new.mp4", "new media")
	f.close()

	var logs []string
	ApplyPendingRestore(f.dir, func(format string, args ...any) { logs = append(logs, format) })
	if f.read(t, "secret.key") != "original-secret" || f.read(t, "sessions/native/alice.enc") != "alice-session" || f.read(t, "config.json") != `{"legacy":true}` {
		t.Fatal("state files were not restored")
	}
	if f.read(t, "downloads/chat/new.mp4") != "new media" || f.read(t, "downloads/chat/video.mp4") != "media bytes" {
		t.Fatal("media was touched")
	}
	out, err := LastRestore(f.dir)
	if err != nil || out == nil || !out.OK || out.Manifest == nil {
		t.Fatalf("outcome: %+v %v (logs %v)", out, err, logs)
	}
	prev := filepath.Join(RestoreDir(f.dir), out.Previous)
	if raw, _ := os.ReadFile(filepath.Join(prev, "secret.key")); string(raw) != "new-secret" {
		t.Fatal("previous state not kept")
	}
	if p, _ := Pending(f.dir); p != nil || exists(filepath.Join(RestoreDir(f.dir), applyStateName)) {
		t.Fatal("restore leftovers remain")
	}
	db, err := store.Open(context.Background(), f.dir)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { db.Reader.Close(); db.Writer.Close() }()
	var marker string
	if err = db.Reader.QueryRow(`SELECT value FROM kv WHERE key='marker'`).Scan(&marker); err != nil || marker != "original" {
		t.Fatalf("restored database: %q %v", marker, err)
	}
	// A second start has nothing to do.
	ApplyPendingRestore(f.dir, nil)
	if again, _ := LastRestore(f.dir); again.At != out.At {
		t.Fatal("second start applied again")
	}
}

func TestFullBackupRefusesNewerSchemaDamageAndOtherFiles(t *testing.T) {
	f := newFullFixture(t)
	newer := f.build(t, store.SchemaVersion()+1)
	if _, err := StageRestore(context.Background(), f.dir, newer, testPass, store.SchemaVersion()); err == nil || !errors.Is(err, ErrNewerBackup) {
		t.Fatalf("newer schema: %v", err)
	}
	file := f.build(t, store.SchemaVersion())
	raw, _ := os.ReadFile(file)
	raw[len(raw)/2] ^= 0xff
	damaged := filepath.Join(f.dir, "damaged.tgdl-backup")
	if err := os.WriteFile(damaged, raw, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := StageRestore(context.Background(), f.dir, damaged, testPass, store.SchemaVersion()); err == nil || !strings.Contains(err.Error(), "damaged") {
		t.Fatalf("damaged: %v", err)
	}
	other := filepath.Join(f.dir, "photo.jpg")
	_ = os.WriteFile(other, []byte("\xff\xd8 not a backup at all"), 0600)
	if _, err := StageRestore(context.Background(), f.dir, other, testPass, store.SchemaVersion()); err == nil || !errors.Is(err, ErrNotFullBackup) {
		t.Fatalf("other file: %v", err)
	}
	if _, _, err := BuildFullBackup(context.Background(), f.dir, FullBackupOptions{DB: f.db.Writer, DataDir: f.dir, SchemaVersion: 1, Passphrase: "short"}); err == nil {
		t.Fatal("short password accepted")
	}
	if p, _ := Pending(f.dir); p != nil {
		t.Fatal("refused backups left a pending restore")
	}
	if leftovers, _ := filepath.Glob(filepath.Join(RestoreDir(f.dir), ".*")); len(leftovers) != 0 {
		t.Fatalf("verification leftovers: %v", leftovers)
	}
}

func TestCheckManifestCatchesChangedAndExtraFiles(t *testing.T) {
	dir := t.TempDir()
	write := func(name, content string) {
		_ = os.MkdirAll(filepath.Dir(filepath.Join(dir, name)), 0700)
		_ = os.WriteFile(filepath.Join(dir, name), []byte(content), 0600)
	}
	write("db.sqlite", "db")
	m := Manifest{Format: manifestFormat, Version: 1, SchemaVersion: 1, Files: []ManifestFile{{Name: "db.sqlite", Size: 2, SHA256: "6e9ddd1a1b5a7b2fd3cf5d7aa6e3b6f6c6d1d36cbd9d7a3e5c0ed1b3b1c1d7a6"}}}
	raw, _ := json.Marshal(m)
	write(manifestName, string(raw))
	root, err := os.OpenRoot(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	if _, err = checkManifest(root, 1); err == nil || !strings.Contains(err.Error(), "checksum") {
		t.Fatalf("changed file: %v", err)
	}
	m.Files[0].SHA256 = "7bdc25d1694ef984782a16f6f1710c1c6bc83ba7a131b515baf532bea021d011" // sha256("db")
	raw, _ = json.Marshal(m)
	write(manifestName, string(raw))
	if _, err = checkManifest(root, 1); err != nil {
		t.Fatalf("valid manifest: %v", err)
	}
	write("sessions/extra.enc", "x")
	if _, err = checkManifest(root, 1); err == nil || !strings.Contains(err.Error(), "does not list") {
		t.Fatalf("extra file: %v", err)
	}
}

// stagedFixture returns a data dir with a verified pending restore and the
// live state changed afterwards, its database closed as at startup.
func stagedFixture(t *testing.T) *fullFixture {
	t.Helper()
	f := newFullFixture(t)
	file := f.build(t, store.SchemaVersion())
	if _, err := StageRestore(context.Background(), f.dir, file, testPass, store.SchemaVersion()); err != nil {
		t.Fatal(err)
	}
	f.write(t, "secret.key", "new-secret")
	f.close()
	return f
}

func TestApplyResumesAfterCrashMidStash(t *testing.T) {
	f := stagedFixture(t)
	dir := RestoreDir(f.dir)
	st := applyState{Phase: "stash", Previous: "previous-crash"}
	if err := os.MkdirAll(filepath.Join(dir, st.Previous), 0700); err != nil {
		t.Fatal(err)
	}
	// Power was lost after the database moved aside.
	if err := os.Rename(filepath.Join(f.dir, "db.sqlite"), filepath.Join(dir, st.Previous, "db.sqlite")); err != nil {
		t.Fatal(err)
	}
	if err := writeJSONAtomic(filepath.Join(dir, applyStateName), st); err != nil {
		t.Fatal(err)
	}
	ApplyPendingRestore(f.dir, nil)
	out, _ := LastRestore(f.dir)
	if out == nil || !out.OK || out.Previous != "previous-crash" || f.read(t, "secret.key") != "original-secret" {
		t.Fatalf("resume: %+v", out)
	}
	if raw, _ := os.ReadFile(filepath.Join(dir, "previous-crash", "secret.key")); string(raw) != "new-secret" {
		t.Fatal("previous state incomplete after resume")
	}
}

func TestApplyFailureRollsBackAndBootsPreviousState(t *testing.T) {
	f := stagedFixture(t)
	dir := RestoreDir(f.dir)
	st := applyState{Phase: "install", Previous: "previous-x"}
	prev := filepath.Join(dir, st.Previous)
	if err := os.MkdirAll(prev, 0700); err != nil {
		t.Fatal(err)
	}
	if err := moveItems(f.dir, prev); err != nil {
		t.Fatal(err)
	}
	// Something re-created a state file between the steps: installing must
	// refuse to overwrite it and put the previous state back.
	if err := os.Rename(filepath.Join(dir, pendingDirName, "db.sqlite"), filepath.Join(f.dir, "db.sqlite")); err != nil {
		t.Fatal(err)
	}
	f.write(t, "restore/pending/db.sqlite", "conflict")
	if err := writeJSONAtomic(filepath.Join(dir, applyStateName), st); err != nil {
		t.Fatal(err)
	}
	ApplyPendingRestore(f.dir, nil)
	out, _ := LastRestore(f.dir)
	if out == nil || out.OK || out.Error == "" {
		t.Fatalf("expected a recorded failure: %+v", out)
	}
	if f.read(t, "secret.key") != "new-secret" || exists(prev) || exists(filepath.Join(dir, applyStateName)) {
		t.Fatal("previous state was not put back")
	}
	if p, _ := Pending(f.dir); p != nil {
		t.Fatal("a failed restore stays pending and would loop")
	}
	db, err := store.Open(context.Background(), f.dir)
	if err != nil {
		t.Fatalf("app cannot start after rollback: %v", err)
	}
	db.Reader.Close()
	db.Writer.Close()
}

func TestApplyRollbackRemovesInstalledItemsTheCurrentDataLacked(t *testing.T) {
	f := stagedFixture(t)
	dir := RestoreDir(f.dir)
	pendingDir := filepath.Join(dir, pendingDirName)
	if !exists(filepath.Join(pendingDir, "config.json")) {
		t.Fatal("fixture backup should hold config.json")
	}
	// The current data has no config.json, the backup does.
	if err := os.Remove(filepath.Join(f.dir, "config.json")); err != nil {
		t.Fatal(err)
	}
	st := applyState{Phase: "install", Previous: "previous-y"}
	prev := filepath.Join(dir, st.Previous)
	if err := os.MkdirAll(prev, 0700); err != nil {
		t.Fatal(err)
	}
	if err := moveItems(f.dir, prev); err != nil {
		t.Fatal(err)
	}
	// Power was lost after config.json was installed; then a stray db.sqlite
	// appeared, so resuming the install fails.
	if err := os.Rename(filepath.Join(pendingDir, "config.json"), filepath.Join(f.dir, "config.json")); err != nil {
		t.Fatal(err)
	}
	f.write(t, "db.sqlite", "stray")
	if err := writeJSONAtomic(filepath.Join(dir, applyStateName), st); err != nil {
		t.Fatal(err)
	}
	ApplyPendingRestore(f.dir, nil)
	if out, _ := LastRestore(f.dir); out == nil || out.OK {
		t.Fatalf("expected a recorded failure: %+v", out)
	}
	if exists(filepath.Join(f.dir, "config.json")) {
		t.Fatal("config.json from the backup was left behind after the rollback")
	}
	if f.read(t, "secret.key") != "new-secret" || exists(prev) {
		t.Fatal("previous state was not put back")
	}
	db, err := store.Open(context.Background(), f.dir)
	if err != nil {
		t.Fatalf("app cannot start after rollback: %v", err)
	}
	db.Reader.Close()
	db.Writer.Close()
}

func TestApplyWithoutPendingDoesNothing(t *testing.T) {
	dir := t.TempDir()
	ApplyPendingRestore(dir, nil)
	if exists(RestoreDir(dir)) {
		t.Fatal("startup without a restore created files")
	}
}
