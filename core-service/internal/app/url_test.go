package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/botnick/telegram-media-downloader/core-service/internal/engine"
	"github.com/botnick/telegram-media-downloader/core-service/internal/telegram"
	"github.com/gotd/td/tg"
)

type urlTestAccount struct {
	recoveryTestAccount
	read func(context.Context, telegram.Dialog, int) (*telegram.RefreshedMessage, error)
}

func (a *urlTestAccount) ResolveDialog(_ context.Context, ref string) (telegram.Dialog, error) {
	if ref != "@channel" && ref != "-1000000000042" {
		return telegram.Dialog{}, errors.New("unknown fixture chat")
	}
	return telegram.Dialog{ID: "-1000000000042", Name: "Native URL", Username: "channel", Type: "channel"}, nil
}
func (a *urlTestAccount) ReadMessage(ctx context.Context, d telegram.Dialog, id int) (*telegram.RefreshedMessage, error) {
	return a.read(ctx, d, id)
}

func urlMessage(id int) *telegram.RefreshedMessage {
	m := updateFixture().Updates[0].(*tg.UpdateNewChannelMessage).Message.(*tg.Message)
	m.ID = id
	if id == 12 {
		m.Media = nil
	}
	return &telegram.RefreshedMessage{Message: m, Entities: &tg.Updates{}, PTS: 10}
}

func urlFactory(read func(context.Context, telegram.Dialog, int) (*telegram.RefreshedMessage, error), download mediaTransport) engine.Factory {
	return func(c engine.AccountConfig, _ *telegram.UpdateState, handler func(context.Context, tg.UpdatesClass) error, _ func(int64)) (engine.Account, error) {
		return &urlTestAccount{recoveryTestAccount: recoveryTestAccount{id: c.ID, fixtureAccount: fixtureAccount{handle: handler, download: download}}, read: read}, nil
	}
}

func urlResults(t *testing.T, a *App, body string) []any {
	t.Helper()
	return historyHTTP(t, a, "POST", "/api/download/url", body)["results"].([]any)
}

func TestURLHTTPDurableBatchDedupRepairAndDisabledSubscriptions(t *testing.T) {
	var transfers atomic.Int64
	factory := urlFactory(func(_ context.Context, _ telegram.Dialog, id int) (*telegram.RefreshedMessage, error) {
		return urlMessage(id), nil
	}, func(_ context.Context, _ telegram.Attachment, w io.Writer) error {
		transfers.Add(1)
		_, err := w.Write([]byte("live"))
		return err
	})
	a, err := newConfiguredTestApp(context.Background(), Config{DataDir: t.TempDir(), AccountFactory: factory})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	configureMonitor(t, a)
	cfg, _ := a.config.Load(context.Background())
	cfg["groups"] = []any{}
	if err = a.config.Save(context.Background(), cfg); err != nil {
		t.Fatal(err)
	}
	if _, err = a.db.Writer.Exec(`UPDATE tgdl_queue_state SET paused=1`); err != nil {
		t.Fatal(err)
	}
	results := urlResults(t, a, `{"urls":["https://t.me/c/42/10","https://t.me/channel/11","not a link",false,"https://t.me/channel/12"]}`)
	if len(results) != 5 {
		t.Fatal(results)
	}
	for i, raw := range results {
		r := raw.(map[string]any)
		if r["ok"] != (i < 2) {
			t.Fatalf("result %d: %v", i, r)
		}
		if i < 2 && r["mediaType"] != "documents" {
			t.Fatalf("public media type changed: %v", r)
		}
	}
	if results[4].(map[string]any)["error"] != "Message has no downloadable media" {
		t.Fatal(results)
	}
	var queued int
	if err = a.db.Reader.QueryRow(`SELECT count(*) FROM tgdl_work WHERE status='pending' AND origin='url'`).Scan(&queued); err != nil || queued != 2 || transfers.Load() != 0 {
		t.Fatalf("ack without durable queue: %d %d %v", queued, transfers.Load(), err)
	}
	cfg, err = a.config.Load(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	groups := configuredGroupList(cfg)
	if len(groups) != 1 || groups[0]["enabled"] != false || groups[0]["id"] != "-1000000000042" || groups[0]["name"] != "Native URL" {
		t.Fatal(groups)
	}
	// Explicit URLs bypass future subscription selections as well, including
	// retry-time filters. The group itself stays disabled throughout.
	groups[0]["filters"] = map[string]any{"files": false}
	groups[0]["trackUsers"] = map[string]any{"enabled": true, "mode": "whitelist", "users": []any{}}
	groups[0]["topics"] = map[string]any{"enabled": true, "mode": "whitelist", "ids": []any{}}
	if err = a.config.Save(context.Background(), cfg); err != nil {
		t.Fatal(err)
	}
	if _, err = a.db.Writer.Exec(`UPDATE tgdl_work SET refresh_required=1`); err != nil {
		t.Fatal(err)
	}
	if _, err = a.db.Writer.Exec(`UPDATE tgdl_queue_state SET paused=0`); err != nil {
		t.Fatal(err)
	}
	waitHistoryDownloads(t, a, 2)
	if transfers.Load() != 1 {
		t.Fatalf("same Telegram media transferred %d times", transfers.Load())
	}
	status, err := a.monitor.Status(context.Background())
	if err != nil || status["state"] != "stopped" {
		t.Fatalf("enabled monitor: %v %v", status, err)
	}
	var path string
	if err = a.db.Reader.QueryRow(`SELECT file_path FROM downloads LIMIT 1`).Scan(&path); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(a.dataDir, "downloads", path))
	if err != nil || string(data) != "live" {
		t.Fatalf("bytes=%q %v", data, err)
	}
	for run := 0; run < 2; run++ {
		if run == 1 {
			if err = os.Remove(filepath.Join(a.dataDir, "downloads", path)); err != nil {
				t.Fatal(err)
			}
		}
		results = urlResults(t, a, `{"url":"https://t.me/channel/10"}`)
		if results[0].(map[string]any)["ok"] != true {
			t.Fatal(results)
		}
		waitURLWork(t, a, 10)
		if transfers.Load() != int64(run+1) {
			t.Fatalf("replay/repair transfers=%d run=%d", transfers.Load(), run)
		}
	}
}

