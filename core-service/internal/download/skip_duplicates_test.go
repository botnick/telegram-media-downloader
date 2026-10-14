package download

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"

	"github.com/botnick/telegram-media-downloader/core-service/internal/telegram"
)

func TestLibrarySkipDuplicatesMakesNoSecondEntry(t *testing.T) {
	dir := t.TempDir()
	library, db := openTestLibrary(t, dir)
	var calls atomic.Int64
	client := clientFunc(func(_ context.Context, _ telegram.MediaIdentity, w io.Writer) error {
		calls.Add(1)
		_, err := w.Write([]byte("same bytes"))
		return err
	})
	first, err := library.Ingest(context.Background(), Item{GroupID: "1", MessageID: 1, Name: "a.jpg", Type: "photo", Identity: telegram.MediaIdentity{Kind: "photo", ID: "7", Size: 10}, SkipDuplicates: true}, client)
	if err != nil || first.Skipped {
		t.Fatalf("first: %+v %v", first, err)
	}
	count := func() int {
		var n int
		if err := db.Reader.QueryRow(`SELECT count(*) FROM downloads`).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}

	// Same Telegram media forwarded to another chat: no download, no entry.
	fwd, err := library.Ingest(context.Background(), Item{GroupID: "2", MessageID: 9, Name: "a.jpg", Type: "photo", Identity: telegram.MediaIdentity{Kind: "photo", ID: "7", Size: 10}, SkipDuplicates: true}, client)
	if err != nil || !fwd.Skipped || fwd.ID != first.ID || calls.Load() != 1 || count() != 1 {
		t.Fatalf("forward: %+v %v calls=%d rows=%d", fwd, err, calls.Load(), count())
	}

	// Same bytes uploaded again as new Telegram media: downloaded once to
	// learn the hash, then dropped without an entry or a second file.
	again, err := library.Ingest(context.Background(), Item{GroupID: "1", MessageID: 2, Name: "b.jpg", Type: "photo", Identity: telegram.MediaIdentity{Kind: "photo", ID: "8", Size: 10}, SkipDuplicates: true}, client)
	if err != nil || !again.Skipped || again.ID != first.ID || count() != 1 {
		t.Fatalf("repost: %+v %v rows=%d", again, err, count())
	}
	files, _ := filepath.Glob(filepath.Join(dir, "downloads", "*", "*", "*"))
	if len(files) != 1 {
		t.Fatalf("files on disk: %v", files)
	}

	// The message that owns the entry is still re-ingested normally.
	own, err := library.Ingest(context.Background(), Item{GroupID: "1", MessageID: 1, Name: "a.jpg", Type: "photo", Identity: telegram.MediaIdentity{Kind: "photo", ID: "7", Size: 10}, SkipDuplicates: true}, client)
	if err != nil || own.Skipped || own.ID != first.ID {
		t.Fatalf("own message: %+v %v", own, err)
	}

	// Without the option every message keeps its own entry, as before.
	kept, err := library.Ingest(context.Background(), Item{GroupID: "3", MessageID: 4, Name: "a.jpg", Type: "photo", Identity: telegram.MediaIdentity{Kind: "photo", ID: "7", Size: 10}}, client)
	if err != nil || kept.Skipped || count() != 2 {
		t.Fatalf("option off: %+v %v rows=%d", kept, err, count())
	}

	// An entry whose file is gone is no reason to skip.
	if err := os.Remove(filepath.Join(dir, "downloads", filepath.FromSlash(first.Path))); err != nil {
		t.Fatal(err)
	}
	fresh, err := library.Ingest(context.Background(), Item{GroupID: "4", MessageID: 5, Name: "a.jpg", Type: "photo", Identity: telegram.MediaIdentity{Kind: "photo", ID: "7", Size: 10}, SkipDuplicates: true}, client)
	if err != nil || fresh.Skipped {
		t.Fatalf("missing file: %+v %v", fresh, err)
	}
}
