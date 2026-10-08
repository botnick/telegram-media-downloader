package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/botnick/telegram-media-downloader/core-service/internal/engine"
	"github.com/botnick/telegram-media-downloader/core-service/internal/telegram"
	"github.com/gotd/td/tg"
)

type storyTestAccount struct {
	urlTestAccount
	stories func(context.Context, telegram.Dialog, []int) ([]*telegram.RefreshedMessage, error)
	page    func(context.Context, string) (telegram.StoryPage, error)
	refresh func(context.Context, *tg.Message) (*telegram.RefreshedMessage, error)
}

func (a *storyTestAccount) ReadStories(ctx context.Context, d telegram.Dialog, ids []int) ([]*telegram.RefreshedMessage, error) {
	return a.stories(ctx, d, ids)
}
func (a *storyTestAccount) StoryPage(ctx context.Context, state string) (telegram.StoryPage, error) {
	return a.page(ctx, state)
}
func (a *storyTestAccount) ListPeerStories(_ context.Context, d telegram.Dialog, ref string) (telegram.PeerStoryList, error) {
	return telegram.PeerStoryList{Peer: telegram.StoryPeer{ID: "42"}, Stories: []telegram.StoryView{{ID: 7, Caption: "fixture"}}}, nil
}
func (a *storyTestAccount) RefreshStory(ctx context.Context, m *tg.Message) (*telegram.RefreshedMessage, error) {
	if a.refresh != nil {
		return a.refresh(ctx, m)
	}
	return urlMessage(m.ID), nil
}
func storyFactory(read func(context.Context, telegram.Dialog, []int) ([]*telegram.RefreshedMessage, error), transport mediaTransport) engine.Factory {
	return func(c engine.AccountConfig, _ *telegram.UpdateState, h func(context.Context, tg.UpdatesClass) error, _ func(int64)) (engine.Account, error) {
		return &storyTestAccount{urlTestAccount: urlTestAccount{recoveryTestAccount: recoveryTestAccount{id: c.ID, fixtureAccount: fixtureAccount{handle: h, download: transport}}, read: func(_ context.Context, _ telegram.Dialog, id int) (*telegram.RefreshedMessage, error) {
			return urlMessage(id), nil
		}}, stories: read}, nil
	}
}
func storyFixtureRead(_ context.Context, _ telegram.Dialog, ids []int) ([]*telegram.RefreshedMessage, error) {
	items := []*telegram.RefreshedMessage{}
	for _, id := range ids {
		fresh := urlMessage(7)
		fresh.Message.ID = id
		items = append(items, fresh)
	}
	return items, nil
}

func TestStoriesDurableBatchSharesDedupWithoutMessageCollision(t *testing.T) {
	var transfers atomic.Int64
	factory := storyFactory(storyFixtureRead, func(_ context.Context, _ telegram.Attachment, w io.Writer) error {
		transfers.Add(1)
		_, err := w.Write([]byte("live"))
		return err
	})
	a, err := newConfiguredTestApp(context.Background(), Config{DataDir: t.TempDir(), AccountFactory: factory})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	configureDisabledHistory(t, a)
	if _, err = a.db.Writer.Exec(`UPDATE tgdl_queue_state SET paused=1`); err != nil {
		t.Fatal(err)
	}
	if got := historyHTTP(t, a, "POST", "/api/stories/user", `{"username":"@channel"}`); len(got["stories"].([]any)) != 1 {
		t.Fatal(got)
	}
	got := historyHTTP(t, a, "POST", "/api/stories/download", `{"username":"@channel","storyIds":[7,8,7]}`)
	if jobCount(got["queued"]) != 2 || jobCount(got["requested"]) != 3 {
		t.Fatal(got)
	}
	urlResults(t, a, `{"url":"https://t.me/channel/7"}`)
	var count int
	if err = a.db.Reader.QueryRow(`SELECT count(*) FROM tgdl_work WHERE status='pending'`).Scan(&count); err != nil || count != 3 || transfers.Load() != 0 {
		t.Fatalf("queue=%d calls=%d %v", count, transfers.Load(), err)
	}
	key, _ := telegram.StoryKey(7)
	// Stale work must refresh through stories.getStoriesByID, never messages.
	if _, err = a.db.Writer.Exec(`UPDATE tgdl_work SET created_at=1 WHERE origin='stories'`); err != nil {
		t.Fatal(err)
	}
	historyHTTP(t, a, "POST", "/api/queue/resume-all", `{}`)
	waitURLWork(t, a, 7)
	waitURLWork(t, a, int(key))
	waitURLWork(t, a, int(key+1))
	if transfers.Load() != 1 {
		t.Fatalf("duplicate media transfers=%d", transfers.Load())
	}
	var path string
	if err = a.db.Reader.QueryRow(`SELECT file_path FROM downloads WHERE message_id=? AND file_type='stories'`, key).Scan(&path); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(a.dataDir, "downloads", path))
	if err != nil || string(data) != "live" {
		t.Fatalf("bytes=%q %v", data, err)
	}
	if err = a.db.Reader.QueryRow(`SELECT count(*) FROM downloads`).Scan(&count); err != nil || count != 3 {
		t.Fatalf("catalog=%d %v", count, err)
	}
	for n := 0; n < 2; n++ {
		if n == 1 {
			if err = os.Remove(filepath.Join(a.dataDir, "downloads", path)); err != nil {
				t.Fatal(err)
			}
		}
		historyHTTP(t, a, "POST", "/api/stories/download", `{"username":"@channel","storyIds":[7]}`)
		waitURLWork(t, a, int(key))
		if transfers.Load() != int64(n+1) {
			t.Fatalf("repair=%d transfers=%d", n, transfers.Load())
		}
	}
}

