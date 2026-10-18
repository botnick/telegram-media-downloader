package telegram

import (
	"bytes"
	"context"
	"errors"
	"strings"
	"testing"
	"unicode/utf16"

	"github.com/gotd/td/tg"
)

type fakeForwardAPI struct {
	uploaded  bytes.Buffer
	sent      []*tg.MessagesSendMediaRequest
	created   int
	dialogs   int
	dialogsFn func() tg.MessagesDialogsClass
}

func (f *fakeForwardAPI) UploadSaveFilePart(_ context.Context, r *tg.UploadSaveFilePartRequest) (bool, error) {
	f.uploaded.Write(r.Bytes)
	return true, nil
}
func (f *fakeForwardAPI) UploadSaveBigFilePart(_ context.Context, r *tg.UploadSaveBigFilePartRequest) (bool, error) {
	f.uploaded.Write(r.Bytes)
	return true, nil
}
func (f *fakeForwardAPI) MessagesGetHistory(context.Context, *tg.MessagesGetHistoryRequest) (tg.MessagesMessagesClass, error) {
	return nil, errors.New("unexpected history read")
}
func (f *fakeForwardAPI) ContactsResolveUsername(context.Context, *tg.ContactsResolveUsernameRequest) (*tg.ContactsResolvedPeer, error) {
	return nil, errors.New("unexpected username lookup")
}
func (f *fakeForwardAPI) ContactsResolvePhone(_ context.Context, phone string) (*tg.ContactsResolvedPeer, error) {
	return &tg.ContactsResolvedPeer{Peer: &tg.PeerUser{UserID: 77}, Users: []tg.UserClass{&tg.User{ID: 77, AccessHash: 5, Phone: phone}}}, nil
}
func (f *fakeForwardAPI) MessagesGetDialogs(context.Context, *tg.MessagesGetDialogsRequest) (tg.MessagesDialogsClass, error) {
	f.dialogs++
	if f.dialogsFn != nil {
		return f.dialogsFn(), nil
	}
	return &tg.MessagesDialogs{}, nil
}
func (f *fakeForwardAPI) MessagesSendMedia(_ context.Context, r *tg.MessagesSendMediaRequest) (tg.UpdatesClass, error) {
	f.sent = append(f.sent, r)
	return &tg.Updates{Updates: []tg.UpdateClass{&tg.UpdateMessageID{ID: 900 + len(f.sent), RandomID: r.RandomID}}}, nil
}
func (f *fakeForwardAPI) ChannelsCreateChannel(_ context.Context, r *tg.ChannelsCreateChannelRequest) (tg.UpdatesClass, error) {
	f.created++
	if !r.Broadcast || r.Title != StorageChannelTitle {
		return nil, errors.New("unexpected channel")
	}
	return &tg.Updates{Chats: []tg.ChatClass{&tg.Channel{ID: 555, AccessHash: 99, Title: r.Title}}}, nil
}

func newTestSender(api *fakeForwardAPI, resolve func(context.Context, string) (Dialog, error), scan func(context.Context, bool) ([]Dialog, error)) *fileSender {
	if resolve == nil {
		resolve = func(context.Context, string) (Dialog, error) { return Dialog{}, errors.New("not cached") }
	}
	if scan == nil {
		scan = func(context.Context, bool) ([]Dialog, error) { return nil, nil }
	}
	return &fileSender{api: api, resolve: resolve, scan: scan}
}

func TestSendFileUploadsToSavedMessagesWithCaption(t *testing.T) {
	api := &fakeForwardAPI{}
	sender := newTestSender(api, nil, nil)
	caption, entities := ForwardCaption("hello", "Chat", "-1001234", 7)
	id, err := sender.send(context.Background(), SendFileRequest{Destination: "me", Name: "a.jpg", Size: 5, Body: strings.NewReader("bytes"), Caption: caption, Entities: entities})
	if err != nil || id != 901 {
		t.Fatalf("id=%d err=%v", id, err)
	}
	if api.uploaded.String() != "bytes" {
		t.Fatalf("uploaded %q", api.uploaded.String())
	}
	req := api.sent[0]
	if _, ok := req.Peer.(*tg.InputPeerSelf); !ok {
		t.Fatalf("peer=%T", req.Peer)
	}
	if _, ok := req.Media.(*tg.InputMediaUploadedPhoto); !ok {
		t.Fatalf("jpeg should go as a photo: %T", req.Media)
	}
	if req.Message != "hello\n\n📌 Source: Chat" || len(req.Entities) != 1 {
		t.Fatalf("caption=%q entities=%v", req.Message, req.Entities)
	}
}

