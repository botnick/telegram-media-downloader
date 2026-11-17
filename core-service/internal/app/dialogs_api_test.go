package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/botnick/telegram-media-downloader/core-service/internal/engine"
	"github.com/botnick/telegram-media-downloader/core-service/internal/telegram"
	"github.com/gotd/td/tg"
)

type dialogAppAccount struct {
	fixtureAccount
	active, archived []telegram.Dialog
	archiveErr       error
	dialogCalls      atomic.Int64
	topics           []telegram.ForumTopic
	firstTopicError  error
	topicCalls       atomic.Int64
}

func (a *dialogAppAccount) Dialogs(_ context.Context, _ int, archived bool) ([]telegram.Dialog, error) {
	a.dialogCalls.Add(1)
	if archived {
		return a.archived, a.archiveErr
	}
	return a.active, nil
}

func (a *dialogAppAccount) ForumTopics(_ context.Context, _ string) ([]telegram.ForumTopic, error) {
	if a.topicCalls.Add(1) == 1 && a.firstTopicError != nil {
		return nil, a.firstTopicError
	}
	return a.topics, nil
}

func TestDialogsHTTPReturnsNativeMultiAccountProjection(t *testing.T) {
	factory := func(_ engine.AccountConfig, _ *telegram.UpdateState, handler func(context.Context, tg.UpdatesClass) error, _ func(int64)) (engine.Account, error) {
		return &dialogAppAccount{
			fixtureAccount: fixtureAccount{handle: handler, download: func(_ context.Context, _ telegram.Attachment, w io.Writer) error {
				_, err := w.Write([]byte("ok"))
				return err
			}},
			active:   []telegram.Dialog{{ID: "-1000000000042", Name: "Media", Type: "channel", Members: intPointer(7)}},
			archived: []telegram.Dialog{{ID: "-1000000000042", Name: "Media old", Type: "channel", Archived: true}},
		}, nil
	}
	a, err := newConfiguredTestApp(context.Background(), Config{DataDir: t.TempDir(), AccountFactory: factory})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	configureMonitor(t, a)
	if rec := monitorRequest(t, a, "/api/monitor/start"); rec.Code != http.StatusOK {
		t.Fatalf("start=%d %s", rec.Code, rec.Body.String())
	}
	token, err := a.sessions.Create(context.Background(), "admin")
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodGet, "/api/dialogs", nil)
	req.AddCookie(&http.Cookie{Name: a.sessions.CookieName(), Value: token})
	rec := httptest.NewRecorder()
	a.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("dialogs=%d %s", rec.Code, rec.Body.String())
	}
	var body struct {
		Dialogs []map[string]any `json:"dialogs"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if len(body.Dialogs) != 1 || body.Dialogs[0]["id"] != "-1000000000042" || body.Dialogs[0]["archived"] != false || body.Dialogs[0]["photoUrl"] != "/api/groups/-1000000000042/photo" {
		t.Fatalf("projection=%+v", body.Dialogs)
	}
	if rec := monitorRequest(t, a, "/api/monitor/stop"); rec.Code != http.StatusOK {
		t.Fatalf("stop=%d %s", rec.Code, rec.Body.String())
	}
	rec = httptest.NewRecorder()
	a.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("chat browsing after stopping monitor: %d %s", rec.Code, rec.Body.String())
	}
}

func TestDialogsHTTPConnectsSavedAccountWithoutStartingMonitor(t *testing.T) {
	var starts atomic.Int64
	var account *dialogAppAccount
	factory := func(_ engine.AccountConfig, _ *telegram.UpdateState, handler func(context.Context, tg.UpdatesClass) error, _ func(int64)) (engine.Account, error) {
		starts.Add(1)
		account = &dialogAppAccount{fixtureAccount: fixtureAccount{handle: handler}, active: []telegram.Dialog{{ID: "-1000000000042", Name: "Media", Type: "channel"}}}
		return account, nil
	}
	a, err := newConfiguredTestApp(context.Background(), Config{DataDir: t.TempDir(), AccountFactory: factory})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	configureMonitor(t, a)
	cfg, err := a.config.Load(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	autoStart := ensureMap(cfg, "monitor")["autoStart"]
	token, err := a.sessions.Create(context.Background(), "admin")
	if err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	for range 4 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			req := httptest.NewRequest(http.MethodGet, "/api/dialogs?fresh=1", nil)
			req.AddCookie(&http.Cookie{Name: a.sessions.CookieName(), Value: token})
			rec := httptest.NewRecorder()
			a.Handler().ServeHTTP(rec, req)
			if rec.Code != http.StatusOK {
				t.Errorf("saved account browse=%d %s", rec.Code, rec.Body.String())
			}
		}()
	}
	wg.Wait()
	if t.Failed() {
		return
	}
	if starts.Load() != 1 {
		t.Fatalf("started %d account connections", starts.Load())
	}
	if err := account.handle(context.Background(), updateFixture()); err != nil {
		t.Fatal(err)
	}
	var queued int
	if err := a.db.Reader.QueryRow(`SELECT count(*) FROM tgdl_work`).Scan(&queued); err != nil {
		t.Fatal(err)
	}
	if queued != 0 {
		t.Fatalf("browsing queued %d live downloads", queued)
	}
	status, err := a.monitor.Status(context.Background())
	if err != nil || status["state"] != "stopped" {
		t.Fatalf("monitor=%v err=%v", status, err)
	}
	cfg, err = a.config.Load(context.Background())
	if err != nil || ensureMap(cfg, "monitor")["autoStart"] != autoStart {
		t.Fatalf("browsing changed autoStart: %v", err)
	}
}

func TestDialogTopicsUsesLoadedAccountPeersWithoutRelistingDialogs(t *testing.T) {
	var account *dialogAppAccount
	factory := func(_ engine.AccountConfig, _ *telegram.UpdateState, handler func(context.Context, tg.UpdatesClass) error, _ func(int64)) (engine.Account, error) {
		account = &dialogAppAccount{
			fixtureAccount: fixtureAccount{handle: handler},
			topics:         []telegram.ForumTopic{{ID: 17, Name: "General"}},
		}
		return account, nil
	}
	a, err := newConfiguredTestApp(context.Background(), Config{DataDir: t.TempDir(), AccountFactory: factory})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	configureMonitor(t, a)
	token, err := a.sessions.Create(context.Background(), "admin")
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodGet, "/api/dialogs/-1000000000042/topics", nil)
	req.AddCookie(&http.Cookie{Name: a.sessions.CookieName(), Value: token})
	rec := httptest.NewRecorder()
	a.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("topics=%d %s", rec.Code, rec.Body.String())
	}
	var body struct {
		Topics []telegram.ForumTopic `json:"topics"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if len(body.Topics) != 1 || body.Topics[0].ID != 17 || body.Topics[0].Name != "General" {
		t.Fatalf("topics=%+v", body.Topics)
	}
	if calls := account.dialogCalls.Load(); calls != 0 {
		t.Fatalf("loaded cached topic names after listing %d dialog folders", calls)
	}
	if calls := account.topicCalls.Load(); calls != 1 {
		t.Fatalf("requested topics %d times", calls)
	}
}

