package download

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"testing"

	"github.com/botnick/telegram-media-downloader/core-service/internal/telegram"
)

type fakeClient struct {
	data []byte
	err  error
}

func (f fakeClient) Download(_ context.Context, _ telegram.MediaIdentity, w io.Writer) error {
	if f.err != nil {
		return f.err
	}
	_, err := w.Write(f.data)
	return err
}

func TestManagerReservesIdentityAndAtomicallyPublishes(t *testing.T) {
	root := t.TempDir()
	m := NewManager(fakeClient{data: []byte("telegram")}, telegram.NewDedupIndex())
	identity := telegram.MediaIdentity{Kind: "document", ID: "55", Size: 8}
	path, err := m.Download(context.Background(), identity, filepath.Join(root, "group", "file.bin"))
	if err != nil {
		t.Fatal(err)
	}
	if path == "" {
		t.Fatal("expected final path")
	}
	data, err := os.ReadFile(path)
	if err != nil || string(data) != "telegram" {
		t.Fatalf("downloaded data = %q err=%v", data, err)
	}
	if _, err := m.Download(context.Background(), identity, filepath.Join(root, "group", "other.bin")); !errors.Is(err, ErrDuplicate) {
		t.Fatalf("duplicate error = %v", err)
	}
}

func TestManagerReleasesIdentityOnFailure(t *testing.T) {
	root := t.TempDir()
	m := NewManager(fakeClient{err: errors.New("network")}, telegram.NewDedupIndex())
	identity := telegram.MediaIdentity{Kind: "photo", ID: "9", Size: 2}
	if _, err := m.Download(context.Background(), identity, filepath.Join(root, "a")); err == nil {
		t.Fatal("expected download failure")
	}
	if m.Index.Has(identity) {
		t.Fatal("failed download kept dedup reservation")
	}
}