func TestStoriesQueueBatchRollsBackOnSecondFailure(t *testing.T) {
	a, err := newConfiguredTestApp(context.Background(), Config{DataDir: t.TempDir(), AccountFactory: storyFactory(storyFixtureRead, nil)})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	configureDisabledHistory(t, a)
	cfg, _ := a.config.Load(context.Background())
	cfg["groups"] = []any{}
	if err = a.config.Save(context.Background(), cfg); err != nil {
		t.Fatal(err)
	}
	if _, err = a.db.Writer.Exec(`UPDATE tgdl_queue_state SET paused=1; CREATE TRIGGER fail_story BEFORE INSERT ON tgdl_work WHEN new.message_id=4294967304 BEGIN SELECT RAISE(ABORT,'injected story failure'); END`); err != nil {
		t.Fatal(err)
	}
	token, err := a.sessions.Create(context.Background(), "admin")
	if err != nil {
		t.Fatal(err)
	}
	r := requestPurge(a, token, "POST", "/api/stories/download", `{"username":"@channel","storyIds":[7,8]}`)
	if r.Code != 500 {
		t.Fatalf("%d %s", r.Code, r.Body.String())
	}
	var count int
	if err = a.db.Reader.QueryRow(`SELECT count(*) FROM tgdl_work`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("partial queue=%d %v", count, err)
	}
	cfg, _ = a.config.Load(context.Background())
	if len(configuredGroupList(cfg)) != 0 {
		t.Fatal("rolled-back batch registered a group")
	}
}

func TestStoryEditedMediaUsesDurableOrderAcrossClockChanges(t *testing.T) {
	var edited atomic.Bool
	factory := storyFactory(func(ctx context.Context, d telegram.Dialog, ids []int) ([]*telegram.RefreshedMessage, error) {
		items, err := storyFixtureRead(ctx, d, ids)
		if edited.Load() {
			items[0].Message.Media.(*tg.MessageMediaDocument).Document.(*tg.Document).ID = 123456789
		}
		return items, err
	}, nil)
	a, err := newConfiguredTestApp(context.Background(), Config{DataDir: t.TempDir(), AccountFactory: factory})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	configureDisabledHistory(t, a)
	if _, err = a.db.Writer.Exec(`UPDATE tgdl_queue_state SET paused=1`); err != nil {
		t.Fatal(err)
	}
	historyHTTP(t, a, "POST", "/api/stories/download", `{"username":"@channel","storyIds":[7]}`)
	// A preexisting higher watermark (e.g. after clock correction) cannot
	// cause an explicit, newer story read to keep obsolete attachment bytes.
	if _, err = a.db.Writer.Exec(`UPDATE tgdl_work SET source_pts=4611686018427387904 WHERE origin='stories'`); err != nil {
		t.Fatal(err)
	}
	edited.Store(true)
	response := historyHTTP(t, a, "POST", "/api/stories/download", `{"username":"@channel","storyIds":[7]}`)
	if jobCount(response["queued"]) != 1 {
		t.Fatal(response)
	}
	var body []byte
	if err = a.db.Reader.QueryRow(`SELECT body FROM tgdl_work WHERE origin='stories'`).Scan(&body); err != nil {
		t.Fatal(err)
	}
	var generation int
	if err = a.db.Reader.QueryRow(`SELECT generation FROM tgdl_work WHERE origin='stories'`).Scan(&generation); err != nil || generation != 2 {
		t.Fatalf("new edit rejected: %d %v", generation, err)
	}
}

