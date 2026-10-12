package engine

import (
	"context"
	"errors"

	"github.com/botnick/telegram-media-downloader/core-service/internal/telegram"
)

type fileSender interface {
	SendFile(context.Context, telegram.SendFileRequest) (int, error)
}

// Observing reports whether the monitor is running live (not only connected
// for manual jobs). 2.x auto-forwarded only while its runtime was running.
func (c *Controller) Observing() bool {
	run, err := c.queueRun()
	return err == nil && run.observing.Load()
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
