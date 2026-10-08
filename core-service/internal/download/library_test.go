package download

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/botnick/telegram-media-downloader/core-service/internal/store"
	"github.com/botnick/telegram-media-downloader/core-service/internal/telegram"
)

func openTestLibrary(t *testing.T, dir string) (*Library, *store.DB) {
	t.Helper()
	db, err := store.Open(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	library, err := NewLibrary(db.Writer, db.Reader, filepath.Join(dir, "downloads"), 4)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Reader.Close(); db.Writer.Close() })
	return library, db
}

func TestLibraryPersistsLiveIdentityAcrossRestart(t *testing.T) {
	dir := t.TempDir()
	library, db := openTestLibrary(t, dir)
	var calls atomic.Int64
	client := clientFunc(func(_ context.Context, _ telegram.MediaIdentity, w io.Writer) error {
		calls.Add(1)
		_, err := w.Write([]byte("media bytes"))
		return err
	})
	item := Item{GroupID: "1", GroupName: "One", MessageID: 1, Name: "photo.jpg", Type: "photo", Identity: telegram.MediaIdentity{Kind: "photo", ID: "999", Size: 11}}
	first, err := library.Ingest(context.Background(), item, client)
	if err != nil {
		t.Fatal(err)
	}
	if first.Reused {
		t.Fatal("new media marked reused")
	}
	if err := db.Reader.Close(); err != nil {
		t.Fatal(err)
	}
	if err := db.Writer.Close(); err != nil {
		t.Fatal(err)
	}
	library, db = openTestLibrary(t, dir)
	item.GroupID = "2"
	item.MessageID = 50
	second, err := library.Ingest(context.Background(), item, client)
	if err != nil {
		t.Fatal(err)
	}
	if !second.Reused || second.Path != first.Path || calls.Load() != 1 {
		t.Fatalf("restart downloaded duplicate: first=%+v second=%+v calls=%d", first, second, calls.Load())
	}
	var records, paths int
	if err := db.Reader.QueryRow(`SELECT count(*),count(DISTINCT file_path) FROM downloads`).Scan(&records, &paths); err != nil || records != 2 || paths != 1 {
		t.Fatalf("catalog refs=%d paths=%d error=%v", records, paths, err)
	}
}

func TestLibraryCoalescesConcurrentMessagesAndRejectsMissingCandidate(t *testing.T) {
	dir := t.TempDir()
	library, db := openTestLibrary(t, dir)
	var calls atomic.Int64
	client := clientFunc(func(_ context.Context, _ telegram.MediaIdentity, w io.Writer) error {
		calls.Add(1)
		_, err := w.Write([]byte("same"))
		return err
	})
	var wg sync.WaitGroup
	errors := make(chan error, 12)
	for i := 1; i <= 12; i++ {
		wg.Add(1)
		go func(id int) {
			defer wg.Done()
			_, err := library.Ingest(context.Background(), Item{GroupID: "1", GroupName: "One", MessageID: int64(id), Name: "same.bin", Type: "document", Identity: telegram.MediaIdentity{Kind: "document", ID: "123", Size: 4}}, client)
			errors <- err
		}(i)
	}
	wg.Wait()
	close(errors)
	for err := range errors {
		if err != nil {
			t.Fatal(err)
		}
	}
	if calls.Load() != 1 {
		t.Fatalf("network calls=%d", calls.Load())
	}
	var path string
	if err := db.Reader.QueryRow(`SELECT file_path FROM downloads LIMIT 1`).Scan(&path); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(dir, "downloads", path)); err != nil {
		t.Fatal(err)
	}
	_, err := library.Ingest(context.Background(), Item{GroupID: "2", MessageID: 1, Name: "same.bin", Type: "document", Identity: telegram.MediaIdentity{Kind: "document", ID: "123", Size: 4}}, client)
	if err != nil || calls.Load() != 2 {
		t.Fatalf("missing file incorrectly reused: calls=%d err=%v", calls.Load(), err)
	}
}

