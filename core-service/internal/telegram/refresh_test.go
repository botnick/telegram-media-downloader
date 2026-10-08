package telegram

import (
	"context"
	"github.com/botnick/telegram-media-downloader/core-service/internal/store"
	"github.com/gotd/td/tg"
	"testing"
)

type refreshAPI struct {
	t      *testing.T
	result tg.MessagesMessagesClass
}

func (a refreshAPI) ChannelsGetMessages(_ context.Context, r *tg.ChannelsGetMessagesRequest) (tg.MessagesMessagesClass, error) {
	channel := r.Channel.(*tg.InputChannel)
	if channel.ChannelID != 42 || channel.AccessHash != 1234 || r.ID[0].(*tg.InputMessageID).ID != 10 {
		a.t.Fatalf("wrong account/peer refresh: %+v", r)
	}
	return a.result, nil
}
func (a refreshAPI) MessagesGetMessages(context.Context, []tg.InputMessageClass) (tg.MessagesMessagesClass, error) {
	a.t.Fatal("channel message used global method")
	return nil, nil
}
func TestRefreshUsesSavedAccountHashAndRetainsFilterEntities(t *testing.T) {
	ctx := context.Background()
	db, err := store.Open(ctx, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer db.Reader.Close()
	defer db.Writer.Close()
	s := &UpdateState{Writer: db.Writer, Reader: db.Reader, AccountID: "one"}
	if err = s.SetChannelAccessHash(ctx, 7, 42, 1234); err != nil {
		t.Fatal(err)
	}
	old := &tg.Message{ID: 10, PeerID: &tg.PeerChannel{ChannelID: 42}}
	fresh := &tg.Message{ID: 10, PeerID: &tg.PeerChannel{ChannelID: 42}, Media: &tg.MessageMediaDocument{Document: &tg.Document{ID: 99, FileReference: []byte("renewed")}}}
	api := refreshAPI{t: t, result: &tg.MessagesChannelMessages{Messages: []tg.MessageClass{fresh}, Users: []tg.UserClass{&tg.User{ID: 1, Username: "allowed"}}}}
	got, err := refreshMessage(ctx, api, s, 7, old)
	if err != nil || got.Message != fresh || len(got.Entities.Users) != 1 {
		t.Fatalf("refresh lost data: %+v %v", got, err)
	}
	fresh.PeerID = &tg.PeerChannel{ChannelID: 999}
	if _, err = refreshMessage(ctx, api, s, 7, old); err == nil {
		t.Fatal("accepted another channel")
	}
}
