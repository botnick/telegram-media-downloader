package telegram

import (
	"context"
	"fmt"
	"testing"

	"github.com/botnick/telegram-media-downloader/core-service/internal/store"
	"github.com/gotd/td/tg"
)

type historyFixture struct {
	calls int
}

func (f *historyFixture) MessagesGetHistory(_ context.Context, request *tg.MessagesGetHistoryRequest) (tg.MessagesMessagesClass, error) {
	f.calls++
	if request.OffsetID != 0 {
		return &tg.MessagesMessages{Messages: nil}, nil
	}
	return &tg.MessagesMessages{Messages: []tg.MessageClass{
		&tg.Message{ID: 3, PeerID: &tg.PeerChannel{ChannelID: 42}},
		&tg.Message{ID: 2, PeerID: &tg.PeerChannel{ChannelID: 42}},
	}}, nil
}

func TestRecoverChannelHistoryPaginatesAndPreservesEntities(t *testing.T) {
	f := new(historyFixture)
	var ids []int
	err := recoverChannelHistory(context.Background(), f, func(_ context.Context, update tg.UpdatesClass) error {
		batch := update.(*tg.Updates)
		message := batch.Updates[0].(*tg.UpdateNewChannelMessage).Message.(*tg.Message)
		ids = append(ids, message.ID)
		return nil
	}, 42, 99)
	if err != nil || f.calls != 1 || len(ids) != 2 || ids[0] != 3 || ids[1] != 2 {
		t.Fatalf("recovery calls=%d ids=%v err=%v", f.calls, ids, err)
	}
}

type serviceHistoryFixture struct {
	calls int
}

func (f *serviceHistoryFixture) MessagesGetHistory(_ context.Context, request *tg.MessagesGetHistoryRequest) (tg.MessagesMessagesClass, error) {
	f.calls++
	if request.OffsetID != 0 {
		return &tg.MessagesMessages{Messages: nil}, nil
	}
	return &tg.MessagesMessages{Messages: []tg.MessageClass{
		&tg.MessageService{ID: 8, PeerID: &tg.PeerChannel{ChannelID: 42}},
		&tg.MessageEmpty{ID: 7, PeerID: &tg.PeerChannel{ChannelID: 42}},
	}}, nil
}

func TestRecoverChannelHistoryAdvancesPastServiceMessages(t *testing.T) {
	f := new(serviceHistoryFixture)
	handled := false
	err := recoverChannelHistory(context.Background(), f, func(context.Context, tg.UpdatesClass) error {
		handled = true
		return nil
	}, 42, 99)
	if err != nil || f.calls != 1 || handled {
		t.Fatalf("service-only recovery calls=%d handled=%v err=%v", f.calls, handled, err)
	}
}

type differenceFixture struct {
	calls []int
}

func (f *differenceFixture) UpdatesGetChannelDifference(_ context.Context, request *tg.UpdatesGetChannelDifferenceRequest) (tg.UpdatesChannelDifferenceClass, error) {
	if request.Limit != recoveryDifferenceLimit {
		return nil, fmt.Errorf("limit=%d", request.Limit)
	}
	f.calls = append(f.calls, request.Pts)
	if len(f.calls) == 1 {
		return &tg.UpdatesChannelDifference{Pts: 20, Final: false}, nil
	}
	return &tg.UpdatesChannelDifference{Pts: 30, Final: true}, nil
}

func TestResolveRecoveryPtsWaitsForFinalDifference(t *testing.T) {
	ctx := context.Background()
	db, err := store.Open(ctx, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer db.Reader.Close()
	defer db.Writer.Close()
	state := &UpdateState{Writer: db.Writer, Reader: db.Reader, AccountID: "one"}
	if err = state.SetChannelPts(ctx, 7, 42, 10); err != nil {
		t.Fatal(err)
	}
	fixture := new(differenceFixture)
	pts, err := resolveRecoveryPts(ctx, fixture, 7, 42, 99, state)
	if err != nil || pts != 30 {
		t.Fatalf("resolved pts=%d calls=%v err=%v", pts, fixture.calls, err)
	}
	if len(fixture.calls) != 2 || fixture.calls[0] != 10 || fixture.calls[1] != 20 {
		t.Fatalf("difference cursors=%v", fixture.calls)
	}
}

type zeroDifferenceFixture struct{}

func (zeroDifferenceFixture) UpdatesGetChannelDifference(context.Context, *tg.UpdatesGetChannelDifferenceRequest) (tg.UpdatesChannelDifferenceClass, error) {
	return &tg.UpdatesChannelDifference{Final: true}, nil
}

func TestResolveRecoveryPtsRejectsZero(t *testing.T) {
	ctx := context.Background()
	db, err := store.Open(ctx, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer db.Reader.Close()
	defer db.Writer.Close()
	state := &UpdateState{Writer: db.Writer, Reader: db.Reader, AccountID: "one"}
	if _, err = resolveRecoveryPts(ctx, zeroDifferenceFixture{}, 7, 42, 99, state); err == nil {
		t.Fatal("zero recovery cursor was accepted")
	}
}

func TestRecoveryMarkerCompletesOnlyAfterHistorySink(t *testing.T) {
	ctx := context.Background()
	db, err := store.Open(ctx, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer db.Reader.Close()
	defer db.Writer.Close()
	state := &UpdateState{Writer: db.Writer, Reader: db.Reader, AccountID: "one"}
	if err = state.SetChannelAccessHash(ctx, 7, 42, 99); err != nil {
		t.Fatal(err)
	}
	if err = state.RecordRecovery(ctx, 7, 42, 20); err != nil {
		t.Fatal(err)
	}
	if err = state.RecordRecovery(ctx, 0, 42, 0); err != nil {
		t.Fatal(err)
	}
	records, err := state.PendingRecovery(ctx)
	if err != nil || len(records) != 1 || records[0].Pts != 20 {
		t.Fatalf("pending=%+v err=%v", records, err)
	}
	if err = state.CompleteRecovery(ctx, records[0]); err != nil {
		t.Fatal(err)
	}
	if records, err = state.PendingRecovery(ctx); err != nil || len(records) != 0 {
		t.Fatalf("marker survived completion: %+v %v", records, err)
	}
	pts, found, err := state.GetChannelPts(ctx, 7, 42)
	if err != nil || !found || pts != 20 {
		t.Fatalf("cursor=%d found=%v err=%v", pts, found, err)
	}
}
