package telegram

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"

	"github.com/gotd/td/tg"
)

type removalRPC struct {
	t       *testing.T
	calls   []string
	leave   func(context.Context, tg.InputChannelClass) (tg.UpdatesClass, error)
	group   func(context.Context, *tg.MessagesDeleteChatUserRequest) (tg.UpdatesClass, error)
	history func(context.Context, *tg.MessagesDeleteHistoryRequest) (*tg.MessagesAffectedHistory, error)
}

func (r *removalRPC) ChannelsLeaveChannel(ctx context.Context, channel tg.InputChannelClass) (tg.UpdatesClass, error) {
	r.calls = append(r.calls, "leave")
	if r.leave == nil {
		r.t.Fatal("unexpected channel leave")
	}
	return r.leave(ctx, channel)
}

func (r *removalRPC) MessagesDeleteChatUser(ctx context.Context, req *tg.MessagesDeleteChatUserRequest) (tg.UpdatesClass, error) {
	r.calls = append(r.calls, "group")
	if r.group == nil {
		r.t.Fatal("unexpected group leave")
	}
	return r.group(ctx, req)
}

func (r *removalRPC) MessagesDeleteHistory(ctx context.Context, req *tg.MessagesDeleteHistoryRequest) (*tg.MessagesAffectedHistory, error) {
	r.calls = append(r.calls, "history")
	if r.history == nil {
		r.t.Fatal("unexpected history deletion")
	}
	return r.history(ctx, req)
}

func removalIndex(dialog Dialog) func(context.Context, bool) ([]Dialog, error) {
	return func(_ context.Context, archived bool) ([]Dialog, error) {
		if archived != dialog.Archived {
			return nil, nil
		}
		return []Dialog{dialog}, nil
	}
}

func removalMapped(peer tg.PeerClass, chat tg.ChatClass, user tg.UserClass) Dialog {
	var chats []tg.ChatClass
	var users []tg.UserClass
	if chat != nil {
		chats = append(chats, chat)
	}
	if user != nil {
		users = append(users, user)
	}
	return mapDialogPage([]tg.DialogClass{&tg.Dialog{Peer: peer}}, chats, users)[0]
}

func TestRemoveDialogFindsArchivedTargetBeyondUIlimitWithCurrentAccountHash(t *testing.T) {
	pages, complete := 0, false
	var folders []int
	source := dialogsFunc(func(_ context.Context, req *tg.MessagesGetDialogsRequest) (tg.MessagesDialogsClass, error) {
		folder, present := req.GetFolderID()
		if !present {
			t.Fatal("folder must be explicit")
		}
		folders = append(folders, folder)
		if folder == 0 {
			return &tg.MessagesDialogs{}, nil
		}
		pages++
		if pages > 13 {
			t.Fatal("index did not finish")
		}
		page := dialogPage((pages-1)*100+1, min(pages*100, 1201))
		page.Count = 1201
		for _, message := range page.Messages {
			message.(*tg.Message).Date += 10000
		}
		if pages == 13 {
			complete = true
			return &tg.MessagesDialogs{Dialogs: page.Dialogs, Chats: page.Chats, Messages: page.Messages}, nil
		}
		return page, nil
	})
	index := func(ctx context.Context, archived bool) ([]Dialog, error) {
		folder := 0
		if archived {
			folder = 1
		}
		return fetchDialogPages(ctx, source, -1, folder, nil)
	}
	rpc := &removalRPC{t: t, leave: func(ctx context.Context, raw tg.InputChannelClass) (tg.UpdatesClass, error) {
		peer, ok := raw.(*tg.InputChannel)
		if !complete || !ok || peer.ChannelID != 1201 || peer.AccessHash != 11201 {
			t.Fatalf("wrong/incomplete current-account resolution: %+v", raw)
		}
		if _, bounded := ctx.Deadline(); !bounded {
			t.Fatal("mutation has no deadline")
		}
		return &tg.Updates{}, nil
	}}
	if err := removeDialog(context.Background(), rpc, index, "-1000000001201"); err != nil {
		t.Fatal(err)
	}
	if pages != 13 || len(folders) != 14 || folders[0] != 0 || !reflect.DeepEqual(rpc.calls, []string{"leave"}) {
		t.Fatalf("incomplete or wrong removal: folders=%v calls=%v", folders, rpc.calls)
	}
}

