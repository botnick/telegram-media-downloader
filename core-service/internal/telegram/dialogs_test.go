package telegram

import (
	"context"
	"testing"

	"github.com/gotd/td/tg"
)

type dialogsFixture struct{}

func (dialogsFixture) MessagesGetDialogs(context.Context, *tg.MessagesGetDialogsRequest) (tg.MessagesDialogsClass, error) {
	dialog := &tg.Dialog{Peer: &tg.PeerChannel{ChannelID: 42}}
	dialog.SetFolderID(1)
	return &tg.MessagesDialogs{Dialogs: []tg.DialogClass{dialog}, Chats: []tg.ChatClass{&tg.Channel{ID: 42, Title: "Media", Username: "media", ParticipantsCount: 7}}}, nil
}

func TestFetchDialogsMapsMarkedChannelAndArchive(t *testing.T) {
	items, err := fetchDialogs(context.Background(), dialogsFixture{}, 10, 1)
	if err != nil || len(items) != 1 {
		t.Fatalf("dialogs=%+v err=%v", items, err)
	}
	if items[0].ID != "-1000000000042" || items[0].Name != "Media" || items[0].Type != "channel" || !items[0].Archived || items[0].Members == nil || *items[0].Members != 7 {
		t.Fatalf("mapped dialog=%+v", items[0])
	}
}
