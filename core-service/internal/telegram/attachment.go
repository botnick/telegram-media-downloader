package telegram

import (
	"context"
	"errors"
	"fmt"
	"io"
	"mime"
	"strconv"
	"strings"

	"github.com/gotd/td/telegram/downloader"
	"github.com/gotd/td/tg"
)

// Attachment is derived directly from fresh MTProto message metadata. Access
// hashes and file references are account credentials and must not reach clients.
type Attachment struct {
	Identity   MediaIdentity
	GroupID    string
	MessageID  int64
	Name, Type string
	DC         int
	Location   tg.InputFileLocationClass
}

var ErrNoMedia = errors.New("Telegram message has no downloadable photo or document")

func MessageAttachment(message *tg.Message) (Attachment, error) {
	if message == nil || message.ID <= 0 {
		return Attachment{}, ErrNoMedia
	}
	a := Attachment{MessageID: int64(message.ID)}
	switch peer := message.PeerID.(type) {
	case *tg.PeerChannel:
		a.GroupID = strconv.FormatInt(-1000000000000-peer.ChannelID, 10)
	case *tg.PeerChat:
		a.GroupID = strconv.FormatInt(-peer.ChatID, 10)
	case *tg.PeerUser:
		a.GroupID = strconv.FormatInt(peer.UserID, 10)
	default:
		return Attachment{}, ErrNoMedia
	}
	var doc *tg.Document
	var photo *tg.Photo
	switch media := message.Media.(type) {
	case *tg.MessageMediaDocument:
		doc, _ = media.Document.(*tg.Document)
	case *tg.MessageMediaPhoto:
		photo, _ = media.Photo.(*tg.Photo)
	case *tg.MessageMediaWebPage:
		if page, ok := media.Webpage.(*tg.WebPage); ok {
			doc, _ = page.Document.(*tg.Document)
			photo, _ = page.Photo.(*tg.Photo)
		}
	}
	if doc != nil {
		a.Identity = MediaIdentity{Kind: "document", ID: strconv.FormatInt(doc.ID, 10), Size: doc.Size}
		a.DC = doc.DCID
		a.Location = doc.AsInputDocumentFileLocation()
		a.Type = "document"
		if strings.HasPrefix(doc.MimeType, "video/") {
			a.Type = "video"
		} else if strings.HasPrefix(doc.MimeType, "audio/") {
			a.Type = "audio"
		}
		animated, sticker := false, false
		for _, attr := range doc.Attributes {
			switch v := attr.(type) {
			case *tg.DocumentAttributeFilename:
				a.Name = v.FileName
			case *tg.DocumentAttributeVideo:
				a.Type = "video"
			case *tg.DocumentAttributeAudio:
				a.Type = "audio"
			case *tg.DocumentAttributeAnimated:
				animated = true
			case *tg.DocumentAttributeSticker:
				sticker = true
			}
		}
		if animated {
			a.Type = "gif"
		}
		if sticker {
			a.Type = "sticker"
		}
		if a.Name == "" {
			ext := ".bin"
			if list, _ := mime.ExtensionsByType(doc.MimeType); len(list) > 0 {
				ext = list[0]
			}
			a.Name = "document_" + a.Identity.ID + ext
		}
	} else if photo != nil {
		var size int64
		var variant string
		for _, s := range photo.Sizes {
			var n int64
			var name string
			switch v := s.(type) {
			case *tg.PhotoSize:
				n = int64(v.Size)
				name = v.Type
			case *tg.PhotoSizeProgressive:
				for _, bytes := range v.Sizes {
					if int64(bytes) > n {
						n = int64(bytes)
					}
				}
				name = v.Type
			}
			if n > size {
				size = n
				variant = name
			}
		}
		if size <= 0 || variant == "" {
			return Attachment{}, ErrNoMedia
		}
		a.Identity = MediaIdentity{Kind: "photo", ID: strconv.FormatInt(photo.ID, 10), Size: size}
		a.Name = "photo_" + a.Identity.ID + ".jpg"
		a.Type = "photo"
		a.DC = photo.DCID
		a.Location = &tg.InputPhotoFileLocation{ID: photo.ID, AccessHash: photo.AccessHash, FileReference: photo.FileReference, ThumbSize: variant}
	} else {
		return Attachment{}, ErrNoMedia
	}
	if !a.Identity.Valid() || a.DC <= 0 {
		return Attachment{}, fmt.Errorf("invalid Telegram media metadata")
	}
	return a, nil
}

type MediaDownloader interface {
	DownloadMedia(context.Context, Attachment, io.Writer) error
}

// AttachmentClient binds one fresh file reference to its stable identity.
// Library dedup decides whether this transport is needed at all.
type AttachmentClient struct {
	Source MediaDownloader
	Media  Attachment
}

func (c AttachmentClient) Download(ctx context.Context, id MediaIdentity, w io.Writer) error {
	if c.Source == nil {
		return errors.New("Telegram media transport unavailable")
	}
	if id.Key() != c.Media.Identity.Key() {
		return errors.New("Telegram attachment identity mismatch")
	}
	return c.Source.DownloadMedia(ctx, c.Media, w)
}

func (c *GotdClient) DownloadMedia(ctx context.Context, a Attachment, w io.Writer) error {
	if c == nil || c.client == nil || a.Location == nil || a.DC <= 0 {
		return errors.New("invalid Telegram download request")
	}
	pool, err := c.client.DC(ctx, a.DC, 1)
	if err != nil {
		return err
	}
	defer pool.Close()
	_, err = downloader.NewDownloader().Download(tg.NewClient(pool), a.Location).WithVerify(true).Stream(ctx, w)
	return err
}