func TestRemoveDialogDeletesDMForSelectedAccountAndContinuesHistory(t *testing.T) {
	for _, deleted := range []bool{false, true} {
		t.Run(fmt.Sprint("deleted=", deleted), func(t *testing.T) {
			hash := int64(123456789)
			if deleted {
				hash = 0
			}
			dialog := removalMapped(&tg.PeerUser{UserID: 42}, nil, &tg.User{ID: 42, AccessHash: hash, Deleted: deleted})
			calls := 0
			rpc := &removalRPC{t: t, history: func(ctx context.Context, req *tg.MessagesDeleteHistoryRequest) (*tg.MessagesAffectedHistory, error) {
				peer, ok := req.Peer.(*tg.InputPeerUser)
				if !ok || peer.UserID != 42 || peer.AccessHash != hash || req.Revoke || req.JustClear || req.MaxID != 0 || req.MinDate != 0 || req.MaxDate != 0 {
					t.Fatalf("unsafe DM deletion: %+v peer=%+v", req, req.Peer)
				}
				if _, bounded := ctx.Deadline(); !bounded {
					t.Fatal("history continuation has no deadline")
				}
				calls++
				return &tg.MessagesAffectedHistory{Offset: 3 - calls}, nil
			}}
			if err := removeDialog(context.Background(), rpc, removalIndex(dialog), "42"); err != nil || calls != 3 {
				t.Fatalf("incomplete deletion: calls=%d err=%v", calls, err)
			}
		})
	}
}

func TestRemoveDialogSupergroupUsesChannelLeave(t *testing.T) {
	for _, chat := range []tg.ChatClass{
		&tg.Channel{ID: 42, AccessHash: 99, Megagroup: true},
		&tg.ChannelForbidden{ID: 42, AccessHash: 99, Megagroup: true},
	} {
		dialog := removalMapped(&tg.PeerChannel{ChannelID: 42}, chat, nil)
		rpc := &removalRPC{t: t, leave: func(_ context.Context, raw tg.InputChannelClass) (tg.UpdatesClass, error) {
			peer, ok := raw.(*tg.InputChannel)
			if !ok || peer.ChannelID != 42 || peer.AccessHash != 99 {
				t.Fatalf("wrong supergroup peer: %+v", raw)
			}
			return &tg.Updates{}, nil
		}}
		if err := removeDialog(context.Background(), rpc, removalIndex(dialog), dialog.ID); err != nil {
			t.Fatalf("supergroup leave failed: %v", err)
		}
		if !reflect.DeepEqual(rpc.calls, []string{"leave"}) {
			t.Fatalf("wrong supergroup removal: %v", rpc.calls)
		}
	}
}

func TestRemoveDialogKeepsActivePeerWhenArchiveContainsDuplicate(t *testing.T) {
	active := removalMapped(&tg.PeerChannel{ChannelID: 42}, &tg.Channel{ID: 42, AccessHash: 99}, nil)
	archived := removalMapped(&tg.PeerChannel{ChannelID: 42}, &tg.Channel{ID: 42, AccessHash: 88}, nil)
	index := func(_ context.Context, archive bool) ([]Dialog, error) {
		if archive {
			return []Dialog{archived}, nil
		}
		return []Dialog{active}, nil
	}
	rpc := &removalRPC{t: t, leave: func(_ context.Context, raw tg.InputChannelClass) (tg.UpdatesClass, error) {
		peer, ok := raw.(*tg.InputChannel)
		if !ok || peer.ChannelID != 42 || peer.AccessHash != 99 {
			t.Fatalf("archive duplicate replaced active account peer: %+v", raw)
		}
		return &tg.Updates{}, nil
	}}
	if err := removeDialog(context.Background(), rpc, index, active.ID); err != nil {
		t.Fatal(err)
	}
}

