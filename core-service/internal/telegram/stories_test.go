package telegram

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/botnick/telegram-media-downloader/core-service/internal/store"
	"github.com/gotd/td/tg"
)

type storiesRPC struct {
	read func(context.Context, *tg.StoriesGetStoriesByIDRequest) (*tg.StoriesStories, error)
	page func(context.Context, *tg.StoriesGetAllStoriesRequest) (tg.StoriesAllStoriesClass, error)
}

func (s storiesRPC) StoriesGetStoriesByID(ctx context.Context, r *tg.StoriesGetStoriesByIDRequest) (*tg.StoriesStories, error) {
	return s.read(ctx, r)
}
func (s storiesRPC) StoriesGetAllStories(ctx context.Context, r *tg.StoriesGetAllStoriesRequest) (tg.StoriesAllStoriesClass, error) {
	return s.page(ctx, r)
}
func (s storiesRPC) StoriesGetPeerStories(context.Context, tg.InputPeerClass) (*tg.StoriesPeerStories, error) {
	return nil, errors.New("unexpected peer list")
}

func fullStory(id int) *tg.StoryItem {
	return &tg.StoryItem{ID: id, Date: 123, ExpireDate: 999, Caption: "story", Public: true, Media: &tg.MessageMediaDocument{Document: &tg.Document{ID: 9007199254740993, AccessHash: 77, FileReference: []byte("private ref"), DCID: 4, Size: 4, MimeType: "video/mp4", Attributes: []tg.DocumentAttributeClass{&tg.DocumentAttributeVideo{}}}}}
}

func TestStoryRPCUsesSelectedPeerAndExactMediaIdentity(t *testing.T) {
	for _, kind := range []string{"user", "channel"} {
		t.Run(kind, func(t *testing.T) {
			d := Dialog{ID: "42", peer: &tg.InputPeerUser{UserID: 42, AccessHash: 765}}
			if kind == "channel" {
				d.ID = "-1000000000042"
				d.peer = &tg.InputPeerChannel{ChannelID: 42, AccessHash: 765}
			}
			api := storiesRPC{read: func(_ context.Context, r *tg.StoriesGetStoriesByIDRequest) (*tg.StoriesStories, error) {
				if r.Peer != d.peer || len(r.ID) != 1 || r.ID[0] != 7 {
					t.Fatalf("request=%+v", r)
				}
				return &tg.StoriesStories{Stories: []tg.StoryItemClass{fullStory(7)}}, nil
			}}
			items, _, _, err := readStories(context.Background(), api, d, []int{7})
			if err != nil || len(items) != 1 {
				t.Fatalf("items=%v %v", items, err)
			}
			m, err := MessageAttachment(items[0].Message)
			if err != nil || m.Identity.ID != "9007199254740993" || m.GroupID != d.ID || m.MessageID != 7 || m.DC != 4 {
				t.Fatalf("media=%+v %v", m, err)
			}
			location := m.Location.(*tg.InputDocumentFileLocation)
			if location.AccessHash != 77 || string(location.FileReference) != "private ref" {
				t.Fatal(location)
			}
			views, err := storyViews([]tg.StoryItemClass{fullStory(7)}, "@peer")
			if err != nil {
				t.Fatal(err)
			}
			encoded, _ := json.Marshal(views)
			if strings.Contains(string(encoded), "private ref") || strings.Contains(string(encoded), "AccessHash") || views[0].Media["type"] != "video" {
				t.Fatalf("unsafe or wrong projection: %s", encoded)
			}
		})
	}
}

