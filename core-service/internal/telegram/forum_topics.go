package telegram

import (
	"context"
	"errors"

	"github.com/gotd/td/tg"
)

type ForumTopic struct {
	ID     int    `json:"id"`
	Name   string `json:"name"`
	Closed bool   `json:"closed,omitempty"`
}

// ForumTopics returns the named topics available in a forum chat.
func (a *Account) ForumTopics(ctx context.Context, groupID string) ([]ForumTopic, error) {
	dialog, err := a.ResolveDialog(ctx, groupID)
	if err != nil {
		return nil, err
	}
	if dialog.Type != "channel" {
		return nil, nil
	}
	if dialog.peer == nil {
		return nil, errors.New("forum topics are only available for supergroups")
	}
	var topics []ForumTopic
	request := &tg.MessagesGetForumTopicsRequest{Peer: dialog.peer, Limit: 100}
	for len(topics) < 500 {
		page, err := a.API().MessagesGetForumTopics(ctx, request)
		if err != nil {
			if tg.IsChannelForumMissing(err) {
				return nil, nil
			}
			return nil, err
		}
		before := len(topics)
		for _, raw := range page.Topics {
			if topic, ok := raw.(*tg.ForumTopic); ok {
				topics = append(topics, ForumTopic{ID: topic.ID, Name: topic.Title, Closed: topic.Closed})
			}
		}
		if len(topics) == before || len(topics) >= page.Count || len(topics) >= 500 {
			break
		}
		last, ok := page.Topics[len(page.Topics)-1].(*tg.ForumTopic)
		if !ok {
			break
		}
		request.OffsetDate = last.Date
		request.OffsetTopic = last.ID
		request.OffsetID = last.TopMessage
	}
	return topics, nil
}