func TestSendFileDocumentKeepsNameAndVideoFacts(t *testing.T) {
	api := &fakeForwardAPI{}
	sender := newTestSender(api, nil, nil)
	_, err := sender.send(context.Background(), SendFileRequest{Destination: "saved", Name: "clip.mp4", Size: 3, Body: strings.NewReader("abc"), Facts: MediaFacts{Width: 640, Height: 360, DurationMs: 2500}})
	if err != nil {
		t.Fatal(err)
	}
	doc, ok := api.sent[0].Media.(*tg.InputMediaUploadedDocument)
	if !ok || doc.MimeType != "video/mp4" || len(doc.Attributes) != 2 {
		t.Fatalf("media=%#v", api.sent[0].Media)
	}
	if name, ok := doc.Attributes[0].(*tg.DocumentAttributeFilename); !ok || name.FileName != "clip.mp4" {
		t.Fatalf("name=%#v", doc.Attributes[0])
	}
	if video, ok := doc.Attributes[1].(*tg.DocumentAttributeVideo); !ok || video.W != 640 || video.Duration != 2.5 || !video.SupportsStreaming {
		t.Fatalf("video=%#v", doc.Attributes[1])
	}
}

func TestStorageChannelIsFoundOrCreatedOnce(t *testing.T) {
	api := &fakeForwardAPI{}
	sender := newTestSender(api, nil, nil)
	for i := 0; i < 2; i++ {
		if _, err := sender.send(context.Background(), SendFileRequest{Name: "f.bin", Size: 1, Body: strings.NewReader("x")}); err != nil {
			t.Fatal(err)
		}
	}
	if api.created != 1 || api.dialogs != 1 {
		t.Fatalf("created=%d dialog reads=%d", api.created, api.dialogs)
	}
	if peer, ok := api.sent[1].Peer.(*tg.InputPeerChannel); !ok || peer.ChannelID != 555 || peer.AccessHash != 99 {
		t.Fatalf("peer=%#v", api.sent[1].Peer)
	}

	existing := &fakeForwardAPI{dialogsFn: func() tg.MessagesDialogsClass {
		return &tg.MessagesDialogs{Dialogs: []tg.DialogClass{&tg.Dialog{Peer: &tg.PeerChannel{ChannelID: 8}}}, Chats: []tg.ChatClass{&tg.Channel{ID: 8, AccessHash: 3, Title: StorageChannelTitle, Broadcast: true}}}
	}}
	if _, err := newTestSender(existing, nil, nil).send(context.Background(), SendFileRequest{Destination: "storage", Name: "f.bin", Size: 1, Body: strings.NewReader("x")}); err != nil {
		t.Fatal(err)
	}
	if existing.created != 0 {
		t.Fatal("created a second storage channel next to the existing one")
	}
	if peer, ok := existing.sent[0].Peer.(*tg.InputPeerChannel); !ok || peer.ChannelID != 8 {
		t.Fatalf("peer=%#v", existing.sent[0].Peer)
	}
}