func TestRemoveDialogBasicGroupLeavesSelfThenDeletesOnlyOwnHistory(t *testing.T) {
	dialog := removalMapped(&tg.PeerChat{ChatID: 42}, &tg.Chat{ID: 42}, nil)
	rpc := &removalRPC{t: t, group: func(_ context.Context, req *tg.MessagesDeleteChatUserRequest) (tg.UpdatesClass, error) {
		if _, self := req.UserID.(*tg.InputUserSelf); !self || req.ChatID != 42 || req.RevokeHistory {
			t.Fatalf("unsafe group removal: %+v", req)
		}
		return &tg.Updates{}, nil
	}, history: func(_ context.Context, req *tg.MessagesDeleteHistoryRequest) (*tg.MessagesAffectedHistory, error) {
		peer, ok := req.Peer.(*tg.InputPeerChat)
		if !ok || peer.ChatID != 42 || req.Revoke || req.JustClear || req.MaxID != 0 {
			t.Fatalf("unsafe group history deletion: %+v", req)
		}
		return &tg.MessagesAffectedHistory{}, nil
	}}
	if err := removeDialog(context.Background(), rpc, removalIndex(dialog), "-42"); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(rpc.calls, []string{"group", "history"}) {
		t.Fatalf("wrong removal ordering: %v", rpc.calls)
	}
}

func TestRemoveDialogAlreadyLeftBasicGroupStillRequiresSuccessfulHistoryRemoval(t *testing.T) {
	for _, chat := range []tg.ChatClass{&tg.Chat{ID: 42, Left: true}, &tg.ChatForbidden{ID: 42}, &tg.Chat{ID: 42, Deactivated: true}} {
		t.Run(fmt.Sprintf("%T:%v", chat, chat), func(t *testing.T) {
			dialog := removalMapped(&tg.PeerChat{ChatID: 42}, chat, nil)
			failure := errors.New("history refused")
			rpc := &removalRPC{t: t, history: func(_ context.Context, req *tg.MessagesDeleteHistoryRequest) (*tg.MessagesAffectedHistory, error) {
				if peer, ok := req.Peer.(*tg.InputPeerChat); !ok || peer.ChatID != 42 || req.Revoke || req.JustClear {
					t.Fatalf("unsafe history cleanup: %+v", req)
				}
				return nil, failure
			}}
			if err := removeDialog(context.Background(), rpc, removalIndex(dialog), "-42"); !errors.Is(err, failure) {
				t.Fatalf("already-left evidence produced false success: %v", err)
			}
		})
	}
}

func TestRemoveDialogRejectsUnsafeUnknownAndAbsentTargets(t *testing.T) {
	valid := removalMapped(&tg.PeerUser{UserID: 42}, nil, &tg.User{ID: 42, AccessHash: 99})
	self := removalMapped(&tg.PeerUser{UserID: 42}, nil, &tg.User{ID: 42, Self: true})
	unknown := removalMapped(&tg.PeerChat{ChatID: 42}, nil, nil)
	minimal := removalMapped(&tg.PeerChannel{ChannelID: 42}, &tg.Channel{ID: 42, AccessHash: 99, Min: true}, nil)
	mismatch := valid
	mismatch.peer = &tg.InputPeerUser{UserID: 43, AccessHash: 99}
	for _, tc := range []struct {
		name, id string
		dialog   Dialog
	}{
		{"username", "@person", valid}, {"zero", "0", valid}, {"leading-zero", "042", valid},
		{"whitespace", " 42", valid}, {"not-in-account", "43", valid}, {"saved-messages", "42", self},
		{"unknown-basic-group", "-42", unknown}, {"minimal-channel", "-1000000000042", minimal},
		{"mismatched-peer", "42", mismatch},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rpc := &removalRPC{t: t}
			if err := removeDialog(context.Background(), rpc, removalIndex(tc.dialog), tc.id); err == nil {
				t.Fatal("unsafe target reported success")
			}
			if len(rpc.calls) != 0 {
				t.Fatalf("unsafe target mutated remote state: %v", rpc.calls)
			}
		})
	}
}