func waitURLWork(t *testing.T, a *App, id int) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		var state string
		if err := a.db.Reader.QueryRow(`SELECT status FROM tgdl_work WHERE message_id=?`, id).Scan(&state); err != nil {
			t.Fatal(err)
		}
		if state == "completed" {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("URL work did not complete")
}

func TestURLShutdownReopensAcceptedWorkWithoutEnablingMonitor(t *testing.T) {
	dir := t.TempDir()
	entered := make(chan struct{}, 1)
	var transfers atomic.Int64
	factory := urlFactory(func(_ context.Context, _ telegram.Dialog, id int) (*telegram.RefreshedMessage, error) {
		return urlMessage(id), nil
	}, func(ctx context.Context, _ telegram.Attachment, w io.Writer) error {
		if transfers.Add(1) == 1 {
			if _, err := w.Write([]byte("li")); err != nil {
				return err
			}
			entered <- struct{}{}
			<-ctx.Done()
			return ctx.Err()
		}
		_, err := w.Write([]byte("live"))
		return err
	})
	a, err := newConfiguredTestApp(context.Background(), Config{DataDir: dir, AccountFactory: factory})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	configureDisabledHistory(t, a)
	if r := urlResults(t, a, `{"url":"https://t.me/c/42/10"}`); r[0].(map[string]any)["ok"] != true {
		t.Fatal(r)
	}
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("transfer did not start")
	}
	if err = a.Close(); err != nil {
		t.Fatal(err)
	}
	b, err := New(context.Background(), Config{DataDir: dir, AccountFactory: factory})
	if err != nil {
		t.Fatal(err)
	}
	defer b.Close()
	waitHistoryDownloads(t, b, 1)
	status, err := b.monitor.Status(context.Background())
	if err != nil || status["state"] != "stopped" || transfers.Load() != 2 {
		t.Fatalf("restart: %v transfers=%d %v", status, transfers.Load(), err)
	}
}

