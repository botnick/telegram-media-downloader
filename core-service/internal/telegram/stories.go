package telegram

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"

	"github.com/gotd/td/tg"
)

// Story keys occupy a disjoint, exactly representable SQLite/JSON range.
// MTProto message and story IDs on the wire remain positive signed int32.
const StoryKeyBase int64 = 1 << 32

func StoryKey(id int) (int64, error) {
	if id <= 0 || int64(id) > 2147483647 {
		return 0, errors.New("invalid story id")
	}
	return StoryKeyBase + int64(id), nil
}

type StoryView struct {
	ID           int            `json:"id"`
	PeerUsername *string        `json:"peerUsername"`
	Date         int            `json:"date"`
	ExpireDate   int            `json:"expireDate"`
	Pinned       bool           `json:"pinned"`
	Public       bool           `json:"public"`
	Caption      string         `json:"caption"`
	Media        map[string]any `json:"media"`
}
type StoryPeer struct {
	ID        string  `json:"id"`
	Username  *string `json:"username"`
	FirstName *string `json:"firstName"`
}
type PeerStoryList struct {
	Peer    StoryPeer   `json:"peer"`
	Stories []StoryView `json:"stories"`
}
type StoryGroup struct {
	Key     string      `json:"-"`
	PeerID  string      `json:"peerId"`
	Stories []StoryView `json:"stories"`
}
type StoryPage struct {
	Groups []StoryGroup
	Count  int
	State  string
	More   bool
}
type storyAPI interface {
	StoriesGetPeerStories(context.Context, tg.InputPeerClass) (*tg.StoriesPeerStories, error)
	StoriesGetAllStories(context.Context, *tg.StoriesGetAllStoriesRequest) (tg.StoriesAllStoriesClass, error)
	StoriesGetStoriesByID(context.Context, *tg.StoriesGetStoriesByIDRequest) (*tg.StoriesStories, error)
}