func TestLibraryHashesDuringDownloadAndMergesDistinctTelegramIDs(t *testing.T) {
	library, db := openTestLibrary(t, t.TempDir())
	client := fakeClient{data: []byte("identical content")}
	one := Item{GroupID: "1", MessageID: 1, Name: "one.bin", Type: "document", Identity: telegram.MediaIdentity{Kind: "document", ID: "1", Size: 17}}
	first, err := library.Ingest(context.Background(), one, client)
	if err != nil {
		t.Fatal(err)
	}
	one.MessageID = 2
	one.Identity.ID = "2"
	one.Name = "two.bin"
	second, err := library.Ingest(context.Background(), one, client)
	if err != nil {
		t.Fatal(err)
	}
	if !second.Reused || second.Path != first.Path {
		t.Fatalf("identical bytes retained twice: %+v %+v", first, second)
	}
	var hash string
	if err := db.Reader.QueryRow(`SELECT file_hash FROM downloads WHERE message_id=2`).Scan(&hash); err != nil || len(hash) != 64 {
		t.Fatalf("ingest hash=%q err=%v", hash, err)
	}
}

func TestLibraryRejectsSameSizeReplacedFileEvenWithPreservedMtime(t *testing.T) {
	dir := t.TempDir()
	library, _ := openTestLibrary(t, dir)
	item := Item{GroupID: "1", MessageID: 1, Name: "x.bin", Type: "document", Identity: telegram.MediaIdentity{Kind: "document", ID: "123", Size: 4}}
	first, err := library.Ingest(context.Background(), item, fakeClient{data: []byte("good")})
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "downloads", first.Path)
	before, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(path, []byte("evil"), 0600); err != nil {
		t.Fatal(err)
	}
	if err = os.Chtimes(path, before.ModTime(), before.ModTime()); err != nil {
		t.Fatal(err)
	}
	item.MessageID = 2
	second, err := library.Ingest(context.Background(), item, fakeClient{data: []byte("good")})
	if err != nil {
		t.Fatal(err)
	}
	if second.Reused || second.Path == first.Path {
		t.Fatalf("reused corrupt file: %+v", second)
	}
}

