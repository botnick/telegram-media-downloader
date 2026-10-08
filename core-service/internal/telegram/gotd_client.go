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
	if cfg.EncryptedSessionPath != "" {
		if cfg.SessionSecret == "" {
			return nil, errors.New("Telegram session secret is required for encrypted sessions")
		}
		if err := ensureConvertedSession(cfg); err != nil {
			return nil, err
		}
	}
	return &GotdClient{client: gotd.NewClient(cfg.AppID, cfg.AppHash, gotd.Options{
		SessionStorage: &session.FileStorage{Path: cfg.SessionPath},
	})}, nil
}

func ensureConvertedSession(cfg GotdConfig) error {
	if info, err := os.Stat(cfg.SessionPath); err == nil && info.Size() > 0 {
		loader := &session.Loader{Storage: &session.FileStorage{Path: cfg.SessionPath}}
		if _, loadErr := loader.Load(context.Background()); loadErr == nil {
			return nil
		}
	} else if err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("inspect gotd session: %w", err)
	}
	data, err := sessionconv.LoadEncrypted(cfg.EncryptedSessionPath, cfg.SessionSecret)
	if err != nil {
		return fmt.Errorf("convert gramJS session: %w", err)
	}
	if err := sessionconv.WriteGotd(context.Background(), cfg.SessionPath, data); err != nil {
		return err
	}
	return nil
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
