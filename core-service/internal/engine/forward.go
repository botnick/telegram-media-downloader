package engine

import (
	"context"
	"errors"
	"io"

	"github.com/botnick/telegram-media-downloader/core-service/internal/telegram"
	"github.com/gotd/td/tg"
)

type fileSender interface {
	SendFile(context.Context, telegram.SendFileRequest) (int, error)
}
type messageForwarder interface {
	ForwardMessage(context.Context, telegram.ForwardMessageRequest) (int, error)
}
type mediaMessageAccount interface {
	telegram.MediaDownloader
	RefreshMessage(context.Context, *tg.Message) (*telegram.RefreshedMessage, error)
}

func (c *Controller) DownloadMessage(ctx context.Context, accountID string, message *tg.Message, identity telegram.MediaIdentity, w io.Writer) error {
	run, err := c.queueRun()
	if err != nil {
		return err
	}
	if run.accounts[accountID] == nil {
		if len(run.ids) == 0 {
			return ErrEngineNotRunning
		}
		accountID = run.ids[0]
	}
	account, ok := run.accounts[accountID].(mediaMessageAccount)
	if !ok {
		return errors.New("account cannot download source media")
	}
	run.jobUsers.Add(1)
	defer run.jobUsers.Add(-1)
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	if run.ctx != nil {
		defer context.AfterFunc(run.ctx, cancel)()
	}
	fresh, err := account.RefreshMessage(ctx, message)
	if err != nil {
		return err
	}
	attachment, err := telegram.MessageAttachment(fresh.Message)
	if err != nil {
		return err
	}
	if attachment.Identity.Key() != identity.Key() {
		return errors.New("source media changed before fallback download")
	}
	return account.DownloadMedia(ctx, attachment, w)
}

// Observing reports whether the monitor is running live (not only connected
// for manual jobs). 2.x auto-forwarded only while its runtime was running.
func (c *Controller) Observing() bool {
	run, err := c.queueRun()
	return err == nil && run.observing.Load()
}

func (c *Controller) ForwardMessage(ctx context.Context, accountID string, req telegram.ForwardMessageRequest) (string, int, error) {
	run, err := c.queueRun()
	if err != nil {
		return "", 0, err
	}
	if run.accounts[accountID] == nil {
		if len(run.ids) == 0 {
			return "", 0, ErrEngineNotRunning
		}
		accountID = run.ids[0]
	}
	forwarder, ok := run.accounts[accountID].(messageForwarder)
	if !ok {
		return accountID, 0, errors.New("account cannot forward messages")
	}
	run.jobUsers.Add(1)
	defer run.jobUsers.Add(-1)
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	if run.ctx != nil {
		defer context.AfterFunc(run.ctx, cancel)()
	}
	id, err := forwarder.ForwardMessage(ctx, req)
	return accountID, id, err
}

// SendFile uploads through the requested account, or the first loaded
// account when it is empty or not loaded (2.x's getClient fallback). It
// returns the account used and the new message ID. The upload ends with the
// account's run.
func (c *Controller) SendFile(ctx context.Context, accountID string, req telegram.SendFileRequest) (string, int, error) {
	run, err := c.queueRun()
	if err != nil {
		return "", 0, err
	}
	if run.accounts[accountID] == nil {
		if len(run.ids) == 0 {
			return "", 0, ErrEngineNotRunning
		}
		accountID = run.ids[0]
	}
	sender, ok := run.accounts[accountID].(fileSender)
	if !ok {
		return accountID, 0, errors.New("account cannot upload files")
	}
	run.jobUsers.Add(1)
	defer run.jobUsers.Add(-1)
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	if run.ctx != nil {
		defer context.AfterFunc(run.ctx, cancel)()
	}
	id, err := sender.SendFile(ctx, req)
	return accountID, id, err
}
