package engine

import (
	"context"
	"errors"
	"fmt"
	"io"
	"sort"
	"time"

	"github.com/botnick/telegram-media-downloader/core-service/internal/telegram"
)

// Retain only the last successful listing in this authenticated run. Photo
// requests reuse its account-bound peers instead of enumerating every chat.
func (s *DialogSession) rememberDialogPhotos(candidates []RecoveryDialog) {
	photos := make(map[string][]RecoveryDialog)
	seen := make(map[string]map[string]bool)
	for _, candidate := range candidates {
		id := candidate.Dialog.ID
		if seen[id] == nil {
			seen[id] = make(map[string]bool)
		}
		if seen[id][candidate.AccountID] {
			continue
		}
		seen[id][candidate.AccountID] = true
		photos[id] = append(photos[id], candidate)
	}
	for id := range photos {
		sort.SliceStable(photos[id], func(i, j int) bool { return photos[id][i].AccountID < photos[id][j].AccountID })
	}
	s.run.mu.Lock()
	s.run.dialogPhotos = photos
	s.run.mu.Unlock()
}

// Context also binds cache publication to the account connection lifetime.
func (s *DialogSession) Context() context.Context { return s.ctx }

func (s *DialogSession) DownloadPhoto(id string, w io.Writer) (bool, error) {
	if err := s.Err(); err != nil {
		return false, err
	}
	s.run.mu.Lock()
	candidates := s.run.dialogPhotos[id]
	s.run.mu.Unlock()
	for _, candidate := range candidates {
		if state := candidate.Dialog.Access.State; state != "" && state != "ok" {
			continue
		}
		source, ok := s.run.accounts[candidate.AccountID].(interface {
			DownloadDialogPhoto(context.Context, telegram.Dialog, io.Writer) (bool, error)
		})
		if !ok {
			return false, fmt.Errorf("account %s cannot download profile photos", candidate.AccountID)
		}
		ctx, cancel := context.WithTimeout(s.ctx, 30*time.Second)
		hasPhoto, err := source.DownloadDialogPhoto(ctx, candidate.Dialog, w)
		if err == nil {
			err = ctx.Err()
		}
		cancel()
		if err == nil {
			err = s.Err()
		}
		return hasPhoto && err == nil, err
	}
	return false, errors.New("chat has no readable dialog in this account connection")
}
