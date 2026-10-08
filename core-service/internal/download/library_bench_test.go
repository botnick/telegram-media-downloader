package download

import (
	"bytes"
	"context"
	"fmt"
	"path/filepath"
	"testing"

	"github.com/botnick/telegram-media-downloader/core-service/internal/store"
	"github.com/botnick/telegram-media-downloader/core-service/internal/telegram"
)

func BenchmarkLibraryForwardedMedia(b *testing.B) {
	for _, owners := range []int{1, 1000} {
		b.Run(fmt.Sprintf("owners=%d", owners), func(b *testing.B) {
			ctx := context.Background()
			dir := b.TempDir()
			db, err := store.Open(ctx, dir)
			if err != nil {
				b.Fatal(err)
			}
			defer db.Reader.Close()
			defer db.Writer.Close()
			library, err := NewLibrary(db.Writer, db.Reader, filepath.Join(dir, "downloads"), 4)
			if err != nil {
				b.Fatal(err)
			}
			item := Item{GroupID: "1", MessageID: 1, Name: "media.bin", Type: "document", Identity: telegram.MediaIdentity{Kind: "document", ID: "123", Size: 1 << 20}}
			first, err := library.Ingest(ctx, item, fakeClient{data: bytes.Repeat([]byte{1}, 1<<20)})
			if err != nil {
				b.Fatal(err)
			}
			tx, err := db.Writer.Begin()
			if err != nil {
				b.Fatal(err)
			}
			for i := 2; i <= owners; i++ {
				if _, err = tx.Exec(`INSERT INTO downloads(group_id,message_id,file_path,file_size,file_hash,telegram_media_kind,telegram_media_id,telegram_media_size) VALUES('1',?,?,?,?, 'document','123',?)`, i, first.Path, item.Identity.Size, first.SHA256, item.Identity.Size); err != nil {
					b.Fatal(err)
				}
			}
			if err = tx.Commit(); err != nil {
				b.Fatal(err)
			}
			item.MessageID = int64(owners + 1)
			b.ReportAllocs()
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				if r, err := library.Ingest(ctx, item, nil); err != nil || !r.Reused {
					b.Fatalf("record=%+v error=%v", r, err)
				}
			}
		})
	}
}
