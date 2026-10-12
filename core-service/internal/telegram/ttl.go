package telegram

import "github.com/gotd/td/tg"

// MessageTTL is the self-destruct timer on a message's photo or document in
// seconds (0 when the media does not expire). 2.x read media.ttlSeconds.
func MessageTTL(message *tg.Message) int {
	if message == nil {
		return 0
	}
	var ttl int
	switch media := message.Media.(type) {
	case *tg.MessageMediaPhoto:
		ttl, _ = media.GetTTLSeconds()
	case *tg.MessageMediaDocument:
		ttl, _ = media.GetTTLSeconds()
	}
	return max(ttl, 0)
}