func TestStoryRPCRejectsIncompleteWrongOrProtectedItems(t *testing.T) {
	d := Dialog{ID: "42", peer: &tg.InputPeerUser{UserID: 42, AccessHash: 1}}
	for _, kind := range []string{"wrong", "duplicate", "minimal", "protected", "deleted", "skipped"} {
		t.Run(kind, func(t *testing.T) {
			s := fullStory(7)
			items := []tg.StoryItemClass{s}
			switch kind {
			case "wrong":
				s.ID = 8
			case "duplicate":
				items = append(items, s)
			case "minimal":
				s.Min = true
			case "protected":
				s.Noforwards = true
			case "deleted":
				items = []tg.StoryItemClass{&tg.StoryItemDeleted{ID: 7}}
			case "skipped":
				items = []tg.StoryItemClass{&tg.StoryItemSkipped{ID: 7}}
			}
			api := storiesRPC{read: func(context.Context, *tg.StoriesGetStoriesByIDRequest) (*tg.StoriesStories, error) {
				return &tg.StoriesStories{Stories: items}, nil
			}}
			out, _, _, err := readStories(context.Background(), api, d, []int{7})
			if kind == "deleted" || kind == "skipped" {
				if err != nil || len(out) != 0 {
					t.Fatalf("%v %v", out, err)
				}
			} else if err == nil {
				t.Fatal("accepted invalid story")
			}
		})
	}
}

func TestStoryPageSetsContinuationFlagsAndRejectsNotModified(t *testing.T) {
	for _, state := range []string{"", "cursor"} {
		api := storiesRPC{page: func(_ context.Context, r *tg.StoriesGetAllStoriesRequest) (tg.StoriesAllStoriesClass, error) {
			value, ok := r.GetState()
			if r.Next != (state != "") || ok != (state != "") || value != state {
				t.Fatalf("request=%+v", r)
			}
			return &tg.StoriesAllStories{Count: 2, HasMore: true, State: "next", PeerStories: []tg.PeerStories{{Peer: &tg.PeerUser{UserID: 42}, Stories: []tg.StoryItemClass{fullStory(7)}}}}, nil
		}}
		page, _, _, err := storyPage(context.Background(), api, state)
		if err != nil || len(page.Groups) != 1 || !page.More || page.State != "next" {
			t.Fatalf("page=%+v %v", page, err)
		}
	}
	api := storiesRPC{page: func(context.Context, *tg.StoriesGetAllStoriesRequest) (tg.StoriesAllStoriesClass, error) {
		return &tg.StoriesAllStoriesNotModified{}, nil
	}}
	if _, _, _, err := storyPage(context.Background(), api, ""); err == nil {
		t.Fatal("incomplete story page reported complete")
	}
}

func TestStoryPeerHashSurvivesReopenAndStaysAccountBound(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	db, err := store.Open(ctx, dir)
	if err != nil {
		t.Fatal(err)
	}
	s := &UpdateState{Reader: db.Reader, Writer: db.Writer, AccountID: "one"}
	users := []tg.UserClass{&tg.User{ID: 42, AccessHash: 765}, &tg.User{ID: 43, AccessHash: 123, Min: true}}
	if err = s.cacheStoryPeers(ctx, 7, nil, users); err != nil {
		t.Fatal(err)
	}
	db.Reader.Close()
	db.Writer.Close()
	db, err = store.Open(ctx, dir)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Reader.Close()
	defer db.Writer.Close()
	s = &UpdateState{Reader: db.Reader, Writer: db.Writer, AccountID: "one"}
	d, err := resolveDialog(ctx, nil, s, 7, "42")
	if err != nil || d.peer.(*tg.InputPeerUser).AccessHash != 765 {
		t.Fatalf("peer=%+v %v", d, err)
	}
	for _, v := range []struct {
		account  string
		self, id int64
	}{{"one", 7, 43}, {"two", 7, 42}, {"one", 8, 42}} {
		x := &UpdateState{Reader: db.Reader, Writer: db.Writer, AccountID: v.account}
		if _, found, err := x.userAccessHash(ctx, v.self, v.id); err != nil || found {
			t.Fatalf("leaked/minimal hash: %+v %v %v", v, found, err)
		}
	}
}
