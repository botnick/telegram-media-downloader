package telegram

import (
	"bytes"
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"
	"unicode/utf16"

	"github.com/gotd/td/tg"
	"github.com/gotd/td/tgerr"
)

type fakeForwardAPI struct {
	uploaded       bytes.Buffer
	sent           []*tg.MessagesSendMediaRequest
	forwards       []*tg.MessagesForwardMessagesRequest
	edits          []*tg.MessagesEditMessageRequest
	deleted        []*tg.MessagesDeleteMessagesRequest
	deletedChannel []*tg.ChannelsDeleteMessagesRequest
	editErr        error
	deleteErr      error
	mu             sync.Mutex
	created        int
	dialogs        int
	dialogsFn      func(int) tg.MessagesDialogsClass
	createStarted  chan struct{}
	createRelease  <-chan struct{}
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
	f.mu.Lock()
	f.dialogs++
	call := f.dialogs
	dialogsFn := f.dialogsFn
	f.mu.Unlock()
	if dialogsFn != nil {
		return dialogsFn(call), nil
	}
	return &tg.MessagesDialogs{}, nil
}
func (f *fakeForwardAPI) MessagesSendMedia(_ context.Context, r *tg.MessagesSendMediaRequest) (tg.UpdatesClass, error) {
	f.sent = append(f.sent, r)
	return &tg.Updates{Updates: []tg.UpdateClass{&tg.UpdateMessageID{ID: 900 + len(f.sent), RandomID: r.RandomID}}}, nil
}
func (f *fakeForwardAPI) MessagesForwardMessages(_ context.Context, r *tg.MessagesForwardMessagesRequest) (tg.UpdatesClass, error) {
	f.forwards = append(f.forwards, r)
	return &tg.Updates{Updates: []tg.UpdateClass{&tg.UpdateMessageID{ID: 777, RandomID: r.RandomID[0]}}}, nil
}
func (f *fakeForwardAPI) MessagesEditMessage(_ context.Context, r *tg.MessagesEditMessageRequest) (tg.UpdatesClass, error) {
	f.edits = append(f.edits, r)
	return nil, f.editErr
}
func (f *fakeForwardAPI) MessagesDeleteMessages(_ context.Context, r *tg.MessagesDeleteMessagesRequest) (*tg.MessagesAffectedMessages, error) {
	f.deleted = append(f.deleted, r)
	return &tg.MessagesAffectedMessages{}, f.deleteErr
}
func (f *fakeForwardAPI) ChannelsDeleteMessages(_ context.Context, r *tg.ChannelsDeleteMessagesRequest) (*tg.MessagesAffectedMessages, error) {
	f.deletedChannel = append(f.deletedChannel, r)
	return &tg.MessagesAffectedMessages{}, f.deleteErr
}
func (f *fakeForwardAPI) ChannelsCreateChannel(_ context.Context, r *tg.ChannelsCreateChannelRequest) (tg.UpdatesClass, error) {
	f.mu.Lock()
	f.created++
	createStarted, createRelease := f.createStarted, f.createRelease
	f.mu.Unlock()
	if createStarted != nil {
		createStarted <- struct{}{}
	}
	if createRelease != nil {
		<-createRelease
	}
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

func TestForwardMessageEditsCaptionWithoutUploadingMedia(t *testing.T) {
	api := &fakeForwardAPI{}
	sender := newTestSender(api, nil, nil)
	entities := []tg.MessageEntityClass{&tg.MessageEntityBold{Offset: 0, Length: 5}}
	id, err := sender.forward(context.Background(), ForwardMessageRequest{
		Source: "me", Destination: "me", MessageID: 12,
		EditCaption: true, Caption: "hello", Entities: entities,
	})
	if err != nil || id != 777 {
		t.Fatalf("id=%d err=%v", id, err)
	}
	if len(api.forwards) != 1 || len(api.edits) != 1 || len(api.sent) != 0 || api.uploaded.Len() != 0 {
		t.Fatalf("forwards=%d edits=%d uploads=%d bytes=%d", len(api.forwards), len(api.edits), len(api.sent), api.uploaded.Len())
	}
	if api.edits[0].ID != 777 || api.edits[0].Message != "hello" || len(api.edits[0].Entities) != 1 {
		t.Fatalf("edit request=%+v", api.edits[0])
	}
}

func TestForwardMessageDropsMediaCaptionWithoutEdit(t *testing.T) {
	api := &fakeForwardAPI{}
	sender := newTestSender(api, nil, nil)
	id, err := sender.forward(context.Background(), ForwardMessageRequest{
		Source: "me", Destination: "me", MessageID: 12, DropMediaCaptions: true,
	})
	if err != nil || id != 777 {
		t.Fatalf("id=%d err=%v", id, err)
	}
	if len(api.forwards) != 1 || !api.forwards[0].DropMediaCaptions || len(api.edits) != 0 || len(api.deleted) != 0 {
		t.Fatalf("forwards=%+v edits=%d deletes=%d", api.forwards, len(api.edits), len(api.deleted))
	}
	api.forwards[0].SetFlags()
	if !api.forwards[0].GetDropMediaCaptions() {
		t.Fatal("Telegram request omitted drop_media_captions flag")
	}
}

func TestForwardCaptionEditFailureCleansCopyBeforeFallback(t *testing.T) {
	editErr := errors.New("caption edit rejected")
	api := &fakeForwardAPI{editErr: editErr}
	sender := newTestSender(api, nil, nil)
	_, err := sender.forward(context.Background(), ForwardMessageRequest{Source: "me", Destination: "me", MessageID: 12, EditCaption: true, Caption: "custom"})
	if !errors.Is(err, editErr) || errors.Is(err, ErrForwardCaptionUnresolved) {
		t.Fatalf("err=%v", err)
	}
	if len(api.deleted) != 1 || !api.deleted[0].Revoke || len(api.deleted[0].ID) != 1 || api.deleted[0].ID[0] != 777 {
		t.Fatalf("cleanup requests=%+v", api.deleted)
	}
}

func TestForwardCaptionAlreadyMatchesIsSuccess(t *testing.T) {
	api := &fakeForwardAPI{editErr: tgerr.New(400, "MESSAGE_NOT_MODIFIED")}
	sender := newTestSender(api, nil, nil)
	id, err := sender.forward(context.Background(), ForwardMessageRequest{
		Source: "me", Destination: "me", MessageID: 12, EditCaption: true, Caption: "custom",
	})
	if err != nil || id != 777 {
		t.Fatalf("id=%d err=%v", id, err)
	}
	if len(api.forwards) != 1 || len(api.edits) != 1 || len(api.deleted) != 0 || len(api.sent) != 0 {
		t.Fatalf("forwards=%d edits=%d deletes=%d uploads=%d", len(api.forwards), len(api.edits), len(api.deleted), len(api.sent))
	}
}

func TestForwardCaptionCleanupFailureIsMarkedUnresolved(t *testing.T) {
	api := &fakeForwardAPI{editErr: errors.New("caption edit rejected"), deleteErr: errors.New("delete rejected")}
	sender := newTestSender(api, nil, nil)
	_, err := sender.forward(context.Background(), ForwardMessageRequest{Source: "me", Destination: "me", MessageID: 12, EditCaption: true, Caption: "custom"})
	if !errors.Is(err, ErrForwardCaptionUnresolved) {
		t.Fatalf("expected unresolved forward error, got %v", err)
	}
}

func TestRetryEditsSavedDestinationMessageWithoutForwardingAgain(t *testing.T) {
	api := &fakeForwardAPI{}
	sender := newTestSender(api, nil, nil)
	var resultID int
	id, err := sender.forward(context.Background(), ForwardMessageRequest{
		Destination: "me", MessageID: 12, EditCaption: true, EditMessageID: 777,
		ResultMessageID: &resultID, Caption: "custom",
	})
	if err != nil || id != 777 || resultID != 777 {
		t.Fatalf("id=%d resultID=%d err=%v", id, resultID, err)
	}
	if len(api.forwards) != 0 || len(api.edits) != 1 || api.edits[0].ID != 777 {
		t.Fatalf("forwards=%d edits=%+v", len(api.forwards), api.edits)
	}
}

func TestForwardToStorageDropsAuthorAttribution(t *testing.T) {
	api := &fakeForwardAPI{dialogsFn: func(int) tg.MessagesDialogsClass {
		return &tg.MessagesDialogs{Dialogs: []tg.DialogClass{&tg.Dialog{Peer: &tg.PeerChannel{ChannelID: 8}}}, Chats: []tg.ChatClass{&tg.Channel{ID: 8, AccessHash: 3, Title: StorageChannelTitle, Broadcast: true}}}
	}}
	sender := newTestSender(api, nil, nil)
	if _, err := sender.forward(context.Background(), ForwardMessageRequest{Source: "me", Destination: "storage", MessageID: 12}); err != nil {
		t.Fatal(err)
	}
	if len(api.forwards) != 1 || !api.forwards[0].DropAuthor {
		t.Fatalf("storage forward=%+v", api.forwards)
	}

	other := &fakeForwardAPI{}
	if _, err := newTestSender(other, nil, nil).forward(context.Background(), ForwardMessageRequest{Source: "me", Destination: "me", MessageID: 12}); err != nil {
		t.Fatal(err)
	}
	if len(other.forwards) != 1 || other.forwards[0].DropAuthor {
		t.Fatalf("non-storage forward=%+v", other.forwards)
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
	if api.created != 1 || api.dialogs != 2 {
		t.Fatalf("created=%d dialog reads=%d", api.created, api.dialogs)
	}
	if peer, ok := api.sent[1].Peer.(*tg.InputPeerChannel); !ok || peer.ChannelID != 555 || peer.AccessHash != 99 {
		t.Fatalf("peer=%#v", api.sent[1].Peer)
	}

	existing := &fakeForwardAPI{dialogsFn: func(int) tg.MessagesDialogsClass {
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

func TestStorageChannelFindsExistingBeyondFirstPage(t *testing.T) {
	api := &fakeForwardAPI{dialogsFn: func(call int) tg.MessagesDialogsClass {
		if call == 1 {
			return dialogPage(1, 100)
		}
		page := dialogPage(201, 201)
		page.Chats[0].(*tg.Channel).Title = StorageChannelTitle
		return &tg.MessagesDialogs{Dialogs: page.Dialogs, Chats: page.Chats, Messages: page.Messages}
	}}
	sender := newTestSender(api, nil, nil)
	peer, err := sender.destination(context.Background(), "storage")
	channel, ok := peer.(*tg.InputPeerChannel)
	if err != nil || !ok || channel.ChannelID != 201 || api.created != 0 || api.dialogs != 2 {
		t.Fatalf("peer=%#v created=%d dialogs=%d err=%v", peer, api.created, api.dialogs, err)
	}
}

func TestStorageChannelFindsArchivedChannel(t *testing.T) {
	api := &fakeForwardAPI{dialogsFn: func(call int) tg.MessagesDialogsClass {
		if call == 1 {
			return &tg.MessagesDialogs{}
		}
		return &tg.MessagesDialogs{
			Dialogs: []tg.DialogClass{&tg.Dialog{Peer: &tg.PeerChannel{ChannelID: 42}}},
			Chats:   []tg.ChatClass{&tg.Channel{ID: 42, AccessHash: 7, Title: StorageChannelTitle}},
		}
	}}
	sender := newTestSender(api, nil, nil)
	peer, err := sender.destination(context.Background(), "storage")
	channel, ok := peer.(*tg.InputPeerChannel)
	if err != nil || !ok || channel.ChannelID != 42 || api.created != 0 || api.dialogs != 2 {
		t.Fatalf("peer=%#v created=%d dialogs=%d err=%v", peer, api.created, api.dialogs, err)
	}
}

func TestStorageChannelSerializesConcurrentCreation(t *testing.T) {
	releaseCreate := make(chan struct{})
	api := &fakeForwardAPI{createStarted: make(chan struct{}, 2), createRelease: releaseCreate}
	sender := newTestSender(api, nil, nil)
	start := make(chan struct{})
	results := make(chan tg.InputPeerClass, 2)
	errs := make(chan error, 2)
	var ready sync.WaitGroup
	ready.Add(2)
	for i := 0; i < 2; i++ {
		go func() {
			ready.Done()
			<-start
			peer, err := sender.destination(context.Background(), "storage")
			results <- peer
			errs <- err
		}()
	}
	ready.Wait()
	close(start)
	select {
	case <-api.createStarted:
	case <-time.After(time.Second):
		close(releaseCreate)
		t.Fatal("storage channel creation did not start")
	}
	select {
	case <-api.createStarted:
		close(releaseCreate)
		t.Fatal("concurrent lookup started a second channel creation")
	case <-time.After(50 * time.Millisecond):
	}
	close(releaseCreate)
	for i := 0; i < 2; i++ {
		if err := <-errs; err != nil {
			t.Fatal(err)
		}
	}
	first, second := <-results, <-results
	if api.created != 1 || first.(*tg.InputPeerChannel).ChannelID != second.(*tg.InputPeerChannel).ChannelID {
		t.Fatalf("created=%d peers=%#v, %#v", api.created, first, second)
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