func TestURLPinnedAccountAndNoRPCAccountFallback(t *testing.T) {
	for _, fail := range []bool{false, true} {
		t.Run(map[bool]string{false: "success", true: "private"}[fail], func(t *testing.T) {
			var oneReads, twoReads, wrongTransfers atomic.Int64
			factory := func(c engine.AccountConfig, s *telegram.UpdateState, handler func(context.Context, tg.UpdatesClass) error, gap func(int64)) (engine.Account, error) {
				return urlFactory(func(_ context.Context, _ telegram.Dialog, id int) (*telegram.RefreshedMessage, error) {
					if c.ID == "two" {
						twoReads.Add(1)
					} else {
						oneReads.Add(1)
					}
					if fail {
						return nil, errors.New("CHANNEL_PRIVATE")
					}
					return urlMessage(id), nil
				}, func(_ context.Context, _ telegram.Attachment, w io.Writer) error {
					if c.ID != "two" {
						wrongTransfers.Add(1)
					}
					_, err := w.Write([]byte("live"))
					return err
				})(c, s, handler, gap)
			}
			a, err := newConfiguredTestApp(context.Background(), Config{DataDir: t.TempDir(), AccountFactory: factory})
			if err != nil {
				t.Fatal(err)
			}
			defer a.Close()
			configureDisabledHistory(t, a)
			if err = os.WriteFile(filepath.Join(a.dataDir, "sessions", "two.enc"), []byte("second fixture account"), 0600); err != nil {
				t.Fatal(err)
			}
			cfg, _ := a.config.Load(context.Background())
			configuredGroupList(cfg)[0]["monitorAccount"] = "two"
			if err = a.config.Save(context.Background(), cfg); err != nil {
				t.Fatal(err)
			}
			// No stored username: the first account resolves it, but media must
			// be re-resolved/read using the numeric group's explicit account pin.
			r := urlResults(t, a, `{"url":"https://t.me/channel/10"}`)[0].(map[string]any)
			if r["ok"] != !fail || oneReads.Load() != 0 || twoReads.Load() != 1 {
				t.Fatalf("routing=%v one=%d two=%d", r, oneReads.Load(), twoReads.Load())
			}
			if fail {
				if r["error"] != "CHANNEL_PRIVATE" {
					t.Fatal(r)
				}
			} else {
				waitHistoryDownloads(t, a, 1)
			}
			if wrongTransfers.Load() != 0 {
				t.Fatal("transferred using wrong account")
			}
		})
	}
}

func TestURLAcceptanceRollbackDoesNotRegisterGroup(t *testing.T) {
	factory := urlFactory(func(_ context.Context, _ telegram.Dialog, id int) (*telegram.RefreshedMessage, error) {
		return urlMessage(id), nil
	}, func(context.Context, telegram.Attachment, io.Writer) error {
		t.Error("uncommitted work downloaded")
		return nil
	})
	a, err := newConfiguredTestApp(context.Background(), Config{DataDir: t.TempDir(), AccountFactory: factory})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	configureMonitor(t, a)
	cfg, _ := a.config.Load(context.Background())
	cfg["groups"] = []any{}
	if err = a.config.Save(context.Background(), cfg); err != nil {
		t.Fatal(err)
	}
	if _, err = a.db.Writer.Exec(`CREATE TRIGGER reject_url BEFORE INSERT ON tgdl_work BEGIN SELECT RAISE(FAIL,'reject URL'); END`); err != nil {
		t.Fatal(err)
	}
	r := urlResults(t, a, `{"url":"https://t.me/c/42/10"}`)[0].(map[string]any)
	if r["ok"] != false || !strings.Contains(toString(r["error"]), "reject URL") {
		t.Fatal(r)
	}
	cfg, err = a.config.Load(context.Background())
	if err != nil || len(configuredGroupList(cfg)) != 0 {
		t.Fatalf("rolled back group escaped: %v %v", cfg["groups"], err)
	}
}

