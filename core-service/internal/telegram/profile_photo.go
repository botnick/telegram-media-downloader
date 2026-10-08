package telegram

import (
	"context"
	"errors"
	"io"

	"github.com/gotd/td/tg"
)

type peerPhoto struct {
	ID int64
	DC int
}

func chatPhoto(raw tg.ChatPhotoClass) (*peerPhoto, bool) {
	switch p := raw.(type) {
	case *tg.ChatPhoto:
		return &peerPhoto{ID: p.PhotoID, DC: p.DCID}, true
	case *tg.ChatPhotoEmpty:
		return nil, true
	}
	return nil, false
}

func (a *Account) DownloadDialogPhoto(ctx context.Context, dialog Dialog, w io.Writer) (bool, error) {
	return downloadDialogPhoto(ctx, a, dialog, w)
}

func downloadDialogPhoto(ctx context.Context, source MediaDownloader, dialog Dialog, w io.Writer) (bool, error) {
	if err := ctx.Err(); err != nil {
		return false, err
	}
	if !dialog.photoKnown {
		return false, errors.New("Telegram did not provide profile photo metadata")
	}
	if dialog.photo == nil {
		return false, nil
	}
	if dialog.peer == nil || dialog.photo.ID == 0 || dialog.photo.DC <= 0 {
		return false, errors.New("profile photo has no account-bound peer or data center")
	}
	err := source.DownloadMedia(ctx, Attachment{DC: dialog.photo.DC, Location: &tg.InputPeerPhotoFileLocation{Peer: dialog.peer, PhotoID: dialog.photo.ID}}, w)
	if err == nil {
		err = ctx.Err()
	}
	return err == nil, err
}
