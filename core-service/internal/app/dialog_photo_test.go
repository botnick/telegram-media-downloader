package app

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/botnick/telegram-media-downloader/core-service/internal/engine"
	"github.com/botnick/telegram-media-downloader/core-service/internal/telegram"
	"github.com/gotd/td/tg"
)

type photoDialogAccount struct {
	fixtureAccount
	dialogs []telegram.Dialog
	lists   atomic.Int64
	photo   func(context.Context, telegram.Dialog, io.Writer) (bool, error)
}

func (a *photoDialogAccount) Dialogs(_ context.Context, _ int, archived bool) ([]telegram.Dialog, error) {
	a.lists.Add(1)
	if archived {
		return nil, nil
	}
	return a.dialogs, nil
}

func (a *photoDialogAccount) DownloadDialogPhoto(ctx context.Context, d telegram.Dialog, w io.Writer) (bool, error) {
	return a.photo(ctx, d, w)
}

func photoDialogApp(t *testing.T, dialogs []telegram.Dialog, photo func(context.Context, telegram.Dialog, io.Writer) (bool, error)) (*App, *photoDialogAccount, string) {
	t.Helper()
	account := &photoDialogAccount{dialogs: dialogs, photo: photo}
	a, err := newConfiguredTestApp(context.Background(), Config{DataDir: t.TempDir(), AccountFactory: func(_ engine.AccountConfig, _ *telegram.UpdateState, handler func(context.Context, tg.UpdatesClass) error, _ func(int64)) (engine.Account, error) {
		account.handle = handler
		return account, nil
	}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { a.Close() })
	configureMonitor(t, a)
	token, err := a.sessions.Create(context.Background(), "admin")
	if err != nil {
		t.Fatal(err)
	}
	if rec := photoDialogRequest(a, context.Background(), token, "/api/dialogs"); rec.Code != http.StatusOK {
		t.Fatalf("browse=%d %s", rec.Code, rec.Body.String())
	}
	return a, account, token
}

func photoDialogRequest(a *App, ctx context.Context, token, path string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodGet, path, nil).WithContext(ctx)
	if token != "" {
		req.AddCookie(&http.Cookie{Name: a.sessions.CookieName(), Value: token})
	}
	rec := httptest.NewRecorder()
	a.Handler().ServeHTTP(rec, req)
	return rec
}

func TestDialogPhotoHTTPFetchesLazilyWithoutMonitorAndCaches(t *testing.T) {
	photo := profileJPEG(t)
	var calls atomic.Int64
	a, account, token := photoDialogApp(t, []telegram.Dialog{{ID: "-1000000000042", Name: "Chat", Type: "channel"}}, func(_ context.Context, d telegram.Dialog, w io.Writer) (bool, error) {
		calls.Add(1)
		if d.ID != "-1000000000042" {
			return false, errors.New("wrong dialog")
		}
		_, err := w.Write(photo)
		return true, err
	})
	if calls.Load() != 0 {
		t.Fatal("listing downloaded invisible photos")
	}
	for range 2 {
		rec := photoDialogRequest(a, context.Background(), token, "/api/groups/-1000000000042/photo")
		if rec.Code != http.StatusOK || !bytes.Equal(rec.Body.Bytes(), photo) {
			t.Fatalf("photo=%d %q", rec.Code, rec.Body.String())
		}
		if rec.Header().Get("Cache-Control") == "" || rec.Header().Get("Vary") != "Cookie" {
			t.Fatal("photo lost private cache headers")
		}
	}
	if calls.Load() != 1 || account.lists.Load() != 2 {
		t.Fatalf("photo calls=%d dialog enumerations=%d", calls.Load(), account.lists.Load())
	}
	status, err := a.monitor.Status(context.Background())
	if err != nil || status["state"] != "stopped" {
		t.Fatalf("monitor changed: %v %v", status, err)
	}
	data, err := os.ReadFile(filepath.Join(a.dataDir, "photos", "-1000000000042.jpg"))
	if err != nil || !bytes.Equal(data, photo) {
		t.Fatalf("cache not published: %v", err)
	}
}

