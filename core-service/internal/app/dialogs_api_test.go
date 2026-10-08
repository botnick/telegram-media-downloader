package app

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/botnick/telegram-media-downloader/core-service/internal/engine"
	"github.com/botnick/telegram-media-downloader/core-service/internal/telegram"
	"github.com/gotd/td/tg"
)

type dialogAppAccount struct {
	fixtureAccount
	active, archived []telegram.Dialog
}

func (a *dialogAppAccount) Dialogs(_ context.Context, _ int, archived bool) ([]telegram.Dialog, error) {
	if archived {
		return a.archived, nil
	}
	return a.active, nil
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
}

func intPointer(value int) *int { return &value }
