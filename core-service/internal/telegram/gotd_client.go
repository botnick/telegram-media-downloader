package telegram

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	sessionconv "github.com/botnick/telegram-media-downloader/core-service/internal/session"
	"github.com/gotd/td/session"
	gotd "github.com/gotd/td/telegram"
	"github.com/gotd/td/tg"
)

type GotdConfig struct {
	AppID       int
	AppHash     string
	SessionPath string
	// EncryptedSessionPath points at the existing gramJS .enc file. When set,
	// the file is converted once into SessionPath without being rewritten.
	EncryptedSessionPath string
	SessionSecret        string
	UpdateHandler        gotd.UpdateHandler
}

// GotdClient owns one Telegram account connection. Run is the only method
// that starts network I/O; constructing it validates config and never dials.
type GotdClient struct {
	client *gotd.Client
}

func NewGotdClient(cfg GotdConfig) (*GotdClient, error) {
	if cfg.AppID <= 0 {
		return nil, errors.New("telegram app id must be positive")
	}
	if cfg.AppHash == "" {
		return nil, errors.New("telegram app hash is required")
	}
	if cfg.SessionPath == "" {
		return nil, errors.New("telegram session path is required")
	}
	if err := os.MkdirAll(filepath.Dir(cfg.SessionPath), 0o700); err != nil {
		return nil, fmt.Errorf("create Telegram session directory: %w", err)
	}
	storage, err := sessionconv.NewEncryptedStorage(cfg.SessionPath, cfg.SessionSecret)
	if err != nil {
		return nil, err
	}
	if err := ensureConvertedSession(cfg, storage); err != nil {
		return nil, err
	}
	return &GotdClient{client: gotd.NewClient(cfg.AppID, cfg.AppHash, gotd.Options{SessionStorage: storage, UpdateHandler: cfg.UpdateHandler})}, nil
}

func ensureConvertedSession(cfg GotdConfig, storage session.Storage) error {
	if info, err := os.Lstat(cfg.SessionPath); err == nil {
		if !info.Mode().IsRegular() || info.Size() == 0 {
			return errors.New("invalid native Telegram session file")
		}
		loader := &session.Loader{Storage: storage}
		if _, err := loader.Load(context.Background()); err != nil {
			return fmt.Errorf("load native Telegram session: %w", err)
		}
		return nil
	} else if !os.IsNotExist(err) {
		return fmt.Errorf("inspect native Telegram session: %w", err)
	}
	if cfg.EncryptedSessionPath == "" {
		return nil
	}
	data, err := sessionconv.LoadEncrypted(cfg.EncryptedSessionPath, cfg.SessionSecret)
	if err != nil {
		return fmt.Errorf("import Telegram session: %w", err)
	}
	// Mark the one legacy source that can otherwise be confused with a
	// separately named native account. The marker contains no credential data.
	if filepath.Base(cfg.EncryptedSessionPath) == "session.enc" {
		marker := cfg.SessionPath + ".imported"
		file, markerErr := os.OpenFile(marker, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if markerErr == nil {
			if _, markerErr = file.WriteString("legacy\n"); markerErr == nil {
				markerErr = file.Sync()
			}
			_ = file.Close()
		} else if !os.IsExist(markerErr) {
			return fmt.Errorf("mark imported Telegram session: %w", markerErr)
		} else {
			markerErr = nil
		}
		if markerErr != nil {
			return fmt.Errorf("mark imported Telegram session: %w", markerErr)
		}
	}
	return sessionconv.WriteGotd(context.Background(), cfg.SessionPath, cfg.SessionSecret, data)
}

func (c *GotdClient) Run(ctx context.Context, ready func(context.Context) error) error {
	if c == nil || c.client == nil {
		return errors.New("Telegram client is not configured")
	}
	return c.client.Run(ctx, ready)
}

func (c *GotdClient) API() *tg.Client {
	if c == nil || c.client == nil {
		return nil
	}
	return c.client.API()
}