func optionalText(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func storyPeerID(p tg.PeerClass) (string, string, error) {
	switch p := p.(type) {
	case *tg.PeerUser:
		if p.UserID > 0 {
			return strconv.FormatInt(p.UserID, 10), strconv.FormatInt(p.UserID, 10), nil
		}
	case *tg.PeerChannel:
		if p.ChannelID > 0 {
			return strconv.FormatInt(-1000000000000-p.ChannelID, 10), strconv.FormatInt(p.ChannelID, 10), nil
		}
	}
	return "", "", errors.New("invalid story peer")
}

func storyViews(items []tg.StoryItemClass, username string) ([]StoryView, error) {
	out := []StoryView{}
	seen := map[int]bool{}
	for _, raw := range items {
		if len(out) >= 10000 {
			return nil, errors.New("story list exceeds limit")
		}
		s, ok := raw.(*tg.StoryItem)
		if !ok {
			continue
		} // Deleted/skipped items have no downloadable media.
		if _, err := StoryKey(s.ID); err != nil {
			return nil, err
		}
		if seen[s.ID] {
			return nil, errors.New("duplicate story id")
		}
		seen[s.ID] = true
		v := StoryView{ID: s.ID, PeerUsername: optionalText(strings.TrimPrefix(username, "@")), Date: s.Date, ExpireDate: s.ExpireDate, Pinned: s.Pinned, Public: s.Public, Caption: s.Caption}
		switch m := s.Media.(type) {
		case *tg.MessageMediaPhoto:
			if _, ok := m.Photo.(*tg.Photo); ok {
				v.Media = map[string]any{"type": "photo", "sizeBytes": 0}
			}
		case *tg.MessageMediaDocument:
			if d, ok := m.Document.(*tg.Document); ok {
				kind := "document"
				for _, k := range []string{"video", "audio", "image"} {
					if strings.HasPrefix(d.MimeType, k+"/") {
						kind = k
						break
					}
				}
				if kind == "image" {
					kind = "photo"
				}
				v.Media = map[string]any{"type": kind, "sizeBytes": d.Size, "mime": d.MimeType}
			}
		}
		out = append(out, v)
	}
	return out, nil
}

func (a *Account) ListPeerStories(ctx context.Context, dialog Dialog, username string) (PeerStoryList, error) {
	r, err := a.API().StoriesGetPeerStories(ctx, dialog.peer)
	if err != nil {
		return PeerStoryList{}, err
	}
	if r == nil {
		return PeerStoryList{}, errors.New("Telegram returned no story list")
	}
	marked, raw, err := storyPeerID(r.Stories.Peer)
	if err != nil {
		return PeerStoryList{}, err
	}
	if marked != dialog.ID {
		return PeerStoryList{}, errors.New("story list returned another peer")
	}
	if err = a.state.cacheStoryPeers(ctx, a.selfID, r.Chats, r.Users); err != nil {
		return PeerStoryList{}, err
	}
	views, err := storyViews(r.Stories.Stories, username)
	peer := StoryPeer{ID: raw, Username: optionalText(dialog.Username)}
	for _, u := range r.Users {
		if u, ok := u.(*tg.User); ok && strconv.FormatInt(u.ID, 10) == marked {
			peer.Username = optionalText(u.Username)
			peer.FirstName = optionalText(u.FirstName)
		}
	}
	return PeerStoryList{Peer: peer, Stories: views}, err
}

func storyPage(ctx context.Context, api storyAPI, state string) (StoryPage, []tg.ChatClass, []tg.UserClass, error) {
	req := &tg.StoriesGetAllStoriesRequest{}
	if state != "" {
		req.Next = true
		req.SetState(state)
	}
	raw, err := api.StoriesGetAllStories(ctx, req)
	if err != nil {
		return StoryPage{}, nil, nil, err
	}
	r, ok := raw.(*tg.StoriesAllStories)
	if !ok || r == nil {
		return StoryPage{}, nil, nil, fmt.Errorf("unexpected story page %T", raw)
	}
	page := StoryPage{Groups: []StoryGroup{}, Count: r.Count, State: r.State, More: r.HasMore}
	for _, p := range r.PeerStories {
		key, id, e := storyPeerID(p.Peer)
		if e != nil {
			return StoryPage{}, nil, nil, e
		}
		views, e := storyViews(p.Stories, "")
		if e != nil {
			return StoryPage{}, nil, nil, e
		}
		page.Groups = append(page.Groups, StoryGroup{Key: key, PeerID: id, Stories: views})
	}
	return page, r.Chats, r.Users, nil
}

func (a *Account) StoryPage(ctx context.Context, state string) (StoryPage, error) {
	p, chats, users, err := storyPage(ctx, a.API(), state)
	if err == nil {
		err = a.state.cacheStoryPeers(ctx, a.selfID, chats, users)
	}
	return p, err
}

func readStories(ctx context.Context, api storyAPI, dialog Dialog, ids []int) ([]*RefreshedMessage, []tg.ChatClass, []tg.UserClass, error) {
	if dialog.peer == nil {
		return nil, nil, nil, errors.New("story peer has no reusable access hash")
	}
	if len(ids) == 0 || len(ids) > 100 {
		return nil, nil, nil, errors.New("request 1-100 story ids")
	}
	wanted := map[int]bool{}
	for _, id := range ids {
		if _, err := StoryKey(id); err != nil {
			return nil, nil, nil, err
		}
		wanted[id] = true
	}
	r, err := api.StoriesGetStoriesByID(ctx, &tg.StoriesGetStoriesByIDRequest{Peer: dialog.peer, ID: ids})
	if err != nil {
		return nil, nil, nil, err
	}
	if r == nil {
		return nil, nil, nil, errors.New("Telegram returned no stories")
	}
	var peer tg.PeerClass
	switch p := dialog.peer.(type) {
	case *tg.InputPeerUser:
		peer = &tg.PeerUser{UserID: p.UserID}
	case *tg.InputPeerChannel:
		peer = &tg.PeerChannel{ChannelID: p.ChannelID}
	case *tg.InputPeerSelf:
		id, e := strconv.ParseInt(dialog.ID, 10, 64)
		if e != nil || id <= 0 {
			return nil, nil, nil, errors.New("invalid self story peer")
		}
		peer = &tg.PeerUser{UserID: id}
	default:
		return nil, nil, nil, errors.New("this peer cannot have stories")
	}
	marked, _, e := storyPeerID(peer)
	if e != nil || marked != dialog.ID {
		return nil, nil, nil, errors.New("story peer does not match dialog")
	}
	if current := mapDialogPage([]tg.DialogClass{&tg.Dialog{Peer: peer}}, r.Chats, r.Users); len(current) == 1 {
		if current[0].Name != "" && current[0].Name != dialog.ID {
			dialog.Name = current[0].Name
		}
		if current[0].Username != "" {
			dialog.Username = current[0].Username
		}
	}
	out := []*RefreshedMessage{}
	seen := map[int]bool{}
	for _, raw := range r.Stories {
		id := raw.GetID()
		if !wanted[id] || seen[id] {
			return nil, nil, nil, errors.New("unexpected or duplicate story id")
		}
		seen[id] = true
		s, ok := raw.(*tg.StoryItem)
		if !ok {
			continue
		}
		if s.Min {
			return nil, nil, nil, errors.New("Telegram returned incomplete story metadata")
		}
		if s.Noforwards {
			return nil, nil, nil, errors.New("this story does not allow saving")
		}
		m := &tg.Message{ID: s.ID, PeerID: peer, Date: s.Date, Message: s.Caption, Media: s.Media, Entities: s.Entities}
		if _, err := MessageAttachment(m); errors.Is(err, ErrNoMedia) {
			continue
		} else if err != nil {
			return nil, nil, nil, err
		}
		out = append(out, &RefreshedMessage{Message: m, Entities: &tg.Updates{Users: r.Users, Chats: r.Chats}, Dialog: &dialog})
	}
	return out, r.Chats, r.Users, nil
}

func (a *Account) ReadStories(ctx context.Context, dialog Dialog, ids []int) ([]*RefreshedMessage, error) {
	out, chats, users, err := readStories(ctx, a.API(), dialog, ids)
	if err == nil {
		err = a.state.cacheStoryPeers(ctx, a.selfID, chats, users)
	}
	return out, err
}

func (a *Account) RefreshStory(ctx context.Context, m *tg.Message) (*RefreshedMessage, error) {
	id, _, err := storyPeerID(m.PeerID)
	if err != nil {
		return nil, err
	}
	d, err := a.ResolveDialog(ctx, id)
	if err != nil {
		return nil, err
	}
	items, err := a.ReadStories(ctx, d, []int{m.ID})
	if err != nil {
		return nil, err
	}
	if len(items) != 1 {
		return nil, errors.New("queued Telegram story is no longer available")
	}
	return items[0], nil
}
