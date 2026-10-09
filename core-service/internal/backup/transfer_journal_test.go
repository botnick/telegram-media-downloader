package backup

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/botnick/telegram-media-downloader/core-service/internal/store"
)

func waitTransferJournal(t *testing.T, m *Manager, count int) {
	t.Helper()
	deadline := time.Now().Add(8 * time.Second)
	for time.Now().Before(deadline) {
		var n int
		err := m.opts.Reader.QueryRow(`SELECT count(*) FROM native_backup_transfers`).Scan(&n)
		if err == nil && n == count {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	rows, err := m.Cleanup(context.Background(), 20, 0)
	t.Fatalf("cleanup journal did not reach %d: %+v %v", count, rows, err)
}
func fixtureDestination(t *testing.T, m *Manager, kind string, cfg map[string]any, enabled bool) (int64, destination) {
	t.Helper()
	d, err := m.Create(context.Background(), map[string]any{"name": "journal fixture", "provider": kind, "config": cfg, "enabled": enabled})
	if err != nil {
		t.Fatal(err)
	}
	id := d["id"].(int64)
	row, err := m.load(context.Background(), id)
	if err != nil {
		t.Fatal(err)
	}
	return id, row
}

// The parent kills this process during a real transfer. No deferred cleanup or
// graceful-shutdown path runs; the next manager must recover from SQLite alone.
func TestBackupCrashProcess(t *testing.T) {
	dir := os.Getenv("TGDL_BACKUP_CRASH_DATA")
	if dir == "" {
		return
	}
	db, err := store.Open(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	m, err := NewManager(context.Background(), Options{Writer: db.Writer, Reader: db.Reader, DataDir: dir, Secret: func(context.Context) ([]byte, error) { return bytes.Repeat([]byte{0x11}, 32), nil }})
	if err != nil {
		t.Fatal(err)
	}
	id, _ := strconv.ParseInt(os.Getenv("TGDL_BACKUP_CRASH_DEST"), 10, 64)
	if err = m.Pause(context.Background(), id, false); err != nil {
		t.Fatal(err)
	}
	select {}
}
func startCrashHelper(t *testing.T, dir string, id int64) (*exec.Cmd, <-chan struct{}) {
	t.Helper()
	cmd := exec.Command(os.Args[0], "-test.run=^TestBackupCrashProcess$", "-test.timeout=30s")
	cmd.Env = append(os.Environ(), "TGDL_BACKUP_CRASH_DATA="+dir, "TGDL_BACKUP_CRASH_DEST="+strconv.FormatInt(id, 10))
	cmd.Stdout = io.Discard
	cmd.Stderr = io.Discard
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	go func() { _ = cmd.Wait(); close(done) }()
	t.Cleanup(func() { _ = cmd.Process.Kill(); <-done })
	return cmd, done
}

func TestS3ProcessKillRecoversMultipartOwnershipAndQueuedFile(t *testing.T) {
	f := newFixtureS3(t)
	m, db, dir := fixtureManager(t, nil)
	id, _ := fixtureDestination(t, m, "s3", f.config(), true)
	if err := m.Pause(context.Background(), id, true); err != nil {
		t.Fatal(err)
	}
	data := strings.Repeat("x", int(s3PartSize)*2+1)
	addSource(t, db, dir, "crash.bin", data, 71)
	m.Close()
	var block atomic.Bool
	block.Store(true)
	reached := make(chan struct{}, 1)
	f.setHook(func(w http.ResponseWriter, r *http.Request) bool {
		if block.Load() && r.Method == "PUT" && r.URL.Query().Get("partNumber") == "3" {
			_, _ = io.Copy(io.Discard, r.Body)
			reached <- struct{}{}
			<-r.Context().Done()
			return true
		}
		return false
	})
	cmd, done := startCrashHelper(t, dir, id)
	select {
	case <-reached:
	case <-done:
		t.Fatal("child exited before transfer")
	case <-time.After(12 * time.Second):
		t.Fatal("child did not reach multipart")
	}
	deadline := time.Now().Add(3 * time.Second)
	storedParts := false
	for time.Now().Before(deadline) {
		f.mu.Lock()
		for _, u := range f.uploads {
			storedParts = storedParts || len(u.parts) > 0
		}
		f.mu.Unlock()
		if storedParts {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !storedParts {
		t.Fatal("fixture never persisted a remote part")
	}
	var count int
	if err := db.Reader.QueryRow(`SELECT count(*) FROM native_backup_transfers WHERE state='active' AND upload_id<>''`).Scan(&count); err != nil || count != 1 {
		t.Fatal("bytes sent before durable ownership", err)
	}
	if err := cmd.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	<-done
	block.Store(false)
	next, err := NewManager(context.Background(), m.opts)
	if err != nil {
		t.Fatal(err)
	}
	defer next.Close()
	waitBackup(t, next, id, 1, 0)
	waitTransferJournal(t, next, 0)
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.aborts != 1 || len(f.uploads) != 0 || string(f.objects["library/ไทย/crash.bin"].data) != data {
		t.Fatalf("crash recovery: aborts=%d uploads=%d", f.aborts, len(f.uploads))
	}
}

func TestSFTPProcessKillRecoversTemporaryAndQueuedFile(t *testing.T) {
	f := newFixtureSFTP(t)
	m, db, dir := fixtureManager(t, nil)
	id, _ := fixtureDestination(t, m, "sftp", f.config(), true)
	if err := m.Pause(context.Background(), id, true); err != nil {
		t.Fatal(err)
	}
	data := strings.Repeat("y", 256<<10)
	addSource(t, db, dir, "crash.bin", data, 72)
	m.Close()
	f.writesBeforeStall.Store(1)
	f.stallWrite.Store(true)
	cmd, done := startCrashHelper(t, dir, id)
	select {
	case <-f.writeStarted:
	case <-done:
		t.Fatal("child exited before transfer")
	case <-time.After(12 * time.Second):
		t.Fatal("child did not reach SFTP")
	}
	var temp string
	if err := db.Reader.QueryRow(`SELECT remote_path FROM native_backup_transfers WHERE kind='sftp-temp' AND state='active'`).Scan(&temp); err != nil {
		t.Fatal("missing ownership before write", err)
	}
	deadline := time.Now().Add(3 * time.Second)
	partial := false
	for time.Now().Before(deadline) {
		if st, e := os.Stat(temp); e == nil && st.Size() > 0 {
			partial = true
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !partial {
		t.Fatal("fixture never persisted partial bytes")
	}
	if err := cmd.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	<-done
	next, err := NewManager(context.Background(), m.opts)
	if err != nil {
		t.Fatal(err)
	}
	defer next.Close()
	waitBackup(t, next, id, 1, 0)
	waitTransferJournal(t, next, 0)
	if _, err = os.Stat(temp); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("old temporary survived: %v", err)
	}
	b, err := os.ReadFile(filepath.Join(f.root, "backup", "crash.bin"))
	if err != nil || string(b) != data {
		t.Fatal("queued file not recovered", err)
	}
}

func TestCleanupRetainsOriginalDestinationAfterEditAndDelete(t *testing.T) {
	old := newFixtureSFTP(t)
	replacement := newFixtureSFTP(t)
	m, _, _ := fixtureManager(t, nil)
	ctx := context.Background()
	id, d := fixtureDestination(t, m, "sftp", old.config(), false)
	j := &transferJournal{m, id, d.Provider, d.Blob}
	name, _ := randomSFTPName(".tgdl-part-")
	temp := filepath.Join(old.root, "backup", name)
	if err := os.MkdirAll(filepath.Dir(temp), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(temp, []byte("owned"), 0600); err != nil {
		t.Fatal(err)
	}
	keep := filepath.Join(old.root, "backup", "user-file")
	if err := os.WriteFile(keep, []byte("keep"), 0600); err != nil {
		t.Fatal(err)
	}
	lease, err := j.track(ctx, "sftp-temp", filepath.ToSlash(temp), "")
	if err != nil {
		t.Fatal(err)
	}
	if err = lease.finish(false, errors.New("simulated interruption")); err != nil {
		t.Fatal(err)
	}
	if _, err = m.Update(ctx, id, map[string]any{"config": replacement.config()}); err != nil {
		t.Fatal(err)
	}
	if _, err = m.Remove(ctx, id); err != nil {
		t.Fatal(err)
	}
	rows, err := m.Cleanup(ctx, 20, 0)
	if err != nil || len(rows) != 1 {
		t.Fatalf("destination removal lost cleanup: %v %v", rows, err)
	}
	encoded, _ := json.Marshal(rows)
	if bytes.Contains(encoded, []byte("fixture-password")) || bytes.Contains(encoded, []byte("config_blob")) || bytes.Contains(encoded, []byte("upload_id")) {
		t.Fatal("cleanup view exposes credentials or upload identifiers")
	}
	if _, err = m.opts.Writer.Exec(`UPDATE native_backup_transfers SET next_retry_at=0`); err != nil {
		t.Fatal(err)
	}
	waitTransferJournal(t, m, 0)
	if _, err = os.Stat(temp); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("did not clean original server", err)
	}
	b, err := os.ReadFile(keep)
	if err != nil || string(b) != "keep" {
		t.Fatal("unrelated remote file changed", err)
	}
	if replacement.handshakes.Load() != 0 {
		t.Fatal("cleanup was redirected to new server")
	}
}

func TestS3CleanupRetriesWithoutDeletingOtherUploads(t *testing.T) {
	f := newFixtureS3(t)
	p := f.provider()
	m, _, _ := fixtureManager(t, nil)
	id, d := fixtureDestination(t, m, "s3", f.config(), false)
	ctx := context.Background()
	key := "library/ไทย/owned"
	own, err := p.client.CreateMultipartUpload(ctx, &s3.CreateMultipartUploadInput{Bucket: &p.bucket, Key: &key})
	if err != nil {
		t.Fatal(err)
	}
	foreign, err := p.client.CreateMultipartUpload(ctx, &s3.CreateMultipartUploadInput{Bucket: &p.bucket, Key: aws.String("library/ไทย/unrelated")})
	if err != nil {
		t.Fatal(err)
	}
	lease, err := (&transferJournal{m, id, d.Provider, d.Blob}).track(ctx, "s3-multipart", key, *own.UploadId)
	if err != nil {
		t.Fatal(err)
	}
	var deny atomic.Bool
	deny.Store(true)
	f.setHook(func(w http.ResponseWriter, r *http.Request) bool {
		if deny.Load() && r.Method == "DELETE" && r.URL.Query().Get("uploadId") == *own.UploadId {
			fixtureS3Error(w, 403, "AccessDenied")
			return true
		}
		return false
	})
	if err = lease.finish(false, errors.New("interrupted")); err != nil {
		t.Fatal(err)
	}
	if _, err = m.opts.Writer.Exec(`UPDATE native_backup_transfers SET next_retry_at=0`); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(4 * time.Second)
	observed := false
	for time.Now().Before(deadline) {
		rows, e := m.Cleanup(ctx, 20, 0)
		if e == nil && len(rows) == 1 && rows[0]["attempts"].(int) >= 2 && strings.Contains(rows[0]["error"].(string), "AccessDenied") {
			observed = true
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !observed {
		t.Fatal("failed cleanup was not persisted for retry")
	}
	deny.Store(false)
	if _, err = m.opts.Writer.Exec(`UPDATE native_backup_transfers SET next_retry_at=0`); err != nil {
		t.Fatal(err)
	}
	waitTransferJournal(t, m, 0)
	f.mu.Lock()
	defer f.mu.Unlock()
	if _, ok := f.uploads[*foreign.UploadId]; !ok || len(f.uploads) != 1 {
		t.Fatal("cleanup canceled an unrelated upload")
	}
}

func TestRemoteContentIsNotSentWhenOwnershipCannotBePersisted(t *testing.T) {
	for _, kind := range []string{"s3", "sftp"} {
		t.Run(kind, func(t *testing.T) {
			m, _, _ := fixtureManager(t, nil)
			var cfg map[string]any
			var s3server *fixtureS3
			var sshserver *fixtureSFTP
			if kind == "s3" {
				s3server = newFixtureS3(t)
				cfg = s3server.config()
			} else {
				sshserver = newFixtureSFTP(t)
				cfg = sshserver.config()
			}
			_, d := fixtureDestination(t, m, kind, cfg, false)
			p, err := m.provider(context.Background(), d, cfg)
			if err != nil {
				t.Fatal(err)
			}
			defer p.Close()
			_, err = m.opts.Writer.Exec(`CREATE TRIGGER reject_transfer_ownership BEFORE INSERT ON native_backup_transfers BEGIN SELECT RAISE(ABORT,'fixture ownership failure'); END;`)
			if err != nil {
				t.Fatal(err)
			}
			data := bytes.Repeat([]byte{1}, int(s3PartSize)+1)
			_, err = p.Upload(context.Background(), "file", bytes.NewReader(data), int64(len(data)), nil)
			if err == nil || !strings.Contains(err.Error(), "persist backup transfer ownership") {
				t.Fatalf("ownership failure ignored: %v", err)
			}
			if s3server != nil {
				s3server.mu.Lock()
				defer s3server.mu.Unlock()
				if len(s3server.uploads) != 0 || len(s3server.objects) != 0 || s3server.aborts != 1 {
					t.Fatal("S3 transferred without durable ownership")
				}
			}
			if sshserver != nil {
				entries, e := os.ReadDir(filepath.Join(sshserver.root, "backup"))
				if e != nil || len(entries) != 0 {
					t.Fatal("SFTP created data without durable ownership", e)
				}
			}
		})
	}
}

func TestS3CleanupRequiresVerificationAfterAcceptedAbort(t *testing.T) {
	for _, reason := range []string{"remaining parts", "verification denied"} {
		t.Run(reason, func(t *testing.T) {
			f := newFixtureS3(t)
			p := f.provider()
			m, _, _ := fixtureManager(t, nil)
			id, d := fixtureDestination(t, m, "s3", f.config(), false)
			ctx := context.Background()
			key := "library/ไทย/owned"
			created, err := p.client.CreateMultipartUpload(ctx, &s3.CreateMultipartUploadInput{Bucket: &p.bucket, Key: &key})
			if err != nil {
				t.Fatal(err)
			}
			f.mu.Lock()
			f.uploads[*created.UploadId].parts[1] = fixtureS3Object{data: []byte("late part"), etag: `"part"`}
			f.mu.Unlock()
			var release atomic.Bool
			f.setHook(func(w http.ResponseWriter, r *http.Request) bool {
				if release.Load() || r.URL.Query().Get("uploadId") != *created.UploadId {
					return false
				}
				if r.Method == "DELETE" {
					// Abort acknowledged while the service still retains a late part.
					w.WriteHeader(http.StatusNoContent)
					return true
				}
				if reason == "verification denied" && r.Method == "GET" {
					fixtureS3Error(w, 403, "AccessDenied")
					return true
				}
				return false
			})
			lease, err := (&transferJournal{m, id, d.Provider, d.Blob}).track(ctx, "s3-multipart", key, *created.UploadId)
			if err != nil {
				t.Fatal(err)
			}
			if err = lease.finish(false, errors.New("interrupted")); err != nil {
				t.Fatal(err)
			}
			if _, err = m.opts.Writer.Exec(`UPDATE native_backup_transfers SET next_retry_at=0`); err != nil {
				t.Fatal(err)
			}
			deadline := time.Now().Add(4 * time.Second)
			retained := false
			for time.Now().Before(deadline) {
				rows, e := m.Cleanup(ctx, 10, 0)
				if e == nil && len(rows) == 1 && rows[0]["state"] == "pending" && rows[0]["attempts"].(int) >= 2 {
					message := rows[0]["error"].(string)
					retained = strings.Contains(message, "parts remain") || strings.Contains(message, "ListParts")
					if retained {
						break
					}
				}
				time.Sleep(10 * time.Millisecond)
			}
			if !retained {
				t.Fatal("accepted abort discarded unverified cleanup ownership")
			}
			release.Store(true)
			if _, err = m.opts.Writer.Exec(`UPDATE native_backup_transfers SET next_retry_at=0`); err != nil {
				t.Fatal(err)
			}
			waitTransferJournal(t, m, 0)
			f.mu.Lock()
			defer f.mu.Unlock()
			if len(f.uploads) != 0 || f.aborts != 1 {
				t.Fatal("retained cleanup was not retried")
			}
		})
	}
}

func TestManagerCloseCancelsAndJoinsRemoteProbe(t *testing.T) {
	f := newFixtureSFTP(t)
	m, _, _ := fixtureManager(t, nil)
	id, _ := fixtureDestination(t, m, "sftp", f.config(), false)
	f.stallWrite.Store(true)
	probeDone := make(chan struct{})
	go func() { _, _, _ = m.Test(context.Background(), id); close(probeDone) }()
	select {
	case <-f.writeStarted:
	case <-time.After(4 * time.Second):
		t.Fatal("probe did not start")
	}
	closed := make(chan struct{})
	go func() { m.Close(); close(closed) }()
	select {
	case <-closed:
	case <-time.After(4 * time.Second):
		t.Fatal("manager shutdown did not cancel probe")
	}
	select {
	case <-probeDone:
	case <-time.After(time.Second):
		t.Fatal("manager shutdown did not join probe")
	}
}

func TestInvalidProviderCanBeReconfiguredWithoutCrashingWorker(t *testing.T) {
	for _, kind := range []string{"s3", "sftp"} {
		t.Run(kind, func(t *testing.T) {
			m, db, dir := fixtureManager(t, nil)
			var cfg map[string]any
			if kind == "s3" {
				cfg = newFixtureS3(t).config()
			} else {
				cfg = newFixtureSFTP(t).config()
			}
			id, _ := fixtureDestination(t, m, kind, map[string]any{}, true)
			addSource(t, db, dir, "file", "bytes", 81)
			deadline := time.Now().Add(3 * time.Second)
			failedInit := false
			for time.Now().Before(deadline) {
				d, err := m.load(context.Background(), id)
				if err == nil && d.Error.Valid {
					failedInit = true
					break
				}
				time.Sleep(10 * time.Millisecond)
			}
			if !failedInit {
				t.Fatal("invalid provider did not report initialization error")
			}
			if _, err := m.Update(context.Background(), id, map[string]any{"config": cfg}); err != nil {
				t.Fatal(err)
			}
			waitBackup(t, m, id, 1, 0)
		})
	}
}