func TestNumericDestinationFallsBackLikeGramJS(t *testing.T) {
	api := &fakeForwardAPI{}
	scans := 0
	sender := newTestSender(api, nil, func(_ context.Context, archived bool) ([]Dialog, error) {
		scans++
		if archived {
			return []Dialog{{ID: "-1000000000042", peer: &tg.InputPeerChannel{ChannelID: 42, AccessHash: 11}}}, nil
		}
		return nil, nil
	})
	ctx := context.Background()
	peer, err := sender.destination(ctx, "-1000000000042")
	if channel, ok := peer.(*tg.InputPeerChannel); err != nil || !ok || channel.AccessHash != 11 {
		t.Fatalf("peer=%#v err=%v", peer, err)
	}
	if _, err = sender.destination(ctx, "-1000000000042"); err != nil || scans != 2 {
		t.Fatalf("resolved destination was not cached: scans=%d err=%v", scans, err)
	}
	peer, err = sender.destination(ctx, "-1009999")
	if channel, ok := peer.(*tg.InputPeerChannel); err != nil || !ok || channel.ChannelID != 9999 || channel.AccessHash != 0 {
		t.Fatalf("hand-made channel=%#v err=%v", peer, err)
	}
	peer, err = sender.destination(ctx, "-55")
	if chat, ok := peer.(*tg.InputPeerChat); err != nil || !ok || chat.ChatID != 55 {
		t.Fatalf("chat=%#v err=%v", peer, err)
	}
	if _, err = sender.destination(ctx, "12345"); !errors.Is(err, ErrDestinationNotFound) {
		t.Fatalf("unknown user err=%v", err)
	}
	peer, err = sender.destination(ctx, "+15550001")
	if user, ok := peer.(*tg.InputPeerUser); err != nil || !ok || user.UserID != 77 || user.AccessHash != 5 {
		t.Fatalf("phone=%#v err=%v", peer, err)
	}
}

func TestUsernameDestinationAcceptsLinks(t *testing.T) {
	var asked []string
	sender := newTestSender(&fakeForwardAPI{}, func(_ context.Context, q string) (Dialog, error) {
		asked = append(asked, q)
		return Dialog{peer: &tg.InputPeerChannel{ChannelID: 1, AccessHash: 2}}, nil
	}, nil)
	for _, dest := range []string{"@Archive", "https://t.me/other"} {
		if _, err := sender.destination(context.Background(), dest); err != nil {
			t.Fatal(err)
		}
	}
	if strings.Join(asked, ",") != "Archive,other" {
		t.Fatalf("asked=%v", asked)
	}
}

func TestForwardCaptionMatchesNodeLayout(t *testing.T) {
	text, entities := ForwardCaption("héllo 😀", "My Chat", "-1001234567890", 42)
	if text != "héllo 😀\n\n📌 Source: My Chat" {
		t.Fatalf("text=%q", text)
	}
	link, ok := entities[0].(*tg.MessageEntityTextURL)
	if !ok || link.URL != "https://t.me/c/1234567890/42" {
		t.Fatalf("entity=%#v", entities[0])
	}
	units := utf16.Encode([]rune(text))
	if got := string(utf16.Decode(units[link.Offset : link.Offset+link.Length])); got != "My Chat" {
		t.Fatalf("entity covers %q", got)
	}
	text, entities = ForwardCaption("", "Group", "-42", 0)
	if bold, ok := entities[0].(*tg.MessageEntityBold); text != "📌 Source: Group" || !ok || bold.Length != 5 {
		t.Fatalf("text=%q entities=%#v", text, entities)
	}
	text, _ = ForwardCaption(strings.Repeat("a", 5000), "Chat", "-1001", 1)
	if n := len(utf16.Encode([]rune(text))); n > maxCaption || !strings.HasSuffix(text, "📌 Source: Chat") {
		t.Fatalf("long caption length=%d", n)
	}
}

func TestMessageTTL(t *testing.T) {
	photo := &tg.MessageMediaPhoto{Photo: &tg.Photo{ID: 1}}
	photo.SetTTLSeconds(10)
	doc := &tg.MessageMediaDocument{Document: &tg.Document{ID: 2}}
	doc.SetTTLSeconds(30)
	for _, tc := range []struct {
		message *tg.Message
		want    int
	}{
		{&tg.Message{Media: photo}, 10},
		{&tg.Message{Media: doc}, 30},
		{&tg.Message{Media: &tg.MessageMediaPhoto{Photo: &tg.Photo{ID: 3}}}, 0},
		{nil, 0},
	} {
		if got := MessageTTL(tc.message); got != tc.want {
			t.Fatalf("ttl=%d want %d", got, tc.want)
		}
	}
}