func TestDialogTopicsRefreshesPeerIndexWhenCachedLookupFails(t *testing.T) {
	var account *dialogAppAccount
	factory := func(_ engine.AccountConfig, _ *telegram.UpdateState, handler func(context.Context, tg.UpdatesClass) error, _ func(int64)) (engine.Account, error) {
		account = &dialogAppAccount{
			fixtureAccount:  fixtureAccount{handle: handler},
			topics:          []telegram.ForumTopic{{ID: 19, Name: "Support"}},
			firstTopicError: errors.New("channel access hash is missing"),
		}
		return account, nil
	}
	a, err := newConfiguredTestApp(context.Background(), Config{DataDir: t.TempDir(), AccountFactory: factory})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	configureMonitor(t, a)
	token, err := a.sessions.Create(context.Background(), "admin")
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodGet, "/api/dialogs/-1000000000042/topics", nil)
	req.AddCookie(&http.Cookie{Name: a.sessions.CookieName(), Value: token})
	rec := httptest.NewRecorder()
	a.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("topics=%d %s", rec.Code, rec.Body.String())
	}
	if dialogs, topics := account.dialogCalls.Load(), account.topicCalls.Load(); dialogs != 2 || topics != 2 {
		t.Fatalf("dialog calls=%d topic calls=%d; want one index refresh then one retry", dialogs, topics)
	}
}

func TestDialogsHTTPRejectsPartialArchiveResult(t *testing.T) {
	factory := func(_ engine.AccountConfig, _ *telegram.UpdateState, handler func(context.Context, tg.UpdatesClass) error, _ func(int64)) (engine.Account, error) {
		return &dialogAppAccount{
			fixtureAccount: fixtureAccount{handle: handler},
			active:         []telegram.Dialog{{ID: "-1000000000042", Name: "Visible", Type: "channel"}},
			archiveErr:     errors.New("archive unavailable"),
		}, nil
	}
	a, err := newConfiguredTestApp(context.Background(), Config{DataDir: t.TempDir(), AccountFactory: factory})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	configureMonitor(t, a)
	if rec := monitorRequest(t, a, "/api/monitor/start"); rec.Code != http.StatusOK {
		t.Fatalf("start=%d %s", rec.Code, rec.Body.String())
	}
	token, err := a.sessions.Create(context.Background(), "admin")
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodGet, "/api/dialogs", nil)
	req.AddCookie(&http.Cookie{Name: a.sessions.CookieName(), Value: token})
	rec := httptest.NewRecorder()
	a.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("incomplete list appeared successful: %d %s", rec.Code, rec.Body.String())
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body["error"] != "dialogs_unavailable" {
		t.Fatalf("RPC error misreported as disconnected: %v", body)
	}
}