func TestStoriesShutdownReopenRefreshesThroughStoryTransport(t *testing.T) {
	dir := t.TempDir()
	entered := make(chan struct{}, 1)
	var transfers, refreshes atomic.Int64
	base := storyFactory(storyFixtureRead, func(ctx context.Context, _ telegram.Attachment, w io.Writer) error {
		if transfers.Add(1) == 1 {
			_, _ = w.Write([]byte("li"))
			entered <- struct{}{}
			<-ctx.Done()
			return ctx.Err()
		}
		_, err := w.Write([]byte("live"))
		return err
	})
	factory := func(c engine.AccountConfig, s *telegram.UpdateState, h func(context.Context, tg.UpdatesClass) error, g func(int64)) (engine.Account, error) {
		a, err := base(c, s, h, g)
		if err != nil {
			return nil, err
		}
		a.(*storyTestAccount).refresh = func(_ context.Context, m *tg.Message) (*telegram.RefreshedMessage, error) {
			refreshes.Add(1)
			return urlMessage(m.ID), nil
		}
		return a, nil
	}
	a, err := newConfiguredTestApp(context.Background(), Config{DataDir: dir, AccountFactory: factory})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	configureDisabledHistory(t, a)
	historyHTTP(t, a, "POST", "/api/stories/download", `{"username":"@channel","storyIds":[7]}`)
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("story transfer did not start")
	}
	if err = a.Close(); err != nil {
		t.Fatal(err)
	}
	b, err := New(context.Background(), Config{DataDir: dir, AccountFactory: factory})
	if err != nil {
		t.Fatal(err)
	}
	defer b.Close()
	key, _ := telegram.StoryKey(7)
	// Restarted interrupted work can still use a fresh existing reference. A
	// force refresh deterministically exercises the story-specific dispatch.
	// The second app may have already claimed it, so use a later repair request.
	waitURLWork(t, b, int(key))
	if _, err = b.db.Writer.Exec(`UPDATE tgdl_queue_state SET paused=1`); err != nil {
		t.Fatal(err)
	}
	historyHTTP(t, b, "POST", "/api/stories/download", `{"username":"@channel","storyIds":[7]}`)
	if _, err = b.db.Writer.Exec(`UPDATE tgdl_work SET refresh_required=1 WHERE origin='stories'`); err != nil {
		t.Fatal(err)
	}
	historyHTTP(t, b, "POST", "/api/queue/resume-all", `{}`)
	waitURLWork(t, b, int(key))
	if refreshes.Load() == 0 || transfers.Load() != 2 {
		t.Fatalf("refresh=%d transfers=%d", refreshes.Load(), transfers.Load())
	}
	status, _ := b.monitor.Status(context.Background())
	if status["state"] != "stopped" {
		t.Fatal(status)
	}
}

