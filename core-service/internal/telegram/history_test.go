package telegram

import (
	"context"
	"reflect"
	"testing"

	"github.com/gotd/td/tg"
)

func TestManualHistoryPageUsesExclusiveBoundsAndExactPeer(t *testing.T) {
	for _, kind := range []string{"channel", "chat", "user"} {
		t.Run(kind, func(t *testing.T) {
			var input tg.InputPeerClass = &tg.InputPeerChannel{ChannelID: 42, AccessHash: 99}
			var peer tg.PeerClass = &tg.PeerChannel{ChannelID: 42}
			if kind == "chat" {
				input = &tg.InputPeerChat{ChatID: 42}
				peer = &tg.PeerChat{ChatID: 42}
			}
			if kind == "user" {
				input = &tg.InputPeerUser{UserID: 42, AccessHash: 99}
				peer = &tg.PeerUser{UserID: 42}
			}
			dialog := Dialog{ID: markedHistoryPeer(peer), peer: input}
			api := historyRPC(func(_ context.Context, r *tg.MessagesGetHistoryRequest) (tg.MessagesMessagesClass, error) {
				if r.OffsetID != 10 || r.MinID != 5 || r.Limit != 100 || !reflect.DeepEqual(r.Peer, input) {
					t.Fatalf("request=%+v", r)
				}
				return &tg.MessagesMessagesSlice{Count: 99, Users: []tg.UserClass{&tg.User{ID: 42}}, Messages: []tg.MessageClass{&tg.Message{ID: 9, PeerID: peer}, &tg.MessageEmpty{ID: 8}, &tg.MessageService{ID: 7, PeerID: peer}, &tg.Message{ID: 9, PeerID: peer}, &tg.Message{ID: 10, PeerID: peer}, &tg.Message{ID: 5, PeerID: peer}}}, nil
			})
			page, err := fetchHistoryPage(context.Background(), api, dialog, HistoryRequest{OffsetID: 10, MinID: 5, Limit: 500})
			if err != nil {
				t.Fatal(err)
			}
			var ids []int
			for _, m := range page.Messages {
				ids = append(ids, m.GetID())
			}
			if !reflect.DeepEqual(ids, []int{9, 8, 7}) || !page.Done || page.NextOffset != 5 || len(page.Entities.Users) != 1 {
				t.Fatalf("ids=%v page=%+v", ids, page)
			}
		})
	}
}

func TestManualHistoryPageShortSliceContinuesAndStallFails(t *testing.T) {
	dialog := Dialog{ID: "-1000000000042", peer: &tg.InputPeerChannel{ChannelID: 42, AccessHash: 99}}
	api := historyRPC(func(context.Context, *tg.MessagesGetHistoryRequest) (tg.MessagesMessagesClass, error) {
		return &tg.MessagesChannelMessages{Messages: []tg.MessageClass{historyMessage(9)}}, nil
	})
	page, err := fetchHistoryPage(context.Background(), api, dialog, HistoryRequest{})
	if err != nil || page.Done || page.NextOffset != 9 {
		t.Fatalf("short page=%+v %v", page, err)
	}
	if _, err = fetchHistoryPage(context.Background(), api, dialog, HistoryRequest{OffsetID: 9}); err == nil {
		t.Fatal("stalled page succeeded")
	}
	dialog.ID = "-1000000000043"
	if _, err = fetchHistoryPage(context.Background(), api, dialog, HistoryRequest{}); err == nil {
		t.Fatal("foreign peer accepted")
	}
}
