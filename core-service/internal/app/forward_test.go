package app

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/botnick/telegram-media-downloader/core-service/internal/engine"
	"github.com/botnick/telegram-media-downloader/core-service/internal/telegram"
	"github.com/gotd/td/bin"
	"github.com/gotd/td/tg"
	"github.com/gotd/td/tgerr"
)

type sentFile struct {
	account string
	req     telegram.SendFileRequest
	body    string
}

type fakeForwarder struct {
	observing      atomic.Bool
	mu             sync.Mutex
	sent           []sentFile
	forwardRequest []telegram.ForwardMessageRequest
	err            error
}

func (f *fakeForwarder) Observing() bool { return f.observing.Load() }

func (f *fakeForwarder) SendFile(_ context.Context, account string, req telegram.SendFileRequest) (string, int, error) {
	body, err := io.ReadAll(req.Body)
	if err != nil {
		return "", 0, err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.sent = append(f.sent, sentFile{account: account, req: req, body: string(body)})
	if account == "" {
		account = "default"
	}
	return account, 41, f.err
}
func (f *fakeForwarder) ForwardMessage(_ context.Context, account string, req telegram.ForwardMessageRequest) (string, int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.forwardRequest = append(f.forwardRequest, req)
	if req.ResultMessageID != nil {
		*req.ResultMessageID = 42
	}
	if account == "" {
		account = "default"
	}
	if !req.EditCaption {
		f.sent = append(f.sent, sentFile{account: account, req: telegram.SendFileRequest{Destination: req.Destination}})
	}
	return account, 42, f.err
}

func (f *fakeForwarder) calls() []sentFile {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]sentFile(nil), f.sent...)
}

func (f *fakeForwarder) forwards() []telegram.ForwardMessageRequest {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]telegram.ForwardMessageRequest(nil), f.forwardRequest...)
}

func (f *fakeForwarder) fail(err error) {
	f.mu.Lock()
	f.err = err
	f.mu.Unlock()
}

func eventually(t *testing.T, what string, check func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !check() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func forwardTestApp(t *testing.T, autoForward map[string]any) (*App, *fakeForwarder) {
	t.Helper()
	return forwardTestAppWith(t, autoForward, Config{})
}

// forwardTestAppWith lets a test hold the background forward workers off
// (RequireMonitorForwards with no running monitor) and drive jobs itself.
func forwardTestAppWith(t *testing.T, autoForward map[string]any, cfg Config) (*App, *fakeForwarder) {
	t.Helper()
	ctx := context.Background()
	cfg.DataDir, cfg.Output = t.TempDir(), io.Discard
	a, err := newConfiguredTestApp(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { a.Close() })
	stored, err := a.config.Load(ctx)
	if err != nil {
		t.Fatal(err)
	}
	stored["groups"] = []any{
		map[string]any{"id": "-1000000000123", "name": "Source", "enabled": true, "autoForward": autoForward, "forwardAccount": "acct2"},
		map[string]any{"id": "-1000000000456", "name": "Other", "enabled": true},
	}
	if err := a.config.Save(ctx, stored); err != nil {
		t.Fatal(err)
	}
	fake := &fakeForwarder{}
	fake.observing.Store(true)
	a.forwarder = fake
	return a, fake
}

func TestForwardProtectionInheritanceAndCaptionMethod(t *testing.T) {
	cfg := map[string]any{"forwarding": map[string]any{"protect": true}}
	group := map[string]any{"protect": true}
	route := map[string]any{"captionMode": "native", "protect": false}
	settings := effectiveForwardProtection(route, group, route, 7, cfg)
	if settings["protect"] != true {
		t.Fatalf("group override lost: %#v", settings)
	}
	if customCaption(settings) {
		t.Fatal("source caption should permit native forwarding")
	}
	settings = effectiveForwardProtection(map[string]any{"protect": false}, group, route, 7, cfg)
	if settings["protect"] != true {
		t.Fatalf("legacy route override replaced group rule: %#v", settings)
	}
	if customCaption(map[string]any{"captionMode": "native"}) {
		t.Fatal("native caption should permit direct forwarding")
	}
	if normalized, err := normalizedAutoForward(nil, map[string]any{"directForward": false}); err != nil || normalized["directForward"] != false {
		t.Fatalf("direct forward opt-out was not preserved: %#v, %v", normalized, err)
	}
}

func TestDirectScanQueueIsDurableIdempotentAndDoesNotCreateDownloadWork(t *testing.T) {
	ctx := context.Background()
	a, _ := forwardTestApp(t, map[string]any{"enabled": true, "destination": "@Archive", "captionMode": "native", "scanRoute": "direct"})
	cfg, err := a.config.Load(ctx)
	if err != nil {
		t.Fatal(err)
	}
	settings, accountID, ok := directScanSettings(cfg, "-1000000000123")
	if !ok || accountID != "acct2" {
		t.Fatalf("direct scan settings=%v account=%q ok=%v", settings, accountID, ok)
	}
	message := docMessage(712, 123, 991, "captured message")
	if err := a.queueDirectScan(ctx, "-1000000000123", "Source", accountID, settings, cfg, message); err != nil {
		t.Fatal(err)
	}
	if err := a.queueDirectScan(ctx, "-1000000000123", "Source", accountID, settings, cfg, message); err != nil {
		t.Fatal(err)
	}
	var jobs, work int
	var filePath, stage string
	var sourceMessage []byte
	if err = a.db.Reader.QueryRowContext(ctx, `SELECT COUNT(*),MAX(file_path),MAX(stage),MAX(source_message) FROM tgdl_forward_queue WHERE group_id=? AND message_id=?`, "-1000000000123", 712).Scan(&jobs, &filePath, &stage, &sourceMessage); err != nil {
		t.Fatal(err)
	}
	var decoded tg.Message
	if err := decoded.Decode(&bin.Buffer{Buf: sourceMessage}); err != nil || decoded.ID != message.ID {
		t.Fatalf("saved fallback source message id=%d err=%v", decoded.ID, err)
	}
	if err = a.db.Reader.QueryRowContext(ctx, `SELECT COUNT(*) FROM tgdl_work WHERE group_id=? AND message_id=?`, "-1000000000123", 712).Scan(&work); err != nil {
		t.Fatal(err)
	}
	if jobs != 1 || filePath != "" || stage != "scan_direct" || work != 0 {
		t.Fatalf("jobs=%d path=%q stage=%q download work=%d", jobs, filePath, stage, work)
	}
}

func TestDirectForwardCanBeEnabledWithoutDeleteAfterForward(t *testing.T) {
	settings, err := normalizedAutoForward(nil, map[string]any{"directForward": true, "deleteAfterForward": false})
	if err != nil || settings["directForward"] != true {
		t.Fatalf("direct option should not require local deletion: %#v err=%v", settings, err)
	}
}

func TestQueuedForwardTriesNativeForwardBeforeUploadingLocalFile(t *testing.T) {
	a, fake := forwardTestApp(t, map[string]any{"enabled": true, "destination": "@Archive", "directForward": true, "deleteAfterForward": false, "captionMode": "native"})
	if err := os.MkdirAll(a.downloadsDir, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(a.downloadsDir, "native.bin"), []byte("media"), 0600); err != nil {
		t.Fatal(err)
	}
	a.forward(context.Background(), forwardJob{groupID: "-1000000000123", groupName: "Source", messageID: 28, path: "native.bin"})
	requests := fake.forwards()
	if len(requests) != 1 || requests[0].Destination != "@Archive" || requests[0].MessageID != 28 {
		t.Fatalf("native direct requests=%+v", requests)
	}
	if _, err := os.Stat(filepath.Join(a.downloadsDir, "native.bin")); err != nil {
		t.Fatalf("local media was removed with delete-after-forward off: %v", err)
	}
}

func TestDirectScanBackfillRemainsDedupedAfterForwardCompletes(t *testing.T) {
	ctx := context.Background()
	a, _ := forwardTestApp(t, map[string]any{"enabled": true, "destination": "@Archive", "captionMode": "native", "scanRoute": "direct"})
	cfg, err := a.config.Load(ctx)
	if err != nil {
		t.Fatal(err)
	}
	settings, accountID, ok := directScanSettings(cfg, "-1000000000123")
	if !ok {
		t.Fatal("direct scan settings not found")
	}
	message := docMessage(719, 123, 995, "captured message")
	if err := a.queueDirectScan(ctx, "-1000000000123", "Source", accountID, settings, cfg, message); err != nil {
		t.Fatal(err)
	}
	if _, err = a.db.Writer.ExecContext(ctx, `UPDATE tgdl_forward_queue SET stage='complete',status='forwarded' WHERE group_id=? AND message_id=?`, "-1000000000123", message.ID); err != nil {
		t.Fatal(err)
	}
	if err := a.queueDirectScan(ctx, "-1000000000123", "Source", accountID, settings, cfg, message); err != nil {
		t.Fatal(err)
	}
	var jobs int
	if err = a.db.Reader.QueryRowContext(ctx, `SELECT COUNT(*) FROM tgdl_forward_queue WHERE group_id=? AND message_id=?`, "-1000000000123", message.ID).Scan(&jobs); err != nil {
		t.Fatal(err)
	}
	if jobs != 1 {
		t.Fatalf("completed direct-forward job was enqueued again: jobs=%d", jobs)
	}
}

func TestManualForwardBackfillPagesOldRecordsAndSkipsDuplicates(t *testing.T) {
	ctx := context.Background()
	a, fake := forwardTestApp(t, map[string]any{"enabled": false, "destination": "@Archive"})
	if err := a.setForwardQueuePaused(ctx, true); err != nil {
		t.Fatal(err)
	}
	if _, err := a.db.Writer.ExecContext(ctx, `INSERT INTO downloads(group_id,group_name,message_id,file_name,file_size,status,file_path) VALUES
		('-1000000000123','Source',10,'local.bin',5,'completed','Source/documents/local.bin'),
		('-1000000000123','Source',20,'archived.bin',5,'completed',NULL)`); err != nil {
		t.Fatal(err)
	}
	token, err := a.sessions.Create(ctx, "admin")
	if err != nil {
		t.Fatal(err)
	}
	call := func(payload string) map[string]any {
		t.Helper()
		req := httptest.NewRequest(http.MethodPost, "/api/forward-queue/backfill", strings.NewReader(payload))
		req.AddCookie(&http.Cookie{Name: a.sessions.CookieName(), Value: token})
		response := httptest.NewRecorder()
		a.Handler().ServeHTTP(response, req)
		if response.Code != http.StatusAccepted {
			t.Fatalf("backfill status=%d body=%s", response.Code, response.Body.String())
		}
		var result map[string]any
		if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
			t.Fatal(err)
		}
		return result
	}
	first := call(`{"groupId":"-1000000000123","destination":"@Archive","limit":1}`)
	if first["queued"] != float64(1) || first["hasMore"] != true {
		t.Fatalf("first batch=%#v", first)
	}
	cursor := int(first["nextBeforeMessageId"].(float64))
	second := call(fmt.Sprintf(`{"groupId":"-1000000000123","destination":"@Archive","beforeMessageId":%d,"limit":1}`, cursor))
	if second["queued"] != float64(1) || second["hasMore"] != false {
		t.Fatalf("second batch=%#v", second)
	}
	repeated := call(`{"groupId":"-1000000000123","destination":"@Archive","limit":1}`)
	if repeated["queued"] != float64(0) || repeated["skipped"] != float64(1) {
		t.Fatalf("repeated batch=%#v", repeated)
	}
	var jobs, archived, direct int
	if err := a.db.Reader.QueryRowContext(ctx, `SELECT COUNT(*),SUM(CASE WHEN COALESCE(file_path,'')='' THEN 1 ELSE 0 END),SUM(CASE WHEN stage='manual_direct' THEN 1 ELSE 0 END) FROM tgdl_forward_queue WHERE group_id='-1000000000123' AND status='pending'`).Scan(&jobs, &archived, &direct); err != nil {
		t.Fatal(err)
	}
	if jobs != 2 || archived != 1 || direct != 2 {
		t.Fatalf("queued records=%d archived=%d direct-first=%d", jobs, archived, direct)
	}
	var status string
	if err := a.setForwardQueuePaused(ctx, false); err != nil {
		t.Fatal(err)
	}
	job, err := a.claimForward(ctx)
	if err != nil || job == nil {
		t.Fatalf("claim manual forward=%+v err=%v", job, err)
	}
	a.forward(ctx, *job)
	if len(fake.forwards()) != 1 {
		t.Fatalf("manual direct requests=%d", len(fake.forwards()))
	}
	if err := a.db.Reader.QueryRowContext(ctx, `SELECT status FROM tgdl_forward_queue WHERE id=?`, job.queueID).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != "forwarded" {
		t.Fatalf("manual forward status=%q", status)
	}
}

