package telegram

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/gotd/td/session"
	gotd "github.com/gotd/td/telegram"
	"github.com/gotd/td/tg"
)

type GotdConfig struct {
	AppID       int
	AppHash     string
	SessionPath string
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
	return &GotdClient{client: gotd.NewClient(cfg.AppID, cfg.AppHash, gotd.Options{
		SessionStorage: &session.FileStorage{Path: cfg.SessionPath},
	})}, nil
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