func TestDialogPhotoHTTPDoesNotFetchForGuestsOrUnknownChats(t *testing.T) {
	var calls atomic.Int64
	a, _, token := photoDialogApp(t, []telegram.Dialog{{ID: "42", Type: "user"}}, func(context.Context, telegram.Dialog, io.Writer) (bool, error) {
		calls.Add(1)
		return false, nil
	})
	guest, err := a.sessions.Create(context.Background(), "guest")
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct{ token, id string }{{guest, "42"}, {"", "42"}, {token, "999"}, {token, "unknown:42"}} {
		rec := photoDialogRequest(a, context.Background(), tc.token, "/api/groups/"+tc.id+"/photo")
		if rec.Code == http.StatusOK {
			t.Fatalf("unexpected photo for %s", tc.id)
		}
	}
	if calls.Load() != 0 {
		t.Fatalf("unauthorized or unknown photo downloads=%d", calls.Load())
	}
}

func TestDialogPhotoHTTPCoalescesConcurrentRequests(t *testing.T) {
	photo := profileJPEG(t)
	entered, release := make(chan struct{}), make(chan struct{})
	var calls atomic.Int64
	a, _, token := photoDialogApp(t, []telegram.Dialog{{ID: "42", Type: "user"}}, func(ctx context.Context, _ telegram.Dialog, w io.Writer) (bool, error) {
		if calls.Add(1) == 1 {
			close(entered)
		}
		select {
		case <-release:
		case <-ctx.Done():
			return false, ctx.Err()
		}
		_, err := w.Write(photo)
		return true, err
	})
	var wg sync.WaitGroup
	results := make(chan *httptest.ResponseRecorder, 8)
	for range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			results <- photoDialogRequest(a, context.Background(), token, "/api/groups/42/photo")
		}()
	}
	select {
	case <-entered:
	case <-time.After(2 * time.Second):
		close(release)
		wg.Wait()
		t.Fatal("missing lazy photo fetch")
	}
	close(release)
	wg.Wait()
	close(results)
	for rec := range results {
		if rec.Code != http.StatusOK || !bytes.Equal(rec.Body.Bytes(), photo) {
			t.Fatalf("photo=%d", rec.Code)
		}
	}
	if calls.Load() != 1 {
		t.Fatalf("same photo fetched %d times", calls.Load())
	}
}

func TestDialogPhotoHTTPDoesNotPublishInterruptedTransfers(t *testing.T) {
	photo := profileJPEG(t)
	for _, mode := range []string{"request", "purge", "account"} {
		t.Run(mode, func(t *testing.T) {
			entered, release := make(chan struct{}), make(chan struct{})
			a, _, token := photoDialogApp(t, []telegram.Dialog{{ID: "42", Type: "user"}}, func(_ context.Context, _ telegram.Dialog, w io.Writer) (bool, error) {
				close(entered)
				<-release // Simulate a transport that returns just as cancellation wins.
				_, err := w.Write(photo)
				return true, err
			})
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			done := make(chan *httptest.ResponseRecorder, 1)
			go func() { done <- photoDialogRequest(a, ctx, token, "/api/groups/42/photo") }()
			select {
			case <-entered:
			case <-time.After(2 * time.Second):
				close(release)
				t.Fatal("photo fetch did not start")
			}
			switch mode {
			case "request":
				cancel()
			case "purge":
				a.purgeMu.Lock()
				a.purgeEpoch++
				a.purgeMu.Unlock()
			case "account":
				if err := a.monitor.Stop(context.Background()); err != nil {
					t.Fatal(err)
				}
			}
			close(release)
			select {
			case rec := <-done:
				if rec.Code == http.StatusOK {
					t.Fatal("interrupted transfer was served")
				}
			case <-time.After(2 * time.Second):
				t.Fatal("interrupted request did not finish")
			}
			if _, err := os.Stat(filepath.Join(a.dataDir, "photos", "42.jpg")); !os.IsNotExist(err) {
				t.Fatalf("interrupted transfer left a cache file: %v", err)
			}
		})
	}
}