func TestLiveDirectScanRouteBypassesLocalMediaDownload(t *testing.T) {
	a, _ := forwardTestApp(t, map[string]any{"enabled": true, "destination": "@Archive", "captionMode": "native", "scanRoute": "direct"})
	var downloads atomic.Int32
	transport := mediaTransport(func(context.Context, telegram.Attachment, io.Writer) error {
		downloads.Add(1)
		return errors.New("direct route must not download")
	})
	work := &engine.Work{GroupID: "-1000000000123", GroupName: "Source", AccountID: "acct1", Origin: "live"}
	if err := a.ingestWorkWithForward(context.Background(), work, docMessage(715, 123, 993, ""), transport, nil); err != nil {
		t.Fatal(err)
	}
	var queued, downloadWork int
	if err := a.db.Reader.QueryRow(`SELECT COUNT(*) FROM tgdl_forward_queue WHERE group_id=? AND message_id=? AND stage='scan_direct'`, work.GroupID, 715).Scan(&queued); err != nil {
		t.Fatal(err)
	}
	if err := a.db.Reader.QueryRow(`SELECT COUNT(*) FROM tgdl_work WHERE group_id=? AND message_id=?`, work.GroupID, 715).Scan(&downloadWork); err != nil {
		t.Fatal(err)
	}
	if downloads.Load() != 0 || queued != 1 || downloadWork != 0 {
		t.Fatalf("downloads=%d forward jobs=%d download jobs=%d", downloads.Load(), queued, downloadWork)
	}
}

func TestLiveRoutePersistsDirectWorkBeforeSkippingDownloadQueue(t *testing.T) {
	for _, tc := range []struct {
		mode         string
		skipDownload bool
		forwardJobs  int
	}{{"direct", true, 1}, {"both", false, 1}, {"download", false, 0}} {
		t.Run(tc.mode, func(t *testing.T) {
			a, _ := forwardTestApp(t, map[string]any{"enabled": true, "destination": "@Archive", "captionMode": "native", "scanRoute": tc.mode})
			target := engine.Target{ID: "-1000000000123", Name: "Source"}
			skipDownload, err := a.routeLiveScan(context.Background(), "acct1", target, docMessage(716, 123, 994, ""))
			if err != nil {
				t.Fatal(err)
			}
			var queued int
			if err := a.db.Reader.QueryRow(`SELECT COUNT(*) FROM tgdl_forward_queue WHERE group_id=? AND message_id=? AND source_kind='scan_direct'`, target.ID, 716).Scan(&queued); err != nil {
				t.Fatal(err)
			}
			if skipDownload != tc.skipDownload || queued != tc.forwardJobs {
				t.Fatalf("skip download=%v forward jobs=%d", skipDownload, queued)
			}
		})
	}
}

func TestLiveBothScanRouteQueuesDownloadAndForwardWithoutDuplicateForward(t *testing.T) {
	a, _ := forwardTestApp(t, map[string]any{"enabled": true, "destination": "@Archive", "captionMode": "native", "scanRoute": "both"})
	work := &engine.Work{GroupID: "-1000000000123", GroupName: "Source", AccountID: "acct1", Origin: "live"}
	if err := a.ingestWorkWithForward(context.Background(), work, docMessage(716, 123, 994, ""), fiveBytes, nil); err != nil {
		t.Fatal(err)
	}
	var forwards, downloads int
	if err := a.db.Reader.QueryRow(`SELECT COUNT(*) FROM tgdl_forward_queue WHERE group_id=? AND message_id=?`, work.GroupID, 716).Scan(&forwards); err != nil {
		t.Fatal(err)
	}
	if err := a.db.Reader.QueryRow(`SELECT COUNT(*) FROM downloads WHERE group_id=? AND message_id=?`, work.GroupID, 716).Scan(&downloads); err != nil {
		t.Fatal(err)
	}
	if forwards != 1 || downloads != 1 {
		var stages []string
		rows, _ := a.db.Reader.Query(`SELECT stage FROM tgdl_forward_queue WHERE group_id=? AND message_id=?`, work.GroupID, 716)
		for rows.Next() {
			var stage string
			_ = rows.Scan(&stage)
			stages = append(stages, stage)
		}
		rows.Close()
		t.Fatalf("forward jobs=%d stages=%v local downloads=%d", forwards, stages, downloads)
	}
}

func TestDirectScanQueueCapacityRetainsOverflowWithoutBlockingDownloadQueue(t *testing.T) {
	ctx := context.Background()
	a, _ := forwardTestApp(t, map[string]any{"enabled": true, "destination": "@Archive", "captionMode": "native", "scanRoute": "direct"})
	now := time.Now().UnixMilli()
	for messageID := int64(1); messageID <= 256; messageID++ {
		if _, err := a.db.Writer.ExecContext(ctx, `INSERT INTO tgdl_forward_queue(group_id,message_id,status,stage,created_at,updated_at) VALUES('-1000000000999',?,'processing','capacity_fixture',?,?)`, messageID, now, now); err != nil {
			t.Fatal(err)
		}
	}
	cfg, err := a.config.Load(ctx)
	if err != nil {
		t.Fatal(err)
	}
	settings, accountID, ok := directScanSettings(cfg, "-1000000000123")
	if !ok {
		t.Fatal("direct route settings missing")
	}
	if err = a.queueDirectScan(ctx, "-1000000000123", "Source", accountID, settings, cfg, docMessage(718, 123, 996, "")); err != nil {
		t.Fatal(err)
	}
	var status, reason string
	var retryAt int64
	if err = a.db.Reader.QueryRowContext(ctx, `SELECT status,reason,retry_at FROM tgdl_forward_queue WHERE group_id='-1000000000123' AND message_id=718`).Scan(&status, &reason, &retryAt); err != nil {
		t.Fatal(err)
	}
	var downloadWork int
	if err = a.db.Reader.QueryRowContext(ctx, `SELECT count(*) FROM tgdl_work WHERE group_id='-1000000000123' AND message_id=718`).Scan(&downloadWork); err != nil {
		t.Fatal(err)
	}
	// Overflow is kept and deferred, not dropped or sent to the download queue.
	if status != "pending" || reason == "" || retryAt <= now || downloadWork != 0 {
		t.Fatalf("overflow status=%q reason=%q retryAt=%d download work=%d", status, reason, retryAt, downloadWork)
	}
}

func TestRetryAfterPartialMultiDestinationSuccessSkipsDeliveredDestination(t *testing.T) {
	ctx := context.Background()
	a, fake := forwardTestApp(t, map[string]any{"enabled": true, "destination": "@Archive", "scanRoute": "direct"})
	settings := map[string]any{"enabled": true, "scanRoute": "direct", "routes": []any{
		map[string]any{"destination": "@Delivered", "captionMode": "native"},
		map[string]any{"destination": "@Pending", "captionMode": "native"},
	}}
	job := forwardJob{groupID: "-1000000000123", groupName: "Source", messageID: 719, settings: settings, accountID: "acct2", stage: "scan_direct", destinations: []forwardDestination{
		{Settings: map[string]any{"destination": "@Delivered", "captionMode": "native"}, Status: "forwarded"},
		{Settings: map[string]any{"destination": "@Pending", "captionMode": "native"}, Status: "pending"},
	}}
	a.forward(ctx, job)
	forwards := fake.forwards()
	if len(forwards) != 1 || forwards[0].Destination != "@Pending" {
		t.Fatalf("retry re-sent delivered destination: %+v", forwards)
	}
}

func TestSafeForwardReasonRedactsPathsAndCredentialFields(t *testing.T) {
	a, _ := forwardTestApp(t, map[string]any{"enabled": true, "destination": "@Archive"})
	got := a.safeForwardReason("open /Users/test/data/session.json api_hash=secret-value")
	if strings.Contains(got, "/Users/") || strings.Contains(got, "secret-value") || !strings.Contains(got, "[redacted]") {
		t.Fatalf("unsafe forward reason: %q", got)
	}
}

func TestForwardClaimHasIndependentPauseAndPersistentRetryDueTime(t *testing.T) {
	ctx := context.Background()
	a, _ := forwardTestApp(t, map[string]any{"enabled": true, "destination": "@Archive"})
	now := time.Now().UnixMilli()
	forwardConfig, _ := json.Marshal(forwardConfigSnapshot{Settings: map[string]any{"enabled": true, "destination": "@Archive"}})
	if _, err := a.db.Writer.Exec(`INSERT INTO tgdl_forward_queue(group_id,message_id,facts_json,forward_config_json,destinations_json,status,stage,created_at,updated_at,retry_at) VALUES('-1000000000123',714,'{}',?,'[]','pending','scan_direct',?,?,?)`, string(forwardConfig), now, now, now+60_000); err != nil {
		t.Fatal(err)
	}
	if _, err := a.db.Writer.Exec(`UPDATE tgdl_queue_state SET paused=1 WHERE id=1`); err != nil {
		t.Fatal(err)
	}
	if job, err := a.claimForward(ctx); err != nil || job != nil {
		t.Fatalf("future retry claimed: job=%v err=%v", job, err)
	}
	if _, err := a.db.Writer.Exec(`UPDATE tgdl_queue_state SET paused=0 WHERE id=1`); err != nil {
		t.Fatal(err)
	}
	if _, err := a.db.Writer.Exec(`UPDATE tgdl_forward_queue_state SET paused=1 WHERE id=1`); err != nil {
		t.Fatal(err)
	}
	if _, err := a.db.Writer.Exec(`UPDATE tgdl_forward_queue SET retry_at=? WHERE message_id=714`, now-1); err != nil {
		t.Fatal(err)
	}
	if job, err := a.claimForward(ctx); err != nil || job != nil {
		t.Fatalf("paused forward bucket claimed: job=%v err=%v", job, err)
	}
	if _, err := a.db.Writer.Exec(`UPDATE tgdl_forward_queue_state SET paused=0 WHERE id=1`); err != nil {
		t.Fatal(err)
	}
	job, err := a.claimForward(ctx)
	if err != nil || job == nil || job.messageID != 714 {
		t.Fatalf("due forward job not claimed after independent resume: job=%+v err=%v", job, err)
	}
}

