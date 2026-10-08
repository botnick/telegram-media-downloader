package telegram

import (
	"context"
	"errors"
	"io"
	"testing"

	"github.com/gotd/td/tg"
)

type profileTransport func(context.Context, Attachment, io.Writer) error

func (fn profileTransport) DownloadMedia(ctx context.Context, a Attachment, w io.Writer) error {
	return fn(ctx, a, w)
}

func TestDialogProfilePhotosKeepAccountPeerAndDC(t *testing.T) {
	for _, kind := range []string{"channel", "group", "user"} {
		t.Run(kind, func(t *testing.T) {
			var peer tg.PeerClass = &tg.PeerChannel{ChannelID: 42}
			var chats = []tg.ChatClass{&tg.Channel{ID: 42, AccessHash: 1234567, Title: "Photo", Photo: &tg.ChatPhoto{PhotoID: 9007199254740993, DCID: 4}}}
			var users []tg.UserClass
			if kind == "group" {
				peer = &tg.PeerChat{ChatID: 42}
				chats = []tg.ChatClass{&tg.Chat{ID: 42, Title: "Photo", Photo: &tg.ChatPhoto{PhotoID: 9007199254740993, DCID: 4}}}
			}
			if kind == "user" {
				peer = &tg.PeerUser{UserID: 42}
				chats = nil
				users = []tg.UserClass{&tg.User{ID: 42, AccessHash: 1234567, FirstName: "Photo", Photo: &tg.UserProfilePhoto{PhotoID: 9007199254740993, DCID: 4}}}
			}
			dialogs := mapDialogPage([]tg.DialogClass{&tg.Dialog{Peer: peer}}, chats, users)
			if len(dialogs) != 1 {
				t.Fatal(dialogs)
			}
			calls := 0
			source := profileTransport(func(_ context.Context, a Attachment, _ io.Writer) error {
				calls++
				location, ok := a.Location.(*tg.InputPeerPhotoFileLocation)
				if !ok || location.PhotoID != 9007199254740993 || location.Big || a.DC != 4 {
					t.Fatalf("wrong location: %+v", a)
				}
				switch p := location.Peer.(type) {
				case *tg.InputPeerChannel:
					if kind != "channel" || p.ChannelID != 42 || p.AccessHash != 1234567 {
						t.Fatal(p)
					}
				case *tg.InputPeerChat:
					if kind != "group" || p.ChatID != 42 {
						t.Fatal(p)
					}
				case *tg.InputPeerUser:
					if kind != "user" || p.UserID != 42 || p.AccessHash != 1234567 {
						t.Fatal(p)
					}
				default:
					t.Fatalf("wrong peer %T", p)
				}
				return nil
			})
			ok, err := downloadDialogPhoto(context.Background(), source, dialogs[0], io.Discard)
			if err != nil || !ok || calls != 1 {
				t.Fatalf("photo=%t calls=%d err=%v", ok, calls, err)
			}
		})
	}
}

func TestMissingPhotoMetadataIsNotProofOfNoPhoto(t *testing.T) {
	peer := &tg.PeerUser{UserID: 42}
	for _, tc := range []struct {
		user  *tg.User
		known bool
	}{{&tg.User{ID: 42, AccessHash: 1}, true}, {&tg.User{ID: 42, Min: true}, false}, {&tg.User{ID: 42, Photo: &tg.UserProfilePhotoEmpty{}}, true}} {
		d := mapDialogPage([]tg.DialogClass{&tg.Dialog{Peer: peer}}, nil, []tg.UserClass{tc.user})[0]
		source := profileTransport(func(context.Context, Attachment, io.Writer) error {
			t.Fatal("absent photo made a download")
			return nil
		})
		ok, err := downloadDialogPhoto(context.Background(), source, d, io.Discard)
		if ok || (err == nil) != tc.known {
			t.Fatalf("known=%t photo=%t error=%v", tc.known, ok, err)
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := downloadDialogPhoto(ctx, nil, Dialog{}, io.Discard); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
}
