package backup

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
)

// OAuthApp performs the one-time authorization-code exchange that yields the
// refresh token stored in a Google Drive or Dropbox destination. It replaces
// the released scripts/setup-gdrive.js and scripts/setup-dropbox.js helpers.
// The flow is copy/paste based, so it also works on a headless server: no
// listener is opened and the browser may run on another machine.
type OAuthApp struct {
	Provider               string
	ClientID, ClientSecret string
	verifier               string
	authURL, tokenURL      string
}

const (
	gdriveScope    = "https://www.googleapis.com/auth/drive.file"
	gdriveRedirect = "http://127.0.0.1:53682/"
)

// NewOAuthApp prepares a PKCE (S256) authorization for "gdrive" or "dropbox".
func NewOAuthApp(provider, clientID, clientSecret string) (*OAuthApp, error) {
	clientID, clientSecret = strings.TrimSpace(clientID), strings.TrimSpace(clientSecret)
	if clientID == "" || clientSecret == "" {
		return nil, errors.New("client ID and client secret are required")
	}
	a := &OAuthApp{Provider: provider, ClientID: clientID, ClientSecret: clientSecret}
	switch provider {
	case "gdrive":
		a.authURL, a.tokenURL = "https://accounts.google.com/o/oauth2/v2/auth", defaultGDriveEndpoints.token
	case "dropbox":
		a.authURL, a.tokenURL = "https://www.dropbox.com/oauth2/authorize", defaultDropboxEndpoints.token
	default:
		return nil, fmt.Errorf("unknown OAuth provider %q (use gdrive or dropbox)", provider)
	}
	random := make([]byte, 32)
	if _, err := rand.Read(random); err != nil {
		return nil, err
	}
	a.verifier = base64.RawURLEncoding.EncodeToString(random)
	return a, nil
}

// AuthorizeURL is opened by the operator in any browser.
func (a *OAuthApp) AuthorizeURL() string {
	challenge := sha256.Sum256([]byte(a.verifier))
	q := url.Values{"client_id": {a.ClientID}, "response_type": {"code"}, "code_challenge": {base64.RawURLEncoding.EncodeToString(challenge[:])}, "code_challenge_method": {"S256"}}
	if a.Provider == "gdrive" {
		// Desktop-app clients may redirect to a loopback address. Nothing
		// listens there: the browser shows an error page whose address
		// contains the code, which the operator pastes back.
		q.Set("redirect_uri", gdriveRedirect)
		q.Set("scope", gdriveScope)
		q.Set("access_type", "offline")
		q.Set("prompt", "consent")
	} else {
		// Dropbox displays the code itself when no redirect is registered.
		q.Set("token_access_type", "offline")
	}
	return a.authURL + "?" + q.Encode()
}

// Exchange accepts the pasted code, or the whole redirected address, and
// returns the long-lived refresh token.
func (a *OAuthApp) Exchange(ctx context.Context, pasted string) (string, error) {
	code := strings.TrimSpace(pasted)
	if u, err := url.Parse(code); err == nil && u.Query().Get("code") != "" {
		code = u.Query().Get("code")
	} else if v, err := url.ParseQuery(strings.TrimPrefix(code, "?")); err == nil && v.Get("code") != "" {
		code = v.Get("code")
	}
	if code == "" {
		return "", errors.New("no authorization code was provided")
	}
	form := url.Values{"grant_type": {"authorization_code"}, "code": {code}, "client_id": {a.ClientID}, "client_secret": {a.ClientSecret}, "code_verifier": {a.verifier}}
	if a.Provider == "gdrive" {
		form.Set("redirect_uri", gdriveRedirect)
	}
	service := map[string]string{"gdrive": "Google Drive", "dropbox": "Dropbox"}[a.Provider]
	api := newCloudAPI(service, a.tokenURL, nil, "", func(int, []byte) (string, bool) { return "", false })
	defer api.close()
	body := form.Encode()
	res, err := api.do(ctx, cloudRequest{op: "authorization code exchange", method: http.MethodPost, url: a.tokenURL, noAuth: true, once: true,
		header: http.Header{"Content-Type": {"application/x-www-form-urlencoded"}},
		body:   func() (io.Reader, int64) { return strings.NewReader(body), int64(len(body)) }})
	if err != nil {
		return "", err
	}
	var out struct {
		RefreshToken string `json:"refresh_token"`
	}
	if json.Unmarshal(res.body, &out) != nil || out.RefreshToken == "" {
		if a.Provider == "dropbox" {
			return "", errors.New("Dropbox returned no refresh token; check the app's permissions and authorize again")
		}
		return "", errors.New("Google returned no refresh token; revoke the app's access in your Google account and authorize again")
	}
	return out.RefreshToken, nil
}
