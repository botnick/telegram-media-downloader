package telegram

import (
	"context"
	"crypto/rand"
	"encoding/binary"
	"errors"

	"github.com/gotd/td/tg"
)

type ChatOperator interface {
	ForumTopics(context.Context, string) ([]ForumTopic, error)
	SendText(context.Context, string, int, string) (int, error)
	EditText(context.Context, string, int, string) error
	CreateForumTopic(context.Context, string, string) (ForumTopic, error)
	UpdateForumTopic(context.Context, string, int, *string, *bool, *int64, *bool) error
}

func (a *Account) SendText(ctx context.Context, groupID string, topicID int, text string) (int, error) {
	dialog, err := a.ResolveDialog(ctx, groupID)
	if err != nil {
		return 0, err
	}
	if dialog.peer == nil {
		return 0, errors.New("chat has no reusable Telegram peer")
	}
	var randomBytes [8]byte
	if _, err := rand.Read(randomBytes[:]); err != nil {
		return 0, err
	}
	randomID := int64(binary.LittleEndian.Uint64(randomBytes[:]))
	request := &tg.MessagesSendMessageRequest{Peer: dialog.peer, Message: text, RandomID: randomID}
	if topicID > 0 {
		reply := &tg.InputReplyToMessage{ReplyToMsgID: topicID}
		reply.SetTopMsgID(topicID)
		request.SetReplyTo(reply)
	}
	result, err := a.API().MessagesSendMessage(ctx, request)
	if err != nil {
		return 0, err
	}
	switch updates := result.(type) {
	case *tg.UpdateShortSentMessage:
		return updates.ID, nil
	case *tg.Updates:
		for _, raw := range updates.Updates {
			switch update := raw.(type) {
			case *tg.UpdateNewMessage:
				if message, ok := update.Message.(*tg.Message); ok && message.Out {
					return message.ID, nil
				}
			case *tg.UpdateNewChannelMessage:
				if message, ok := update.Message.(*tg.Message); ok && message.Out {
					return message.ID, nil
				}
			}
		}
	}
	return 0, errors.New("Telegram accepted the message but returned no message ID")
}

func (a *Account) EditText(ctx context.Context, groupID string, messageID int, text string) error {
	dialog, err := a.ResolveDialog(ctx, groupID)
	if err != nil {
		return err
	}
	if dialog.peer == nil {
		return errors.New("chat has no reusable Telegram peer")
	}
	_, err = a.API().MessagesEditMessage(ctx, &tg.MessagesEditMessageRequest{Peer: dialog.peer, ID: messageID, Message: text})
	return err
}

func (a *Account) CreateForumTopic(ctx context.Context, groupID, title string) (ForumTopic, error) {
	dialog, err := a.ResolveDialog(ctx, groupID)
	if err != nil {
		return ForumTopic{}, err
	}
	if dialog.peer == nil {
		return ForumTopic{}, errors.New("chat has no reusable Telegram peer")
	}
	var randomBytes [8]byte
	if _, err := rand.Read(randomBytes[:]); err != nil {
		return ForumTopic{}, err
	}
	request := &tg.MessagesCreateForumTopicRequest{Peer: dialog.peer, Title: title, RandomID: int64(binary.LittleEndian.Uint64(randomBytes[:]))}
	result, err := a.API().MessagesCreateForumTopic(ctx, request)
	if err != nil {
		return ForumTopic{}, err
	}
	var createdID int
	switch updates := result.(type) {
	case *tg.Updates:
		for _, raw := range updates.Updates {
			if update, ok := raw.(*tg.UpdateNewChannelMessage); ok {
				if message, ok := update.Message.(*tg.MessageService); ok {
					if _, ok := message.Action.(*tg.MessageActionTopicCreate); ok {
						createdID = message.ID
					}
				}
			}
		}
	case *tg.UpdatesCombined:
		for _, raw := range updates.Updates {
			if update, ok := raw.(*tg.UpdateNewChannelMessage); ok {
				if message, ok := update.Message.(*tg.MessageService); ok {
					if _, ok := message.Action.(*tg.MessageActionTopicCreate); ok {
						createdID = message.ID
					}
				}
			}
		}
	}
	if createdID <= 0 {
		return ForumTopic{}, errors.New("Telegram created the topic but returned no topic ID")
	}
	return ForumTopic{ID: createdID, Name: title}, nil
}

func (a *Account) UpdateForumTopic(ctx context.Context, groupID string, topicID int, title *string, closed *bool, iconEmojiID *int64, hidden *bool) error {
	dialog, err := a.ResolveDialog(ctx, groupID)
	if err != nil {
		return err
	}
	if dialog.peer == nil {
		return errors.New("chat has no reusable Telegram peer")
	}
	request := &tg.MessagesEditForumTopicRequest{Peer: dialog.peer, TopicID: topicID}
	if title != nil {
		request.SetTitle(*title)
	}
	if closed != nil {
		request.SetClosed(*closed)
	}
	if iconEmojiID != nil {
		request.SetIconEmojiID(*iconEmojiID)
	}
	if hidden != nil {
		request.SetHidden(*hidden)
	}
	_, err = a.API().MessagesEditForumTopic(ctx, request)
	return err
}

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
	if dialog.Type != "channel" && dialog.Type != "supergroup" {
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
