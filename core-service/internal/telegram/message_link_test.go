package telegram

import "testing"

func TestMessageLinksPreserveExactPeerAndMessage(t *testing.T) {
	for _, tc := range []struct {
		url, peer      string
		message, topic int
	}{
		{"https://t.me/channel/42", "@channel", 42, 0},
		{"https://telegram.me/channel/7/42", "@channel", 42, 7},
		{"http://telegram.dog/c/42/7/2147483647?single#ignored", "-1000000000042", 2147483647, 7},
		{"https://t.me/c/1000000003/42", "-1001000000003", 42, 0},
		{"tg://privatepost?channel=1000000003&post=42&thread=7", "-1001000000003", 42, 7},
		{"tg:resolve?domain=channel&post=42", "@channel", 42, 0},
		{"tg://resolve?domain=channel&post=42&thread=7", "@channel", 42, 7},
		{"t.me/s/channel/42?thread=7", "@channel", 42, 7},
		{"https://t.me/channel/7/42?thread=7&t=12", "@channel", 42, 7},
	} {
		t.Run(tc.url, func(t *testing.T) {
			link, err := ParseMessageLink(tc.url)
			if err != nil || link.ChatRef != tc.peer || link.MessageID != tc.message || link.TopicID != tc.topic {
				t.Fatalf("link=%+v err=%v", link, err)
			}
		})
	}
}

func TestMessageLinksRejectAmbiguousOrInvalidTargets(t *testing.T) {
	for _, input := range []string{
		"", "not a link", "https://evil.test/channel/42", "https://t.me.evil.test/channel/42", "ftp://t.me/channel/42", "https://user@t.me/channel/42", "https://t.me:444/channel/42",
		"https://t.me/channel", "https://t.me/c/42", "https://t.me/channel/0", "https://t.me/channel/-1", "https://t.me/channel/42oops", "https://t.me/channel/2147483648", "https://t.me/channel/42/2/3",
		"https://t.me/c/0/42", "https://t.me/c/1000000000000/42", "https://t.me/c/-1000000000042/42", "https://t.me/c/12.5/42", "https://t.me/channel/7/42?thread=8",
		"tg://resolve?domain=channel&post=1&post=2", "tg://resolve?domain=channel&post=42&thread=", "tg://privatepost?post=42", "tg://resolve?domain=channel", "tg://join?invite=abc", "https://t.me/channel/42?comment=7",
		"https://t.me/channel/%2b42", "https://t.me/channel/42?thread=NaN", "https://t.me/ch%2fannel/42", "tg://resolve/extra?domain=channel&post=42",
	} {
		t.Run(input, func(t *testing.T) {
			if link, err := ParseMessageLink(input); err == nil {
				t.Fatalf("accepted %+v", link)
			}
		})
	}
}