func TestURLPurgeCancelsLookupWithoutRecreatingGroup(t *testing.T) {
	entered := make(chan struct{}, 1)
	factory := urlFactory(func(ctx context.Context, _ telegram.Dialog, id int) (*telegram.RefreshedMessage, error) {
		entered <- struct{}{}
		<-ctx.Done()
		// A transport returning a late result still cannot publish it.
		return urlMessage(id), nil
	}, func(context.Context, telegram.Attachment, io.Writer) error {
		t.Error("purged lookup downloaded")
		return nil
	})
	a, err := newConfiguredTestApp(context.Background(), Config{DataDir: t.TempDir(), AccountFactory: factory})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	configureDisabledHistory(t, a)
	token, _ := a.sessions.Create(context.Background(), "admin")
	done := make(chan map[string]any, 1)
	go func() {
		r := requestPurge(a, token, "POST", "/api/download/url", `{"url":"https://t.me/c/42/10"}`)
		var body map[string]any
		_ = json.Unmarshal(r.Body.Bytes(), &body)
		done <- body
	}()
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("lookup did not start")
	}
	if r := requestPurge(a, token, "DELETE", "/api/groups/-1000000000042/purge", ""); r.Code != 200 {
		t.Fatal(r.Body.String())
	}
	a.purgeWG.Wait()
	assertPurgeDone(t, a, "group:-1000000000042")
	select {
	case body := <-done:
		if r := body["results"].([]any)[0].(map[string]any); r["ok"] != false {
			t.Fatal(r)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("purge did not cancel lookup")
	}
	var rows int
	if err = a.db.Reader.QueryRow(`SELECT count(*) FROM tgdl_work`).Scan(&rows); err != nil || rows != 0 {
		t.Fatalf("resurrected work: %d %v", rows, err)
	}
	cfg, err := a.config.Load(context.Background())
	if err != nil || len(configuredGroupList(cfg)) != 0 {
		t.Fatalf("resurrected group: %v %v", cfg["groups"], err)
	}
}

func TestURLHonorsSuspensionOwnershipAndConcurrentAccountChange(t *testing.T) {
	for _, rule := range []string{"suspended", "owner", "changed-pin"} {
		t.Run(rule, func(t *testing.T) {
			var a *App
			factory := urlFactory(func(_ context.Context, _ telegram.Dialog, id int) (*telegram.RefreshedMessage, error) {
				if rule == "changed-pin" {
					a.configMu.Lock()
					defer a.configMu.Unlock()
					cfg, err := a.config.Load(context.Background())
					if err != nil {
						return nil, err
					}
					configuredGroupList(cfg)[0]["monitorAccount"] = "two"
					if err = a.config.Save(context.Background(), cfg); err != nil {
						return nil, err
					}
				}
				return urlMessage(id), nil
			}, func(context.Context, telegram.Attachment, io.Writer) error {
				t.Error("blocked URL downloaded")
				return nil
			})
			var err error
			a, err = newConfiguredTestApp(context.Background(), Config{DataDir: t.TempDir(), AccountFactory: factory})
			if err != nil {
				t.Fatal(err)
			}
			defer a.Close()
			configureDisabledHistory(t, a)
			cfg, _ := a.config.Load(context.Background())
			g := configuredGroupList(cfg)[0]
			if rule == "suspended" {
				g["suspended"] = true
			}
			if rule == "owner" {
				g["ownerPeerId"] = "another-peer"
			}
			if err = a.config.Save(context.Background(), cfg); err != nil {
				t.Fatal(err)
			}
			res := urlResults(t, a, `{"url":"https://t.me/c/42/10"}`)[0].(map[string]any)
			if res["ok"] != false {
				t.Fatal(res)
			}
			var count int
			if err = a.db.Reader.QueryRow(`SELECT count(*) FROM tgdl_work`).Scan(&count); err != nil || count != 0 {
				t.Fatalf("blocked work queued %d %v", count, err)
			}
		})
	}
}

func TestURLKnownInaccessibleChatDoesNotConnect(t *testing.T) {
	a, err := newConfiguredTestApp(context.Background(), Config{DataDir: t.TempDir(), AccountFactory: func(engine.AccountConfig, *telegram.UpdateState, func(context.Context, tg.UpdatesClass) error, func(int64)) (engine.Account, error) {
		t.Error("known inaccessible link opened an account")
		return nil, errors.New("unexpected connection")
	}})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	configureDisabledHistory(t, a)
	if _, err = a.db.Writer.Exec(`INSERT INTO chat_access(chat_id,state,checked_at,updated_at) VALUES('-1000000000042','inaccessible',1,1)`); err != nil {
		t.Fatal(err)
	}
	res := urlResults(t, a, `{"url":"https://t.me/c/42/10"}`)[0].(map[string]any)
	if res["ok"] != false || res["code"] != "CHAT_UNREACHABLE" {
		t.Fatal(res)
	}
}

