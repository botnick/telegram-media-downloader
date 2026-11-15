package telegram

import (
	"context"
	"crypto/rand"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"mime"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"unicode/utf16"

	"github.com/gotd/td/telegram/uploader"
	"github.com/gotd/td/tg"
	"github.com/gotd/td/tgerr"
)

// StorageChannelTitle is the channel 2.x created (or reused) when an
// auto-forward rule names no destination.
const StorageChannelTitle = "Telegram Downloader Storage"

// ErrDestinationNotFound mirrors gramJS's "Could not find the input entity":
// the account has no way to address the configured destination.
var ErrDestinationNotFound = errors.New("could not find the input entity for the forward destination")

// SendFileRequest is one auto-forward: a downloaded file re-uploaded to a
// destination with a caption. 2.x uploaded the file (sendFile) rather than
// forwarding the message so chats that restrict forwarding still work.
type SendFileRequest struct {
	// Destination is "me"/"saved" (Saved Messages), "" or "storage" (the
	// storage channel), a numeric chat ID, a @username/t.me link or a +phone.
	Destination string
	TopicID     int
	Name        string
	Size        int64
	Body        io.Reader
	Facts       MediaFacts
	Caption     string
	Entities    []tg.MessageEntityClass
	Protect     bool
}

type ForwardMessageRequest struct {
	Source, Destination string
	MessageID, TopicID  int
	Protect             bool
	DropMediaCaptions   bool
	EditCaption         bool
	EditMessageID       int
	ResultMessageID     *int `json:"-"`
	Caption             string
	Entities            []tg.MessageEntityClass
}

// ErrForwardCaptionUnresolved reports that Telegram accepted the forward but
// the app cannot confirm the requested caption or safely remove the copy.
var ErrForwardCaptionUnresolved = errors.New("forwarded message may remain without the requested caption")

type forwardAPI interface {
	uploader.Client
	peerRecoveryAPI
	dialogsAPI
	ContactsResolvePhone(context.Context, string) (*tg.ContactsResolvedPeer, error)
	MessagesSendMedia(context.Context, *tg.MessagesSendMediaRequest) (tg.UpdatesClass, error)
	MessagesForwardMessages(context.Context, *tg.MessagesForwardMessagesRequest) (tg.UpdatesClass, error)
	ChannelsCreateChannel(context.Context, *tg.ChannelsCreateChannelRequest) (tg.UpdatesClass, error)
}

func (a *Account) ForwardMessage(ctx context.Context, req ForwardMessageRequest) (int, error) {
	if a == nil || a.API() == nil {
		return 0, errors.New("Telegram account is not connected")
	}
	a.senderOnce.Do(func() { a.sender = &fileSender{api: a.API(), resolve: a.ResolveDialog, scan: a.RecoveryDialogs} })
	return a.sender.forward(ctx, req)
}

func (s *fileSender) forward(ctx context.Context, req ForwardMessageRequest) (int, error) {
	if req.EditCaption && req.EditMessageID > 0 {
		destination, err := s.destination(ctx, req.Destination)
		if err != nil {
			return 0, fmt.Errorf("resolve destination: %w", err)
		}
		if req.ResultMessageID != nil {
			*req.ResultMessageID = req.EditMessageID
		}
		if err := s.editForwardedCaption(ctx, destination, req.EditMessageID, req); err != nil {
			return 0, err
		}
		return req.EditMessageID, nil
	}
	if req.MessageID <= 0 {
		return 0, errors.New("invalid Telegram message id")
	}
	source, err := s.destination(ctx, req.Source)
	if err != nil {
		return 0, fmt.Errorf("resolve source: %w", err)
	}
	destination, err := s.destination(ctx, req.Destination)
	if err != nil {
		return 0, fmt.Errorf("resolve destination: %w", err)
	}
	var random [8]byte
	if _, err := rand.Read(random[:]); err != nil {
		return 0, err
	}
	id := int64(binary.LittleEndian.Uint64(random[:]))
	updates, err := s.api.MessagesForwardMessages(ctx, &tg.MessagesForwardMessagesRequest{FromPeer: source, ID: []int{req.MessageID}, RandomID: []int64{id}, ToPeer: destination, TopMsgID: req.TopicID, DropAuthor: isStorageDestination(req.Destination), DropMediaCaptions: req.DropMediaCaptions, Noforwards: req.Protect})
	if err != nil {
		return 0, err
	}
	sentID := sentMessageID(updates, id)
	if req.ResultMessageID != nil {
		*req.ResultMessageID = sentID
	}
	if !req.EditCaption {
		return sentID, nil
	}
	if sentID <= 0 {
		return 0, fmt.Errorf("%w: Telegram forward response did not include the destination message id", ErrForwardCaptionUnresolved)
	}
	if err := s.editForwardedCaption(ctx, destination, sentID, req); err != nil {
		return 0, err
	}
	return sentID, nil
}

