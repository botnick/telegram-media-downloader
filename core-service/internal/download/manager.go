// Package download owns the bounded file handoff from Telegram to the local
// library. Identity reservation happens before network I/O, and publication
// publishes a sibling .part file without overwriting an existing destination.
package download

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"github.com/botnick/telegram-media-downloader/core-service/internal/telegram"
)

var ErrDuplicate = errors.New("telegram media identity is already queued or downloaded")
var ErrInvalidIdentity = errors.New("invalid Telegram media identity")

type Client interface {
	Download(context.Context, telegram.MediaIdentity, io.Writer) error
}

type Manager struct {
	Client Client
	Index  *telegram.DedupIndex
}

func NewManager(client Client, index *telegram.DedupIndex) *Manager {
	if index == nil {
		index = telegram.NewDedupIndex()
	}
	return &Manager{Client: client, Index: index}
}

func (m *Manager) Download(ctx context.Context, identity telegram.MediaIdentity, finalPath string) (string, error) {
	if m == nil || m.Client == nil || m.Index == nil {
		return "", errors.New("download manager is not configured")
	}
	if !identity.Valid() {
		return "", ErrInvalidIdentity
	}
	if err := ctx.Err(); err != nil {
		return "", err
	}
	if !m.Index.Reserve(identity) {
		return "", ErrDuplicate
	}
	return m.DownloadReserved(ctx, identity, finalPath)
}

// DownloadReserved publishes an identity that was reserved by the live
// Telegram monitor before enqueueing. It is the handoff that prevents a live
// update and a history catch-up from both starting network I/O.
func (m *Manager) DownloadReserved(ctx context.Context, identity telegram.MediaIdentity, finalPath string) (string, error) {
	if m == nil || m.Client == nil || m.Index == nil {
		return "", errors.New("download manager is not configured")
	}
	if !identity.Valid() {
		return "", ErrInvalidIdentity
	}
	if !m.Index.Claim(identity) {
		return "", ErrDuplicate
	}
	return m.downloadReserved(ctx, identity, finalPath)
}

func (m *Manager) downloadReserved(ctx context.Context, identity telegram.MediaIdentity, finalPath string) (string, error) {
	committed := false
	defer func() {
		if !committed {
			m.Index.AbortClaim(identity)
		}
	}()
	if err := ctx.Err(); err != nil {
		return "", err
	}
	finalPath = filepath.Clean(finalPath)
	if finalPath == "." || finalPath == string(filepath.Separator) {
		return "", errors.New("invalid final path")
	}
	dir := filepath.Dir(finalPath)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", fmt.Errorf("create media directory: %w", err)
	}
	if _, err := os.Stat(finalPath); err == nil {
		return "", fmt.Errorf("final file already exists: %w", ErrDuplicate)
	} else if !errors.Is(err, os.ErrNotExist) {
		return "", fmt.Errorf("check final file: %w", err)
	}
	tmp, err := os.CreateTemp(dir, ".tgdl-*.part")
	if err != nil {
		return "", fmt.Errorf("create partial file: %w", err)
	}
	tmpPath := tmp.Name()
	defer func() {
		_ = tmp.Close()
		_ = os.Remove(tmpPath)
	}()
	writer := &mediaWriter{ctx: ctx, dst: tmp, remaining: identity.Size}
	if err := m.Client.Download(ctx, identity, writer); err != nil {
		return "", fmt.Errorf("download Telegram media: %w", err)
	}
	if err := ctx.Err(); err != nil {
		return "", err
	}
	if writer.remaining != 0 {
		return "", fmt.Errorf("Telegram media size mismatch: expected %d, received %d", identity.Size, identity.Size-writer.remaining)
	}
	if err := tmp.Sync(); err != nil {
		return "", fmt.Errorf("sync partial file: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return "", fmt.Errorf("close partial file: %w", err)
	}
	if err := ctx.Err(); err != nil {
		return "", err
	}
	// The OS performs an exclusive rename: a competing file must never be
	// replaced, even if it appeared after the initial existence check.
	if err := publishExclusive(tmpPath, finalPath); err != nil {
		if errors.Is(err, os.ErrExist) {
			return "", fmt.Errorf("final file already exists: %w", ErrDuplicate)
		}
		return "", fmt.Errorf("publish media file: %w", err)
	}
	committed = true
	m.Index.Complete(identity)
	return finalPath, nil
}

type mediaWriter struct {
	ctx       context.Context
	dst       io.Writer
	remaining int64
}

func (w *mediaWriter) Write(p []byte) (int, error) {
	if err := w.ctx.Err(); err != nil {
		return 0, err
	}
	if int64(len(p)) > w.remaining {
		return 0, errors.New("Telegram media exceeds declared size")
	}
	n, err := w.dst.Write(p)
	w.remaining -= int64(n)
	return n, err
}