func TestRemoveDialogRemoteFailuresNeverTriggerFallbackOrFalseSuccess(t *testing.T) {
	for _, forbidden := range []bool{false, true} {
		var chat tg.ChatClass = &tg.Channel{ID: 42, AccessHash: 99, Restricted: true}
		if forbidden {
			chat = &tg.ChannelForbidden{ID: 42, AccessHash: 99}
		}
		dialog := removalMapped(&tg.PeerChannel{ChannelID: 42}, chat, nil)
		failure := errors.New("CHANNEL_PRIVATE")
		rpc := &removalRPC{t: t, leave: func(context.Context, tg.InputChannelClass) (tg.UpdatesClass, error) { return nil, failure }}
		if err := removeDialog(context.Background(), rpc, removalIndex(dialog), dialog.ID); !errors.Is(err, failure) {
			t.Fatalf("remote channel refusal lost: %v", err)
		}
	}
	dialog := removalMapped(&tg.PeerChat{ChatID: 42}, &tg.Chat{ID: 42}, nil)
	failure := errors.New("USER_NOT_PARTICIPANT")
	rpc := &removalRPC{t: t, group: func(context.Context, *tg.MessagesDeleteChatUserRequest) (tg.UpdatesClass, error) { return nil, failure }}
	if err := removeDialog(context.Background(), rpc, removalIndex(dialog), dialog.ID); !errors.Is(err, failure) {
		t.Fatalf("remote group refusal lost: %v", err)
	}
	rpc.group = func(context.Context, *tg.MessagesDeleteChatUserRequest) (tg.UpdatesClass, error) {
		return &tg.Updates{}, nil
	}
	rpc.history = func(context.Context, *tg.MessagesDeleteHistoryRequest) (*tg.MessagesAffectedHistory, error) {
		return nil, failure
	}
	if err := removeDialog(context.Background(), rpc, removalIndex(dialog), dialog.ID); !errors.Is(err, failure) || !strings.Contains(err.Error(), "left") {
		t.Fatalf("partial leave not explained: %v", err)
	}
}

func TestRemoveDialogIndexFailureAndCancellationStopMutation(t *testing.T) {
	dialog := removalMapped(&tg.PeerUser{UserID: 42}, nil, &tg.User{ID: 42, AccessHash: 99})
	failure := errors.New("archive incomplete")
	index := func(_ context.Context, archived bool) ([]Dialog, error) {
		if archived {
			return nil, failure
		}
		return []Dialog{dialog}, nil
	}
	rpc := &removalRPC{t: t}
	if err := removeDialog(context.Background(), rpc, index, "42"); !errors.Is(err, failure) {
		t.Fatalf("partial index used: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := removeDialog(ctx, rpc, removalIndex(dialog), "42"); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancellation ignored: %v", err)
	}
	ctx, cancel = context.WithCancel(context.Background())
	defer cancel()
	rpc.history = func(context.Context, *tg.MessagesDeleteHistoryRequest) (*tg.MessagesAffectedHistory, error) {
		cancel()
		return &tg.MessagesAffectedHistory{Offset: 1}, nil
	}
	if err := removeDialog(ctx, rpc, removalIndex(dialog), "42"); !errors.Is(err, context.Canceled) || len(rpc.calls) != 1 {
		t.Fatalf("cancelled continuation: calls=%v err=%v", rpc.calls, err)
	}
}

func TestRemoveDialogRejectsMissingOrInvalidRPCResult(t *testing.T) {
	dialog := removalMapped(&tg.PeerUser{UserID: 42}, nil, &tg.User{ID: 42, AccessHash: 99})
	for _, result := range []*tg.MessagesAffectedHistory{nil, {Offset: -1}} {
		rpc := &removalRPC{t: t, history: func(context.Context, *tg.MessagesDeleteHistoryRequest) (*tg.MessagesAffectedHistory, error) {
			return result, nil
		}}
		if err := removeDialog(context.Background(), rpc, removalIndex(dialog), "42"); err == nil {
			t.Fatalf("invalid result returned success: %+v", result)
		}
	}
}
