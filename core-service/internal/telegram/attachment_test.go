package telegram

import (
	"github.com/gotd/td/tg"
	"testing"
)

func TestMessageAttachmentUsesLargestActualPhotoSize(t *testing.T) {
	m := &tg.Message{ID: 5, PeerID: &tg.PeerChannel{ChannelID: 123}, Media: &tg.MessageMediaPhoto{Photo: &tg.Photo{ID: 999, DCID: 2, Sizes: []tg.PhotoSizeClass{
		&tg.PhotoSize{Type: "x", Size: 100, W: 100, H: 100}, &tg.PhotoSizeProgressive{Type: "y", W: 1000, H: 1000, Sizes: []int{50, 200, 300}}, &tg.PhotoStrippedSize{Type: "i", Bytes: []byte{1}},
	}}}}
	a, err := MessageAttachment(m)
	if err != nil {
		t.Fatal(err)
	}
	if a.Identity.Size != 300 || a.Identity.ID != "999" || a.GroupID != "-1000000000123" || a.Location.(*tg.InputPhotoFileLocation).ThumbSize != "y" {
		t.Fatalf("attachment=%+v", a)
	}
}
func TestMessageAttachmentKeepsDocumentIdentityForVideoAndSticker(t *testing.T) {
	for _, tc := range []struct {
		attr tg.DocumentAttributeClass
		kind string
	}{{&tg.DocumentAttributeVideo{}, "video"}, {&tg.DocumentAttributeSticker{}, "sticker"}} {
		m := &tg.Message{ID: 7, PeerID: &tg.PeerChat{ChatID: 3}, Media: &tg.MessageMediaDocument{Document: &tg.Document{ID: 42, Size: 4, DCID: 2, Attributes: []tg.DocumentAttributeClass{&tg.DocumentAttributeFilename{FileName: "test.bin"}, tc.attr}}}}
		a, err := MessageAttachment(m)
		if err != nil {
			t.Fatal(err)
		}
		if a.Identity.Kind != "document" || a.Identity.ID != "42" || a.Name != "test.bin" || a.Type != tc.kind {
			t.Fatalf("attachment=%+v", a)
		}
	}
}
