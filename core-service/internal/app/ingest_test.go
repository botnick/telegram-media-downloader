package app

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/botnick/telegram-media-downloader/core-service/internal/telegram"
	"github.com/gorilla/websocket"
	"github.com/gotd/td/tg"
)

type mediaTransport func(context.Context, telegram.Attachment, io.Writer) error

func (f mediaTransport) DownloadMedia(c context.Context, a telegram.Attachment, w io.Writer) error {
	return f(c, a, w)
}

func TestRawTelegramIngestionSharesFileServesRangeAndSurvivesRestart(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	a, err := newConfiguredTestApp(ctx, Config{DataDir: dir})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { a.Close() }()
	server := httptest.NewServer(a.Handler())
	defer server.Close()
	token, err := a.sessions.Create(ctx, "admin")
	if err != nil {
		t.Fatal(err)
	}
	headers := http.Header{"Cookie": []string{a.sessions.CookieName() + "=" + token}}
	ws, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http")+"/", headers)
	if err != nil {
		t.Fatal(err)
	}
	defer ws.Close()
	ws.SetReadDeadline(time.Now().Add(3 * time.Second))
	var calls atomic.Int64
	transport := mediaTransport(func(ctx context.Context, media telegram.Attachment, w io.Writer) error {
		calls.Add(1)
		if media.Identity.Kind != "document" || media.Identity.ID != "9007199254740993" {
			t.Fatalf("identity lost precision: %+v", media)
		}
		_, err := w.Write([]byte("fresh media"))
		return err
	})
	msg := &tg.Message{ID: 10, PeerID: &tg.PeerChannel{ChannelID: 123}, Media: &tg.MessageMediaDocument{Document: &tg.Document{ID: 9007199254740993, Size: 11, DCID: 2, AccessHash: 123, FileReference: []byte("private"), Attributes: []tg.DocumentAttributeClass{&tg.DocumentAttributeFilename{FileName: "test.mp4"}, &tg.DocumentAttributeVideo{}}}}}
	first, err := a.IngestTelegram(ctx, msg, "Thai", transport)
	if err != nil {
		t.Fatal(err)
	}
	var event map[string]any
	if err = ws.ReadJSON(&event); err != nil {
		t.Fatal(err)
	}
	payload, ok := event["payload"].(map[string]any)
	if !ok || event["type"] != "download_complete" || payload["mediaType"] != "video" || payload["key"] != "-1000000000123_10" {
		t.Fatalf("web event=%#v", event)
	}
	wire, _ := json.Marshal(event)
	if strings.Contains(string(wire), "private") || strings.Contains(string(wire), "AccessHash") {
		t.Fatal("event leaked Telegram file credentials")
	}
	msg.ID = 11
	msg.PeerID = &tg.PeerChannel{ChannelID: 456}
	second, err := a.IngestTelegram(ctx, msg, "Two", transport)
	if err != nil {
		t.Fatal(err)
	}
	if second.Path != first.Path || !second.Reused || calls.Load() != 1 {
		t.Fatalf("first=%+v second=%+v calls=%d", first, second, calls.Load())
	}
	// Exercise the authenticated HTTP range path used by the browser player.
	req, err := http.NewRequest("GET", server.URL+"/files/"+url.PathEscape(first.Path), nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header = headers.Clone()
	req.Header.Set("Range", "bytes=0-4")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	data, err := io.ReadAll(resp.Body)
	resp.Body.Close()
	if err != nil || resp.StatusCode != 206 || string(data) != "fresh" {
		t.Fatalf("range=%d %q error=%v", resp.StatusCode, data, err)
	}
	// Delete one catalog owner through the same mutation used by HTTP routes.
	deletion := httptest.NewRequest("DELETE", "/api/file", nil)
	if n, err := a.deleteRows(deletion, []int64{first.ID}, nil); err != nil || n != 1 {
		t.Fatalf("delete=%d error=%v", n, err)
	}
	if _, err = os.Stat(filepath.Join(dir, "downloads", first.Path)); err != nil {
		t.Fatal("shared media removed", err)
	}
	ws.Close()
	server.Close()
	a.Close()
	a, err = New(ctx, Config{DataDir: dir})
	if err != nil {
		t.Fatal(err)
	}
	msg.ID = 12
	third, err := a.IngestTelegram(ctx, msg, "Two", nil)
	if err != nil || !third.Reused || third.Path != first.Path {
		t.Fatalf("restart=%+v error=%v", third, err)
	}
	var owners int
	if err = a.db.Reader.QueryRow(`SELECT count(*) FROM downloads WHERE file_path=?`, first.Path).Scan(&owners); err != nil || owners != 2 {
		t.Fatalf("owners=%s error=%v", strconv.Itoa(owners), err)
	}
}
