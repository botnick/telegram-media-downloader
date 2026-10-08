package telegram

import (
	"context"
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
