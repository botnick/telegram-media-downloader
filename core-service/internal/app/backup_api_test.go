package app

import (
	"context"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/botnick/telegram-media-downloader/core-service/internal/telegram"
	"github.com/gotd/td/tg"
)

func TestNativeBackupHTTPAndLiveTelegramIngestion(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	a, err := newConfiguredTestApp(ctx, Config{DataDir: dir})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	admin, err := a.sessions.Create(ctx, "admin")
	if err != nil {
		t.Fatal(err)
	}
	guest, err := a.sessions.Create(ctx, "guest")
	if err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(dir, "mirror")
	body, _ := json.Marshal(map[string]any{"name": "live mirror", "provider": "local", "config": map[string]any{"rootPath": root}})
	for _, method := range []string{"GET", "POST"} {
		r := requestPurge(a, guest, method, "/api/backup/destinations", string(body))
		if r.Code != 403 {
			t.Fatalf("guest %s status %d", method, r.Code)
		}
	}
	r := requestPurge(a, admin, "POST", "/api/backup/destinations", string(body))
	if r.Code != 200 {
		t.Fatalf("create %d %s", r.Code, r.Body.String())
	}
	data := "live Telegram fixture bytes"
	msg := &tg.Message{ID: 10, PeerID: &tg.PeerChannel{ChannelID: 123}, Media: &tg.MessageMediaDocument{Document: &tg.Document{ID: 456, DCID: 2, AccessHash: 789, FileReference: []byte("test-only"), Size: int64(len(data)), MimeType: "video/mp4", Attributes: []tg.DocumentAttributeClass{&tg.DocumentAttributeFilename{FileName: "video.mp4"}}}}}
	record, err := a.IngestTelegram(ctx, msg, "Fixture", mediaTransport(func(ctx context.Context, attachment telegram.Attachment, out io.Writer) error {
		_, err := io.Copy(out, strings.NewReader(data))
		return err
	}))
	if err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		raw, err := os.ReadFile(filepath.Join(root, record.Path))
		if err == nil && string(raw) == data {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("download did not automatically mirror: %v", err)
		}
		time.Sleep(10 * time.Millisecond)
	}
	r = requestPurge(a, admin, "GET", "/api/backup/destinations/1/jobs", "")
	if r.Code != 200 || !strings.Contains(r.Body.String(), `"download_id":`) {
		t.Fatalf("jobs %d %s", r.Code, r.Body.String())
	}
	if r = requestPurge(a, admin, "POST", "/api/backup/destinations/1/pause", ""); r.Code != 200 {
		t.Fatal(r.Body.String())
	}
	a.Close()
	next, err := New(ctx, Config{DataDir: dir})
	if err != nil {
		t.Fatal(err)
	}
	defer next.Close()
	r = requestPurge(next, admin, "GET", "/api/backup/destinations/1/status", "")
	if r.Code != 200 || !strings.Contains(r.Body.String(), `"paused":true`) {
		t.Fatalf("restart lost pause %d %s", r.Code, r.Body.String())
	}
}
