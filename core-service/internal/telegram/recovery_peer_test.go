package telegram

import (
	"context"
	"errors"
	"testing"

	"github.com/botnick/telegram-media-downloader/core-service/internal/store"
	"github.com/gotd/td/tg"
)

type recoveryPeerFixture struct {
	t       *testing.T
	hash    int64
	failure error
	probes  int
}

func (f *recoveryPeerFixture) ContactsResolveUsername(_ context.Context, username string) (*tg.ContactsResolvedPeer, error) {
	if username != "public_media" {
		f.t.Fatalf("username=%q", username)
	}
	return &tg.ContactsResolvedPeer{Peer: &tg.PeerChannel{ChannelID: 42}, Chats: []tg.ChatClass{&tg.Channel{ID: 42, Title: "Media", Username: username, AccessHash: f.hash}}}, nil
}
func (f *recoveryPeerFixture) MessagesGetHistory(_ context.Context, r *tg.MessagesGetHistoryRequest) (tg.MessagesMessagesClass, error) {
	f.probes++
	peer, ok := r.Peer.(*tg.InputPeerChannel)
	if !ok || peer.ChannelID != 42 || peer.AccessHash != f.hash || r.Limit != 1 {
		f.t.Fatalf("probe request=%+v peer=%+v", r, r.Peer)
	}
	return &tg.MessagesChannelMessages{}, f.failure
}
func TestRecoveryPublicUsernameCachesHashAndProbesReadability(t *testing.T) {
	ctx := context.Background()
	db, err := store.Open(ctx, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer db.Reader.Close()
	defer db.Writer.Close()
	state := &UpdateState{Writer: db.Writer, Reader: db.Reader, AccountID: "one"}
	fixture := &recoveryPeerFixture{t: t, hash: 987}
	dialog, err := resolveDialog(ctx, fixture, state, 7, "@public_media")
	if err != nil || dialog.ID != "-1000000000042" || fixture.probes != 0 {
		t.Fatalf("resolve=%+v %v", dialog, err)
	}
	if err := probeDialog(ctx, fixture, dialog); err != nil {
		t.Fatal(err)
	}
	reopened, err := resolveDialog(ctx, fixture, state, 7, dialog.ID)
	if err != nil {
		t.Fatal(err)
	}
	fixture.failure = errors.New("CHANNEL_PRIVATE")
	if err := probeDialog(ctx, fixture, reopened); !errors.Is(err, fixture.failure) {
		t.Fatalf("probe denied but succeeded: %v", err)
	}
	other := &UpdateState{Writer: db.Writer, Reader: db.Reader, AccountID: "two"}
	if _, err := resolveDialog(ctx, fixture, other, 7, dialog.ID); err == nil {
		t.Fatal("borrowed another account hash")
	}
	if err := probeDialog(ctx, fixture, Dialog{ID: dialog.ID}); err == nil {
		t.Fatal("probed with guessed access hash")
	}
}

func TestRecoveryDialogIndexExceedsUICap(t *testing.T) {
	next, calls := 1, 0
	api := dialogsFunc(func(_ context.Context, r *tg.MessagesGetDialogsRequest) (tg.MessagesDialogsClass, error) {
		calls++
		if r.Limit != 100 {
			t.Fatalf("limit=%d", r.Limit)
		}
		end := min(next+99, 1050)
		page := dialogPage(next, end)
		next = end + 1
		for _, raw := range page.Messages {
			raw.(*tg.Message).Date += 10000
		}
		if end == 1050 {
			return &tg.MessagesDialogs{Dialogs: page.Dialogs, Chats: page.Chats, Messages: page.Messages}, nil
		}
		return page, nil
	})
	items, err := fetchDialogPages(context.Background(), api, -1, 0, nil)
	if err != nil || len(items) != 1050 || calls != 11 {
		t.Fatalf("index=%d calls=%d err=%v", len(items), calls, err)
	}
}
