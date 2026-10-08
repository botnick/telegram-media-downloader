package telegram

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"testing"

	"github.com/botnick/telegram-media-downloader/core-service/internal/store"
	"github.com/gotd/td/tg"
)

type historyFixture struct {
	calls int
}

type historyRPC func(context.Context, *tg.MessagesGetHistoryRequest) (tg.MessagesMessagesClass, error)

func (f historyRPC) MessagesGetHistory(ctx context.Context, req *tg.MessagesGetHistoryRequest) (tg.MessagesMessagesClass, error) {
	return f(ctx, req)
}

func (historyRPC) UpdatesGetChannelDifference(context.Context, *tg.UpdatesGetChannelDifferenceRequest) (tg.UpdatesChannelDifferenceClass, error) {
	return nil, errors.New("unexpected difference request")
}

func historyMessage(id int) *tg.Message {
	return &tg.Message{ID: id, PeerID: &tg.PeerChannel{ChannelID: 42}}
}

func TestRecoverChannelHistoryContinuesShortPagesAndSuppressesOverlap(t *testing.T) {
	var offsets, ids []int
	users := []tg.UserClass{&tg.User{ID: 123, Username: "tracked"}}
	chats := []tg.ChatClass{&tg.Channel{ID: 42, AccessHash: 99}}
	api := historyRPC(func(ctx context.Context, r *tg.MessagesGetHistoryRequest) (tg.MessagesMessagesClass, error) {
		if _, ok := ctx.Deadline(); !ok {
			t.Fatal("history RPC is unbounded")
		}
		peer := r.Peer.(*tg.InputPeerChannel)
		if peer.ChannelID != 42 || peer.AccessHash != 99 || r.Limit != 100 {
			t.Fatalf("wrong history request: %+v", r)
		}
		offsets = append(offsets, r.OffsetID)
		page := &tg.MessagesChannelMessages{Count: 999, Users: users, Chats: chats}
		switch r.OffsetID {
		case 0:
			page.Messages = []tg.MessageClass{historyMessage(7), historyMessage(6), &tg.MessageService{ID: 5, PeerID: &tg.PeerChannel{ChannelID: 42}}}
		case 5:
			page.Messages = []tg.MessageClass{historyMessage(5), &tg.MessageEmpty{ID: 4}, historyMessage(3), historyMessage(3), historyMessage(2)}
		case 2:
		default:
			t.Fatalf("unexpected offset %d", r.OffsetID)
		}
		return page, nil
	})
	err := recoverChannelHistory(context.Background(), api, func(_ context.Context, raw tg.UpdatesClass) error {
		u := raw.(*tg.Updates)
		if !reflect.DeepEqual(u.Users, users) || !reflect.DeepEqual(u.Chats, chats) {
			t.Fatal("history lost user/chat filter entities")
		}
		ids = append(ids, u.Updates[0].(*tg.UpdateNewChannelMessage).Message.GetID())
		return nil
	}, 42, 99)
	if err != nil || !reflect.DeepEqual(offsets, []int{0, 5, 2}) || !reflect.DeepEqual(ids, []int{7, 6, 3, 2}) {
		t.Fatalf("offsets=%v messages=%v error=%v", offsets, ids, err)
	}
}

func TestRecoverChannelHistoryRejectsIncompleteOrForeignPages(t *testing.T) {
	for _, tc := range []struct {
		name string
		page tg.MessagesMessagesClass
	}{
		{"stalled cursor", &tg.MessagesChannelMessages{Messages: []tg.MessageClass{historyMessage(7)}}},
		{"cursor moved newer", &tg.MessagesChannelMessages{Messages: []tg.MessageClass{historyMessage(8)}}},
		{"wrong channel", &tg.MessagesChannelMessages{Messages: []tg.MessageClass{&tg.Message{ID: 6, PeerID: &tg.PeerChannel{ChannelID: 43}}}}},
		{"mixed peers", &tg.MessagesChannelMessages{Messages: []tg.MessageClass{historyMessage(6), &tg.Message{ID: 5, PeerID: &tg.PeerChat{ChatID: 42}}}}},
		{"invalid id", &tg.MessagesChannelMessages{Messages: []tg.MessageClass{historyMessage(0)}}},
		{"nil message", &tg.MessagesChannelMessages{Messages: []tg.MessageClass{nil}}},
		{"not modified without cache", &tg.MessagesMessagesNotModified{}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls, handled := 0, 0
			api := historyRPC(func(context.Context, *tg.MessagesGetHistoryRequest) (tg.MessagesMessagesClass, error) {
				calls++
				if calls == 1 {
					return &tg.MessagesChannelMessages{Messages: []tg.MessageClass{historyMessage(7)}}, nil
				}
				return tc.page, nil
			})
			err := recoverChannelHistory(context.Background(), api, func(context.Context, tg.UpdatesClass) error {
				handled++
				return nil
			}, 42, 99)
			if err == nil || calls != 2 || handled != 1 {
				t.Fatalf("calls=%d handled=%d error=%v", calls, handled, err)
			}
		})
	}
}

