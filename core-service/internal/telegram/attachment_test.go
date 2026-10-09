package telegram

import (
	"testing"

	"github.com/gotd/td/tg"
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

func TestDocumentClassificationPreservesWireIdentityAndFilterSwitch(t *testing.T) {
	for _, tc := range []struct {
		name, mime, kind, key string
		attrs                 []tg.DocumentAttributeClass
	}{
		{name: "file", mime: "application/pdf", kind: "document", key: "files"},
		{name: "image document", mime: "Image/PNG; x=1", kind: "photo", key: "photos"},
		{name: "webp without sticker attribute", mime: "image/webp", kind: "photo", key: "photos"},
		{name: "gif", mime: "image/gif", kind: "gif", key: "gifs"},
		{name: "animation", mime: "video/mp4", kind: "gif", key: "gifs", attrs: []tg.DocumentAttributeClass{&tg.DocumentAttributeVideo{}, &tg.DocumentAttributeAnimated{}}},
		{name: "video", mime: "application/octet-stream", kind: "video", key: "videos", attrs: []tg.DocumentAttributeClass{&tg.DocumentAttributeVideo{}}},
		{name: "round video", mime: "video/mp4", kind: "video", key: "videos", attrs: []tg.DocumentAttributeClass{&tg.DocumentAttributeVideo{RoundMessage: true}}},
		{name: "voice", mime: "audio/ogg", kind: "audio", key: "voice", attrs: []tg.DocumentAttributeClass{&tg.DocumentAttributeAudio{Voice: true}}},
		{name: "music", mime: "audio/mpeg", kind: "audio", key: "audio", attrs: []tg.DocumentAttributeClass{&tg.DocumentAttributeAudio{}}},
		{name: "sticker", mime: "video/webm", kind: "sticker", key: "stickers", attrs: []tg.DocumentAttributeClass{&tg.DocumentAttributeSticker{}, &tg.DocumentAttributeVideo{}}},
		{name: "animated sticker", mime: "application/x-tgsticker", kind: "sticker", key: "stickers", attrs: []tg.DocumentAttributeClass{&tg.DocumentAttributeAnimated{}}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			for _, preview := range []bool{false, true} {
				doc := &tg.Document{ID: 9007199254740993, Size: 123, DCID: 2, MimeType: tc.mime, Attributes: tc.attrs, AccessHash: 456, FileReference: []byte{7, 8}}
				m := &tg.Message{ID: 3, PeerID: &tg.PeerChannel{ChannelID: 42}, Media: &tg.MessageMediaDocument{Document: doc}}
				if preview {
					m.Media = &tg.MessageMediaWebPage{Webpage: &tg.WebPage{Document: doc}}
				}
				attachment, err := MessageAttachment(m)
				if err != nil {
					t.Fatal(err)
				}
				if attachment.Type != tc.kind || attachment.FilterKey() != tc.key || attachment.Identity.Kind != "document" || attachment.Identity.ID != "9007199254740993" {
					t.Fatalf("preview=%t classification=%s/%s identity=%+v", preview, attachment.Type, attachment.FilterKey(), attachment.Identity)
				}
				location := attachment.Location.(*tg.InputDocumentFileLocation)
				if location.ID != doc.ID || location.AccessHash != doc.AccessHash || string(location.FileReference) != string(doc.FileReference) {
					t.Fatal("classification changed the source file reference")
				}
			}
		})
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

func TestMessageAttachmentRecordsDescriptiveMediaFacts(t *testing.T) {
	photo := &tg.Message{ID: 5, PeerID: &tg.PeerChannel{ChannelID: 123}, Media: &tg.MessageMediaPhoto{Photo: &tg.Photo{ID: 999, DCID: 2, Sizes: []tg.PhotoSizeClass{
		&tg.PhotoStrippedSize{Type: "i", Bytes: []byte{1, 2, 3}}, &tg.PhotoSize{Type: "x", Size: 100, W: 320, H: 240}, &tg.PhotoSize{Type: "y", Size: 900, W: 1280, H: 960},
	}}}}
	photo.SetFwdFrom(tg.MessageFwdHeader{FromID: &tg.PeerChannel{ChannelID: 77}, ChannelPost: 12})
	a, err := MessageAttachment(photo)
	if err != nil {
		t.Fatal(err)
	}
	if f := a.Facts; f.Mime != "image/jpeg" || f.Width != 1280 || f.Height != 960 || f.Origin != "-1000000000077:12" || string(f.Thumb) != "\x01\x02\x03" || f.DurationMs != 0 {
		t.Fatalf("photo facts=%+v", f)
	}

	video := &tg.Message{ID: 6, PeerID: &tg.PeerUser{UserID: 5}, Media: &tg.MessageMediaDocument{Document: &tg.Document{ID: 1, DCID: 2, Size: 10, MimeType: "video/mp4; codecs=avc1",
		Thumbs:     []tg.PhotoSizeClass{&tg.PhotoStrippedSize{Type: "i", Bytes: []byte{9}}},
		Attributes: []tg.DocumentAttributeClass{&tg.DocumentAttributeVideo{W: 1920, H: 1080, Duration: 12.345}, &tg.DocumentAttributeFilename{FileName: "clip.mp4"}},
	}}}
	video.SetFwdFrom(tg.MessageFwdHeader{SavedFromPeer: &tg.PeerUser{UserID: 42}})
	a, err = MessageAttachment(video)
	if err != nil {
		t.Fatal(err)
	}
	if f := a.Facts; f.Mime != "video/mp4" || f.Width != 1920 || f.Height != 1080 || f.DurationMs != 12345 || f.Origin != "42" || string(f.Thumb) != "\x09" {
		t.Fatalf("video facts=%+v", f)
	}

	audio := &tg.Message{ID: 7, PeerID: &tg.PeerChat{ChatID: 8}, Media: &tg.MessageMediaDocument{Document: &tg.Document{ID: 2, DCID: 2, Size: 10, MimeType: "audio/ogg",
		Attributes: []tg.DocumentAttributeClass{&tg.DocumentAttributeAudio{Duration: 61, Voice: true}},
	}}}
	a, err = MessageAttachment(audio)
	if err != nil {
		t.Fatal(err)
	}
	if f := a.Facts; f.DurationMs != 61000 || f.Origin != "" || f.Width != 0 || f.Thumb != nil {
		t.Fatalf("audio facts=%+v", f)
	}
}