func (s *fileSender) editForwardedCaption(ctx context.Context, destination tg.InputPeerClass, messageID int, req ForwardMessageRequest) error {
	editor, ok := s.api.(interface {
		MessagesEditMessage(context.Context, *tg.MessagesEditMessageRequest) (tg.UpdatesClass, error)
	})
	if !ok {
		editErr := errors.New("Telegram API does not support editing forwarded captions")
		if cleanupErr := s.deleteForwarded(ctx, destination, messageID); cleanupErr != nil {
			return fmt.Errorf("%w: edit: %v; cleanup: %v", ErrForwardCaptionUnresolved, editErr, cleanupErr)
		}
		if req.ResultMessageID != nil {
			*req.ResultMessageID = 0
		}
		return editErr
	}
	if _, err := editor.MessagesEditMessage(ctx, &tg.MessagesEditMessageRequest{Peer: destination, ID: messageID, Message: req.Caption, Entities: req.Entities}); err == nil || tgerr.Is(err, "MESSAGE_NOT_MODIFIED") {
		return nil
	} else if cleanupErr := s.deleteForwarded(ctx, destination, messageID); cleanupErr != nil {
		return fmt.Errorf("%w: edit: %v; cleanup: %v", ErrForwardCaptionUnresolved, err, cleanupErr)
	} else {
		if req.ResultMessageID != nil {
			*req.ResultMessageID = 0
		}
		return fmt.Errorf("edit forwarded caption: %w", err)
	}
}

func (s *fileSender) deleteForwarded(ctx context.Context, peer tg.InputPeerClass, messageID int) error {
	var channel tg.InputChannelClass
	switch channelPeer := peer.(type) {
	case *tg.InputPeerChannel:
		channel = &tg.InputChannel{ChannelID: channelPeer.ChannelID, AccessHash: channelPeer.AccessHash}
	case *tg.InputPeerChannelFromMessage:
		channel = &tg.InputChannelFromMessage{Peer: channelPeer.Peer, MsgID: channelPeer.MsgID, ChannelID: channelPeer.ChannelID}
	}
	if channel != nil {
		deleter, ok := s.api.(interface {
			ChannelsDeleteMessages(context.Context, *tg.ChannelsDeleteMessagesRequest) (*tg.MessagesAffectedMessages, error)
		})
		if !ok {
			return errors.New("Telegram API does not support deleting channel messages")
		}
		_, err := deleter.ChannelsDeleteMessages(ctx, &tg.ChannelsDeleteMessagesRequest{Channel: channel, ID: []int{messageID}})
		return err
	}
	deleter, ok := s.api.(interface {
		MessagesDeleteMessages(context.Context, *tg.MessagesDeleteMessagesRequest) (*tg.MessagesAffectedMessages, error)
	})
	if !ok {
		return errors.New("Telegram API does not support deleting forwarded messages")
	}
	_, err := deleter.MessagesDeleteMessages(ctx, &tg.MessagesDeleteMessagesRequest{Revoke: true, ID: []int{messageID}})
	return err
}

// fileSender keeps the destinations it resolved for one account, so a busy
// rule does not repeat username lookups or dialog scans for every file.
type fileSender struct {
	api       forwardAPI
	resolve   func(context.Context, string) (Dialog, error)
	scan      func(context.Context, bool) ([]Dialog, error)
	mu        sync.Mutex
	storageMu sync.Mutex
	peers     map[string]tg.InputPeerClass
}

