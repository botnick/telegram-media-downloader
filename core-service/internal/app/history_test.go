package app

import (
	"context"
	"encoding/json"
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

type historyTestAccount struct {
	recoveryTestAccount
	page func(context.Context, telegram.HistoryRequest) (telegram.HistoryPage, error)
}

func (a *historyTestAccount) HistoryPage(ctx context.Context, _ telegram.Dialog, r telegram.HistoryRequest) (telegram.HistoryPage, error) {
	return a.page(ctx, r)
}

func historyFactory(t *testing.T, page func(context.Context, telegram.HistoryRequest) (telegram.HistoryPage, error), made chan *historyTestAccount, transfers *atomic.Int64) engine.Factory {
	t.Helper()
	return func(c engine.AccountConfig, _ *telegram.UpdateState, handler func(context.Context, tg.UpdatesClass) error, _ func(int64)) (engine.Account, error) {
		account := &historyTestAccount{recoveryTestAccount: recoveryTestAccount{id: c.ID, dialogs: []telegram.Dialog{{ID: "-1000000000042", Name: "Native history", Type: "channel"}}, fixtureAccount: fixtureAccount{handle: handler, download: func(_ context.Context, _ telegram.Attachment, w io.Writer) error {
			transfers.Add(1)
			_, err := w.Write([]byte("live"))
			return err
		}}}, page: page}
		if made != nil {
			made <- account
		}
		return account, nil
	}
}

func historyMessages(ids ...int) telegram.HistoryPage {
	page := telegram.HistoryPage{Entities: &tg.Updates{}}
	for _, id := range ids {
		m := updateFixture().Updates[0].(*tg.UpdateNewChannelMessage).Message.(*tg.Message)
		m.ID = id
		// Same document in different messages must share one physical transfer.
		page.Messages = append(page.Messages, m)
		page.NextOffset = id
	}
	if len(ids) == 0 {
		page.Done = true
	}
	return page
}

func historyHTTP(t *testing.T, a *App, method, path, body string) map[string]any {
	t.Helper()
	token, err := a.sessions.Create(context.Background(), "admin")
	if err != nil {
		t.Fatal(err)
	}
	rec := requestPurge(a, token, method, path, body)
	if rec.Code != 200 {
		t.Fatalf("%s %s: %d %s", method, path, rec.Code, rec.Body.String())
	}
	var result map[string]any
	if err = json.Unmarshal(rec.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	return result
}

func historyFinished(t *testing.T, a *App, id string) historyJob {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		a.historyMu.Lock()
		j := *a.historyJobs[id]
		a.historyMu.Unlock()
		if j.State != "running" {
			return j
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("history job did not finish")
	return historyJob{}
}

func configureDisabledHistory(t *testing.T, a *App) {
	t.Helper()
	configureMonitor(t, a)
	cfg, err := a.config.Load(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	cfg["groups"].([]any)[0].(map[string]any)["enabled"] = false
	if err = a.config.Save(context.Background(), cfg); err != nil {
		t.Fatal(err)
	}
}

func waitHistoryDownloads(t *testing.T, a *App, want int) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		var count int
		if err := a.db.Reader.QueryRow(`SELECT count(*) FROM downloads`).Scan(&count); err != nil {
			t.Fatal(err)
		}
		if count == want {
			return
		}
		time.Sleep(time.Millisecond)
	}
	rows, _ := a.db.Reader.Query(`SELECT status,error,origin FROM tgdl_work`)
	if rows != nil {
		defer rows.Close()
		for rows.Next() {
			var status, origin string
			var err any
			rows.Scan(&status, &err, &origin)
			t.Log(status, origin, err)
		}
	}
	t.Fatal("history downloads did not finish")
}

func TestHistoryHTTPDownloadsDisabledGroupWithoutStartingLiveMonitor(t *testing.T) {
	var transfers atomic.Int64
	made := make(chan *historyTestAccount, 2)
	var pages atomic.Int64
	page := func(_ context.Context, r telegram.HistoryRequest) (telegram.HistoryPage, error) {
		pages.Add(1)
		switch r.OffsetID {
		case 0:
			return historyMessages(10), nil
		case 10:
			return historyMessages(9), nil
		case 9:
			return historyMessages(), nil
		}
		return telegram.HistoryPage{}, fmt.Errorf("unexpected offset %d", r.OffsetID)
	}
	a, err := newConfiguredTestApp(context.Background(), Config{DataDir: t.TempDir(), AccountFactory: historyFactory(t, page, made, &transfers)})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	configureDisabledHistory(t, a)
	res := historyHTTP(t, a, "POST", "/api/history", `{"groupId":"-1000000000042","limit":0,"mode":"rescan"}`)
	id := res["jobId"].(string)
	j := historyFinished(t, a, id)
	if j.State != "done" || j.Processed != 2 || j.Downloaded != 2 {
		t.Fatalf("job=%+v", j)
	}
	waitHistoryDownloads(t, a, 2)
	if transfers.Load() != 1 || pages.Load() != 3 {
		t.Fatalf("transfers=%d pages=%d", transfers.Load(), pages.Load())
	}
	status, err := a.monitor.Status(context.Background())
	if err != nil || status["state"] != "stopped" {
		t.Fatalf("monitor=%v %v", status, err)
	}
	cfg, err := a.config.Load(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if cfg["groups"].([]any)[0].(map[string]any)["enabled"] != false {
		t.Fatal("history enabled live monitoring")
	}
	var path string
	if err = a.db.Reader.QueryRow(`SELECT file_path FROM downloads LIMIT 1`).Scan(&path); err != nil {
		t.Fatal(err)
	}
	bytes, err := os.ReadFile(filepath.Join(a.dataDir, "downloads", path))
	if err != nil || string(bytes) != "live" {
		t.Fatalf("download=%q %v", bytes, err)
	}
	account := <-made
	if err = account.handle(context.Background(), updateFixture()); err != nil {
		t.Fatal(err)
	}
	var count int
	a.db.Reader.QueryRow(`SELECT count(*) FROM tgdl_work`).Scan(&count)
	if count != 2 {
		t.Fatalf("live update created work while monitor off: %d", count)
	}
}

func TestHistoryShutdownResumesCommittedCursorWithoutRequeue(t *testing.T) {
	dir := t.TempDir()
	entered := make(chan struct{}, 1)
	var transfers atomic.Int64
	page := func(ctx context.Context, r telegram.HistoryRequest) (telegram.HistoryPage, error) {
		if r.OffsetID == 0 {
			return historyMessages(10), nil
		}
		entered <- struct{}{}
		<-ctx.Done()
		return telegram.HistoryPage{}, ctx.Err()
	}
	a, err := newConfiguredTestApp(context.Background(), Config{DataDir: dir, AccountFactory: historyFactory(t, page, nil, &transfers)})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	configureDisabledHistory(t, a)
	res := historyHTTP(t, a, "POST", "/api/history", `{"groupId":"-1000000000042","limit":0,"mode":"rescan"}`)
	id := res["jobId"].(string)
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("second page never started")
	}
	if err = a.Close(); err != nil {
		t.Fatal(err)
	}
	var resumed atomic.Int64
	page = func(_ context.Context, r telegram.HistoryRequest) (telegram.HistoryPage, error) {
		resumed.Add(1)
		if r.OffsetID == 10 {
			return historyMessages(9), nil
		}
		if r.OffsetID == 9 {
			return historyMessages(), nil
		}
		return telegram.HistoryPage{}, fmt.Errorf("lost checkpoint %d", r.OffsetID)
	}
	b, err := New(context.Background(), Config{DataDir: dir, AccountFactory: historyFactory(t, page, nil, &transfers)})
	if err != nil {
		t.Fatal(err)
	}
	defer b.Close()
	j := historyFinished(t, b, id)
	if j.State != "done" || j.Processed != 2 || j.Downloaded != 2 {
		t.Fatalf("resumed=%+v", j)
	}
	waitHistoryDownloads(t, b, 2)
	if resumed.Load() != 2 {
		t.Fatalf("resumed pages=%d", resumed.Load())
	}
}

func TestHistorySingleFlightCancellationAndPromotion(t *testing.T) {
	entered := make(chan struct{}, 1)
	var factories, transfers atomic.Int64
	page := func(ctx context.Context, r telegram.HistoryRequest) (telegram.HistoryPage, error) {
		entered <- struct{}{}
		<-ctx.Done()
		return telegram.HistoryPage{}, ctx.Err()
	}
	factory := historyFactory(t, page, nil, &transfers)
	a, err := newConfiguredTestApp(context.Background(), Config{DataDir: t.TempDir(), AccountFactory: func(c engine.AccountConfig, s *telegram.UpdateState, h func(context.Context, tg.UpdatesClass) error, g func(int64)) (engine.Account, error) {
		factories.Add(1)
		return factory(c, s, h, g)
	}})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	configureDisabledHistory(t, a)
	res := historyHTTP(t, a, "POST", "/api/history", `{"groupId":"-1000000000042"}`)
	id := res["jobId"].(string)
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("history did not start")
	}
	token, _ := a.sessions.Create(context.Background(), "admin")
	if r := requestPurge(a, token, "POST", "/api/history", `{"groupId":"-1000000000042"}`); r.Code != 409 {
		t.Fatalf("double start=%d %s", r.Code, r.Body.String())
	}
	if r := requestPurge(a, token, "DELETE", "/api/history/"+id, ""); r.Code != 409 {
		t.Fatalf("running delete=%d", r.Code)
	}
	if r := monitorRequest(t, a, "/api/monitor/start"); r.Code != 200 {
		t.Fatal(r.Body.String())
	}
	if factories.Load() != 1 {
		t.Fatalf("promotion created %d account clients", factories.Load())
	}
	if r := monitorRequest(t, a, "/api/monitor/stop"); r.Code != 200 {
		t.Fatal(r.Body.String())
	}
	a.historyMu.Lock()
	state := a.historyJobs[id].State
	a.historyMu.Unlock()
	if state != "running" {
		t.Fatalf("stopping live subscription interrupted history: %s", state)
	}
	if r := monitorRequest(t, a, "/api/monitor/start"); r.Code != 200 {
		t.Fatal(r.Body.String())
	}
	historyHTTP(t, a, "POST", "/api/history/"+id+"/cancel", `{}`)
	j := historyFinished(t, a, id)
	if j.State != "cancelled" || !j.Cancelled {
		t.Fatalf("cancel=%+v", j)
	}
	status, _ := a.monitor.Status(context.Background())
	if status["state"] != "running" {
		t.Fatalf("history cancellation stopped live monitor: %v", status)
	}
}

func TestHistoryRescanReusesValidBytesAndRepairsMissingFile(t *testing.T) {
	var transfers atomic.Int64
	page := func(_ context.Context, r telegram.HistoryRequest) (telegram.HistoryPage, error) {
		p := historyMessages(10)
		p.Done = true
		return p, nil
	}
	a, err := newConfiguredTestApp(context.Background(), Config{DataDir: t.TempDir(), AccountFactory: historyFactory(t, page, nil, &transfers)})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	configureDisabledHistory(t, a)
	for run := 1; run <= 3; run++ {
		if run == 3 {
			var path string
			if err = a.db.Reader.QueryRow(`SELECT file_path FROM downloads LIMIT 1`).Scan(&path); err != nil {
				t.Fatal(err)
			}
			if err = os.Remove(filepath.Join(a.dataDir, "downloads", path)); err != nil {
				t.Fatal(err)
			}
		}
		res := historyHTTP(t, a, "POST", "/api/history", `{"groupId":"-1000000000042","mode":"rescan"}`)
		j := historyFinished(t, a, res["jobId"].(string))
		if j.State != "done" || j.Downloaded != 1 {
			t.Fatalf("rescan=%+v", j)
		}
		deadline := time.Now().Add(5 * time.Second)
		for {
			var state string
			a.db.Reader.QueryRow(`SELECT status FROM tgdl_work WHERE message_id=10`).Scan(&state)
			if state == "completed" {
				break
			}
			if time.Now().After(deadline) {
				t.Fatalf("rescan work=%s", state)
			}
			time.Sleep(time.Millisecond)
		}
		want := int64(1)
		if run == 3 {
			want = 2
		}
		if transfers.Load() != want {
			t.Fatalf("run=%d transfers=%d want=%d", run, transfers.Load(), want)
		}
	}
}

func TestHistoryModesUseCatalogBoundsAndRegisterUnknownGroupsDisabled(t *testing.T) {
	for _, mode := range []string{"pull-older", "catch-up", "rescan"} {
		t.Run(mode, func(t *testing.T) {
			var transfers atomic.Int64
			requests := make(chan telegram.HistoryRequest, 1)
			page := func(_ context.Context, r telegram.HistoryRequest) (telegram.HistoryPage, error) {
				requests <- r
				return historyMessages(), nil
			}
			a, err := newConfiguredTestApp(context.Background(), Config{DataDir: t.TempDir(), AccountFactory: historyFactory(t, page, nil, &transfers)})
			if err != nil {
				t.Fatal(err)
			}
			defer a.Close()
			configureDisabledHistory(t, a)
			cfg, err := a.config.Load(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			cfg["groups"] = []any{}
			if err = a.config.Save(context.Background(), cfg); err != nil {
				t.Fatal(err)
			}
			if _, err = a.db.Writer.Exec(`INSERT INTO downloads(group_id,group_name,message_id,file_name,file_path,file_type,file_size,status) VALUES('-1000000000042','Old',-5,'a','a','document',4,'completed'),('-1000000000042','Old',10,'b','b','document',4,'completed'),('-1000000000042','Old',20,'c','c','document',4,'completed'),('-1000000000042','Old',1,'story-old','story-old','stories',4,'completed'),('-1000000000042','Old',4294967396,'story','story','stories',4,'completed')`); err != nil {
				t.Fatal(err)
			}
			res := historyHTTP(t, a, "POST", "/api/history", fmt.Sprintf(`{"groupId":"-1000000000042","mode":%q}`, mode))
			j := historyFinished(t, a, res["jobId"].(string))
			if j.State != "done" {
				t.Fatalf("job=%+v", j)
			}
			r := <-requests
			if mode == "pull-older" && (r.OffsetID != 10 || r.MinID != 0) || mode == "catch-up" && (r.OffsetID != 0 || r.MinID != 20) || mode == "rescan" && (r.OffsetID != 0 || r.MinID != 0) {
				t.Fatalf("%s bounds=%+v", mode, r)
			}
			cfg, err = a.config.Load(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			groups := configuredGroupList(cfg)
			if len(groups) != 1 || groups[0]["enabled"] != false || groups[0]["name"] != "Native history" {
				t.Fatalf("registered=%v", groups)
			}
		})
	}
}

func TestHistoryCheckpointFailureRollsBackQueuedMessage(t *testing.T) {
	var transfers atomic.Int64
	page := func(context.Context, telegram.HistoryRequest) (telegram.HistoryPage, error) {
		p := historyMessages(10)
		p.Done = true
		return p, nil
	}
	a, err := newConfiguredTestApp(context.Background(), Config{DataDir: t.TempDir(), AccountFactory: historyFactory(t, page, nil, &transfers)})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	configureDisabledHistory(t, a)
	if _, err = a.db.Writer.Exec(`CREATE TRIGGER reject_history_checkpoint BEFORE UPDATE ON tgdl_history_jobs WHEN json_extract(NEW.payload,'$.job.processed')>0 BEGIN SELECT RAISE(FAIL,'checkpoint rejected'); END`); err != nil {
		t.Fatal(err)
	}
	res := historyHTTP(t, a, "POST", "/api/history", `{"groupId":"-1000000000042"}`)
	j := historyFinished(t, a, res["jobId"].(string))
	if j.State != "error" || j.Processed != 0 || j.Downloaded != 0 || j.Error == nil || !strings.Contains(*j.Error, "checkpoint rejected") {
		t.Fatalf("failed checkpoint=%+v", j)
	}
	var rows int
	if err = a.db.Reader.QueryRow(`SELECT count(*) FROM tgdl_work`).Scan(&rows); err != nil || rows != 0 || transfers.Load() != 0 {
		t.Fatalf("uncommitted message escaped: rows=%d transfers=%d %v", rows, transfers.Load(), err)
	}
}

func TestHistoryBackpressureHonorsConfiguredStallDeadline(t *testing.T) {
	var transfers, pages atomic.Int64
	page := func(context.Context, telegram.HistoryRequest) (telegram.HistoryPage, error) {
		pages.Add(1)
		return historyMessages(10), nil
	}
	a, err := newConfiguredTestApp(context.Background(), Config{DataDir: t.TempDir(), AccountFactory: historyFactory(t, page, nil, &transfers)})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	configureDisabledHistory(t, a)
	cfg, err := a.config.Load(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	ensureMap(cfg, "advanced")["history"] = map[string]any{"backpressureCap": 1, "backpressureMaxWaitMs": 1}
	if err = a.config.Save(context.Background(), cfg); err != nil {
		t.Fatal(err)
	}
	if _, err = a.db.Writer.Exec(`UPDATE tgdl_queue_state SET paused=1`); err != nil {
		t.Fatal(err)
	}
	res := historyHTTP(t, a, "POST", "/api/history", `{"groupId":"-1000000000042"}`)
	j := historyFinished(t, a, res["jobId"].(string))
	if j.State != "error" || j.Processed != 1 || j.Error == nil || !strings.Contains(*j.Error, "stall deadline") || pages.Load() != 1 || transfers.Load() != 0 {
		t.Fatalf("backpressure job=%+v pages=%d transfers=%d", j, pages.Load(), transfers.Load())
	}
}

func TestPurgeJoinsJobsOnlyTransferAndRemovesResumableHistory(t *testing.T) {
	dir := t.TempDir()
	entered := make(chan struct{}, 1)
	var factories atomic.Int64
	factory := func(c engine.AccountConfig, _ *telegram.UpdateState, handler func(context.Context, tg.UpdatesClass) error, _ func(int64)) (engine.Account, error) {
		factories.Add(1)
		return &historyTestAccount{recoveryTestAccount: recoveryTestAccount{id: c.ID, dialogs: []telegram.Dialog{{ID: "-1000000000042", Name: "History", Type: "channel"}}, fixtureAccount: fixtureAccount{handle: handler, download: func(ctx context.Context, _ telegram.Attachment, w io.Writer) error {
			if _, err := w.Write([]byte("li")); err != nil {
				return err
			}
			entered <- struct{}{}
			<-ctx.Done()
			return ctx.Err()
		}}}, page: func(ctx context.Context, r telegram.HistoryRequest) (telegram.HistoryPage, error) {
			if r.OffsetID == 0 {
				return historyMessages(10), nil
			}
			<-ctx.Done()
			return telegram.HistoryPage{}, ctx.Err()
		}}, nil
	}
	a, err := newConfiguredTestApp(context.Background(), Config{DataDir: dir, AccountFactory: factory})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	configureDisabledHistory(t, a)
	historyHTTP(t, a, "POST", "/api/history", `{"groupId":"-1000000000042","limit":0}`)
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("history transfer did not start")
	}
	status, err := a.monitor.Status(context.Background())
	if err != nil || status["state"] != "stopped" {
		t.Fatalf("jobs-only status=%v %v", status, err)
	}
	token, _ := a.sessions.Create(context.Background(), "admin")
	if response := requestPurge(a, token, "DELETE", "/api/groups/-1000000000042/purge", ""); response.Code != 200 {
		t.Fatal(response.Body.String())
	}
	done := make(chan struct{})
	go func() { a.purgeWG.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("purge did not cancel/join the jobs-only transfer")
	}
	assertPurgeDone(t, a, "group:-1000000000042")
	if err = a.Close(); err != nil {
		t.Fatal(err)
	}
	b, err := New(context.Background(), Config{DataDir: dir, AccountFactory: factory})
	if err != nil {
		t.Fatal(err)
	}
	defer b.Close()
	for _, query := range []string{`SELECT count(*) FROM downloads`, `SELECT count(*) FROM tgdl_work`, `SELECT count(*) FROM tgdl_history_jobs WHERE state='running'`} {
		var rows int
		if err = b.db.Reader.QueryRow(query).Scan(&rows); err != nil || rows != 0 {
			t.Fatalf("purge resurrected rows=%d %v", rows, err)
		}
	}
	if factories.Load() != 1 {
		t.Fatalf("purged history opened accounts on restart: %d", factories.Load())
	}
}
