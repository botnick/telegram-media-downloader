package telegram

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strconv"

	"github.com/gotd/td/tg"
)

type HistoryRequest struct{ OffsetID, MinID, Limit int }
type HistoryPage struct {
	Messages   []tg.MessageClass
	Entities   *tg.Updates
	NextOffset int
	Done       bool
}

func (a *Account) HistoryPage(ctx context.Context, dialog Dialog, request HistoryRequest) (HistoryPage, error) {
	return fetchHistoryPage(ctx, a.API(), dialog, request)
}

func fetchHistoryPage(ctx context.Context, api historyAPI, dialog Dialog, request HistoryRequest) (HistoryPage, error) {
	var page HistoryPage
	if err := ctx.Err(); err != nil {
		return page, err
	}
	if dialog.peer == nil {
		return page, errors.New("history dialog has no account-specific peer")
	}
	if request.OffsetID < 0 || request.MinID < 0 {
		return page, errors.New("invalid history bounds")
	}
	limit := request.Limit
	if limit <= 0 || limit > 100 {
		limit = 100
	}
	result, err := api.MessagesGetHistory(ctx, &tg.MessagesGetHistoryRequest{Peer: dialog.peer, OffsetID: request.OffsetID, MinID: request.MinID, Limit: limit})
	if err != nil {
		return page, err
	}
	if err = ctx.Err(); err != nil {
		return page, err
	}
	raw, users, chats, err := historyMessages(result)
	if err != nil {
		return page, err
	}
	page.Entities = &tg.Updates{Users: users, Chats: chats}
	page.Messages = make([]tg.MessageClass, 0, len(raw))
	_, page.Done = result.(*tg.MessagesMessages)
	if len(raw) == 0 {
		page.Done = true
		return page, nil
	}
	seen := map[int]bool{}
	for _, message := range raw {
		if message == nil || message.GetID() <= 0 {
			return HistoryPage{}, errors.New("invalid Telegram history message")
		}
		var peer tg.PeerClass
		switch message := message.(type) {
		case *tg.Message:
			peer = message.PeerID
		case *tg.MessageService:
			peer = message.PeerID
		case *tg.MessageEmpty:
			peer = message.PeerID
		}
		if peer != nil && markedHistoryPeer(peer) != dialog.ID {
			return HistoryPage{}, errors.New("Telegram history returned another peer")
		}
		if peer == nil {
			if _, ok := message.(*tg.MessageEmpty); !ok {
				return HistoryPage{}, errors.New("Telegram history message has no peer")
			}
		}
		id := message.GetID()
		if page.NextOffset == 0 || id < page.NextOffset {
			page.NextOffset = id
		}
		if id <= request.MinID {
			page.Done = true
			continue
		}
		if (request.OffsetID > 0 && id >= request.OffsetID) || seen[id] {
			continue
		}
		seen[id] = true
		page.Messages = append(page.Messages, message)
	}
	if request.OffsetID > 0 && page.NextOffset >= request.OffsetID {
		return HistoryPage{}, fmt.Errorf("Telegram history cursor did not advance from %d", request.OffsetID)
	}
	if page.NextOffset <= request.MinID+1 {
		page.Done = true
	}
	sort.SliceStable(page.Messages, func(i, j int) bool { return page.Messages[i].GetID() > page.Messages[j].GetID() })
	return page, nil
}

func markedHistoryPeer(peer tg.PeerClass) string {
	switch peer := peer.(type) {
	case *tg.PeerChannel:
		return strconv.FormatInt(-1000000000000-peer.ChannelID, 10)
	case *tg.PeerChat:
		return strconv.FormatInt(-peer.ChatID, 10)
	case *tg.PeerUser:
		return strconv.FormatInt(peer.UserID, 10)
	}
	return ""
}