// SendFile uploads a downloaded file to the destination and returns the new
// message ID (0 when Telegram's answer does not name it). Every RPC goes
// through the account's flood guard.
func (a *Account) SendFile(ctx context.Context, req SendFileRequest) (int, error) {
	if a == nil || a.API() == nil {
		return 0, errors.New("Telegram account is not connected")
	}
	a.senderOnce.Do(func() {
		a.sender = &fileSender{
			api:     a.API(),
			resolve: a.ResolveDialog,
			scan:    a.RecoveryDialogs,
		}
	})
	return a.sender.send(ctx, req)
}

func (s *fileSender) send(ctx context.Context, req SendFileRequest) (int, error) {
	if req.Body == nil || req.Size <= 0 {
		return 0, errors.New("forward file is empty")
	}
	peer, err := s.destination(ctx, req.Destination)
	if err != nil {
		return 0, err
	}
	// One upload stream at a time, as 2.x did (workers: 1).
	file, err := uploader.NewUploader(s.api).WithThreads(1).Upload(ctx, uploader.NewUpload(req.Name, req.Body, req.Size))
	if err != nil {
		return 0, fmt.Errorf("upload %s: %w", req.Name, err)
	}
	var random [8]byte
	if _, err := rand.Read(random[:]); err != nil {
		return 0, err
	}
	randomID := int64(binary.LittleEndian.Uint64(random[:]))
	updates, err := s.api.MessagesSendMedia(ctx, &tg.MessagesSendMediaRequest{
		Peer: peer, ReplyTo: forwardTopicReply(req.TopicID), Media: uploadedMedia(file, req), Message: req.Caption, Entities: req.Entities, RandomID: randomID, Noforwards: req.Protect,
	})
	if err != nil {
		return 0, err
	}
	return sentMessageID(updates, randomID), nil
}

func forwardTopicReply(topicID int) tg.InputReplyToClass {
	if topicID <= 0 {
		return nil
	}
	return &tg.InputReplyToMessage{ReplyToMsgID: topicID}
}

var numericDestination = regexp.MustCompile(`^-?\d+$`)

func (s *fileSender) destination(ctx context.Context, raw string) (tg.InputPeerClass, error) {
	dest := strings.TrimSpace(raw)
	switch dest {
	case "me", "saved":
		return &tg.InputPeerSelf{}, nil
	case "", "storage":
		dest = "storage"
	}
	s.mu.Lock()
	cached := s.peers[dest]
	s.mu.Unlock()
	if cached != nil {
		return cached, nil
	}
	var peer tg.InputPeerClass
	var err error
	switch {
	case dest == "storage":
		peer, err = s.storageChannel(ctx)
	case numericDestination.MatchString(dest):
		peer, err = s.numericPeer(ctx, dest)
	case strings.HasPrefix(dest, "+"):
		peer, err = s.phonePeer(ctx, dest)
	default:
		var dialog Dialog
		dialog, err = s.resolve(ctx, usernameOf(dest))
		peer = dialog.peer
		if err == nil && peer == nil {
			err = ErrDestinationNotFound
		}
	}
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	if s.peers == nil {
		s.peers = map[string]tg.InputPeerClass{}
	}
	s.peers[dest] = peer
	s.mu.Unlock()
	return peer, nil
}

func isStorageDestination(raw string) bool {
	switch strings.TrimSpace(raw) {
	case "", "storage":
		return true
	default:
		return false
	}
}

// numericPeer follows gramJS: the cached entity first, then the account's
// dialogs, then a hand-made peer that Telegram refuses with a clear error
// (CHANNEL_INVALID) when the account has never seen the channel.
func (s *fileSender) numericPeer(ctx context.Context, id string) (tg.InputPeerClass, error) {
	if dialog, err := s.resolve(ctx, id); err == nil && dialog.peer != nil {
		return dialog.peer, nil
	} else if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	for _, archived := range []bool{false, true} {
		dialogs, err := s.scan(ctx, archived)
		if err != nil {
			return nil, err
		}
		for _, dialog := range dialogs {
			if dialog.ID == id && dialog.peer != nil {
				return dialog.peer, nil
			}
		}
	}
	switch {
	case strings.HasPrefix(id, "-100"):
		channel, err := strconv.ParseInt(strings.TrimPrefix(id, "-100"), 10, 64)
		if err != nil {
			return nil, err
		}
		return &tg.InputPeerChannel{ChannelID: channel}, nil
	case strings.HasPrefix(id, "-"):
		chat, err := strconv.ParseInt(strings.TrimPrefix(id, "-"), 10, 64)
		if err != nil {
			return nil, err
		}
		return &tg.InputPeerChat{ChatID: chat}, nil
	default:
		return nil, ErrDestinationNotFound
	}
}

