package engine

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/botnick/telegram-media-downloader/core-service/internal/telegram"
	"github.com/gotd/td/tg"
)

func ttlMessage(id int, media int64, ttl int) *tg.Message {
	message := testMessage(id, 0, media)
	doc := message.Media.(*tg.MessageMediaDocument)
	doc.SetTTLSeconds(ttl)
	return message
}

func TestSelfDestructingMediaIsClaimedFirst(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	if _, _, err := enqueueWork(ctx, s.writer, "one", Target{}, testMessage(1, 0, 1), 0, "history"); err != nil {
		t.Fatal(err)
	}
	for _, id := range []int{2, 3} {
		if _, _, err := s.Enqueue(ctx, "one", Target{}, testMessage(id, 0, int64(id))); err != nil {
			t.Fatal(err)
		}
	}
	if _, _, err := s.Enqueue(ctx, "one", Target{}, ttlMessage(4, 4, 10)); err != nil {
		t.Fatal(err)
	}
	var ttl int
	if err := s.reader.QueryRow(`SELECT ttl_seconds FROM tgdl_work WHERE message_id=4`).Scan(&ttl); err != nil || ttl != 10 {
		t.Fatalf("ttl=%d %v", ttl, err)
	}
	var order []int64
	for {
		work, err := s.Claim(ctx, []string{"one"}, time.Now())
		if err != nil {
			t.Fatal(err)
		}
		if work == nil {
			break
		}
		order = append(order, work.MessageID)
		if err := s.Finish(ctx, work, nil, false, time.Time{}); err != nil {
			t.Fatal(err)
		}
	}
	if len(order) != 4 || order[0] != 4 || order[1] != 2 || order[2] != 3 || order[3] != 1 {
		t.Fatalf("claim order=%v, want TTL, live, live, history", order)
	}
	rows, err := s.reader.Query(`EXPLAIN QUERY PLAN SELECT id FROM tgdl_work WHERE status='pending' AND paused=0 ORDER BY ` + claimPriority + `,id LIMIT 1`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var plan []string
	for rows.Next() {
		var detail string
		if err := rows.Scan(new(int), new(int), new(int), &detail); err != nil {
			t.Fatal(err)
		}
		plan = append(plan, detail)
	}
	joined := strings.Join(plan, "; ")
	if !strings.Contains(joined, "idx_tgdl_work_priority") || strings.Contains(joined, "TEMP B-TREE") {
		t.Fatalf("claim order no longer comes from its index: %s", joined)
	}
}

type sendingAccount struct {
	connectingAccount
	sent  chan telegram.SendFileRequest
	block bool
}

func (a *sendingAccount) SendFile(ctx context.Context, req telegram.SendFileRequest) (int, error) {
	if a.block {
		<-ctx.Done()
		return 0, ctx.Err()
	}
	a.sent <- req
	return 7, nil
}

func TestSendFileUsesForwardAccountOrFirstAccount(t *testing.T) {
	one := &sendingAccount{sent: make(chan telegram.SendFileRequest, 1)}
	two := &sendingAccount{sent: make(chan telegram.SendFileRequest, 1)}
	run := &running{ctx: context.Background(), accounts: map[string]Account{"one": one, "two": two}, ids: []string{"one", "two"}}
	c := &Controller{state: "running", run: run}
	if c.Observing() {
		t.Fatal("jobs-only run reported as live monitor")
	}
	run.observing.Store(true)
	if !c.Observing() {
		t.Fatal("live monitor not reported")
	}
	used, id, err := c.SendFile(context.Background(), "two", telegram.SendFileRequest{Name: "x"})
	if err != nil || used != "two" || id != 7 || len(two.sent) != 1 {
		t.Fatalf("used=%s id=%d err=%v", used, id, err)
	}
	used, _, err = c.SendFile(context.Background(), "gone", telegram.SendFileRequest{Name: "x"})
	if err != nil || used != "one" || len(one.sent) != 1 {
		t.Fatalf("fallback used=%s err=%v", used, err)
	}
	if run.jobUsers.Load() != 0 {
		t.Fatal("upload lease leaked")
	}
	c.state = "stopped"
	if _, _, err = c.SendFile(context.Background(), "", telegram.SendFileRequest{}); !errors.Is(err, ErrEngineNotRunning) {
		t.Fatalf("stopped engine err=%v", err)
	}
}

func TestSendFileEndsWithAccountRun(t *testing.T) {
	runCtx, cancel := context.WithCancel(context.Background())
	run := &running{ctx: runCtx, accounts: map[string]Account{"one": &sendingAccount{block: true}}, ids: []string{"one"}}
	c := &Controller{state: "running", run: run}
	done := make(chan error, 1)
	go func() {
		_, _, err := c.SendFile(context.Background(), "", telegram.SendFileRequest{})
		done <- err
	}()
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("err=%v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("upload outlived its account")
	}
}
