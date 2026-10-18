package telegram

import (
	"context"
	"errors"
	"fmt"
	"io"
	"mime"
	"net"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/gotd/td/bin"
	gotd "github.com/gotd/td/telegram"
	"github.com/gotd/td/telegram/downloader"
	"github.com/gotd/td/tg"
	"github.com/gotd/td/tgerr"
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
		a.Location = doc.AsInputDocumentFileLocation("")
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
	// Per-chunk verification is opt-in (TGDL_VERIFY_CHUNKS=1): it makes the
	// library request 128 KiB hash-sized parts instead of 1 MiB ones, and
	// Telegram rate-limits download requests by count, so it cut throughput
	// about eightfold. MTProto already authenticates every response.
	//
	// When enabled: Telegram keeps no chunk hashes for some files and can
	// refuse them in the middle of a transfer. Remember such a file so its
	// next attempt streams without per-chunk verification. The refusal is a
	// property of the chat (seen on whole channels), so the chat is remembered
	// too and its later files skip the wasted first try.
	key, chat := a.Identity.Key(), "chat:"+a.GroupID
	_, plainFile := c.unverified.Load(key)
	_, plainChat := c.unverified.Load(chat)
	verify := verifyChunks && !plainFile && !plainChat
	tuned := c.threads != nil && c.guard != nil && !verify && a.Identity.Size > downloadPartSize
	// Several parts of one file at once; a FLOOD_WAIT meanwhile halves the
	// account's threads for its next files.
	threads, floods := 1, uint64(0)
	if tuned {
		threads, floods = c.threads.threads(), c.guard.floods.Load()
	}
	err := downloadMedia(ctx, guardedClient{c.client, c}, a, w, verify, threads)
	if tuned {
		if flooded := c.guard.floods.Load() != floods; flooded || err == nil {
			c.threads.record(flooded)
		}
	}
	if err != nil && hashesUnavailable(err) {
		c.unverified.Store(key, struct{}{})
		if a.GroupID != "" {
			c.unverified.Store(chat, struct{}{})
		}
	}
	return err
}

// guardedClient serves downloads from long-lived connection pools, one per
// datacenter and shared by every worker of the account, behind the account's
// flood guard. Opening a pool per file meant a new MTProto connection (and,
// for other datacenters, a new authorization export) for every download and
// let pools tear each other's requests down ("engine forcibly closed").
type guardedClient struct {
	*gotd.Client
	owner *GotdClient
}

// Connections a datacenter pool may open; each carries one request at a time.
const downloadPoolConnections = 12

func (c guardedClient) Pool(int64) (gotd.CloseInvoker, error) {
	return c.owner.sharedPool(0, func() (gotd.CloseInvoker, error) { return c.Client.Pool(downloadPoolConnections) })
}

func (c guardedClient) DC(ctx context.Context, dc int, _ int64) (gotd.CloseInvoker, error) {
	return c.owner.sharedPool(dc, func() (gotd.CloseInvoker, error) { return c.Client.DC(ctx, dc, downloadPoolConnections) })
}

func (c *GotdClient) sharedPool(dc int, open func() (gotd.CloseInvoker, error)) (gotd.CloseInvoker, error) {
	c.poolMu.Lock()
	defer c.poolMu.Unlock()
	if pool := c.pools[dc]; pool != nil {
		return sharedInvoker{pool, c.guard}, nil
	}
	pool, err := open()
	if err != nil {
		return nil, err
	}
	if c.pools == nil {
		c.pools = map[int]gotd.CloseInvoker{}
	}
	c.pools[dc] = pool
	return sharedInvoker{pool, c.guard}, nil
}

// sharedInvoker is one download's view of a shared pool: guarded, and Close
// leaves the pool open for the other downloads.
type sharedInvoker struct {
	pool  gotd.CloseInvoker
	guard *floodGuard
}