func (s *fileSender) phonePeer(ctx context.Context, phone string) (tg.InputPeerClass, error) {
	result, err := s.api.ContactsResolvePhone(ctx, strings.TrimPrefix(phone, "+"))
	if err != nil {
		return nil, err
	}
	dialogs := mapDialogPage([]tg.DialogClass{&tg.Dialog{Peer: result.Peer}}, result.Chats, result.Users)
	if len(dialogs) != 1 || dialogs[0].peer == nil {
		return nil, ErrDestinationNotFound
	}
	return dialogs[0].peer, nil
}

// storageChannel reuses the account's storage channel or creates it once.
func (s *fileSender) storageChannel(ctx context.Context) (tg.InputPeerClass, error) {
	s.storageMu.Lock()
	defer s.storageMu.Unlock()

	s.mu.Lock()
	peer := s.peers["storage"]
	s.mu.Unlock()
	if peer != nil {
		return peer, nil
	}
	for _, folder := range []int{0, 1} {
		dialogs, err := fetchDialogs(ctx, s.api, -1, folder)
		if err != nil {
			return nil, err
		}
		for _, dialog := range dialogs {
			if dialog.Name != StorageChannelTitle {
				continue
			}
			if dialog.peer == nil {
				return nil, errors.New("existing storage channel has no reusable Telegram peer")
			}
			s.cacheStoragePeer(dialog.peer)
			return dialog.peer, nil
		}
	}
	created, err := s.api.ChannelsCreateChannel(ctx, &tg.ChannelsCreateChannelRequest{
		Broadcast: true,
		Title:     StorageChannelTitle,
		About:     "Auto-forwarded media storage from Telegram Media Downloader",
	})
	if err != nil {
		return nil, fmt.Errorf("create storage channel: %w", err)
	}
	var chats []tg.ChatClass
	switch u := created.(type) {
	case *tg.Updates:
		chats = u.Chats
	case *tg.UpdatesCombined:
		chats = u.Chats
	}
	for _, chat := range chats {
		if channel, ok := chat.(*tg.Channel); ok {
			peer := &tg.InputPeerChannel{ChannelID: channel.ID, AccessHash: channel.AccessHash}
			s.cacheStoragePeer(peer)
			return peer, nil
		}
	}
	return nil, errors.New("Telegram did not return the created storage channel")
}

func (s *fileSender) cacheStoragePeer(peer tg.InputPeerClass) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.peers == nil {
		s.peers = map[string]tg.InputPeerClass{}
	}
	s.peers["storage"] = peer
}

func usernameOf(dest string) string {
	for _, prefix := range []string{"https://", "http://"} {
		dest = strings.TrimPrefix(dest, prefix)
	}
	for _, prefix := range []string{"t.me/", "telegram.me/"} {
		dest = strings.TrimPrefix(dest, prefix)
	}
	return strings.TrimPrefix(dest, "@")
}

// Telegram accepts photos up to 10 MB; larger images go as documents.
const maxUploadedPhoto = 10 << 20