func TestForwardRetryAndAmbiguousDeliverySurviveAppRestart(t *testing.T) {
	ctx := context.Background()
	a, _ := forwardTestApp(t, map[string]any{"enabled": true, "destination": "@Archive", "captionMode": "native", "scanRoute": "direct"})
	dataDir := a.dataDir
	cfg, err := a.config.Load(ctx)
	if err != nil {
		t.Fatal(err)
	}
	settings, accountID, ok := directScanSettings(cfg, "-1000000000123")
	if !ok {
		t.Fatal("direct scan settings missing")
	}
	if err = a.queueDirectScan(ctx, "-1000000000123", "Source", accountID, settings, cfg, docMessage(741, 123, 995, "retry after restart")); err != nil {
		t.Fatal(err)
	}
	retryAt := time.Now().Add(time.Minute).UnixMilli()
	if _, err = a.db.Writer.ExecContext(ctx, `UPDATE tgdl_forward_queue SET retry_at=? WHERE message_id=741`, retryAt); err != nil {
		t.Fatal(err)
	}
	if _, err = a.db.Writer.ExecContext(ctx, `INSERT INTO tgdl_forward_queue(group_id,message_id,status,stage,destinations_json,created_at,updated_at) VALUES('-1000000000123',742,'processing','scan_direct','[{"settings":{"destination":"@Archive"},"status":"processing"}]',?,?)`, time.Now().UnixMilli(), time.Now().UnixMilli()); err != nil {
		t.Fatal(err)
	}
	if err = a.Close(); err != nil {
		t.Fatal(err)
	}

	restarted, err := New(ctx, Config{DataDir: dataDir, Output: io.Discard})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = restarted.Close() })
	var status string
	var persistedRetryAt int64
	if err = restarted.db.Reader.QueryRowContext(ctx, `SELECT status,retry_at FROM tgdl_forward_queue WHERE message_id=741`).Scan(&status, &persistedRetryAt); err != nil {
		t.Fatal(err)
	}
	if status != "pending" || persistedRetryAt != retryAt {
		t.Fatalf("retry after restart status=%q retry_at=%d, want pending at %d", status, persistedRetryAt, retryAt)
	}
	if job, err := restarted.claimForward(ctx); err != nil || job != nil {
		t.Fatalf("future retry claimed after restart: job=%+v err=%v", job, err)
	}
	if err = restarted.db.Reader.QueryRowContext(ctx, `SELECT status FROM tgdl_forward_queue WHERE message_id=742`).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != "uncertain" {
		t.Fatalf("in-flight delivery after restart status=%q, want uncertain", status)
	}
	if _, err = restarted.db.Writer.ExecContext(ctx, `UPDATE tgdl_forward_queue SET retry_at=? WHERE message_id=741`, time.Now().Add(-time.Second).UnixMilli()); err != nil {
		t.Fatal(err)
	}
	job, err := restarted.claimForward(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if job != nil && job.messageID == 741 {
		return
	}
	var claimedStatus string
	var claimedRetryAt int64
	if err = restarted.db.Reader.QueryRowContext(ctx, `SELECT status,retry_at FROM tgdl_forward_queue WHERE message_id=741`).Scan(&claimedStatus, &claimedRetryAt); err != nil {
		t.Fatal(err)
	}
	if claimedStatus != "processing" || claimedRetryAt != 0 {
		t.Fatalf("due retry was neither claimed here nor by a worker: job=%+v status=%q retry_at=%d", job, claimedStatus, claimedRetryAt)
	}
}

func TestForwardClaimReleasedWhenPacingDelayIsCancelled(t *testing.T) {
	ctx := context.Background()
	a, _ := forwardTestApp(t, map[string]any{"enabled": true, "destination": "@Archive"})
	now := time.Now().UnixMilli()
	result, err := a.db.Writer.ExecContext(ctx, `INSERT INTO tgdl_forward_queue(group_id,message_id,status,attempts,created_at,updated_at) VALUES('-1000000000123',722,'processing',2,?,?)`, now, now)
	if err != nil {
		t.Fatal(err)
	}
	id, _ := result.LastInsertId()
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	if err := a.releaseForwardClaim(cancelled, id, ""); err != nil {
		t.Fatal(err)
	}
	var status, reason string
	var attempts int
	var retryAt int64
	if err := a.db.Reader.QueryRowContext(ctx, `SELECT status,reason,attempts,retry_at FROM tgdl_forward_queue WHERE id=?`, id).Scan(&status, &reason, &attempts, &retryAt); err != nil {
		t.Fatal(err)
	}
	if status != "pending" || reason != "" || attempts != 2 || retryAt != 0 {
		t.Fatalf("cancelled pre-send claim was lost: status=%q reason=%q attempts=%d retryAt=%d", status, reason, attempts, retryAt)
	}
}

func TestForwardClaimReturnsToPendingWhenEngineStopsAfterClaim(t *testing.T) {
	ctx := context.Background()
	a, err := New(ctx, Config{DataDir: t.TempDir(), Output: io.Discard, RequireMonitorForwards: true})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { a.Close() })
	if a.forwardEngineReady() {
		t.Fatal("stopped engine was considered ready")
	}
	now := time.Now().UnixMilli()
	result, err := a.db.Writer.ExecContext(ctx, `INSERT INTO tgdl_forward_queue(group_id,message_id,status,attempts,created_at,updated_at) VALUES('-1000000000123',724,'processing',2,?,?)`, now, now)
	if err != nil {
		t.Fatal(err)
	}
	id, _ := result.LastInsertId()
	if err := a.releaseForwardClaim(ctx, id, "Waiting for monitor to start"); err != nil {
		t.Fatal(err)
	}
	var status, reason string
	var attempts int
	if err := a.db.Reader.QueryRowContext(ctx, `SELECT status,reason,attempts FROM tgdl_forward_queue WHERE id=?`, id).Scan(&status, &reason, &attempts); err != nil {
		t.Fatal(err)
	}
	if status != "pending" || reason != "Waiting for monitor to start" || attempts != 2 {
		t.Fatalf("stopped-engine claim was not preserved: status=%q reason=%q attempts=%d", status, reason, attempts)
	}
}

func TestCancelledForwardAccountWaitIsRetryableNotUncertain(t *testing.T) {
	ctx := context.Background()
	a, fake := forwardTestAppWith(t, map[string]any{"enabled": true, "destination": "@Archive", "captionMode": "native", "scanRoute": "direct"}, Config{RequireMonitorForwards: true})
	cfg, err := a.config.Load(ctx)
	if err != nil {
		t.Fatal(err)
	}
	settings, accountID, ok := directScanSettings(cfg, "-1000000000123")
	if !ok {
		t.Fatal("direct scan settings not found")
	}
	message := docMessage(723, 123, 996, "")
	if err := a.queueDirectScan(ctx, "-1000000000123", "Source", accountID, settings, cfg, message); err != nil {
		t.Fatal(err)
	}
	job, err := a.claimForward(ctx)
	if err != nil || job == nil {
		t.Fatalf("claim job=%v err=%v", job, err)
	}
	if _, err := a.db.Writer.ExecContext(ctx, `INSERT INTO tgdl_forward_account_limits(account_id,blocked_until) VALUES(?,?)`, accountID, time.Now().Add(time.Minute).UnixMilli()); err != nil {
		t.Fatal(err)
	}
	forwardCtx, cancel := context.WithCancel(ctx)
	done := make(chan struct{})
	go func() {
		a.forward(forwardCtx, *job)
		close(done)
	}()
	eventually(t, "forward destination entering pre-send wait", func() bool {
		var states string
		if err := a.db.Reader.QueryRowContext(ctx, `SELECT destinations_json FROM tgdl_forward_queue WHERE id=?`, job.queueID).Scan(&states); err != nil {
			return false
		}
		return strings.Contains(states, `"status":"processing"`)
	})
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("cancelled forward did not finish")
	}
	if got := fake.forwards(); len(got) != 0 {
		t.Fatalf("cancelled pre-send wait called Telegram: %+v", got)
	}
	var status, raw string
	if err := a.db.Reader.QueryRowContext(ctx, `SELECT status,destinations_json FROM tgdl_forward_queue WHERE id=?`, job.queueID).Scan(&status, &raw); err != nil {
		t.Fatal(err)
	}
	var destinations []forwardDestination
	if err := json.Unmarshal([]byte(raw), &destinations); err != nil {
		t.Fatal(err)
	}
	if status != "pending" || len(destinations) != 1 || destinations[0].Status != "pending" {
		t.Fatalf("pre-send cancellation is not retryable: status=%q destinations=%+v", status, destinations)
	}
}

func TestForwardPacingConfigDefaultsAndAppearsInQueueSnapshot(t *testing.T) {
	ctx := context.Background()
	a, _ := forwardTestApp(t, map[string]any{"enabled": true, "destination": "@Archive"})
	if got := a.forwarderConfig(ctx).intervalSec; got != 1 {
		t.Fatalf("default forward gap=%d, want 1 second", got)
	}
	snapshot, err := a.forwardQueueSnapshot(ctx, 0)
	if err != nil {
		t.Fatal(err)
	}
	if snapshot["intervalSec"] != 1 {
		t.Fatalf("forward queue snapshot interval=%v, want 1", snapshot["intervalSec"])
	}
	cfg, err := a.config.Load(ctx)
	if err != nil {
		t.Fatal(err)
	}
	advanced, _ := cfg["advanced"].(map[string]any)
	if advanced == nil {
		advanced = map[string]any{}
		cfg["advanced"] = advanced
	}
	advanced["forwarder"] = map[string]any{"intervalSec": 7}
	if err := a.config.Save(ctx, cfg); err != nil {
		t.Fatal(err)
	}
	if got := a.forwarderConfig(ctx).intervalSec; got != 7 {
		t.Fatalf("configured forward gap=%d, want 7 seconds", got)
	}
}

