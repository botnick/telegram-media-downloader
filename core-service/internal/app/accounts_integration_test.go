package app

import (
	"bytes"
	"context"
	"crypto/sha1"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/botnick/telegram-media-downloader/core-service/internal/accounts"
	"github.com/botnick/telegram-media-downloader/core-service/internal/engine"
	nativesession "github.com/botnick/telegram-media-downloader/core-service/internal/session"
	"github.com/botnick/telegram-media-downloader/core-service/internal/telegram"
	gotdsession "github.com/gotd/td/session"
	gotdauth "github.com/gotd/td/telegram/auth"
	"github.com/gotd/td/tg"
)

type httpLoginFixture struct {
	cfg    telegram.GotdConfig
	closed *atomic.Bool
}

func (f *httpLoginFixture) Run(ctx context.Context, fn func(context.Context, telegram.LoginRPC) error) error {
	defer f.closed.Store(true)
	storage, err := nativesession.NewEncryptedStorage(f.cfg.SessionPath, f.cfg.SessionSecret)
	if err != nil {
		return err
	}
	key := bytes.Repeat([]byte{42}, 256)
	sum := sha1.Sum(key)
	if err = (&gotdsession.Loader{Storage: storage}).Save(ctx, &gotdsession.Data{DC: 2, Addr: "149.154.167.51:443", AuthKey: key, AuthKeyID: sum[12:]}); err != nil {
		return err
	}
	return fn(ctx, f)
}
func (f *httpLoginFixture) SendCode(_ context.Context, phone string, _ gotdauth.SendCodeOptions) (tg.AuthSentCodeClass, error) {
	if phone != "+10000000001" {
		return nil, errors.New("unexpected phone")
	}
	return &tg.AuthSentCode{PhoneCodeHash: "private-hash"}, nil
}
func (f *httpLoginFixture) SignIn(_ context.Context, phone, code, hash string) (*tg.AuthAuthorization, error) {
	if phone != "+10000000001" || code != "12345" || hash != "private-hash" {
		return nil, errors.New("incorrect authentication arguments")
	}
	return &tg.AuthAuthorization{User: &tg.User{ID: 42, FirstName: "Alice", LastName: "Example", Username: "alice_ex", Phone: "10000000001"}}, nil
}
func (*httpLoginFixture) Password(context.Context, string) (*tg.AuthAuthorization, error) {
	return nil, errors.New("unexpected password request")
}
func (*httpLoginFixture) PasswordHint(context.Context) (string, error) {
	return "", errors.New("unexpected password hint request")
}

type wizardMonitorAccount struct {
	fixtureAccount
	fingerprint string
}

func (a *wizardMonitorAccount) Fingerprint() string { return a.fingerprint }

