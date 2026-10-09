package telegram

import (
	"context"
	"errors"
	"fmt"
	"io"
	"mime"
	"strconv"
	"strings"

	gotd "github.com/gotd/td/telegram"
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
	Voice      bool
	DC         int
	Location   tg.InputFileLocationClass
	Facts      MediaFacts
}

// MediaFacts are the descriptive metadata Telegram sends with media. None of
// it is a credential. A re-uploaded file gets a new identity, so these facts
// (and the tiny stripped thumbnail) are what can still show a likely duplicate.
type MediaFacts struct {
	Mime       string `json:"mime,omitempty"`
	Width      int    `json:"width,omitempty"`
	Height     int    `json:"height,omitempty"`
	DurationMs int64  `json:"durationMs,omitempty"`
	// Origin is the forwarded or saved-from source: "<peer id>:<message id>",
	// or "<peer id>" when Telegram names no message.
	Origin string `json:"origin,omitempty"`
	Thumb  []byte `json:"thumb,omitempty"` // stripped JPEG thumbnail, a few hundred bytes
}

func forwardOrigin(header tg.MessageFwdHeader, ok bool) string {
	if !ok {
		return ""
	}
	peer, post := header.FromID, header.ChannelPost
	if peer == nil {
		peer, post = header.SavedFromPeer, header.SavedFromMsgID
	}
	id := ""
	switch p := peer.(type) {
	case *tg.PeerChannel:
		id = strconv.FormatInt(-1000000000000-p.ChannelID, 10)
	case *tg.PeerChat:
		id = strconv.FormatInt(-p.ChatID, 10)
	case *tg.PeerUser:
		id = strconv.FormatInt(p.UserID, 10)
	default:
		return ""
	}
	if post > 0 {
		return id + ":" + strconv.Itoa(post)
	}
	return id
}

func strippedThumb(sizes []tg.PhotoSizeClass) []byte {
	for _, size := range sizes {
		if v, ok := size.(*tg.PhotoStrippedSize); ok && len(v.Bytes) > 0 && len(v.Bytes) <= 4096 {
			return append([]byte(nil), v.Bytes...)
		}
	}
	return nil
}

var ErrNoMedia = errors.New("Telegram message has no downloadable photo or document")

// FilterKey uses the public settings names. A voice message remains audio in
// the library but has its own subscription switch; wire identity is unchanged.
func (a Attachment) FilterKey() string {
	switch a.Type {
	case "photo":
		return "photos"
	case "video":
		return "videos"
	case "audio":
		if a.Voice {
			return "voice"
		}
		return "audio"
	case "gif":
		return "gifs"
	case "sticker":
		return "stickers"
	default:
		return "files"
	}
}

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
		mediaType := strings.ToLower(strings.TrimSpace(strings.SplitN(doc.MimeType, ";", 2)[0]))
		switch {
		case mediaType == "image/gif":
			a.Type = "gif"
		case mediaType == "application/x-tgsticker":
			a.Type = "sticker"
		case strings.HasPrefix(mediaType, "image/"):
			a.Type = "photo"
		case strings.HasPrefix(mediaType, "video/"):
			a.Type = "video"
		case strings.HasPrefix(mediaType, "audio/"):
			a.Type = "audio"
		}
		a.Facts.Mime = mediaType
		a.Facts.Thumb = strippedThumb(doc.Thumbs)
		animated, sticker, video, audio, voice := false, false, false, false, false
		for _, attr := range doc.Attributes {
			switch v := attr.(type) {
			case *tg.DocumentAttributeFilename:
				a.Name = v.FileName
			case *tg.DocumentAttributeImageSize:
				a.Facts.Width, a.Facts.Height = v.W, v.H
			case *tg.DocumentAttributeVideo:
				video = true
				a.Facts.Width, a.Facts.Height = v.W, v.H
				a.Facts.DurationMs = int64(v.Duration * 1000)
			case *tg.DocumentAttributeAudio:
				audio = true
				voice = voice || v.Voice
				if a.Facts.DurationMs == 0 {
					a.Facts.DurationMs = int64(v.Duration) * 1000
				}
			case *tg.DocumentAttributeAnimated:
				animated = true
			case *tg.DocumentAttributeSticker:
				sticker = true
			}
		}
		// Attribute order must not change the policy. Video stickers and GIFs
		// keep their dedicated switch even though their underlying file is video.
		switch {
		case sticker || a.Type == "sticker":
			a.Type = "sticker"
		case animated || a.Type == "gif":
			a.Type = "gif"
		case voice:
			a.Type, a.Voice = "audio", true
		case video:
			a.Type = "video"
		case audio:
			a.Type = "audio"
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
		var width, height int
		for _, s := range photo.Sizes {
			var n int64
			var name string
			var w, h int
			switch v := s.(type) {
			case *tg.PhotoSize:
				n = int64(v.Size)
				name, w, h = v.Type, v.W, v.H
			case *tg.PhotoSizeProgressive:
				for _, bytes := range v.Sizes {
					if int64(bytes) > n {
						n = int64(bytes)
					}
				}
				name, w, h = v.Type, v.W, v.H
			}
			if n > size {
				size = n
				variant = name
				width, height = w, h
			}
		}
		if size <= 0 || variant == "" {
			return Attachment{}, ErrNoMedia
		}
		a.Identity = MediaIdentity{Kind: "photo", ID: strconv.FormatInt(photo.ID, 10), Size: size}
		a.Name = "photo_" + a.Identity.ID + ".jpg"
		a.Type = "photo"
		a.Facts = MediaFacts{Mime: "image/jpeg", Width: width, Height: height, Thumb: strippedThumb(photo.Sizes)}
		a.DC = photo.DCID
		a.Location = &tg.InputPhotoFileLocation{ID: photo.ID, AccessHash: photo.AccessHash, FileReference: photo.FileReference, ThumbSize: variant}
	} else {
		return Attachment{}, ErrNoMedia
	}
	if !a.Identity.Valid() || a.DC <= 0 {
		return Attachment{}, fmt.Errorf("invalid Telegram media metadata")
	}
	if a.Facts.DurationMs < 0 {
		a.Facts.DurationMs = 0
	}
	a.Facts.Origin = forwardOrigin(message.GetFwdFrom())
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
	return downloadMedia(ctx, c.client, a, w)
}

type downloadClient interface {
	Config() tg.Config
	Pool(int64) (gotd.CloseInvoker, error)
	DC(context.Context, int, int64) (gotd.CloseInvoker, error)
}

func downloadMedia(ctx context.Context, client downloadClient, a Attachment, w io.Writer) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	var pool gotd.CloseInvoker
	var err error
	if a.DC == client.Config().ThisDC {
		// DC() transfers authorization to another datacenter. Exporting it
		// back to the current one is rejected with DC_ID_INVALID; Pool()
		// reuses the authenticated primary session for this case.
		pool, err = client.Pool(1)
	} else {
		pool, err = client.DC(ctx, a.DC, 1)
	}
	if err != nil {
		return err
	}
	defer pool.Close()
	_, err = downloader.NewDownloader().Download(tg.NewClient(pool), a.Location).WithVerify(true).Stream(ctx, w)
	return err
}
