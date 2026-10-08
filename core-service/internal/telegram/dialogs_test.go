package telegram

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/gotd/td/tg"
)

type dialogsFixture struct{}

func (dialogsFixture) MessagesGetDialogs(context.Context, *tg.MessagesGetDialogsRequest) (tg.MessagesDialogsClass, error) {
	dialog := &tg.Dialog{Peer: &tg.PeerChannel{ChannelID: 42}}
	dialog.SetFolderID(1)
	return &tg.MessagesDialogs{Dialogs: []tg.DialogClass{dialog}, Chats: []tg.ChatClass{&tg.Channel{ID: 42, Title: "Media", Username: "media", ParticipantsCount: 7}}}, nil
}

type dialogsFunc func(context.Context, *tg.MessagesGetDialogsRequest) (tg.MessagesDialogsClass, error)

func (fn dialogsFunc) MessagesGetDialogs(ctx context.Context, req *tg.MessagesGetDialogsRequest) (tg.MessagesDialogsClass, error) {
	return fn(ctx, req)
}

func dialogPage(from, to int) *tg.MessagesDialogsSlice {
	page := &tg.MessagesDialogsSlice{Count: 201}
	for id := from; id <= to; id++ {
		peer := &tg.PeerChannel{ChannelID: int64(id)}
		page.Dialogs = append(page.Dialogs, &tg.Dialog{Peer: peer, TopMessage: 10})
		page.Messages = append(page.Messages, &tg.Message{ID: 10, PeerID: peer, Date: 1000 - id})
		page.Chats = append(page.Chats, &tg.Channel{ID: int64(id), Title: fmt.Sprintf("Channel %d", id), AccessHash: int64(10000 + id)})
	}
	return page
}

func TestDialogsPaginatesWithPeerScopedMessageAndExplicitFolder(t *testing.T) {
	calls := 0
	api := dialogsFunc(func(ctx context.Context, req *tg.MessagesGetDialogsRequest) (tg.MessagesDialogsClass, error) {
		folder, present := req.GetFolderID()
		if !present || folder != 0 || req.Limit != 100 {
			t.Fatalf("folder/page request: %+v", req)
		}
		if _, bounded := ctx.Deadline(); !bounded {
			t.Fatal("RPC lacks deadline")
		}
		calls++
		if calls == 1 {
			if req.ExcludePinned || req.OffsetID != 0 {
				t.Fatalf("first request=%+v", req)
			}
			return dialogPage(1, 100), nil
		}
		last := int64((calls - 1) * 100)
		peer, ok := req.OffsetPeer.(*tg.InputPeerChannel)
		if !ok || peer.ChannelID != last || peer.AccessHash != 10000+last || req.OffsetID != 10 || req.OffsetDate != 1000-int(last) || !req.ExcludePinned {
			t.Fatalf("cursor=%+v peer=%+v", req, req.OffsetPeer)
		}
		if calls == 2 {
			return dialogPage(101, 200), nil
		}
		if calls != 3 {
			t.Fatalf("extra RPC: %d", calls)
		}
		page := dialogPage(201, 201)
		return &tg.MessagesDialogs{Dialogs: page.Dialogs, Chats: page.Chats, Messages: page.Messages}, nil
	})
	items, err := fetchDialogs(context.Background(), api, 500, 0)
	if err != nil || len(items) != 201 || calls != 3 || items[200].ID != "-1000000000201" {
		t.Fatalf("count=%d calls=%d err=%v", len(items), calls, err)
	}
}

func TestDialogsShortSlicePinnedOnlyAndOverlap(t *testing.T) {
	calls := 0
	api := dialogsFunc(func(_ context.Context, req *tg.MessagesGetDialogsRequest) (tg.MessagesDialogsClass, error) {
		if folder, ok := req.GetFolderID(); !ok || folder != 1 {
			t.Fatalf("archive flag missing: %+v", req)
		}
		calls++
		switch calls {
		case 1:
			page := dialogPage(1, 1)
			page.Dialogs[0].(*tg.Dialog).Pinned = true
			return page, nil
		case 2:
			if !req.ExcludePinned || req.OffsetID != 0 {
				t.Fatalf("pinned dialog used as offset: %+v", req)
			}
			return dialogPage(2, 3), nil
		case 3:
			if req.OffsetDate != 997 {
				t.Fatalf("offset=%+v", req)
			}
			// A dialog moving across the page boundary must not duplicate rows.
			page := dialogPage(3, 4)
			return &tg.MessagesDialogs{Dialogs: page.Dialogs, Chats: page.Chats}, nil
		default:
			t.Fatal("unbounded pagination")
			return nil, nil
		}
	})
	items, err := fetchDialogs(context.Background(), api, 500, 1)
	if err != nil || len(items) != 4 || calls != 3 {
		t.Fatalf("count=%d calls=%d err=%v", len(items), calls, err)
	}
}

func TestDialogsRejectsIncompletePages(t *testing.T) {
	for _, failure := range []string{"rpc", "message", "hash", "minimal", "loop", "cycle", "unexpected"} {
		t.Run(failure, func(t *testing.T) {
			calls := 0
			api := dialogsFunc(func(_ context.Context, _ *tg.MessagesGetDialogsRequest) (tg.MessagesDialogsClass, error) {
				calls++
				if calls > 4 {
					t.Fatal("pagination did not stop")
				}
				page := dialogPage(1, 1)
				switch failure {
				case "rpc":
					if calls > 1 {
						return nil, errors.New("unreachable")
					}
				case "message":
					page.Messages = []tg.MessageClass{&tg.Message{ID: 10, Date: 99, PeerID: &tg.PeerUser{UserID: 1}}}
				case "hash":
					page.Chats = nil
				case "minimal":
					page.Chats[0].(*tg.Channel).Min = true
				case "cycle":
					if calls == 2 {
						page = dialogPage(2, 2)
					}
				case "unexpected":
					return &tg.MessagesDialogsNotModified{}, nil
				}
				return page, nil
			})
			items, err := fetchDialogs(context.Background(), api, 500, 0)
			if err == nil || items != nil {
				t.Fatalf("incomplete response returned as success: %v %+v", err, items)
			}
		})
	}
}

func TestDialogsTotalLimitCancellationAndObserverFailure(t *testing.T) {
	api := dialogsFunc(func(_ context.Context, req *tg.MessagesGetDialogsRequest) (tg.MessagesDialogsClass, error) {
		if req.Limit != 2 {
			t.Fatalf("page limit=%d", req.Limit)
		}
		return dialogPage(1, 3), nil
	})
	items, err := fetchDialogs(context.Background(), api, 2, 0)
	if err != nil || len(items) != 2 {
		t.Fatalf("limit not honored: %v %+v", err, items)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := fetchDialogs(ctx, api, 2, 0); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancellation=%v", err)
	}
	items, err = fetchDialogPages(context.Background(), api, 2, 0, func(context.Context, []tg.ChatClass, []tg.UserClass) error { return errors.New("cache failed") })
	if err == nil || !strings.Contains(err.Error(), "cache failed") || items != nil {
		t.Fatalf("ignored cache failure: %v %+v", err, items)
	}
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
