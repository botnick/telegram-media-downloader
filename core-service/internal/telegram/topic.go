package telegram

import "github.com/gotd/td/tg"

func MessageTopicID(message *tg.Message) int {
	if message == nil {
		return 0
	}
	reply, ok := message.ReplyTo.(*tg.MessageReplyHeader)
	if !ok || !reply.ForumTopic {
		return 0
	}
	if reply.ReplyToTopID != 0 {
		return reply.ReplyToTopID
	}
	return reply.ReplyToMsgID
}