func TestDialogsHTTPGuestDoesNotConnectAccounts(t *testing.T) {
	var starts atomic.Int64
	a, err := newConfiguredTestApp(context.Background(), Config{DataDir: t.TempDir(), AccountFactory: func(_ engine.AccountConfig, _ *telegram.UpdateState, _ func(context.Context, tg.UpdatesClass) error, _ func(int64)) (engine.Account, error) {
		starts.Add(1)
		return nil, errors.New("guest must not start accounts")
	}})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	configureMonitor(t, a)
	token, err := a.sessions.Create(context.Background(), "guest")
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodGet, "/api/dialogs", nil)
	req.AddCookie(&http.Cookie{Name: a.sessions.CookieName(), Value: token})
	rec := httptest.NewRecorder()
	a.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden || starts.Load() != 0 {
		t.Fatalf("guest browse=%d starts=%d", rec.Code, starts.Load())
	}
}

func intPointer(value int) *int { return &value }

func TestDialogsHTTPClassifiesUnavailableChatsIncludingDisabledDM(t *testing.T) {
	factory := func(_ engine.AccountConfig, _ *telegram.UpdateState, handler func(context.Context, tg.UpdatesClass) error, _ func(int64)) (engine.Account, error) {
		return &dialogAppAccount{fixtureAccount: fixtureAccount{handle: handler}, active: []telegram.Dialog{
			{ID: "-1000000000042", Type: "channel", Name: "Terms", Access: telegram.DialogAccess{State: "restricted", Code: "terms", Detail: "Telegram restriction"}},
			{ID: "55", Type: "user", Name: "Deleted account", Access: telegram.DialogAccess{State: "deleted", Code: "USER_DELETED"}},
			{ID: "56", Type: "user", Name: "Normal DM", Access: telegram.DialogAccess{State: "ok"}},
			{ID: "-57", Type: "group", Name: "Readable again", Access: telegram.DialogAccess{State: "ok"}},
		}}, nil
	}
	a, err := newConfiguredTestApp(context.Background(), Config{DataDir: t.TempDir(), AccountFactory: factory})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	configureMonitor(t, a)
	if _, err = a.db.Writer.Exec(`INSERT INTO chat_access(chat_id,state,checked_at,updated_at) VALUES('-57','inaccessible',1,1)`); err != nil {
		t.Fatal(err)
	}
	token, err := a.sessions.Create(context.Background(), "admin")
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodGet, "/api/dialogs", nil)
	req.AddCookie(&http.Cookie{Name: a.sessions.CookieName(), Value: token})
	rec := httptest.NewRecorder()
	a.Handler().ServeHTTP(rec, req)
	if rec.Code != 200 {
		t.Fatalf("dialogs=%d %s", rec.Code, rec.Body.String())
	}
	var body struct {
		Dialogs []map[string]any `json:"dialogs"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if len(body.Dialogs) != 3 {
		t.Fatalf("rows=%+v", body.Dialogs)
	}
	for _, row := range body.Dialogs {
		access := row["access"].(map[string]any)
		want := map[string]string{"-1000000000042": "restricted", "55": "deleted", "-57": "ok"}[row["id"].(string)]
		if access["state"] != want {
			t.Fatalf("access=%+v", row)
		}
		if row["id"] == "55" && row["dmDisabled"] != true {
			t.Fatal("DM settings bypassed")
		}
		var state string
		if err := a.db.Reader.QueryRow(`SELECT state FROM chat_access WHERE chat_id=?`, row["id"]).Scan(&state); err != nil || state != want {
			t.Fatalf("durable state=%s want=%s err=%v", state, want, err)
		}
	}
}

type boundedDialogAccount struct{ dialogAppAccount }

func (a *boundedDialogAccount) Dialogs(_ context.Context, limit int, archived bool) ([]telegram.Dialog, error) {
	if archived {
		return nil, nil
	}
	items := a.active
	if limit >= 0 && len(items) > limit {
		items = items[:limit]
	}
	return items, nil
}

func TestDialogsHTTPUsesCompleteEvidenceBeyond500Chats(t *testing.T) {
	items := make([]telegram.Dialog, 501)
	for i := range items {
		items[i] = telegram.Dialog{ID: fmt.Sprintf("-%d", i+1), Name: "Chat", Type: "group", Access: telegram.DialogAccess{State: "ok"}}
	}
	a, err := newConfiguredTestApp(context.Background(), Config{DataDir: t.TempDir(), AccountFactory: func(_ engine.AccountConfig, _ *telegram.UpdateState, handler func(context.Context, tg.UpdatesClass) error, _ func(int64)) (engine.Account, error) {
		return &boundedDialogAccount{dialogAppAccount{fixtureAccount: fixtureAccount{handle: handler}, active: items}}, nil
	}})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	configureMonitor(t, a)
	token, err := a.sessions.Create(context.Background(), "admin")
	if err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest("GET", "/api/dialogs", nil)
	r.AddCookie(&http.Cookie{Name: a.sessions.CookieName(), Value: token})
	w := httptest.NewRecorder()
	a.Handler().ServeHTTP(w, r)
	var body struct {
		Dialogs []any `json:"dialogs"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if w.Code != 200 || len(body.Dialogs) != 501 {
		t.Fatalf("truncated evidence: code=%d dialogs=%d", w.Code, len(body.Dialogs))
	}
}