// uploadedMedia matches gramJS sendFile with forceDocument=false: JPEG and
// PNG files become photos, everything else a document that keeps its name.
func uploadedMedia(file tg.InputFileClass, req SendFileRequest) tg.InputMediaClass {
	ext := strings.ToLower(filepath.Ext(req.Name))
	if (ext == ".jpg" || ext == ".jpeg" || ext == ".png") && req.Size <= maxUploadedPhoto {
		return &tg.InputMediaUploadedPhoto{File: file}
	}
	mimeType := req.Facts.Mime
	if mimeType == "" {
		mimeType = strings.SplitN(mime.TypeByExtension(ext), ";", 2)[0]
	}
	if mimeType == "" {
		mimeType = "application/octet-stream"
	}
	attributes := []tg.DocumentAttributeClass{&tg.DocumentAttributeFilename{FileName: req.Name}}
	switch {
	case strings.HasPrefix(mimeType, "video/"):
		attributes = append(attributes, &tg.DocumentAttributeVideo{SupportsStreaming: true, W: req.Facts.Width, H: req.Facts.Height, Duration: float64(req.Facts.DurationMs) / 1000})
	case strings.HasPrefix(mimeType, "audio/"):
		attributes = append(attributes, &tg.DocumentAttributeAudio{Duration: int(req.Facts.DurationMs / 1000)})
	}
	return &tg.InputMediaUploadedDocument{File: file, MimeType: mimeType, Attributes: attributes}
}

func sentMessageID(updates tg.UpdatesClass, randomID int64) int {
	var list []tg.UpdateClass
	switch u := updates.(type) {
	case *tg.UpdateShortSentMessage:
		return u.ID
	case *tg.Updates:
		list = u.Updates
	case *tg.UpdatesCombined:
		list = u.Updates
	case *tg.UpdateShort:
		list = []tg.UpdateClass{u.Update}
	}
	fallback := 0
	for _, update := range list {
		switch u := update.(type) {
		case *tg.UpdateMessageID:
			if u.RandomID == randomID {
				return u.ID
			}
		case *tg.UpdateNewMessage:
			fallback = u.Message.GetID()
		case *tg.UpdateNewChannelMessage:
			fallback = u.Message.GetID()
		}
	}
	return fallback
}

// Telegram's caption limit, counted in UTF-16 code units like entity offsets.
const maxCaption = 1024

func PlainForwardCaption(text string) string {
	if utf16Len(text) <= maxCaption {
		return text
	}
	used, cut := 0, 0
	for i, r := range text {
		n := utf16.RuneLen(r)
		if used+n > maxCaption-1 {
			cut = i
			break
		}
		used += n
	}
	return text[:cut] + "…"
}

// ForwardCaption builds the 2.x caption: the source text, a blank line and
// "📌 Source: <chat>" linking to the original post (t.me/c/<id>/<message>),
// or the chat name in bold when there is no message to link. The source text
// is shortened when needed so Telegram does not refuse the caption.
func ForwardCaption(text, groupName, groupID string, messageID int) (string, []tg.MessageEntityClass) {
	if groupName == "" {
		groupName = groupID
	}
	label := "📌 Source: "
	name := []rune(groupName)
	if limit := maxCaption / 4; len(name) > limit {
		name = name[:limit]
	}
	trailer := label + string(name)
	room := maxCaption - utf16Len(trailer) - 2
	if text != "" && utf16Len(text) > room {
		used, cut := 0, 0
		for i, r := range text {
			if used+utf16.RuneLen(r)+1 > room {
				cut = i
				break
			}
			used += utf16.RuneLen(r)
		}
		text = text[:cut] + "…"
	}
	prefix := label
	if text != "" {
		prefix = text + "\n\n" + label
	}
	offset, length := utf16Len(prefix), utf16Len(string(name))
	var entity tg.MessageEntityClass = &tg.MessageEntityBold{Offset: offset, Length: length}
	if id := linkChannelID(groupID); messageID > 0 && id != "" {
		entity = &tg.MessageEntityTextURL{Offset: offset, Length: length, URL: "https://t.me/c/" + id + "/" + strconv.Itoa(messageID)}
	}
	if length == 0 {
		return prefix, nil
	}
	return prefix + string(name), []tg.MessageEntityClass{entity}
}

// linkChannelID is the bare channel ID of a marked "-100…" chat ID; other IDs
// keep 2.x's plain "-100" prefix strip.
func linkChannelID(groupID string) string {
	if id, err := strconv.ParseInt(groupID, 10, 64); err == nil && id < -1000000000000 {
		return strconv.FormatInt(-1000000000000-id, 10)
	}
	return strings.TrimPrefix(groupID, "-100")
}

func utf16Len(s string) int { return len(utf16.Encode([]rune(s))) }