func TestDialogPhotoHTTPRejectsMalformedAndPartialImages(t *testing.T) {
	photo := profileJPEG(t)
	for _, mode := range []string{"partial", "invalid", "oversized", "absent"} {
		t.Run(mode, func(t *testing.T) {
			a, _, token := photoDialogApp(t, []telegram.Dialog{{ID: "42", Type: "user"}}, func(_ context.Context, _ telegram.Dialog, w io.Writer) (bool, error) {
				switch mode {
				case "partial":
					_, _ = w.Write(photo[:len(photo)/2])
					return true, errors.New("network interrupted")
				case "invalid":
					_, err := w.Write([]byte("not an image"))
					return true, err
				case "oversized":
					_, err := w.Write(make([]byte, (2<<20)+1))
					return true, err
				default:
					return false, nil
				}
			})
			if rec := photoDialogRequest(a, context.Background(), token, "/api/groups/42/photo"); rec.Code != http.StatusNotFound {
				t.Fatalf("invalid photo=%d", rec.Code)
			}
			if entries, err := os.ReadDir(filepath.Join(a.dataDir, "photos")); err == nil && len(entries) > 0 {
				t.Fatalf("invalid photo left files: %v", entries)
			}
		})
	}
}

func TestDialogPhotoHTTPBoundsDownloadsAndCancelsQueue(t *testing.T) {
	entered := make(chan struct{}, 8)
	var active, peak atomic.Int64
	dialogs := make([]telegram.Dialog, 8)
	for i := range dialogs {
		dialogs[i] = telegram.Dialog{ID: fmt.Sprint(i + 1), Type: "user"}
	}
	a, _, token := photoDialogApp(t, dialogs, func(ctx context.Context, _ telegram.Dialog, _ io.Writer) (bool, error) {
		n := active.Add(1)
		defer active.Add(-1)
		for previous := peak.Load(); previous < n && !peak.CompareAndSwap(previous, n); previous = peak.Load() {
		}
		entered <- struct{}{}
		<-ctx.Done()
		return false, ctx.Err()
	})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var wg sync.WaitGroup
	for _, dialog := range dialogs {
		wg.Add(1)
		go func(id string) { defer wg.Done(); photoDialogRequest(a, ctx, token, "/api/groups/"+id+"/photo") }(dialog.ID)
	}
	for range 4 {
		select {
		case <-entered:
		case <-time.After(2 * time.Second):
			cancel()
			wg.Wait()
			t.Fatal("bounded photo downloads did not start")
		}
	}
	select {
	case <-entered:
		cancel()
		wg.Wait()
		t.Fatal("more than four simultaneous photo downloads")
	case <-time.After(50 * time.Millisecond):
	}
	cancel()
	wg.Wait()
	if peak.Load() > 4 || active.Load() != 0 {
		t.Fatalf("peak=%d remaining=%d", peak.Load(), active.Load())
	}
}

func TestDialogPhotoHTTPShutdownCancelsTransport(t *testing.T) {
	entered := make(chan struct{})
	a, _, token := photoDialogApp(t, []telegram.Dialog{{ID: "42", Type: "user"}}, func(ctx context.Context, _ telegram.Dialog, _ io.Writer) (bool, error) {
		close(entered)
		<-ctx.Done()
		return false, ctx.Err()
	})
	done := make(chan *httptest.ResponseRecorder, 1)
	go func() { done <- photoDialogRequest(a, context.Background(), token, "/api/groups/42/photo") }()
	select {
	case <-entered:
	case <-time.After(2 * time.Second):
		t.Fatal("photo fetch did not start")
	}
	closed := make(chan error, 1)
	go func() { closed <- a.Close() }()
	select {
	case err := <-closed:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("shutdown did not drain photo downloads")
	}
	select {
	case rec := <-done:
		if rec.Code == http.StatusOK {
			t.Fatal("shutdown published photo")
		}
	case <-time.After(time.Second):
		t.Fatal("photo handler outlived shutdown")
	}
}
