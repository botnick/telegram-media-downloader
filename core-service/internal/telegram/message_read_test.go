package telegram

import (
	"context"
	"errors"
	"testing"

	"github.com/gotd/td/tg"
)

type lookupAPI struct {
	channel func(context.Context, *tg.ChannelsGetMessagesRequest) (tg.MessagesMessagesClass, error)
	message func(context.Context, []tg.InputMessageClass) (tg.MessagesMessagesClass, error)
}

func (a lookupAPI) ChannelsGetMessages(ctx context.Context, r *tg.ChannelsGetMessagesRequest) (tg.MessagesMessagesClass, error) {
	return a.channel(ctx, r)
}
func (a lookupAPI) MessagesGetMessages(ctx context.Context, ids []tg.InputMessageClass) (tg.MessagesMessagesClass, error) {
	return a.message(ctx, ids)
}

func TestURLMessageReadUsesBoundAccountPeerAndChannelPTS(t *testing.T) {
	for _, kind := range []string{"channel", "group", "user"} {
		t.Run(kind, func(t *testing.T) {
			d := Dialog{ID: "-1000000000042", Name: "Known name", Username: "known", peer: &tg.InputPeerChannel{ChannelID: 42, AccessHash: 9007199254740993}}
			var peer tg.PeerClass = &tg.PeerChannel{ChannelID: 42}
			if kind == "group" {
				d.ID, d.peer, peer = "-42", &tg.InputPeerChat{ChatID: 42}, &tg.PeerChat{ChatID: 42}
			}
			if kind == "user" {
				d.ID, d.peer, peer = "42", &tg.InputPeerUser{UserID: 42, AccessHash: 19}, &tg.PeerUser{UserID: 42}
			}
			m := &tg.Message{ID: 10, PeerID: peer}
			var result tg.MessagesMessagesClass = &tg.MessagesMessages{Messages: []tg.MessageClass{m}, Users: []tg.UserClass{&tg.User{ID: 5}}}
			if kind == "channel" {
				result = &tg.MessagesChannelMessages{Pts: 99, Messages: []tg.MessageClass{m}, Chats: []tg.ChatClass{&tg.Channel{ID: 42, AccessHash: 9007199254740993, Title: "Fresh title"}}, Users: []tg.UserClass{&tg.User{ID: 5}}}
			}
			api := lookupAPI{channel: func(_ context.Context, req *tg.ChannelsGetMessagesRequest) (tg.MessagesMessagesClass, error) {
				p := req.Channel.(*tg.InputChannel)
				if kind != "channel" || p.ChannelID != 42 || p.AccessHash != 9007199254740993 || len(req.ID) != 1 || req.ID[0].(*tg.InputMessageID).ID != 10 {
					t.Fatalf("wrong RPC %+v", req)
				}
				return result, nil
			}, message: func(_ context.Context, ids []tg.InputMessageClass) (tg.MessagesMessagesClass, error) {
				if kind == "channel" || len(ids) != 1 || ids[0].(*tg.InputMessageID).ID != 10 {
					t.Fatal("wrong message RPC")
				}
				return result, nil
			}}
			got, err := readMessage(context.Background(), api, d, 10)
			if err != nil || got.Message != m || len(got.Entities.Users) != 1 {
				t.Fatalf("lookup=%+v %v", got, err)
			}
			if kind == "channel" && (got.PTS != 99 || got.Dialog.Name != "Fresh title") {
				t.Fatalf("lost channel metadata: %+v", got)
			}
			if kind != "channel" && (got.Dialog.Name != "Known name" || got.Dialog.Username != "known") {
				t.Fatalf("missing entities erased resolved metadata: %+v", got.Dialog)
			}
			m.PeerID = &tg.PeerUser{UserID: 999}
			if _, err = readMessage(context.Background(), api, d, 10); err == nil {
				t.Fatal("accepted another peer")
			}
		})
	}
}

func TestURLMessageReadRejectsMissingWrongIDAndCancellation(t *testing.T) {
	d := Dialog{ID: "-42", peer: &tg.InputPeerChat{ChatID: 42}}
	for _, messages := range [][]tg.MessageClass{nil, {&tg.MessageEmpty{ID: 10}}, {&tg.Message{ID: 11, PeerID: &tg.PeerChat{ChatID: 42}}}, {&tg.Message{ID: 10, PeerID: &tg.PeerChat{ChatID: 42}}, &tg.Message{ID: 10}}} {
		api := lookupAPI{message: func(context.Context, []tg.InputMessageClass) (tg.MessagesMessagesClass, error) {
			return &tg.MessagesMessagesSlice{Messages: messages}, nil
		}}
		if _, err := readMessage(context.Background(), api, d, 10); err == nil {
			t.Fatalf("accepted invalid response %v", messages)
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	api := lookupAPI{message: func(context.Context, []tg.InputMessageClass) (tg.MessagesMessagesClass, error) {
		cancel()
		return &tg.MessagesMessages{Messages: []tg.MessageClass{&tg.Message{ID: 10, PeerID: &tg.PeerChat{ChatID: 42}}}}, nil
	}}
	if _, err := readMessage(ctx, api, d, 10); !errors.Is(err, context.Canceled) {
		t.Fatalf("accepted cancelled RPC: %v", err)
	}
	api.message = func(context.Context, []tg.InputMessageClass) (tg.MessagesMessagesClass, error) {
		t.Fatal("cancelled read made RPC")
		return nil, nil
	}
	if _, err := readMessage(ctx, api, d, 10); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
}
