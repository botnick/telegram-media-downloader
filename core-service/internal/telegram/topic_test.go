package telegram

import (
	"github.com/gotd/td/tg"
	"strings"
	"testing"
	"unicode/utf16"
)

func TestMessageTopicID(t *testing.T) {
	for _, tc := range []struct {
		name    string
		message *tg.Message
		want    int
	}{
		{"nil", nil, 0},
		{"ordinary message", &tg.Message{}, 0},
		{"ordinary reply", &tg.Message{ReplyTo: &tg.MessageReplyHeader{ReplyToMsgID: 7}}, 0},
		{"topic root reply", &tg.Message{ReplyTo: &tg.MessageReplyHeader{ForumTopic: true, ReplyToMsgID: 7}}, 7},
		{"nested topic reply", &tg.Message{ReplyTo: &tg.MessageReplyHeader{ForumTopic: true, ReplyToMsgID: 8, ReplyToTopID: 7}}, 7},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := MessageTopicID(tc.message); got != tc.want {
				t.Fatalf("got %d want %d", got, tc.want)
			}
		})
	}
}

func TestForwardTopicReply(t *testing.T) {
	if forwardTopicReply(0) != nil {
		t.Fatal("general destination should not add reply")
	}
	reply := forwardTopicReply(17).(*tg.InputReplyToMessage)
	if reply.ReplyToMsgID != 17 {
		t.Fatal(reply)
	}
}

func TestPlainForwardCaptionUTF16Boundary(t *testing.T) {
	for _, input := range []string{"short", strings.Repeat("a", 1024), strings.Repeat("a", 1025), strings.Repeat("😀", 600)} {
		got := PlainForwardCaption(input)
		if len(utf16.Encode([]rune(got))) > maxCaption {
			t.Fatal("caption exceeds Telegram limit")
		}
		if utf16Len(input) <= maxCaption && got != input {
			t.Fatal("short caption changed")
		}
	}
}