func BenchmarkURLAcceptance(b *testing.B) {
	ctx := context.Background()
	factory := urlFactory(func(_ context.Context, _ telegram.Dialog, id int) (*telegram.RefreshedMessage, error) {
		return urlMessage(id), nil
	}, func(context.Context, telegram.Attachment, io.Writer) error {
		return errors.New("benchmark queue should stay paused")
	})
	a, err := newConfiguredTestApp(ctx, Config{DataDir: b.TempDir(), AccountFactory: factory})
	if err != nil {
		b.Fatal(err)
	}
	defer a.Close()
	cfg, err := a.config.Load(ctx)
	if err != nil {
		b.Fatal(err)
	}
	cfg["telegram"] = map[string]any{"apiId": 123, "apiHash": "fixture"}
	cfg["groups"] = []any{manualGroup(telegram.Dialog{ID: "-1000000000042", Name: "Bench"})}
	if err = a.config.Save(ctx, cfg); err != nil {
		b.Fatal(err)
	}
	if err = os.MkdirAll(filepath.Join(a.dataDir, "sessions"), 0700); err != nil {
		b.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(a.dataDir, "sessions", "one.enc"), []byte("fixture account"), 0600); err != nil {
		b.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(a.dataDir, "secret.key"), []byte("fixture secret"), 0600); err != nil {
		b.Fatal(err)
	}
	if _, err = a.db.Writer.Exec(`UPDATE tgdl_queue_state SET paused=1`); err != nil {
		b.Fatal(err)
	}
	if err = a.startTelegramEngine(ctx, false); err != nil {
		b.Fatal(err)
	}
	token, err := a.sessions.Create(ctx, "admin")
	if err != nil {
		b.Fatal(err)
	}
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		// Skip fixture message 12, deliberately used for no-media tests.
		response := requestPurge(a, token, "POST", "/api/download/url", fmt.Sprintf(`{"url":"https://t.me/c/42/%d"}`, i+100))
		var result struct {
			Results []struct {
				OK bool `json:"ok"`
			} `json:"results"`
		}
		if err = json.Unmarshal(response.Body.Bytes(), &result); err != nil || response.Code != 200 || len(result.Results) != 1 || !result.Results[0].OK {
			b.Fatalf("accept: %d %s %v", response.Code, response.Body.String(), err)
		}
	}
	b.StopTimer()
}

func TestURLWaitingForAccountCannotOutliveCompletedPurge(t *testing.T) {
	a, err := newConfiguredTestApp(context.Background(), Config{DataDir: t.TempDir(), AccountFactory: func(engine.AccountConfig, *telegram.UpdateState, func(context.Context, tg.UpdatesClass) error, func(int64)) (engine.Account, error) {
		t.Error("URL submitted before purge opened a new account after purge")
		return nil, errors.New("unexpected account")
	}})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	configureDisabledHistory(t, a)
	// This is the request checkpoint captured before waiting for monitorOp;
	// even a fully completed purge must invalidate it, not just active purges.
	epoch, err := a.urlPurgeCheckpoint()
	if err != nil {
		t.Fatal(err)
	}
	token, _ := a.sessions.Create(context.Background(), "admin")
	if r := requestPurge(a, token, "DELETE", "/api/groups/-1000000000042/purge", ""); r.Code != 200 {
		t.Fatal(r.Body.String())
	}
	a.purgeWG.Wait()
	assertPurgeDone(t, a, "group:-1000000000042")
	link, _ := telegram.ParseMessageLink("https://t.me/c/42/10")
	err = a.acceptMessageURL(contextRequest(a.ctx), link, map[string]any{}, epoch)
	if err == nil || !strings.Contains(err.Error(), "purge interrupted") {
		t.Fatalf("stale request accepted: %v", err)
	}
}
