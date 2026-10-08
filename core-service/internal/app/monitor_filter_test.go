package app

import (
	"context"
	"io"
	"sync/atomic"
	"testing"

	"github.com/botnick/telegram-media-downloader/core-service/internal/engine"
	"github.com/botnick/telegram-media-downloader/core-service/internal/telegram"
	"github.com/gotd/td/tg"
)

func TestSelfOwnedGroupIsAccepted(t *testing.T) {
	ctx := context.Background()
	a, err := newConfiguredTestApp(ctx, Config{DataDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	self := "11111111-1111-4111-8111-111111111111"
	if _, err = a.db.Writer.ExecContext(ctx, `INSERT OR REPLACE INTO kv(key,value,updated_at) VALUES('peer_id',?,0)`, `"`+self+`"`); err != nil {
		t.Fatal(err)
	}
	cfg, err := a.config.Load(ctx)
	if err != nil {
		t.Fatal(err)
	}
	cfg["groups"] = []any{map[string]any{"id": "-1000000000042", "name": "self-owned", "enabled": true, "ownerPeerId": self}}
	if err = a.config.Save(ctx, cfg); err != nil {
		t.Fatal(err)
	}
	u := updateFixture()
	m := u.Updates[0].(*tg.UpdateNewChannelMessage).Message.(*tg.Message)
	_, allowed, err := a.monitorFilter(ctx, "one", m, u)
	if err != nil {
		t.Fatal(err)
	}
	if !allowed {
		t.Fatal("explicitly self-owned group was silently rejected")
	}
}

func TestMonitorUsesPublicMediaFilterSwitches(t *testing.T) {
	ctx := context.Background()
	a, err := newConfiguredTestApp(ctx, Config{DataDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	for _, tc := range []struct {
		name    string
		mime    string
		attrs   []tg.DocumentAttributeClass
		filters map[string]any
		allowed bool
	}{
		{name: "disabled files", mime: "application/pdf", filters: map[string]any{"files": false}},
		{name: "enabled files", mime: "application/pdf", filters: map[string]any{"files": true}, allowed: true},
		{name: "voice off music on", mime: "audio/ogg", attrs: []tg.DocumentAttributeClass{&tg.DocumentAttributeAudio{Voice: true}}, filters: map[string]any{"voice": false, "audio": true}},
		{name: "voice on music off", mime: "audio/ogg", attrs: []tg.DocumentAttributeClass{&tg.DocumentAttributeAudio{Voice: true}}, filters: map[string]any{"voice": true, "audio": false}, allowed: true},
		{name: "music independent of voice", mime: "audio/mpeg", filters: map[string]any{"voice": false, "audio": true}, allowed: true},
		{name: "disabled music", mime: "audio/mpeg", filters: map[string]any{"voice": true, "audio": false}},
		{name: "photo sent as document", mime: "image/png", filters: map[string]any{"photos": false, "files": true}},
		{name: "gif independent of photos", mime: "image/gif", filters: map[string]any{"photos": false, "gifs": true}, allowed: true},
		{name: "sticker opt in", mime: "video/webm", attrs: []tg.DocumentAttributeClass{&tg.DocumentAttributeSticker{}}, filters: map[string]any{"videos": true}},
		{name: "enabled sticker", mime: "video/webm", attrs: []tg.DocumentAttributeClass{&tg.DocumentAttributeSticker{}}, filters: map[string]any{"videos": false, "stickers": true}, allowed: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			cfg, err := a.config.Load(ctx)
			if err != nil {
				t.Fatal(err)
			}
			cfg["groups"] = []any{map[string]any{"id": "-1000000000042", "name": "Filters", "enabled": true, "filters": tc.filters}}
			if err = a.config.Save(ctx, cfg); err != nil {
				t.Fatal(err)
			}
			message := &tg.Message{ID: 12, PeerID: &tg.PeerChannel{ChannelID: 42}, Media: &tg.MessageMediaDocument{Document: &tg.Document{ID: 123, DCID: 2, Size: 4, MimeType: tc.mime, Attributes: tc.attrs}}}
			_, allowed, err := a.monitorFilter(ctx, "one", message, &tg.Updates{})
			if err != nil || allowed != tc.allowed {
				t.Fatalf("allowed=%t want=%t error=%v", allowed, tc.allowed, err)
			}
		})
	}
}

func TestMonitorRejectsDisabledMediaBeforeQueueAndTransfer(t *testing.T) {
	ctx := context.Background()
	var account *fixtureAccount
	var transfers atomic.Int64
	factory := func(_ engine.AccountConfig, _ *telegram.UpdateState, handle func(context.Context, tg.UpdatesClass) error, _ func(int64)) (engine.Account, error) {
		account = &fixtureAccount{handle: handle, download: func(_ context.Context, _ telegram.Attachment, w io.Writer) error {
			transfers.Add(1)
			_, err := w.Write([]byte("live"))
			return err
		}}
		return account, nil
	}
	a, err := newConfiguredTestApp(ctx, Config{DataDir: t.TempDir(), AccountFactory: factory})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	configureMonitor(t, a)
	cfg, err := a.config.Load(ctx)
	if err != nil {
		t.Fatal(err)
	}
	cfg["groups"].([]any)[0].(map[string]any)["filters"] = map[string]any{"files": false, "voice": false, "photos": false, "audio": true}
	if err = a.config.Save(ctx, cfg); err != nil {
		t.Fatal(err)
	}
	if response := monitorRequest(t, a, "/api/monitor/start"); response.Code != 200 {
		t.Fatal(response.Body.String())
	}
	for i, mime := range []string{"application/pdf", "audio/ogg", "image/png", "audio/mpeg"} {
		u := updateFixture()
		message := u.Updates[0].(*tg.UpdateNewChannelMessage).Message.(*tg.Message)
		message.ID += i
		doc := message.Media.(*tg.MessageMediaDocument).Document.(*tg.Document)
		doc.ID += int64(i)
		doc.MimeType = mime
		if i == 1 {
			doc.Attributes = append(doc.Attributes, &tg.DocumentAttributeAudio{Voice: true})
		}
		if err := account.handle(ctx, u); err != nil {
			t.Fatal(err)
		}
	}
	waitCompleted(t, a)
	var work, downloaded, messageID int
	if err := a.db.Reader.QueryRow(`SELECT count(*) FROM tgdl_work`).Scan(&work); err != nil {
		t.Fatal(err)
	}
	if err := a.db.Reader.QueryRow(`SELECT count(*),message_id FROM downloads`).Scan(&downloaded, &messageID); err != nil {
		t.Fatal(err)
	}
	if work != 1 || downloaded != 1 || messageID != 13 || transfers.Load() != 1 {
		t.Fatalf("work=%d catalog=%d message=%d transfers=%d", work, downloaded, messageID, transfers.Load())
	}
}