func TestStoriesPurgeCancelsLookupWithoutResurrection(t *testing.T) {
	entered := make(chan struct{}, 1)
	factory := storyFactory(func(ctx context.Context, d telegram.Dialog, ids []int) ([]*telegram.RefreshedMessage, error) {
		entered <- struct{}{}
		<-ctx.Done()
		return storyFixtureRead(context.Background(), d, ids)
	}, nil)
	a, err := newConfiguredTestApp(context.Background(), Config{DataDir: t.TempDir(), AccountFactory: factory})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	configureDisabledHistory(t, a)
	token, err := a.sessions.Create(context.Background(), "admin")
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan int, 1)
	go func() {
		r := requestPurge(a, token, "POST", "/api/stories/download", `{"username":"@channel","storyIds":[7]}`)
		done <- r.Code
	}()
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("no story lookup")
	}
	r := requestPurge(a, token, "DELETE", "/api/groups/-1000000000042/purge", `{"confirm":true}`)
	if r.Code != 200 {
		t.Fatalf("purge %d %s", r.Code, r.Body.String())
	}
	select {
	case code := <-done:
		if code == 200 {
			t.Fatal("late story accepted")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("story lookup not canceled")
	}
	var count int
	if err = a.db.Reader.QueryRow(`SELECT count(*) FROM tgdl_work`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("queue=%d %v", count, err)
	}
}

func TestStoriesUsePinnedAccountAndDoNotSwitchAfterFailure(t *testing.T) {
	var wrong atomic.Int64
	base := storyFactory(storyFixtureRead, nil)
	factory := func(c engine.AccountConfig, s *telegram.UpdateState, h func(context.Context, tg.UpdatesClass) error, g func(int64)) (engine.Account, error) {
		a, err := base(c, s, h, g)
		if err != nil {
			return nil, err
		}
		a.(*storyTestAccount).stories = func(context.Context, telegram.Dialog, []int) ([]*telegram.RefreshedMessage, error) {
			if c.ID != "two" {
				wrong.Add(1)
			}
			return nil, errors.New("CHANNEL_PRIVATE")
		}
		return a, nil
	}
	a, err := newConfiguredTestApp(context.Background(), Config{DataDir: t.TempDir(), AccountFactory: factory})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	configureDisabledHistory(t, a)
	if err = os.WriteFile(filepath.Join(a.dataDir, "sessions", "two.enc"), []byte("fixture"), 0600); err != nil {
		t.Fatal(err)
	}
	cfg, _ := a.config.Load(context.Background())
	configuredGroupList(cfg)[0]["monitorAccount"] = "two"
	if err = a.config.Save(context.Background(), cfg); err != nil {
		t.Fatal(err)
	}
	token, err := a.sessions.Create(context.Background(), "admin")
	if err != nil {
		t.Fatal(err)
	}
	r := requestPurge(a, token, "POST", "/api/stories/download", `{"username":"@channel","storyIds":[7]}`)
	if r.Code != 500 || wrong.Load() != 0 {
		t.Fatalf("%d wrong=%d %s", r.Code, wrong.Load(), r.Body.String())
	}
}

