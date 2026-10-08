package download

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"sync/atomic"
	"testing"

	"github.com/botnick/telegram-media-downloader/core-service/internal/telegram"
)

type fakeClient struct {
	data []byte
	err  error
}

type clientFunc func(context.Context, telegram.MediaIdentity, io.Writer) error

func (f clientFunc) Download(ctx context.Context, id telegram.MediaIdentity, w io.Writer) error {
	return f(ctx, id, w)
}

func TestReservedDownloadCanOnlyBeClaimedOnce(t *testing.T) {
	id := telegram.MediaIdentity{Kind: "document", ID: "44", Size: 1}
	index := telegram.NewDedupIndex()
	index.Reserve(id)
	entered := make(chan struct{}, 2)
	release := make(chan struct{})
	var calls atomic.Int64
	m := NewManager(clientFunc(func(ctx context.Context, id telegram.MediaIdentity, w io.Writer) error {
		calls.Add(1)
		entered <- struct{}{}
		<-release
		_, err := w.Write([]byte("x"))
		return err
	}), index)
	dir := t.TempDir()
	results := make(chan error, 2)
	go func() {
		_, err := m.DownloadReserved(context.Background(), id, filepath.Join(dir, "one"))
		results <- err
	}()
	<-entered
	go func() {
		_, err := m.DownloadReserved(context.Background(), id, filepath.Join(dir, "two"))
		results <- err
	}()
	// The second worker must return before the first network request completes.
	finished := 0
	select {
	case err := <-results:
		finished++
		if !errors.Is(err, ErrDuplicate) {
			t.Errorf("second claim=%v", err)
		}
	case <-entered:
		t.Error("second worker reached network for the same reservation")
	}
	close(release)
	for i := finished; i < 2; i++ {
		if err := <-results; err != nil {
			t.Error(err)
		}
	}
	if calls.Load() != 1 {
		t.Fatalf("network requests=%d", calls.Load())
	}
}

func TestPublicationNeverOverwritesFileCreatedDuringDownload(t *testing.T) {
	file := filepath.Join(t.TempDir(), "same.bin")
	m := NewManager(clientFunc(func(ctx context.Context, id telegram.MediaIdentity, w io.Writer) error {
		if err := os.WriteFile(file, []byte("original"), 0600); err != nil {
			return err
		}
		_, err := w.Write([]byte("new"))
		return err
	}), telegram.NewDedupIndex())
	_, err := m.Download(context.Background(), telegram.MediaIdentity{Kind: "document", ID: "9", Size: 3}, file)
	if !errors.Is(err, ErrDuplicate) {
		t.Errorf("collision error=%v", err)
	}
	got, readErr := os.ReadFile(file)
	if readErr != nil || string(got) != "original" {
		t.Fatalf("existing media overwritten: %q %v", got, readErr)
	}
}

func TestWrongSizeAndCancellationCannotPublish(t *testing.T) {
	for _, tc := range []struct {
		name   string
		data   string
		cancel bool
	}{{"short", "a", false}, {"long", "toolong", false}, {"cancel", "four", true}} {
		t.Run(tc.name, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			m := NewManager(clientFunc(func(ctx context.Context, id telegram.MediaIdentity, w io.Writer) error {
				_, err := w.Write([]byte(tc.data))
				if tc.cancel {
					cancel()
				}
				return err
			}), telegram.NewDedupIndex())
			id := telegram.MediaIdentity{Kind: "document", ID: "10", Size: 4}
			dir := t.TempDir()
			if _, err := m.Download(ctx, id, filepath.Join(dir, "media.bin")); err == nil {
				t.Error("invalid download published")
			}
			if m.Index.Has(id) {
				t.Error("failed identity cannot be retried")
			}
			files, err := os.ReadDir(dir)
			if err != nil || len(files) != 0 {
				t.Fatalf("file residue=%d %v", len(files), err)
			}
		})
	}
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

func TestRootedDownloadCannotBeRedirectedDuringTransfer(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows does not allow this ancestor rename with open handles")
	}
	base := t.TempDir()
	outside := t.TempDir()
	dir := filepath.Join(base, "group")
	if err := os.Mkdir(dir, 0700); err != nil {
		t.Fatal(err)
	}
	root, err := os.OpenRoot(base)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	m := NewManager(clientFunc(func(_ context.Context, _ telegram.MediaIdentity, w io.Writer) error {
		if err := os.Rename(dir, filepath.Join(base, "moved")); err != nil {
			return err
		}
		if err := os.Symlink(outside, dir); err != nil {
			return err
		}
		_, err := w.Write([]byte("test"))
		return err
	}), nil)
	_, err = m.DownloadInRoot(context.Background(), telegram.MediaIdentity{Kind: "document", ID: "1", Size: 4}, root, "group/test.bin")
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(base, "moved/test.bin"))
	if err != nil || string(data) != "test" {
		t.Fatalf("data=%s error=%v", data, err)
	}
	files, err := os.ReadDir(outside)
	if err != nil || len(files) != 0 {
		t.Fatalf("outside changed: %v error=%v", files, err)
	}
}
