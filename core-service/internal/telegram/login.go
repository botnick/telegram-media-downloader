package telegram

import (
	"context"

	gotdauth "github.com/gotd/td/telegram/auth"
	"github.com/gotd/td/tg"
)

// LoginClient owns a fresh key until Run has completely returned. Only then
// may the wizard publish that session for an account connection to acquire.
type LoginClient interface {
	Run(context.Context, func(context.Context, LoginRPC) error) error
}
type LoginFactory func(GotdConfig) (LoginClient, error)
type LoginRPC interface {
	SendCode(context.Context, string, gotdauth.SendCodeOptions) (tg.AuthSentCodeClass, error)
	SignIn(context.Context, string, string, string) (*tg.AuthAuthorization, error)
	Password(context.Context, string) (*tg.AuthAuthorization, error)
	PasswordHint(context.Context) (string, error)
}
type loginClient struct{ *GotdClient }
type loginRPC struct {
	*gotdauth.Client
	api *tg.Client
}

func NewLoginClient(cfg GotdConfig) (LoginClient, error) {
	client, err := NewGotdClient(cfg)
	if err != nil {
		return nil, err
	}
	return &loginClient{client}, nil
}
func (c *loginClient) Run(ctx context.Context, fn func(context.Context, LoginRPC) error) error {
	return c.GotdClient.Run(ctx, func(ctx context.Context) error { return fn(ctx, loginRPC{Client: c.client.Auth(), api: c.API()}) })
}
func (c loginRPC) PasswordHint(ctx context.Context) (string, error) {
	p, err := c.api.AccountGetPassword(ctx)
	if err != nil {
		return "", err
	}
	return p.Hint, nil
}