func TestStoriesRejectFractionalAndOversizedIDs(t *testing.T) {
	a, err := newConfiguredTestApp(context.Background(), Config{DataDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	token, err := a.sessions.Create(context.Background(), "admin")
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"0", "-1", "1.5", "2147483648", "true", "null"} {
		r := requestPurge(a, token, "POST", "/api/stories/download", fmt.Sprintf(`{"username":"@channel","storyIds":[%s]}`, id))
		if r.Code != 400 {
			t.Fatalf("id=%s code=%d", id, r.Code)
		}
	}
}

func TestStoriesAllPaginatesWithoutPublishingPartialResults(t *testing.T) {
	for _, failure := range []string{"", "cycle", "rpc"} {
		t.Run("failure="+failure, func(t *testing.T) {
			base := storyFactory(storyFixtureRead, nil)
			calls := 0
			factory := func(c engine.AccountConfig, s *telegram.UpdateState, h func(context.Context, tg.UpdatesClass) error, g func(int64)) (engine.Account, error) {
				a, err := base(c, s, h, g)
				if err != nil {
					return nil, err
				}
				a.(*storyTestAccount).page = func(ctx context.Context, state string) (telegram.StoryPage, error) {
					calls++
					if _, ok := ctx.Deadline(); !ok {
						t.Error("story page has no deadline")
					}
					group := telegram.StoryGroup{Key: "42", PeerID: "42", Stories: []telegram.StoryView{{ID: 7}}}
					if state == "" {
						return telegram.StoryPage{Groups: []telegram.StoryGroup{group}, Count: 2, State: "next", More: true}, nil
					}
					if state != "next" {
						return telegram.StoryPage{}, errors.New("wrong continuation")
					}
					if failure == "rpc" {
						return telegram.StoryPage{}, errors.New("page failed")
					}
					if failure == "cycle" {
						return telegram.StoryPage{State: "next", More: true}, nil
					}
					return telegram.StoryPage{Groups: []telegram.StoryGroup{group, {Key: "-1000000000042", PeerID: "42", Stories: []telegram.StoryView{{ID: 7}}}}, Count: 2}, nil
				}
				return a, nil
			}
			a, err := newConfiguredTestApp(context.Background(), Config{DataDir: t.TempDir(), AccountFactory: factory})
			if err != nil {
				t.Fatal(err)
			}
			defer a.Close()
			configureDisabledHistory(t, a)
			token, err := a.sessions.Create(context.Background(), "admin")
			if err != nil {
				t.Fatal(err)
			}
			r := requestPurge(a, token, "POST", "/api/stories/all", `{}`)
			if calls != 2 {
				t.Fatalf("calls=%d body=%s", calls, r.Body.String())
			}
			var response map[string]any
			if err = json.Unmarshal(r.Body.Bytes(), &response); err != nil {
				t.Fatal(err)
			}
			if failure != "" {
				if r.Code != 502 || response["groups"] != nil {
					t.Fatalf("partial success: %d %s", r.Code, r.Body.String())
				}
				return
			}
			groups := response["groups"].([]any)
			if r.Code != 200 || len(groups) != 2 || jobCount(response["count"]) != 2 || len(groups[0].(map[string]any)["stories"].([]any)) != 1 {
				t.Fatalf("%d %s", r.Code, r.Body.String())
			}
		})
	}
}

func BenchmarkStoriesBatch100(b *testing.B) {
	ctx := context.Background()
	a, err := newConfiguredTestApp(ctx, Config{DataDir: b.TempDir(), AccountFactory: storyFactory(storyFixtureRead, nil)})
	if err != nil {
		b.Fatal(err)
	}
	defer a.Close()
	cfg, err := a.config.Load(ctx)
	if err != nil {
		b.Fatal(err)
	}
	cfg["telegram"] = map[string]any{"apiId": 123, "apiHash": "fixture"}
	cfg["groups"] = []any{manualGroup(telegram.Dialog{ID: "-1000000000042", Name: "Story benchmark"})}
	if err = a.config.Save(ctx, cfg); err != nil {
		b.Fatal(err)
	}
	if err = os.MkdirAll(filepath.Join(a.dataDir, "sessions"), 0700); err != nil {
		b.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(a.dataDir, "sessions", "one.enc"), []byte("fixture"), 0600); err != nil {
		b.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(a.dataDir, "secret.key"), []byte("fixture secret"), 0600); err != nil {
		b.Fatal(err)
	}
	if _, err = a.db.Writer.Exec(`UPDATE tgdl_queue_state SET paused=1`); err != nil {
		b.Fatal(err)
	}
	a.monitorOp.Lock()
	err = a.startTelegramEngine(ctx, false)
	a.monitorOp.Unlock()
	if err != nil {
		b.Fatal(err)
	}
	lease, err := a.monitor.OpenStories(ctx, "")
	if err != nil {
		b.Fatal(err)
	}
	defer lease.Close()
	ids := make([]int, 100)
	for n := range ids {
		ids[n] = n + 1
	}
	data, err := json.Marshal(map[string]any{"username": "@channel", "storyIds": ids})
	if err != nil {
		b.Fatal(err)
	}
	token, err := a.sessions.Create(ctx, "admin")
	if err != nil {
		b.Fatal(err)
	}
	b.ReportAllocs()
	b.ResetTimer()
	for n := 0; n < b.N; n++ {
		b.StopTimer()
		if _, err = a.db.Writer.Exec(`DELETE FROM tgdl_work`); err != nil {
			b.Fatal(err)
		}
		b.StartTimer()
		r := requestPurge(a, token, "POST", "/api/stories/download", string(data))
		if r.Code != 200 {
			b.Fatalf("%d %s", r.Code, r.Body.String())
		}
		var response map[string]any
		if err = json.Unmarshal(r.Body.Bytes(), &response); err != nil || jobCount(response["queued"]) != 100 {
			b.Fatalf("%s %v", r.Body.String(), err)
		}
	}
	b.StopTimer()
}