func (i sharedInvoker) Invoke(ctx context.Context, input bin.Encoder, output bin.Decoder) error {
	if i.guard == nil {
		return i.pool.Invoke(ctx, input, output)
	}
	err := i.guard.invoke(ctx, i.pool, input, output)
	// Telegram drops download connections under load, failing every request
	// in flight on them. Reads are idempotent: ask again on another pooled
	// connection instead of failing the whole file.
	err = retryLostConnection(ctx, err, func() error { return i.guard.invoke(ctx, i.pool, input, output) })
	// A wait short enough to sleep through that is still refused after every
	// inline retry is Telegram refusing this file, not the account: the
	// library would retry it forever, closing the account's gate each time
	// and starving every other download. Fail the attempt instead.
	if d, flood := tgerr.AsFloodWait(err); flood && d <= floodSleepThreshold {
		return fmt.Errorf("Telegram kept refusing this file after %d waits (FLOOD_WAIT_%d)", floodInlineRetries+1, int(d.Seconds()))
	}
	return err
}

func (sharedInvoker) Close() error { return nil }

var (
	connectionRetries    = 6
	connectionRetryDelay = 250 * time.Millisecond
)

// retryLostConnection repeats an idempotent request whose previous try (err)
// died with its connection, backing off while the connection is replaced.
func retryLostConnection(ctx context.Context, err error, again func() error) error {
	for try := 0; try < connectionRetries && connectionLost(err) && ctx.Err() == nil; try++ {
		timer := time.NewTimer(connectionRetryDelay << min(try, 5))
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-timer.C:
		}
		err = again()
	}
	return err
}

// connectionLost reports a request that died with its connection rather than
// being answered by Telegram.
func connectionLost(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) || errors.Is(err, net.ErrClosed) {
		return true
	}
	text := err.Error()
	for _, mark := range []string{"engine forcibly closed", "engine was closed", "connection dead", "broken pipe", "connection reset"} {
		if strings.Contains(text, mark) {
			return true
		}
	}
	return false
}

const downloadPartSize = 1024 * 1024

// verifyChunks turns on per-chunk hash verification (see DownloadMedia).
var verifyChunks = os.Getenv("TGDL_VERIFY_CHUNKS") == "1"

type downloadClient interface {
	Config() tg.Config
	Pool(int64) (gotd.CloseInvoker, error)
	DC(context.Context, int, int64) (gotd.CloseInvoker, error)
}

// downloadMedia writes the attachment to w. Without per-chunk verification, a
// file of more than one part is fetched with up to threads parts in flight.
func downloadMedia(ctx context.Context, client downloadClient, a Attachment, w io.Writer, verify bool, threads int) error {
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
	if !verify && threads > 1 && a.Identity.Size > downloadPartSize {
		return fetchParallel(ctx, tg.NewClient(pool), a.Location, a.Identity.Size, threads, w)
	}
	if !verify {
		_, err = downloader.NewDownloader().WithPartSize(downloadPartSize).Download(tg.NewClient(pool), a.Location).Stream(ctx, w)
		return err
	}
	// When the refusal comes before any byte was written, fall back at once;
	// otherwise the caller's retry uses the unverified path from the start.
	counted := &countingWriter{w: w}
	_, err = downloader.NewDownloader().WithPartSize(downloadPartSize).Download(tg.NewClient(pool), a.Location).WithVerify(true).Stream(ctx, counted)
	if err != nil && counted.n == 0 && hashesUnavailable(err) && ctx.Err() == nil {
		_, err = downloader.NewDownloader().WithPartSize(downloadPartSize).Download(tg.NewClient(pool), a.Location).Stream(ctx, w)
	}
	return err
}

type countingWriter struct {
	w io.Writer
	n int64
}

func (c *countingWriter) Write(p []byte) (int, error) {
	n, err := c.w.Write(p)
	c.n += int64(n)
	return n, err
}

func hashesUnavailable(err error) bool {
	return tgerr.Is(err, "VOLUME_LOC_NOT_FOUND") && strings.Contains(err.Error(), "get hashes")
}