func TestForwardWorkerLeavesJobsPendingUntilMonitorRuns(t *testing.T) {
	ctx := context.Background()
	a, err := New(ctx, Config{DataDir: t.TempDir(), Output: io.Discard, RequireMonitorForwards: true})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { a.Close() })
	cfg, err := a.config.Load(ctx)
	if err != nil {
		t.Fatal(err)
	}
	cfg["groups"] = []any{map[string]any{
		"id": "-1000000000123", "name": "Source", "enabled": true,
		"autoForward": map[string]any{"enabled": true, "destination": "@Archive", "directForward": true, "deleteAfterForward": true},
	}}
	if err := a.config.Save(ctx, cfg); err != nil {
		t.Fatal(err)
	}
	if err := a.monitor.RequireRunning(); err == nil {
		t.Fatal("monitor unexpectedly running")
	}
	a.queueForward(forwardJob{groupID: "-1000000000123", groupName: "Source", messageID: 999, stage: "scan_direct"})

	workerCtx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		a.runForwards(workerCtx)
		close(done)
	}()
	time.Sleep(100 * time.Millisecond)
	cancel()
	<-done

	var status string
	if err := a.db.Reader.QueryRow(`SELECT status FROM tgdl_forward_queue WHERE message_id=999`).Scan(&status); err != nil {
		t.Fatal(err)
	}
	var attempts int
	var reason string
	if err := a.db.Reader.QueryRow(`SELECT attempts,reason FROM tgdl_forward_queue WHERE message_id=999`).Scan(&attempts, &reason); err != nil {
		t.Fatal(err)
	}
	if status != "pending" || attempts != 0 || reason != "" {
		t.Fatalf("status=%q attempts=%d reason=%q; want untouched pending job", status, attempts, reason)
	}
}

func TestForwardEngineStopAfterClaimReturnsJobToPending(t *testing.T) {
	ctx := context.Background()
	a, fake := forwardTestApp(t, map[string]any{"enabled": true, "destination": "@Archive", "directForward": true, "deleteAfterForward": true})
	fake.fail(engine.ErrEngineNotRunning)
	cfg, err := a.config.Load(ctx)
	if err != nil {
		t.Fatal(err)
	}
	groupSettings, accountID, _ := forwardSettings(cfg, "-1000000000123")
	job := forwardJob{queueID: 123, groupID: "-1000000000123", groupName: "Source", messageID: 998, stage: "scan_direct", settings: groupSettings, accountID: accountID, destinations: []forwardDestination{{}}}
	if _, err := a.db.Writer.Exec(`INSERT INTO tgdl_forward_queue(id,group_id,group_name,message_id,facts_json,forward_config_json,destinations_json,status,stage,created_at,updated_at) VALUES(123,?,?,?,?,?,'[]','processing','scan_direct',?,?)`, job.groupID, job.groupName, job.messageID, "{}", "{}", time.Now().UnixMilli(), time.Now().UnixMilli()); err != nil {
		t.Fatal(err)
	}
	a.forward(ctx, job)

	var status, reason, rawDestinations string
	var attempts int
	if err := a.db.Reader.QueryRow(`SELECT status,reason,attempts,destinations_json FROM tgdl_forward_queue WHERE id=?`, job.queueID).Scan(&status, &reason, &attempts, &rawDestinations); err != nil {
		t.Fatal(err)
	}
	if status != "pending" || attempts != 0 || reason != "Waiting for monitor to start" || len(fake.forwards()) != 1 {
		t.Fatalf("status=%q reason=%q attempts=%d send calls=%d", status, reason, attempts, len(fake.forwards()))
	}
	var destinations []forwardDestination
	if err := json.Unmarshal([]byte(rawDestinations), &destinations); err != nil || len(destinations) != 1 || destinations[0].Status != "pending" || destinations[0].DirectFailed {
		t.Fatalf("destination state=%+v err=%v", destinations, err)
	}
}

func TestForwardClaimFailsLegacyJobWithoutDestinationSnapshotClosed(t *testing.T) {
	ctx := context.Background()
	a, _ := forwardTestApp(t, map[string]any{"enabled": true, "destination": "@NewConfigTarget"})
	now := time.Now().UnixMilli()
	result, err := a.db.Writer.ExecContext(ctx, `INSERT INTO tgdl_forward_queue(group_id,message_id,facts_json,forward_config_json,destinations_json,status,stage,created_at,updated_at) VALUES('-1000000000123',720,'{}','{}','[]','processing','legacy',?,?)`, now, now)
	if err != nil {
		t.Fatal(err)
	}
	id, _ := result.LastInsertId()
	a.failClaimedForward(ctx, id, "saved destination snapshot is unavailable; requeue after reviewing the destination")
	var status, reason string
	if err := a.db.Reader.QueryRowContext(ctx, `SELECT status,reason FROM tgdl_forward_queue WHERE id=?`, id).Scan(&status, &reason); err != nil {
		t.Fatal(err)
	}
	if status != "failed" || !strings.Contains(reason, "destination snapshot is unavailable") {
		t.Fatalf("legacy queue status=%q reason=%q", status, reason)
	}
}

func TestForwardFloodWaitGateIsSharedByAccountAndCancelable(t *testing.T) {
	ctx := context.Background()
	a, _ := forwardTestApp(t, map[string]any{"enabled": true, "destination": "@Archive"})
	a.blockForwardAccount(ctx, "acct2", 2*time.Second)
	var blockedUntil int64
	if err := a.db.Reader.QueryRowContext(ctx, `SELECT blocked_until FROM tgdl_forward_account_limits WHERE account_id='acct2'`).Scan(&blockedUntil); err != nil {
		t.Fatal(err)
	}
	if blockedUntil <= time.Now().UnixMilli() {
		t.Fatalf("flood deadline not persisted: %d", blockedUntil)
	}
	waitCtx, cancel := context.WithTimeout(ctx, 10*time.Millisecond)
	defer cancel()
	if err := a.waitForwardAccount(waitCtx, "acct2"); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("account gate error=%v", err)
	}
	if err := a.waitForwardAccount(ctx, "acct3"); err != nil {
		t.Fatalf("unthrottled account blocked: %v", err)
	}
}