func TestLibraryMediaEditInvalidatesDerivedData(t *testing.T) {
	library, db := openTestLibrary(t, t.TempDir())
	item := Item{GroupID: "1", MessageID: 1, Name: "x.bin", Type: "document", Identity: telegram.MediaIdentity{Kind: "document", ID: "123", Size: 4}}
	first, err := library.Ingest(context.Background(), item, fakeClient{data: []byte("good")})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.Writer.Exec(`UPDATE downloads SET pinned=1,nsfw_score=0.9,nsfw_checked_at=1,nsfw_whitelist=1,ai_indexed_at=1 WHERE id=?`, first.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Writer.Exec(`INSERT INTO image_tags(download_id,tag,score) VALUES(?,'old',1)`, first.ID); err != nil {
		t.Fatal(err)
	}
	item.Identity.ID = "456"
	second, err := library.Ingest(context.Background(), item, fakeClient{data: []byte("edit")})
	if err != nil {
		t.Fatal(err)
	}
	var stale, pin int
	if err = db.Reader.QueryRow(`SELECT (SELECT count(*) FROM image_tags WHERE download_id=d.id)+(nsfw_score IS NOT NULL)+(nsfw_checked_at IS NOT NULL)+(ai_indexed_at IS NOT NULL)+nsfw_whitelist,pinned FROM downloads d WHERE id=?`, second.ID).Scan(&stale, &pin); err != nil {
		t.Fatal(err)
	}
	if stale != 0 || pin != 1 || second.ID != first.ID {
		t.Fatalf("stale=%d pin=%d IDs=%d/%d", stale, pin, first.ID, second.ID)
	}
}

func TestLibraryRecoversPublicationAfterCatalogCommitFailure(t *testing.T) {
	dir := t.TempDir()
	library, db := openTestLibrary(t, dir)
	// Inject a database failure after bytes are published but before registration.
	if _, err := db.Writer.Exec(`CREATE TRIGGER reject_ingest BEFORE INSERT ON downloads BEGIN SELECT RAISE(FAIL,'injected catalog failure'); END`); err != nil {
		t.Fatal(err)
	}
	item := Item{GroupID: "1", MessageID: 1, Name: "x.bin", Type: "document", Identity: telegram.MediaIdentity{Kind: "document", ID: "123", Size: 4}}
	if _, err := library.Ingest(context.Background(), item, fakeClient{data: []byte("good")}); err == nil {
		t.Fatal("expected catalog failure")
	}
	if _, err := db.Writer.Exec(`DROP TRIGGER reject_ingest`); err != nil {
		t.Fatal(err)
	}
	db.Reader.Close()
	db.Writer.Close()
	library, db = openTestLibrary(t, dir)
	if err := library.Recover(context.Background()); err != nil {
		t.Fatal(err)
	}
	record, err := library.Ingest(context.Background(), item, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !record.Reused {
		t.Fatal("did not recover completed download")
	}
	var pending int
	if err := db.Reader.QueryRow(`SELECT count(*) FROM tgdl_ingest_files`).Scan(&pending); err != nil || pending != 0 {
		t.Fatalf("pending=%d err=%v", pending, err)
	}
}

func TestLibrarySerializesMediaEditsForSameMessage(t *testing.T) {
	library, db := openTestLibrary(t, t.TempDir())
	started, release := make(chan struct{}), make(chan struct{})
	oldDone := make(chan error, 1)
	newDone := make(chan error, 1)
	item := Item{GroupID: "1", MessageID: 1, Name: "x.bin", Type: "document", Identity: telegram.MediaIdentity{Kind: "document", ID: "123", Size: 4}}
	go func() {
		_, err := library.Ingest(context.Background(), item, clientFunc(func(_ context.Context, _ telegram.MediaIdentity, w io.Writer) error {
			close(started)
			<-release
			_, err := w.Write([]byte("old!"))
			return err
		}))
		oldDone <- err
	}()
	<-started
	newer := item
	newer.Identity.ID = "456"
	go func() {
		_, err := library.Ingest(context.Background(), newer, fakeClient{data: []byte("new!")})
		newDone <- err
	}()
	// The older accepted message must commit before its edit, never after it.
	select {
	case err := <-newDone:
		t.Fatalf("edit overtook prior in-flight message: %v", err)
	case <-time.After(30 * time.Millisecond):
	}
	close(release)
	if err := <-oldDone; err != nil {
		t.Fatal(err)
	}
	if err := <-newDone; err != nil {
		t.Fatal(err)
	}
	var id string
	if err := db.Reader.QueryRow(`SELECT telegram_media_id FROM downloads WHERE message_id=1`).Scan(&id); err != nil || id != "456" {
		t.Fatalf("stored identity=%s error=%v", id, err)
	}
}

func TestLibraryRejectsMutationWhileWaitingForContent(t *testing.T) {
	dir := t.TempDir()
	library, db := openTestLibrary(t, dir)
	digest := sha256.Sum256([]byte("good"))
	release, err := library.enter(context.Background(), "sha256:"+hex.EncodeToString(digest[:]))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { release() }()
	item := Item{GroupID: "1", MessageID: 1, Name: "x.bin", Type: "document", Identity: telegram.MediaIdentity{Kind: "document", ID: "123", Size: 4}}
	done := make(chan error, 1)
	go func() {
		_, err := library.Ingest(context.Background(), item, fakeClient{data: []byte("good")})
		done <- err
	}()
	var path string
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		db.Reader.QueryRow(`SELECT path FROM tgdl_ingest_files WHERE sha256<>''`).Scan(&path)
		if path != "" {
			if _, err := os.Stat(filepath.Join(dir, "downloads", path)); err == nil {
				break
			}
		}
		time.Sleep(time.Millisecond)
	}
	if path == "" {
		t.Fatal("transfer not published")
	}
	// Give the worker a chance to reach its blocked content flight, with a
	// receipt already captured. A changed file must never inherit its old hash.
	time.Sleep(20 * time.Millisecond)
	full := filepath.Join(dir, "downloads", path)
	info, err := os.Stat(full)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(full, []byte("evil"), 0600); err != nil {
		t.Fatal(err)
	}
	if err = os.Chtimes(full, info.ModTime(), info.ModTime()); err != nil {
		t.Fatal(err)
	}
	release()
	release = func() {}
	if err := <-done; !errors.Is(err, errCandidateChanged) {
		t.Fatalf("changed file accepted: %v", err)
	}
	var count int
	if err = db.Reader.QueryRow(`SELECT count(*) FROM downloads`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("rows=%d error=%v", count, err)
	}
}

func TestLibraryKeepsVerifiedHashForLegacyUnhashedOwners(t *testing.T) {
	dir := t.TempDir()
	library, db := openTestLibrary(t, dir)
	if err := os.WriteFile(filepath.Join(dir, "downloads/legacy.bin"), []byte("good"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Writer.Exec(`INSERT INTO downloads(group_id,message_id,file_path,file_size,telegram_media_kind,telegram_media_id,telegram_media_size) VALUES('1',1,'legacy.bin',4,'document','123',4)`); err != nil {
		t.Fatal(err)
	}
	item := Item{GroupID: "1", MessageID: 2, Identity: telegram.MediaIdentity{Kind: "document", ID: "123", Size: 4}}
	if _, err := library.Ingest(context.Background(), item, nil); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "downloads/legacy.bin")
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(path, []byte("evil"), 0600); err != nil {
		t.Fatal(err)
	}
	if err = os.Chtimes(path, info.ModTime(), info.ModTime()); err != nil {
		t.Fatal(err)
	}
	item.MessageID = 3
	if record, err := library.Ingest(context.Background(), item, nil); err == nil {
		t.Fatalf("accepted changed legacy file %+v", record)
	}
}

func TestLibraryReuseWorksWithOneReadConnection(t *testing.T) {
	library, db := openTestLibrary(t, t.TempDir())
	db.Reader.SetMaxOpenConns(1)
	item := Item{GroupID: "1", MessageID: 1, Identity: telegram.MediaIdentity{Kind: "document", ID: "123", Size: 4}}
	if _, err := library.Ingest(context.Background(), item, fakeClient{data: []byte("good")}); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	item.MessageID = 2
	if _, err := library.Ingest(ctx, item, nil); err != nil {
		t.Fatal(err)
	}
}

func TestLibraryEditRemovesDerivedFiles(t *testing.T) {
	for _, linked := range []bool{false, true} {
		t.Run(fmt.Sprintf("symlink=%v", linked), func(t *testing.T) {
			dir := t.TempDir()
			if linked {
				if err := os.Symlink(t.TempDir(), filepath.Join(dir, "downloads")); err != nil {
					t.Skipf("symlink unavailable: %v", err)
				}
			}
			library, db := openTestLibrary(t, dir)
			item := Item{GroupID: "1", MessageID: 1, Identity: telegram.MediaIdentity{Kind: "document", ID: "123", Size: 4}}
			first, err := library.Ingest(context.Background(), item, fakeClient{data: []byte("good")})
			if err != nil {
				t.Fatal(err)
			}
			sum := sha256.Sum256([]byte(strconv.FormatInt(first.ID, 10) + ":320"))
			thumb := filepath.Join(dir, "thumbs", hex.EncodeToString(sum[:])[:32]+".webp")
			sprite := filepath.Join(dir, "seekbar", "old.webp")
			meta := filepath.Join(dir, "seekbar", "old.json")
			for _, name := range []string{thumb, sprite, meta} {
				if err := os.MkdirAll(filepath.Dir(name), 0700); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(name, []byte("old"), 0600); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := db.Writer.Exec(`INSERT INTO seekbar_sprites(download_id,sprite_path,meta_path,generated_at) VALUES(?,?,?,1)`, first.ID, sprite, meta); err != nil {
				t.Fatal(err)
			}
			item.Identity.ID = "456"
			if _, err := library.Ingest(context.Background(), item, fakeClient{data: []byte("edit")}); err != nil {
				t.Fatal(err)
			}
			for _, name := range []string{thumb, sprite, meta} {
				if _, err := os.Stat(name); !os.IsNotExist(err) {
					t.Fatalf("stale artifact %s: %v", name, err)
				}
			}
		})
	}
}

func TestLibraryRecoveryCannotRevertNewerMessage(t *testing.T) {
	dir := t.TempDir()
	library, db := openTestLibrary(t, dir)
	if _, err := db.Writer.Exec(`CREATE TRIGGER reject_ingest BEFORE INSERT ON downloads BEGIN SELECT RAISE(FAIL,'injected');END`); err != nil {
		t.Fatal(err)
	}
	item := Item{GroupID: "1", MessageID: 1, Identity: telegram.MediaIdentity{Kind: "document", ID: "123", Size: 4}}
	if _, err := library.Ingest(context.Background(), item, fakeClient{data: []byte("old!")}); err == nil {
		t.Fatal("missing injection")
	}
	if _, err := db.Writer.Exec(`DROP TRIGGER reject_ingest`); err != nil {
		t.Fatal(err)
	}
	item.Identity.ID = "456"
	latest, err := library.Ingest(context.Background(), item, fakeClient{data: []byte("new!")})
	if err != nil {
		t.Fatal(err)
	}
	if err := library.Recover(context.Background()); err != nil {
		t.Fatal(err)
	}
	var id, path string
	if err := db.Reader.QueryRow(`SELECT telegram_media_id,file_path FROM downloads`).Scan(&id, &path); err != nil || id != "456" || path != latest.Path {
		t.Fatalf("id=%s path=%s error=%v", id, path, err)
	}
}

func TestLibraryRecoveryRejectsMutationWhileWaitingForWriter(t *testing.T) {
	dir := t.TempDir()
	library, db := openTestLibrary(t, dir)
	if _, err := db.Writer.Exec(`CREATE TRIGGER reject_ingest BEFORE INSERT ON downloads BEGIN SELECT RAISE(FAIL,'injected');END`); err != nil {
		t.Fatal(err)
	}
	item := Item{GroupID: "1", MessageID: 1, Identity: telegram.MediaIdentity{Kind: "document", ID: "123", Size: 4}}
	if _, err := library.Ingest(context.Background(), item, fakeClient{data: []byte("good")}); err == nil {
		t.Fatal("missing injection")
	}
	if _, err := db.Writer.Exec(`DROP TRIGGER reject_ingest`); err != nil {
		t.Fatal(err)
	}
	var path string
	if err := db.Reader.QueryRow(`SELECT path FROM tgdl_ingest_files`).Scan(&path); err != nil {
		t.Fatal(err)
	}
	full := filepath.Join(dir, "downloads", path)
	info, err := os.Stat(full)
	if err != nil {
		t.Fatal(err)
	}
	tx, err := db.Writer.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	waitCount := db.Writer.Stats().WaitCount
	done := make(chan error, 1)
	go func() { done <- library.Recover(context.Background()) }()
	deadline := time.Now().Add(3 * time.Second)
	for db.Writer.Stats().WaitCount == waitCount && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if db.Writer.Stats().WaitCount == waitCount {
		t.Fatal("recovery did not wait for writer")
	}
	if err = os.WriteFile(full, []byte("evil"), 0600); err != nil {
		t.Fatal(err)
	}
	if err = os.Chtimes(full, info.ModTime(), info.ModTime()); err != nil {
		t.Fatal(err)
	}
	tx.Rollback()
	if err := <-done; !errors.Is(err, errCandidateChanged) {
		t.Fatalf("recovered mutated file: %v", err)
	}
}
