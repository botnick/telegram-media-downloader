package telegram

import (
	"context"
	"time"

	gotdauth "github.com/gotd/td/telegram/auth"
	"github.com/gotd/td/telegram/auth/qrlogin"
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
	// QR signs in by a login token that another logged-in Telegram app
	// scans. show is called with each token URL (tg://login?token=…) and
	// its expiry, again whenever Telegram issues a fresh one. When the
	// account has a cloud password the error is SESSION_PASSWORD_NEEDED and
	// Password finishes the sign-in.
	QR(ctx context.Context, show func(url string, expires time.Time) error) (*tg.AuthAuthorization, error)
}
type loginClient struct {
	*GotdClient
	loggedIn qrlogin.LoggedIn
}
type loginRPC struct {
	*gotdauth.Client
	api      *tg.Client
	qr       qrlogin.QR
	loggedIn qrlogin.LoggedIn
}

func NewLoginClient(cfg GotdConfig) (LoginClient, error) {
	// Telegram announces an accepted QR token with updateLoginToken; the
	// login connection needs a dispatcher for that one update.
	dispatcher := tg.NewUpdateDispatcher()
	loggedIn := qrlogin.OnLoginToken(dispatcher)
	cfg.UpdateHandler = dispatcher
	client, err := NewGotdClient(cfg)
	if err != nil {
		return nil, err
	}
	return &loginClient{GotdClient: client, loggedIn: loggedIn}, nil
}
func (c *loginClient) Run(ctx context.Context, fn func(context.Context, LoginRPC) error) error {
	return c.GotdClient.Run(ctx, func(ctx context.Context) error {
		return fn(ctx, loginRPC{Client: c.client.Auth(), api: c.API(), qr: c.client.QR(), loggedIn: c.loggedIn})
	})
}
func (c loginRPC) QR(ctx context.Context, show func(string, time.Time) error) (*tg.AuthAuthorization, error) {
	return c.qr.Auth(ctx, c.loggedIn, func(_ context.Context, token qrlogin.Token) error {
		return show(token.URL(), token.Expires())
	})
}
func (c loginRPC) PasswordHint(ctx context.Context) (string, error) {
	p, err := c.api.AccountGetPassword(ctx)
	if err != nil {
		return "", err
	}
	return p.Hint, nil
}