func TestRecoverChannelHistoryCancellationCannotCompleteOnEmptyPage(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	api := historyRPC(func(context.Context, *tg.MessagesGetHistoryRequest) (tg.MessagesMessagesClass, error) {
		cancel()
		return &tg.MessagesChannelMessages{}, nil
	})
	err := recoverChannelHistory(ctx, api, func(context.Context, tg.UpdatesClass) error { return nil }, 42, 99)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("cancellation reported success: %v", err)
	}
}

func TestPendingHistoryFailureSurvivesReopenAndAdvancesOnlyAfterAllPages(t *testing.T) {
	for _, failureMode := range []string{"rpc", "sink"} {
		t.Run(failureMode, func(t *testing.T) {
			ctx := context.Background()
			dir := t.TempDir()
			db, err := store.Open(ctx, dir)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { db.Reader.Close(); db.Writer.Close() })
			state := &UpdateState{Reader: db.Reader, Writer: db.Writer, AccountID: "one"}
			if err = state.SetChannelAccessHash(ctx, 1, 42, 99); err != nil {
				t.Fatal(err)
			}
			if err = state.SetChannelPts(ctx, 1, 42, 5); err != nil {
				t.Fatal(err)
			}
			if err = state.RecordRecovery(ctx, 1, 42, 20); err != nil {
				t.Fatal(err)
			}
			failure := errors.New("history interrupted")
			interrupted := true
			var ids []int
			api := historyRPC(func(_ context.Context, r *tg.MessagesGetHistoryRequest) (tg.MessagesMessagesClass, error) {
				if r.OffsetID != 0 && interrupted && failureMode == "rpc" {
					return nil, failure
				}
				page := &tg.MessagesChannelMessages{}
				switch r.OffsetID {
				case 0:
					page.Messages = []tg.MessageClass{historyMessage(10)}
				case 10:
					page.Messages = []tg.MessageClass{historyMessage(9)}
				case 9:
				default:
					t.Fatalf("unexpected offset=%d", r.OffsetID)
				}
				return page, nil
			})
			sink := func(ctx context.Context, raw tg.UpdatesClass) error {
				pts, _, err := state.GetChannelPts(ctx, 1, 42)
				if err != nil || pts != 5 {
					t.Fatalf("cursor advanced before history was accepted: %d %v", pts, err)
				}
				records, err := state.PendingRecovery(ctx)
				if err != nil || len(records) != 1 {
					t.Fatalf("marker disappeared before history was accepted: %+v %v", records, err)
				}
				id := raw.(*tg.Updates).Updates[0].(*tg.UpdateNewChannelMessage).Message.GetID()
				if id == 9 && interrupted && failureMode == "sink" {
					return failure
				}
				ids = append(ids, id)
				return nil
			}
			if err = recoverPendingHistory(ctx, api, state, 1, sink); !errors.Is(err, failure) {
				t.Fatalf("partial history completed: %v", err)
			}
			db.Reader.Close()
			db.Writer.Close()
			db, err = store.Open(ctx, dir)
			if err != nil {
				t.Fatal(err)
			}
			state = &UpdateState{Reader: db.Reader, Writer: db.Writer, AccountID: "one"}
			interrupted = false
			if err = recoverPendingHistory(ctx, api, state, 1, sink); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(ids, []int{10, 10, 9}) {
				t.Fatalf("resume lost history (first page replay is deduped by the queue): %v", ids)
			}
			pts, found, err := state.GetChannelPts(ctx, 1, 42)
			if err != nil || !found || pts != 20 {
				t.Fatalf("completed cursor=%d found=%t error=%v", pts, found, err)
			}
			records, err := state.PendingRecovery(ctx)
			if err != nil || len(records) != 0 {
				t.Fatalf("completed markers=%+v error=%v", records, err)
			}
		})
	}
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