func TestForwardSnapshotPagination(t *testing.T) {
	ctx := context.Background()
	a, _ := forwardTestApp(t, map[string]any{"enabled": true, "destination": "@Archive"})
	states, _ := json.Marshal([]forwardDestination{{Settings: map[string]any{"destination": "@Secret"}, Status: "pending"}})
	config, _ := json.Marshal(forwardConfigSnapshot{Settings: map[string]any{"enabled": true, "destination": "@Secret"}, AccountID: "acct2", Destinations: []forwardDestination{{Settings: map[string]any{"destination": "@Secret"}, Status: "pending"}}})
	now := time.Now().UnixMilli()
	var offPageID int64
	for messageID := int64(1); messageID <= 51; messageID++ {
		result, err := a.db.Writer.ExecContext(ctx, `INSERT INTO tgdl_forward_queue(group_id,message_id,facts_json,forward_config_json,destinations_json,status,stage,created_at,updated_at) VALUES(?,?, '{}',?,?,'failed','scan_direct',?,?)`, "-1000000000123", messageID, string(config), string(states), now, now)
		if err != nil {
			t.Fatal(err)
		}
		if messageID == 1 {
			offPageID, _ = result.LastInsertId()
		}
	}
	first, err := a.forwardQueueSnapshot(ctx, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(first["items"].([]map[string]any)) != forwardQueuePageSize || first["hasMore"] != true {
		t.Fatalf("first-page pagination=%v", first)
	}
	second, err := a.forwardQueueSnapshot(ctx, forwardQueuePageSize)
	if err != nil {
		t.Fatal(err)
	}
	items := second["items"].([]map[string]any)
	if len(items) != 1 || items[0]["id"] != offPageID || second["hasMore"] != false {
		var firstID any
		if len(items) > 0 {
			firstID = items[0]["id"]
		}
		t.Fatalf("second-page items=%d id=%v expected=%d hasMore=%v", len(items), firstID, offPageID, second["hasMore"])
	}
}

func TestUncertainForwardResendNeedsExplicitDuplicateRiskConfirmationAndAudit(t *testing.T) {
	ctx := context.Background()
	a, _ := forwardTestApp(t, map[string]any{"enabled": true, "destination": "@Archive", "captionMode": "native", "scanRoute": "direct"})
	cfg, err := a.config.Load(ctx)
	if err != nil {
		t.Fatal(err)
	}
	settings, accountID, _ := directScanSettings(cfg, "-1000000000123")
	states := []forwardDestination{{Settings: map[string]any{"destination": "@Archive"}, Status: "uncertain"}, {Settings: map[string]any{"destination": "@Archive2"}, Status: "uncertain"}}
	stateJSON, _ := json.Marshal(states)
	configJSON, _ := json.Marshal(forwardConfigSnapshot{Settings: settings, AccountID: accountID, Destinations: states})
	now := time.Now().UnixMilli()
	if _, err = a.db.Writer.ExecContext(ctx, `INSERT INTO tgdl_forward_queue(group_id,group_name,message_id,facts_json,forward_config_json,destinations_json,status,stage,created_at,updated_at) VALUES('-1000000000123','Source',713,'{}',?,?,'uncertain','scan_direct',?,?)`, string(configJSON), string(stateJSON), now, now); err != nil {
		t.Fatal(err)
	}
	var id int64
	var raw string
	if err = a.db.Reader.QueryRowContext(ctx, `SELECT id,destinations_json FROM tgdl_forward_queue WHERE group_id=? AND message_id=?`, "-1000000000123", 713).Scan(&id, &raw); err != nil {
		t.Fatal(err)
	}
	request := func(action string, confirm bool, index *int) *httptest.ResponseRecorder {
		body, _ := json.Marshal(map[string]any{"action": action, "confirmDuplicateRisk": confirm, "destinationIndex": index})
		req := httptest.NewRequest(http.MethodPost, "/api/forward-queue/1/reconcile", bytes.NewReader(body))
		req.SetPathValue("id", strconv.FormatInt(id, 10))
		recorder := httptest.NewRecorder()
		a.handleForwardQueueReconcile(recorder, req)
		return recorder
	}
	first := 0
	second := 1
	if got := request("resend", false, &first).Code; got != http.StatusBadRequest {
		t.Fatalf("unconfirmed resend returned %d", got)
	}
	if got := request("sent", false, &first).Code; got != http.StatusOK {
		t.Fatalf("confirm sent returned %d", got)
	}
	var afterConfirm string
	if err = a.db.Reader.QueryRowContext(ctx, `SELECT status FROM tgdl_forward_queue WHERE id=?`, id).Scan(&afterConfirm); err != nil || afterConfirm != "uncertain" {
		t.Fatalf("one target confirmation changed unresolved job to %q: %v", afterConfirm, err)
	}
	if recorder := request("resend", true, &second); recorder.Code != http.StatusOK {
		t.Fatalf("confirmed resend returned %d: %s", recorder.Code, recorder.Body.String())
	}
	var status string
	var audits, resends int
	if err = a.db.Reader.QueryRowContext(ctx, `SELECT status FROM tgdl_forward_queue WHERE id=?`, id).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if err = a.db.Reader.QueryRowContext(ctx, `SELECT COUNT(*),SUM(action='resend') FROM tgdl_forward_queue_audit WHERE job_id=?`, id).Scan(&audits, &resends); err != nil {
		t.Fatal(err)
	}
	if status != "pending" || audits != 2 || resends != 1 {
		t.Fatalf("status=%s audit count=%d resend count=%d", status, audits, resends)
	}
	if err = a.db.Reader.QueryRowContext(ctx, `SELECT destinations_json FROM tgdl_forward_queue WHERE id=?`, id).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	if err = json.Unmarshal([]byte(raw), &states); err != nil || states[0].Status != "forwarded" || states[1].Status != "pending" {
		t.Fatalf("per-destination states=%+v err=%v", states, err)
	}
}

func TestDirectScanWithoutCaptionSkipsCaptionEdit(t *testing.T) {
	for i, test := range []struct {
		name, mode, sourceCaption string
		wantEdit, wantDrop        bool
	}{
		{name: "no caption on source", mode: "none", wantDrop: true},
		{name: "remove existing caption natively", mode: "none", sourceCaption: "source text", wantDrop: true},
		{name: "preserve native caption", mode: "native", sourceCaption: "source text"},
	} {
		t.Run(test.name, func(t *testing.T) {
			ctx := context.Background()
			a, fake := forwardTestApp(t, map[string]any{
				"enabled": true, "destination": "@Archive", "scanRoute": "direct", "captionMode": test.mode,
			})
			cfg, err := a.config.Load(ctx)
			if err != nil {
				t.Fatal(err)
			}
			settings, accountID, _ := directScanSettings(cfg, "-1000000000123")
			if err := a.queueDirectScan(ctx, "-1000000000123", "Source", accountID, settings, cfg, docMessage(997+i, 123, 77, test.sourceCaption)); err != nil {
				t.Fatal(err)
			}
			eventually(t, "direct scan forward", func() bool { return len(fake.forwards()) == 1 })
			if request := fake.forwards()[0]; request.EditCaption != test.wantEdit || request.DropMediaCaptions != test.wantDrop {
				t.Fatalf("EditCaption=%v DropMediaCaptions=%v; want %v/%v: %+v", request.EditCaption, request.DropMediaCaptions, test.wantEdit, test.wantDrop, request)
			}
		})
	}
}

func TestNoCaptionRetryEditsSavedForwardInsteadOfResending(t *testing.T) {
	ctx := context.Background()
	a, fake := forwardTestApp(t, map[string]any{
		"enabled": true, "destination": "@Archive", "scanRoute": "direct", "captionMode": "none",
	})
	cfg, err := a.config.Load(ctx)
	if err != nil {
		t.Fatal(err)
	}
	settings, accountID, _ := directScanSettings(cfg, "-1000000000123")
	job := forwardJob{
		groupID: "-1000000000123", groupName: "Source", messageID: 996, stage: "caption_edit_failed",
		settings: settings, accountID: accountID,
		destinations: []forwardDestination{{Settings: map[string]any{"destination": "@Archive", "captionMode": "none"}, Status: "processing", DestinationMessageID: 9001}},
	}
	a.forward(ctx, job)
	requests := fake.forwards()
	if len(requests) != 1 || !requests[0].EditCaption || requests[0].DropMediaCaptions || requests[0].EditMessageID != 9001 {
		t.Fatalf("retry request=%+v; want edit existing message 9001 without a new native forward", requests)
	}
}

func TestAutoForwardWithoutDownloadRequiresDeleteAfterForward(t *testing.T) {
	ctx := context.Background()
	a, fake := forwardTestApp(t, map[string]any{"enabled": true, "destination": "@Archive", "deleteAfterForward": true, "directForward": true, "captionMode": "native"})
	var directCalls atomic.Int32
	transport := mediaTransport(func(_ context.Context, _ telegram.Attachment, w io.Writer) error {
		_, err := w.Write([]byte("media"))
		return err
	})
	_, err := a.ingestTelegramWithForward(ctx, docMessage(10, 123, 77, "native caption"), "", "Source", "acct1", transport, func(_ context.Context, request telegram.ForwardMessageRequest) error {
		if request.Destination != "@Archive" || request.MessageID != 10 {
			t.Fatalf("forward request=%+v", request)
		}
		directCalls.Add(1)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	eventually(t, "native forward", func() bool { return directCalls.Load() == 1 })
	if len(fake.calls()) != 0 {
		t.Fatalf("unexpected uploads=%d", len(fake.calls()))
	}
	eventually(t, "local copy deletion", func() bool {
		stored, exists := rowPath(t, a, "-1000000000123", 10)
		return exists && stored == ""
	})
	if stored, exists := rowPath(t, a, "-1000000000123", 10); !exists || stored != "" {
		t.Fatal("direct-forwarded media bytes were not evicted while retaining its catalog row")
	}

	// With delete-after-forward off, the message must use the download/upload path.
	a.configMu.Lock()
	cfg, err := a.config.Load(ctx)
	if err != nil {
		a.configMu.Unlock()
		t.Fatal(err)
	}
	groups, _ := cfg["groups"].([]any)
	group := groups[0].(map[string]any)
	settings := group["autoForward"].(map[string]any)
	settings["deleteAfterForward"] = false
	settings["directForward"] = false
	group["autoForward"] = settings
	cfg["groups"] = groups
	err = a.config.Save(ctx, cfg)
	a.configMu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	var downloads atomic.Int32
	transport = mediaTransport(func(_ context.Context, _ telegram.Attachment, w io.Writer) error {
		downloads.Add(1)
		_, writeErr := w.Write([]byte("media"))
		return writeErr
	})
	_, err = a.ingestTelegramWithForward(ctx, docMessage(11, 123, 78, ""), "", "Source", "acct1", transport, func(context.Context, telegram.ForwardMessageRequest) error {
		directCalls.Add(1)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	eventually(t, "uploaded downloaded media", func() bool { return len(fake.calls()) == 1 })
	if downloads.Load() != 1 || directCalls.Load() != 1 {
		t.Fatalf("downloads=%d direct=%d", downloads.Load(), directCalls.Load())
	}
	if _, exists := rowPath(t, a, "-1000000000123", 11); !exists {
		t.Fatal("downloaded media not retained when delete-after-forward is off")
	}
}

func TestAutoForwardReturnsBeforeNativeForwardCompletes(t *testing.T) {
	ctx := context.Background()
	a, _ := forwardTestApp(t, map[string]any{"enabled": true, "destination": "@Archive", "deleteAfterForward": true, "directForward": true, "captionMode": "native"})
	started, release := make(chan struct{}), make(chan struct{})
	transport := mediaTransport(func(_ context.Context, _ telegram.Attachment, w io.Writer) error {
		_, err := w.Write([]byte("media"))
		return err
	})
	done := make(chan error, 1)
	go func() {
		_, err := a.ingestTelegramWithForward(ctx, docMessage(901, 123, 99, "native caption"), "", "Source", "acct1", transport, func(context.Context, telegram.ForwardMessageRequest) error {
			close(started)
			<-release
			return nil
		})
		done <- err
	}()
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("native forward did not start")
	}
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(100 * time.Millisecond):
		t.Fatal("ingest waited for native forward instead of queueing it")
	}
	close(release)
	eventually(t, "download finishing", func() bool {
		var status string
		_ = a.db.Reader.QueryRowContext(ctx, `SELECT outcome FROM tgdl_processing_attempts WHERE message_id=901 ORDER BY id DESC LIMIT 1`).Scan(&status)
		return status == "downloaded"
	})
}

func TestCustomCaptionUsesDirectForwardThenEdit(t *testing.T) {
	ctx := context.Background()
	a, fake := forwardTestApp(t, map[string]any{
		"enabled": true, "destination": "@Archive", "deleteAfterForward": true,
		"directForward": true, "captionMode": "custom", "captionBase": "custom",
		"caption": "Hi {{source_name}} #{{message_id}}",
	})
	transport := mediaTransport(func(_ context.Context, _ telegram.Attachment, w io.Writer) error {
		_, err := w.Write([]byte("media"))
		return err
	})
	requestCh := make(chan telegram.ForwardMessageRequest, 1)
	_, err := a.ingestTelegramWithForward(ctx, docMessage(13, 123, 80, "source caption"), "", "Source", "acct1", transport, func(_ context.Context, req telegram.ForwardMessageRequest) error {
		requestCh <- req
		if req.ResultMessageID != nil {
			*req.ResultMessageID = 42
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	var request telegram.ForwardMessageRequest
	select {
	case request = <-requestCh:
	case <-time.After(time.Second):
		t.Fatal("native forward did not start")
	}
	if !request.EditCaption || request.Caption != "Hi Source #13" {
		t.Fatalf("native forward request=%+v", request)
	}
	if len(fake.calls()) != 0 {
		t.Fatalf("unexpected upload calls: %d", len(fake.calls()))
	}
	eventually(t, "local copy deletion", func() bool {
		stored, exists := rowPath(t, a, "-1000000000123", 13)
		return exists && stored == ""
	})
	if stored, exists := rowPath(t, a, "-1000000000123", 13); !exists || stored != "" {
		t.Fatal("direct-forwarded media bytes were not evicted while retaining its catalog row")
	}
}

func TestUnresolvedCustomCaptionForwardFailsWithoutDuplicateUpload(t *testing.T) {
	ctx := context.Background()
	a, _ := forwardTestApp(t, map[string]any{
		"enabled": true, "destination": "@Archive", "deleteAfterForward": true,
		"directForward": true, "captionMode": "custom", "captionBase": "custom", "caption": "custom",
	})
	transport := mediaTransport(func(_ context.Context, _ telegram.Attachment, w io.Writer) error {
		_, err := w.Write([]byte("media"))
		return err
	})
	_, err := a.ingestTelegramWithForward(ctx, docMessage(14, 123, 81, "source caption"), "", "Source", "acct1", transport, func(_ context.Context, request telegram.ForwardMessageRequest) error {
		if request.ResultMessageID != nil {
			*request.ResultMessageID = 9001
		}
		return telegram.ErrForwardCaptionUnresolved
	})
	if err != nil {
		t.Fatalf("err=%v", err)
	}
	eventually(t, "caption failure recorded", func() bool {
		var status string
		_ = a.db.Reader.QueryRowContext(ctx, `SELECT forward_status FROM tgdl_processing_attempts WHERE message_id=14 ORDER BY id DESC LIMIT 1`).Scan(&status)
		return status == "failed"
	})
	var status, stage, states string
	if err := a.db.Reader.QueryRowContext(ctx, `SELECT status,stage,destinations_json FROM tgdl_forward_queue ORDER BY id DESC LIMIT 1`).Scan(&status, &stage, &states); err != nil {
		t.Fatal(err)
	}
	var destinations []forwardDestination
	if err := json.Unmarshal([]byte(states), &destinations); err != nil {
		t.Fatal(err)
	}
	if status != "failed" || stage != "caption_edit_failed" || len(destinations) != 1 || !destinations[0].DirectFailed || destinations[0].DestinationMessageID != 9001 {
		t.Fatalf("status=%q stage=%q destinations=%+v", status, stage, destinations)
	}
}

func TestRetryCaptionEditUsesSavedDestinationMessageID(t *testing.T) {
	ctx := context.Background()
	a, fake := forwardTestApp(t, map[string]any{
		"enabled": true, "destination": "@Archive", "deleteAfterForward": true,
		"directForward": true, "captionMode": "custom", "captionBase": "custom", "caption": "fixed caption",
	})
	settings := map[string]any{
		"enabled": true, "destination": "@Archive", "deleteAfterForward": true,
		"directForward": true, "captionMode": "custom", "captionBase": "custom", "caption": "fixed caption",
	}
	a.forward(ctx, forwardJob{
		groupID: "-1000000000123", groupName: "Source", messageID: 14, text: "source caption",
		settings: settings, stage: "caption_edit_failed", path: "already-downloaded.mp4",
		destinations: []forwardDestination{{
			Settings: map[string]any{"destination": "@Archive", "captionMode": "custom", "captionBase": "custom", "caption": "fixed caption"},
			Status:   "processing", DirectFailed: true, DestinationMessageID: 9001,
		}},
	})
	requests := fake.forwards()
	if len(requests) != 1 || requests[0].EditMessageID != 9001 || !requests[0].EditCaption || requests[0].MessageID != 14 || len(fake.calls()) != 0 {
		t.Fatalf("retry requests=%+v calls=%+v", requests, fake.calls())
	}
}

func TestForwardQueueRetryResetsFailedAndInterruptedJobs(t *testing.T) {
	ctx := context.Background()
	a, _ := forwardTestApp(t, map[string]any{"enabled": true, "destination": "@Archive"})
	for _, status := range []string{"failed", "interrupted"} {
		t.Run(status, func(t *testing.T) {
			var id int64
			err := a.db.Writer.QueryRowContext(ctx, `INSERT INTO tgdl_forward_queue(group_id,group_name,message_id,status,reason,stage,destinations_json,created_at,updated_at,completed_at)
				VALUES('-1000000000123','Source',14,?,'temporary failure','upload','[{"status":"forwarded"}]',1,1,1) RETURNING id`, status).Scan(&id)
			if err != nil {
				t.Fatal(err)
			}
			r := httptest.NewRequest(http.MethodPost, "/api/forward-queue/1/retry", nil)
			r.SetPathValue("id", strconv.FormatInt(id, 10))
			w := httptest.NewRecorder()
			a.handleForwardQueueRetry(w, r)
			if w.Code != http.StatusOK {
				t.Fatalf("retry status=%d body=%s", w.Code, w.Body.String())
			}
			var gotStatus, reason, stage, destinations string
			var completedAt int64
			if err := a.db.Reader.QueryRowContext(ctx, `SELECT status,reason,stage,destinations_json,completed_at FROM tgdl_forward_queue WHERE id=?`, id).Scan(&gotStatus, &reason, &stage, &destinations, &completedAt); err != nil {
				t.Fatal(err)
			}
			if gotStatus != "pending" || reason != "" || stage != "upload" || destinations != `[{"status":"forwarded"}]` || completedAt != 0 {
				t.Fatalf("retry state=%q reason=%q stage=%q destinations=%s completedAt=%d", gotStatus, reason, stage, destinations, completedAt)
			}
		})
	}
}

func TestForwardQueueRetryAllOnlyResetsFailedAndInterruptedJobs(t *testing.T) {
	ctx := context.Background()
	a, _ := forwardTestApp(t, map[string]any{"enabled": true, "destination": "@Archive"})
	if _, err := a.db.Writer.ExecContext(ctx, `UPDATE tgdl_queue_state SET paused=1 WHERE id=1`); err != nil {
		t.Fatal(err)
	}
	ids := make(map[string]int64)
	for _, status := range []string{"failed", "interrupted", "forwarded", "pending"} {
		var id int64
		if err := a.db.Writer.QueryRowContext(ctx, `INSERT INTO tgdl_forward_queue(group_id,group_name,message_id,status,reason,stage,destinations_json,created_at,updated_at,completed_at)
			VALUES('-1000000000123','Source',?,?,?,'upload','[]',1,1,1) RETURNING id`, len(ids)+1, status, "temporary failure").Scan(&id); err != nil {
			t.Fatal(err)
		}
		ids[status] = id
	}
	w := httptest.NewRecorder()
	a.handleForwardQueueRetryAll(w, httptest.NewRequest(http.MethodPost, "/api/forward-queue/retry-all", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("retry-all status=%d body=%s", w.Code, w.Body.String())
	}
	var response struct {
		Retried int64 `json:"retried"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if response.Retried != 2 {
		t.Fatalf("retried=%d, want 2", response.Retried)
	}
	for status, id := range ids {
		var gotStatus, reason string
		var completedAt int64
		if err := a.db.Reader.QueryRowContext(ctx, `SELECT status,reason,completed_at FROM tgdl_forward_queue WHERE id=?`, id).Scan(&gotStatus, &reason, &completedAt); err != nil {
			t.Fatal(err)
		}
		wantStatus, wantReason, wantCompleted := status, "temporary failure", int64(1)
		if status == "failed" || status == "interrupted" {
			wantStatus, wantReason, wantCompleted = "pending", "", 0
		}
		if gotStatus != wantStatus || reason != wantReason || completedAt != wantCompleted {
			t.Fatalf("status %q became status=%q reason=%q completedAt=%d, want %q %q %d", status, gotStatus, reason, completedAt, wantStatus, wantReason, wantCompleted)
		}
	}
}

func TestForwardQueueSnapshotIncludesAllRetryableJobs(t *testing.T) {
	ctx := context.Background()
	a, _ := forwardTestApp(t, map[string]any{"enabled": true, "destination": "@Archive"})
	statuses := []string{"pending", "processing", "forwarded", "failed", "interrupted", "not_applicable"}
	for i, status := range statuses {
		destinations := "[]"
		if status == "forwarded" {
			destinations = `[{"settings":{"destination":"@Archive"},"status":"forwarded","method":"upload","fallbackReason":"Direct forward rejected; uploaded instead"}]`
		}
		if _, err := a.db.Writer.ExecContext(ctx, `INSERT INTO tgdl_forward_queue(group_id,group_name,message_id,status,destinations_json,created_at,updated_at)
			VALUES('-1000000000123','Source',?,?,?,1,1)`, i+1, status, destinations); err != nil {
			t.Fatal(err)
		}
	}
	for i := 0; i < 60; i++ {
		if _, err := a.db.Writer.ExecContext(ctx, `INSERT INTO tgdl_forward_queue(group_id,group_name,message_id,status,created_at,updated_at)
			VALUES('-1000000000123','Source',?,'failed',1,1)`, 100+i); err != nil {
			t.Fatal(err)
		}
	}

	snapshot, err := a.forwardQueueSnapshot(ctx, 0)
	if err != nil {
		t.Fatal(err)
	}
	pending := snapshot["pending"].(int64)
	active := snapshot["active"].(int64)
	failed := snapshot["failed"].(int64)
	interrupted := snapshot["interrupted"].(int64)
	if snapshot["total"] != int64(65) || active != 1 || interrupted != 1 || pending+failed != 62 {
		t.Fatalf("snapshot counts = total:%v pending:%v active:%v failed:%v interrupted:%v", snapshot["total"], snapshot["pending"], snapshot["active"], snapshot["failed"], snapshot["interrupted"])
	}
	if got := len(snapshot["items"].([]map[string]any)); got != forwardQueuePageSize {
		t.Fatalf("first snapshot page items = %d, want %d", got, forwardQueuePageSize)
	}
	if snapshot["page"] != 1 || snapshot["pageSize"] != forwardQueuePageSize {
		t.Fatalf("snapshot pagination = page:%v size:%v", snapshot["page"], snapshot["pageSize"])
	}
	secondPage, err := a.forwardQueueSnapshot(ctx, forwardQueuePageSize)
	if err != nil {
		t.Fatal(err)
	}
	wantSecondPage := int(secondPage["pending"].(int64)+secondPage["active"].(int64)+secondPage["failed"].(int64)+secondPage["interrupted"].(int64)) - forwardQueuePageSize
	if got := len(secondPage["items"].([]map[string]any)); got != wantSecondPage || secondPage["page"] != 2 {
		t.Fatalf("second snapshot page = %#v", secondPage)
	}
	lastPage, err := a.forwardQueueSnapshot(ctx, 50_000)
	if err != nil {
		t.Fatal(err)
	}
	if lastPage["page"] != 2 || len(lastPage["items"].([]map[string]any)) != wantSecondPage {
		t.Fatalf("out-of-range page should clamp to last page: %#v", lastPage)
	}
	recent := lastPage["recent"].([]map[string]any)
	if len(recent) != 1 || recent[0]["status"] != "forwarded" || recent[0]["destinationStates"].([]forwardDestination)[0].FallbackReason != "Direct forward rejected; uploaded instead" {
		t.Fatalf("recent forward history=%#v", recent)
	}
	token, err := a.sessions.Create(ctx, "admin")
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodGet, "/api/forward-queue?page=2", nil)
	req.AddCookie(&http.Cookie{Name: a.sessions.CookieName(), Value: token})
	response := httptest.NewRecorder()
	a.Handler().ServeHTTP(response, req)
	if response.Code != http.StatusOK {
		t.Fatalf("forward queue page status=%d body=%s", response.Code, response.Body.String())
	}
	var pageResponse map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &pageResponse); err != nil {
		t.Fatal(err)
	}
	wantPageItems := int(pageResponse["pending"].(float64)+pageResponse["active"].(float64)+pageResponse["failed"].(float64)+pageResponse["interrupted"].(float64)) - forwardQueuePageSize
	if pageResponse["page"] != float64(2) || len(pageResponse["items"].([]any)) != wantPageItems {
		t.Fatalf("forward queue page response = %#v", pageResponse)
	}
}

func TestUnresolvedCustomCaptionWithoutMessageIDDoesNotRetryAsNewForward(t *testing.T) {
	ctx := context.Background()
	a, fake := forwardTestApp(t, map[string]any{
		"enabled": true, "destination": "@Archive", "deleteAfterForward": true,
		"directForward": true, "captionMode": "custom", "captionBase": "custom", "caption": "fixed caption",
	})
	a.forward(ctx, forwardJob{
		groupID: "-1000000000123", groupName: "Source", messageID: 14,
		settings: map[string]any{
			"enabled": true, "destination": "@Archive", "deleteAfterForward": true,
			"directForward": true, "captionMode": "custom", "captionBase": "custom", "caption": "fixed caption",
		},
		stage: "caption_edit_failed",
		path:  "already-downloaded.mp4",
		destinations: []forwardDestination{{
			Settings: map[string]any{"destination": "@Archive", "captionMode": "custom", "captionBase": "custom", "caption": "fixed caption"},
			Status:   "processing", DirectFailed: true,
		}},
	})
	if len(fake.forwards()) != 0 {
		t.Fatalf("unsafe retry created another forward: %+v", fake.forwards())
	}
}

func TestLegacyUncertainForwardNeedsExplicitCurrentTargetForResend(t *testing.T) {
	ctx := context.Background()
	a, _ := forwardTestApp(t, map[string]any{"enabled": true, "destination": "@CurrentTarget"})
	if _, err := a.db.Writer.ExecContext(ctx, `UPDATE tgdl_forward_queue_state SET paused=1 WHERE id=1`); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UnixMilli()
	ids := make([]int64, 2)
	for i := range ids {
		result, err := a.db.Writer.ExecContext(ctx, `INSERT INTO tgdl_forward_queue(group_id,message_id,forward_config_json,destinations_json,status,stage,created_at,updated_at) VALUES('-1000000000123',?,'{}','[]','uncertain','legacy',?,?)`, 730+i, now, now)
		if err != nil {
			t.Fatal(err)
		}
		ids[i], _ = result.LastInsertId()
	}
	request := func(id int64, action string, confirm bool) *httptest.ResponseRecorder {
		body, _ := json.Marshal(map[string]any{"action": action, "confirmDuplicateRisk": confirm})
		req := httptest.NewRequest(http.MethodPost, "/api/forward-queue/reconcile", bytes.NewReader(body))
		req.SetPathValue("id", strconv.FormatInt(id, 10))
		recorder := httptest.NewRecorder()
		a.handleForwardQueueReconcile(recorder, req)
		return recorder
	}
	if got := request(ids[0], "resend", false).Code; got != http.StatusBadRequest {
		t.Fatalf("unconfirmed legacy resend returned %d", got)
	}
	if got := request(ids[0], "sent", false).Code; got != http.StatusOK {
		t.Fatalf("legacy delivery confirmation returned %d", got)
	}
	if got := request(ids[1], "resend", true).Code; got != http.StatusOK {
		t.Fatalf("confirmed legacy resend returned %d", got)
	}
	var status, config string
	if err := a.db.Reader.QueryRowContext(ctx, `SELECT status,forward_config_json FROM tgdl_forward_queue WHERE id=?`, ids[1]).Scan(&status, &config); err != nil {
		t.Fatal(err)
	}
	var snapshot forwardConfigSnapshot
	if err := json.Unmarshal([]byte(config), &snapshot); err != nil {
		t.Fatal(err)
	}
	if status != "pending" || toString(snapshot.Settings["destination"]) != "@CurrentTarget" {
		t.Fatalf("legacy resend status=%q snapshot=%+v", status, snapshot)
	}
}

func TestAmbiguousTelegramResponseStaysUncertainWithoutAutomaticResend(t *testing.T) {
	ctx := context.Background()
	a, fake := forwardTestApp(t, map[string]any{"enabled": true, "destination": "@Archive", "captionMode": "native", "scanRoute": "direct"})
	fake.fail(context.DeadlineExceeded)
	cfg, err := a.config.Load(ctx)
	if err != nil {
		t.Fatal(err)
	}
	settings, accountID, _ := directScanSettings(cfg, "-1000000000123")
	if err = a.queueDirectScan(ctx, "-1000000000123", "Source", accountID, settings, cfg, docMessage(717, 123, 995, "")); err != nil {
		t.Fatal(err)
	}
	job, err := a.claimForward(ctx)
	if err != nil || job == nil {
		t.Fatalf("claim job=%+v err=%v", job, err)
	}
	a.forward(ctx, *job)
	var status string
	if err = a.db.Reader.QueryRowContext(ctx, `SELECT status FROM tgdl_forward_queue WHERE id=?`, job.queueID).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != "uncertain" || len(fake.forwards()) != 1 {
		t.Fatalf("status=%q native sends=%d", status, len(fake.forwards()))
	}
}

func TestDirectForwardFailureDownloadsThenUploads(t *testing.T) {
	ctx := context.Background()
	a, fake := forwardTestApp(t, map[string]any{"enabled": true, "destination": "@Archive", "deleteAfterForward": true, "directForward": true, "captionMode": "native"})
	var directCalls, downloads atomic.Int32
	transport := mediaTransport(func(_ context.Context, _ telegram.Attachment, w io.Writer) error {
		downloads.Add(1)
		_, err := w.Write([]byte("media"))
		return err
	})
	_, err := a.ingestTelegramWithForward(ctx, docMessage(12, 123, 79, "source caption"), "", "Source", "acct1", transport, func(context.Context, telegram.ForwardMessageRequest) error {
		directCalls.Add(1)
		return errors.New("Telegram forbids native forwarding")
	})
	if err != nil {
		t.Fatal(err)
	}
	eventually(t, "fallback upload", func() bool { return len(fake.calls()) == 1 })
	calls := fake.calls()
	if directCalls.Load() != 1 || downloads.Load() != 1 {
		t.Fatalf("direct attempts=%d downloads=%d", directCalls.Load(), downloads.Load())
	}
	if calls[0].body != "media" || calls[0].req.Protect {
		t.Fatalf("fallback upload=%+v body=%q", calls[0].req, calls[0].body)
	}
	eventually(t, "fallback local copy deletion", func() bool {
		stored, exists := rowPath(t, a, "-1000000000123", 12)
		return exists && stored == ""
	})
	if stored, exists := rowPath(t, a, "-1000000000123", 12); !exists || stored != "" {
		t.Fatal("fallback media bytes were not evicted while retaining its catalog row")
	}
	var downloadRows, forwardRows, attemptRows int
	if err := a.db.Reader.QueryRowContext(ctx, `SELECT COUNT(*) FROM downloads WHERE group_id=? AND message_id=? AND file_path IS NULL`, "-1000000000123", 12).Scan(&downloadRows); err != nil {
		t.Fatal(err)
	}
	if err := a.db.Reader.QueryRowContext(ctx, `SELECT COUNT(*) FROM tgdl_forward_queue WHERE group_id=? AND message_id=? AND status='forwarded' AND destinations_json LIKE '%Direct forward was rejected; downloaded and uploaded instead%'`, "-1000000000123", 12).Scan(&forwardRows); err != nil {
		t.Fatal(err)
	}
	if err := a.db.Reader.QueryRowContext(ctx, `SELECT COUNT(*) FROM tgdl_processing_attempts WHERE group_id=? AND message_id=? AND forward_status='forwarded' AND local_deleted=1`, "-1000000000123", 12).Scan(&attemptRows); err != nil {
		t.Fatal(err)
	}
	if downloadRows != 1 || forwardRows != 1 || attemptRows != 1 {
		t.Fatalf("durable fallback history after cleanup: downloads=%d forwards=%d attempts=%d", downloadRows, forwardRows, attemptRows)
	}
}

func TestProtectedAutoForwardDownloadsAndUploadsProtectedCopy(t *testing.T) {
	ctx := context.Background()
	a, fake := forwardTestApp(t, map[string]any{"enabled": true, "destination": "@Archive", "deleteAfterForward": true, "protect": true, "captionMode": "native"})
	if _, err := a.ingestTelegramWithForward(ctx, docMessage(20, 123, 88, ""), "", "Source", "acct1", fiveBytes, func(context.Context, telegram.ForwardMessageRequest) error {
		t.Fatal("protected media used native forwarding")
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	eventually(t, "protected upload", func() bool { return len(fake.calls()) == 1 })
	call := fake.calls()[0]
	if call.body != "media" || !call.req.Protect {
		t.Fatalf("protected upload=%+v", call)
	}
	eventually(t, "protected copy deletion after forward", func() bool {
		stored, exists := rowPath(t, a, "-1000000000123", 20)
		return exists && stored == ""
	})
}

func docMessage(id int, channel, doc int64, text string) *tg.Message {
	return &tg.Message{ID: id, Message: text, PeerID: &tg.PeerChannel{ChannelID: channel}, Media: &tg.MessageMediaDocument{Document: &tg.Document{ID: doc, Size: 5, DCID: 2, Attributes: []tg.DocumentAttributeClass{&tg.DocumentAttributeFilename{FileName: "clip.bin"}}}}}
}

var fiveBytes = mediaTransport(func(_ context.Context, _ telegram.Attachment, w io.Writer) error {
	_, err := w.Write([]byte("media"))
	return err
})

func rowPath(t *testing.T, a *App, group string, message int) (string, bool) {
	t.Helper()
	var path sql.NullString
	err := a.db.Reader.QueryRow(`SELECT file_path FROM downloads WHERE group_id=? AND message_id=?`, group, message).Scan(&path)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false
	}
	if err != nil {
		t.Fatal(err)
	}
	return path.String, true
}

func TestAutoForwardUploadsAndDeletesOnlyTheLocalCopy(t *testing.T) {
	ctx := context.Background()
	a, fake := forwardTestApp(t, map[string]any{"enabled": true, "destination": "@Archive", "deleteAfterForward": true})
	// Another chat already holds the same media: the forwarded message reuses
	// its file, which must survive deleteAfterForward.
	if _, err := a.ingestTelegram(ctx, docMessage(1, 456, 77, ""), "", "Other", "acct1", fiveBytes); err != nil {
		t.Fatal(err)
	}
	shared, _ := rowPath(t, a, "-1000000000456", 1)
	if _, err := a.ingestTelegram(ctx, docMessage(10, 123, 77, "caption text"), "", "Source", "acct1", fiveBytes); err != nil {
		t.Fatal(err)
	}
	eventually(t, "forwarded local path removal", func() bool { p, ok := rowPath(t, a, "-1000000000123", 10); return ok && p == "" })
	calls := fake.calls()
	if len(calls) != 1 {
		t.Fatalf("calls=%d", len(calls))
	}
	call := calls[0]
	if call.account != "acct2" || call.req.Destination != "@Archive" || call.body != "media" || call.req.Size != 5 {
		t.Fatalf("send=%+v", call)
	}
	if call.req.Caption != "caption text\n\n📌 Source: Source" || len(call.req.Entities) != 1 {
		t.Fatalf("caption=%q", call.req.Caption)
	}
	if link, ok := call.req.Entities[0].(*tg.MessageEntityTextURL); !ok || link.URL != "https://t.me/c/123/10" {
		t.Fatalf("entity=%#v", call.req.Entities[0])
	}
	if _, err := os.Stat(filepath.Join(a.downloadsDir, shared)); err != nil {
		t.Fatalf("shared file removed: %v", err)
	}
	if _, ok := rowPath(t, a, "-1000000000456", 1); !ok {
		t.Fatal("another chat's row was deleted")
	}

	// A file only this message owns is removed from disk.
	unique := mediaTransport(func(_ context.Context, _ telegram.Attachment, w io.Writer) error {
		_, err := w.Write([]byte("other"))
		return err
	})
	// The forward worker may already have removed the row; take the path from
	// the ingest result instead of reading it back.
	record, err := a.ingestTelegram(ctx, docMessage(11, 123, 78, ""), "", "Source", "acct1", unique)
	if err != nil {
		t.Fatal(err)
	}
	own := record.Path
	if own == "" {
		t.Fatal("download missing")
	}
	eventually(t, "local file removal", func() bool {
		_, err := os.Stat(filepath.Join(a.downloadsDir, own))
		return os.IsNotExist(err)
	})
	if len(fake.calls()) != 2 {
		t.Fatalf("calls=%d", len(fake.calls()))
	}
}

func TestAutoForwardSkipsWhenNotLiveDisabledOrAlreadyDownloaded(t *testing.T) {
	ctx := context.Background()
	a, fake := forwardTestApp(t, map[string]any{"enabled": true, "destination": "me", "deleteAfterForward": false})
	fake.observing.Store(false)
	if _, err := a.ingestTelegram(ctx, docMessage(1, 123, 1, ""), "", "Source", "acct1", fiveBytes); err != nil {
		t.Fatal(err)
	}
	fake.observing.Store(true)
	// Re-ingesting a message already in the library is not a new download.
	if _, err := a.ingestTelegram(ctx, docMessage(1, 123, 1, ""), "", "Source", "acct1", fiveBytes); err != nil {
		t.Fatal(err)
	}
	if _, err := a.ingestTelegram(ctx, docMessage(2, 456, 2, ""), "", "Other", "acct1", fiveBytes); err != nil {
		t.Fatal(err)
	}
	if _, err := a.ingestTelegram(ctx, docMessage(3, 123, 3, ""), "", "Source", "acct1", fiveBytes); err != nil {
		t.Fatal(err)
	}
	eventually(t, "forward", func() bool { return len(fake.calls()) == 1 })
	time.Sleep(50 * time.Millisecond)
	if calls := fake.calls(); len(calls) != 1 || !strings.HasPrefix(calls[0].req.Caption, "📌 Source: ") {
		t.Fatalf("calls=%+v", calls)
	}
	// deleteAfterForward off: the download stays.
	if _, ok := rowPath(t, a, "-1000000000123", 3); !ok {
		t.Fatal("download removed without deleteAfterForward")
	}
}

func TestQueuedAutoForwardStopsWhenDisabledAfterEnqueue(t *testing.T) {
	ctx := context.Background()
	a, fake := forwardTestApp(t, map[string]any{"enabled": false, "destination": "me"})
	a.forward(ctx, forwardJob{
		groupID: "-1000000000123",
		settings: map[string]any{
			"enabled": true,
			"routes":  []any{map[string]any{"sourceTopicId": float64(0), "destinationGroupId": "me"}},
		},
		stage: "metadata",
	})
	if calls := fake.calls(); len(calls) != 0 {
		t.Fatalf("disabled auto-forward still sent %d messages", len(calls))
	}
}

func TestAutoForwardDoesNotUploadFallbackAfterItIsDisabled(t *testing.T) {
	ctx := context.Background()
	a, fake := forwardTestApp(t, map[string]any{
		"enabled": true, "destination": "@Archive", "deleteAfterForward": true, "captionMode": "native",
	})
	transport := mediaTransport(func(_ context.Context, _ telegram.Attachment, w io.Writer) error {
		_, err := w.Write([]byte("media"))
		return err
	})
	_, err := a.ingestTelegramWithForward(ctx, docMessage(21, 123, 87, ""), "", "Source", "acct1", transport, func(context.Context, telegram.ForwardMessageRequest) error {
		a.configMu.Lock()
		defer a.configMu.Unlock()
		cfg, err := a.config.Load(ctx)
		if err != nil {
			return err
		}
		groups, _ := cfg["groups"].([]any)
		group := groups[0].(map[string]any)
		settings := group["autoForward"].(map[string]any)
		settings["enabled"] = false
		group["autoForward"] = settings
		cfg["groups"] = groups
		if err := a.config.Save(ctx, cfg); err != nil {
			return err
		}
		return errors.New("native forwarding failed")
	})
	if err != nil {
		t.Fatal(err)
	}
	if calls := fake.calls(); len(calls) != 0 {
		t.Fatalf("auto-forward uploaded after disable: %d uploads", len(calls))
	}
	if _, exists := rowPath(t, a, "-1000000000123", 21); !exists {
		t.Fatal("source media should still be downloaded after native forwarding fails")
	}
}

func TestAutoForwardPausesARefusingDestinationUntilItsRecheck(t *testing.T) {
	ctx := context.Background()
	a, fake := forwardTestApp(t, map[string]any{"enabled": true, "destination": "@Archive", "deleteAfterForward": true})
	fake.fail(tgerr.New(403, "CHAT_WRITE_FORBIDDEN"))
	if _, err := a.ingestTelegram(ctx, docMessage(1, 123, 1, ""), "", "Source", "acct1", fiveBytes); err != nil {
		t.Fatal(err)
	}
	var state, accounts string
	var next int64
	eventually(t, "destination access row", func() bool {
		return a.db.Reader.QueryRow(`SELECT state,next_check_at,accounts FROM chat_access WHERE chat_id='dest:@archive'`).Scan(&state, &next, &accounts) == nil
	})
	if state != "restricted" || next <= time.Now().UnixMilli() || !strings.Contains(accounts, `"acct2"`) {
		t.Fatalf("state=%s next=%d accounts=%s", state, next, accounts)
	}
	// A failed forward never deletes anything.
	if _, ok := rowPath(t, a, "-1000000000123", 1); !ok {
		t.Fatal("download deleted after a failed forward")
	}
	if _, err := a.ingestTelegram(ctx, docMessage(2, 123, 2, ""), "", "Source", "acct1", fiveBytes); err != nil {
		t.Fatal(err)
	}
	time.Sleep(100 * time.Millisecond)
	if n := len(fake.calls()); n != 1 {
		t.Fatalf("paused destination still received %d uploads", n)
	}
	token, err := a.sessions.Create(ctx, "admin")
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodGet, "/api/groups", nil)
	req.AddCookie(&http.Cookie{Name: a.sessions.CookieName(), Value: token})
	rec := httptest.NewRecorder()
	a.Handler().ServeHTTP(rec, req)
	var groups []map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &groups); err != nil {
		t.Fatalf("%v: %s", err, rec.Body.String())
	}
	if access, ok := groups[0]["forwardAccess"].(map[string]any); !ok || access["state"] != "restricted" {
		t.Fatalf("group=%v", groups[0])
	}

	// Its re-check time comes: the next forward is the re-check, and a
	// success clears the pause.
	fake.fail(nil)
	if _, err := a.db.Writer.Exec(`UPDATE chat_access SET next_check_at=1 WHERE chat_id='dest:@archive'`); err != nil {
		t.Fatal(err)
	}
	if _, err := a.ingestTelegram(ctx, docMessage(3, 123, 3, ""), "", "Source", "acct1", fiveBytes); err != nil {
		t.Fatal(err)
	}
	eventually(t, "access row cleared", func() bool {
		var n int
		return a.db.Reader.QueryRow(`SELECT COUNT(*) FROM chat_access WHERE chat_id='dest:@archive'`).Scan(&n) == nil && n == 0
	})
	if n := len(fake.calls()); n != 2 {
		t.Fatalf("calls=%d", n)
	}
}

func TestRecordDestinationAccessBacksOffOnRechecks(t *testing.T) {
	ctx := context.Background()
	a, _ := forwardTestApp(t, nil)
	read := func() (state string, checks int, next int64) {
		if err := a.db.Reader.QueryRow(`SELECT state,checks,next_check_at FROM chat_access WHERE chat_id='dest:1'`).Scan(&state, &checks, &next); err != nil {
			t.Fatal(err)
		}
		return
	}
	if err := a.recordDestinationAccess(ctx, "dest:1", "a", "deleted", "CHANNEL_INVALID", false); err != nil {
		t.Fatal(err)
	}
	_, checks, first := read()
	if checks != 0 || first-time.Now().UnixMilli() > int64(66*time.Minute/time.Millisecond) {
		t.Fatalf("checks=%d next=%d", checks, first)
	}
	// A failure outside a re-check keeps the schedule.
	if err := a.recordDestinationAccess(ctx, "dest:1", "a", "deleted", "CHANNEL_INVALID", false); err != nil {
		t.Fatal(err)
	}
	if _, checks, next := read(); checks != 0 || next != first {
		t.Fatalf("checks=%d next=%d first=%d", checks, next, first)
	}
	if err := a.recordDestinationAccess(ctx, "dest:1", "a", "deleted", "CHANNEL_INVALID", true); err != nil {
		t.Fatal(err)
	}
	if state, checks, next := read(); state != "deleted" || checks != 1 || next-time.Now().UnixMilli() < int64(5*time.Hour/time.Millisecond) {
		t.Fatalf("state=%s checks=%d next=%d", state, checks, next)
	}
	if err := a.markDestinationReachable(ctx, "dest:1", "a"); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := a.db.Reader.QueryRow(`SELECT COUNT(*) FROM chat_access WHERE chat_id='dest:1'`).Scan(&n); err != nil || n != 0 {
		t.Fatalf("rows=%d %v", n, err)
	}
}

func TestDestinationKeyMatchesNode(t *testing.T) {
	for in, want := range map[string]string{"": "", "storage": "", "me": "", "saved": "", "-1001": "dest:-1001", "@Foo": "dest:@foo", "Bar": "dest:@bar"} {
		if got := destinationKey(in); got != want {
			t.Fatalf("%q -> %q, want %q", in, got, want)
		}
	}
}

func TestSelfDestructingMediaRecordsTTL(t *testing.T) {
	ctx := context.Background()
	a, fake := forwardTestApp(t, nil)
	fake.observing.Store(false)
	message := docMessage(5, 456, 9, "")
	message.Media.(*tg.MessageMediaDocument).SetTTLSeconds(15)
	if _, err := a.ingestTelegram(ctx, message, "", "Other", "acct1", fiveBytes); err != nil {
		t.Fatal(err)
	}
	var ttl sql.NullInt64
	if err := a.db.Reader.QueryRow(`SELECT ttl_seconds FROM downloads WHERE group_id='-1000000000456' AND message_id=5`).Scan(&ttl); err != nil || ttl.Int64 != 15 {
		t.Fatalf("ttl=%v %v", ttl, err)
	}
	if _, err := a.ingestTelegram(ctx, docMessage(6, 456, 10, ""), "", "Other", "acct1", fiveBytes); err != nil {
		t.Fatal(err)
	}
	if err := a.db.Reader.QueryRow(`SELECT ttl_seconds FROM downloads WHERE group_id='-1000000000456' AND message_id=6`).Scan(&ttl); err != nil || ttl.Valid {
		t.Fatalf("ordinary media got ttl=%v %v", ttl, err)
	}
}