func TestHTTPAccountLoginPublishesEncryptedSessionAndRefreshesMonitorOnce(t *testing.T) {
	var loginClosed atomic.Bool
	var created atomic.Int64
	factory := func(cfg engine.AccountConfig, _ *telegram.UpdateState, handler func(context.Context, tg.UpdatesClass) error, _ func(int64)) (engine.Account, error) {
		created.Add(1)
		if cfg.ID == "alice" && !loginClosed.Load() {
			t.Error("monitor acquired key before login connection closed")
		}
		return &wizardMonitorAccount{fingerprint: cfg.ID, fixtureAccount: fixtureAccount{handle: handler, download: func(context.Context, telegram.Attachment, io.Writer) error { return nil }}}, nil
	}
	login := func(cfg telegram.GotdConfig) (telegram.LoginClient, error) {
		return &httpLoginFixture{cfg: cfg, closed: &loginClosed}, nil
	}
	a, err := newConfiguredTestApp(context.Background(), Config{DataDir: t.TempDir(), AccountFactory: factory, AccountLoginFactory: login})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	configureMonitor(t, a)
	if w := monitorRequest(t, a, "/api/monitor/start"); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	begin := accountRequest(t, a, "POST", "/api/accounts/auth/begin", `{"label":"Alice"}`)
	var result struct {
		SessionID string `json:"sessionId"`
	}
	if err = json.Unmarshal(begin.Body.Bytes(), &result); err != nil || result.SessionID == "" {
		t.Fatalf("begin: %d %s", begin.Code, begin.Body.String())
	}
	phone := accountRequest(t, a, "POST", "/api/accounts/auth/phone", `{"sessionId":"`+result.SessionID+`","phone":"+10000000001"}`)
	if phone.Code != 200 || !strings.Contains(phone.Body.String(), `"state":"code"`) {
		t.Fatalf("phone: %d %s", phone.Code, phone.Body.String())
	}
	code := accountRequest(t, a, "POST", "/api/accounts/auth/code", `{"sessionId":"`+result.SessionID+`","code":"12345"}`)
	if code.Code != 200 || !strings.Contains(code.Body.String(), `"state":"done"`) {
		t.Fatalf("code: %d %s", code.Code, code.Body.String())
	}
	raw, err := os.ReadFile(filepath.Join(a.dataDir, "sessions", "native", "alice.enc"))
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(raw, []byte("AuthKey")) || bytes.Contains(raw, []byte("12345")) {
		t.Fatal("session stored credentials as plaintext")
	}
	storage, err := nativesession.NewEncryptedStorage(filepath.Join(a.dataDir, "sessions", "native", "alice.enc"), "fixture-secret")
	if err != nil {
		t.Fatal(err)
	}
	loaded, err := (&gotdsession.Loader{Storage: storage}).Load(context.Background())
	if err != nil || len(loaded.AuthKey) != 256 {
		t.Fatalf("native session cannot reopen: %v", err)
	}
	before := created.Load()
	for i := 0; i < 3; i++ {
		w := accountRequest(t, a, "GET", "/api/accounts/auth/"+result.SessionID, "")
		if w.Code != 200 {
			t.Fatal(w.Body.String())
		}
	}
	if created.Load() != before {
		t.Fatal("polling restarted account connections")
	}
	status, err := a.monitor.Status(context.Background())
	if err != nil || status["state"] != "running" || status["accounts"] != 2 {
		t.Fatalf("monitor did not acquire new account: %+v %v", status, err)
	}
	list := accountRequest(t, a, "GET", "/api/accounts", "")
	if !strings.Contains(list.Body.String(), "Alice Example") {
		t.Fatal("account metadata missing")
	}
	removed := accountRequest(t, a, "DELETE", "/api/accounts/alice", "")
	if removed.Code != 200 {
		t.Fatalf("remove: %d %s", removed.Code, removed.Body.String())
	}
	if _, err = os.Stat(filepath.Join(a.dataDir, "sessions", "native", "alice.enc")); !os.IsNotExist(err) {
		t.Fatal("deleted session still present")
	}
	status, err = a.monitor.Status(context.Background())
	if err != nil || status["state"] != "running" || status["accounts"] != 1 {
		t.Fatalf("remaining account not resumed: %+v %v", status, err)
	}
}

func TestAccountPublicationCollisionDoesNotStopHealthyMonitor(t *testing.T) {
	factory := func(cfg engine.AccountConfig, _ *telegram.UpdateState, handler func(context.Context, tg.UpdatesClass) error, _ func(int64)) (engine.Account, error) {
		return &wizardMonitorAccount{fingerprint: cfg.ID, fixtureAccount: fixtureAccount{handle: handler, download: func(context.Context, telegram.Attachment, io.Writer) error { return nil }}}, nil
	}
	a, err := newConfiguredTestApp(context.Background(), Config{DataDir: t.TempDir(), AccountFactory: factory})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	configureMonitor(t, a)
	if rec := monitorRequest(t, a, "/api/monitor/start"); rec.Code != 200 {
		t.Fatalf("start=%d %s", rec.Code, rec.Body.String())
	}
	pending := filepath.Join(a.dataDir, "sessions", "pending", "collision.enc")
	if err = os.MkdirAll(filepath.Dir(pending), 0700); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(pending, []byte("pending collision"), 0600); err != nil {
		t.Fatal(err)
	}
	_, err = a.publishAccount(context.Background(), accounts.PendingAccount{SessionPath: pending, Label: "one", User: &tg.User{ID: 99, Username: "new_one"}})
	if err == nil || !strings.Contains(err.Error(), "already exists") {
		t.Fatalf("collision unexpectedly succeeded: %v", err)
	}
	status, err := a.monitor.Status(context.Background())
	if err != nil || status["state"] != "running" {
		t.Fatalf("collision stopped healthy monitor: %+v %v", status, err)
	}
}
