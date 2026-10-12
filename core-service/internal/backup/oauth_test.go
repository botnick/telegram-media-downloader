package backup

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

func TestOAuthAuthorizationCodeExchangeUsesPKCE(t *testing.T) {
	for _, provider := range []string{"gdrive", "dropbox"} {
		a, err := NewOAuthApp(provider, " client ", "secret")
		if err != nil {
			t.Fatal(err)
		}
		auth, err := url.Parse(a.AuthorizeURL())
		if err != nil {
			t.Fatal(err)
		}
		q := auth.Query()
		sum := sha256.Sum256([]byte(a.verifier))
		if q.Get("client_id") != "client" || q.Get("code_challenge_method") != "S256" || q.Get("code_challenge") != base64.RawURLEncoding.EncodeToString(sum[:]) || q.Get("client_secret") != "" {
			t.Fatalf("%s authorize URL: %s", provider, auth)
		}
		if provider == "gdrive" && (q.Get("access_type") != "offline" || q.Get("scope") != gdriveScope || q.Get("redirect_uri") != gdriveRedirect) {
			t.Fatalf("gdrive authorize URL: %s", auth)
		}
		if provider == "dropbox" && q.Get("token_access_type") != "offline" {
			t.Fatalf("dropbox authorize URL: %s", auth)
		}
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			_ = r.ParseForm()
			f := r.PostForm
			if f.Get("grant_type") != "authorization_code" || f.Get("code") != "the-code" || f.Get("code_verifier") != a.verifier || f.Get("client_secret") != "secret" || (provider == "gdrive") != (f.Get("redirect_uri") == gdriveRedirect) {
				w.WriteHeader(http.StatusBadRequest)
				_, _ = w.Write([]byte(`{"error":"invalid_grant","error_description":"private"}`))
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"access_token": "a", "refresh_token": "long-lived", "token_type": "bearer"})
		}))
		a.tokenURL = server.URL
		for _, pasted := range []string{"the-code", "  http://127.0.0.1:53682/?code=the-code&scope=x \n", "?code=the-code"} {
			token, err := a.Exchange(context.Background(), pasted)
			if err != nil || token != "long-lived" {
				t.Fatalf("%s exchange of %q: %q %v", provider, pasted, token, err)
			}
		}
		if _, err = a.Exchange(context.Background(), "wrong"); err == nil || !strings.Contains(err.Error(), "invalid_grant") || strings.Contains(err.Error(), "private") {
			t.Fatalf("rejected code: %v", err)
		}
		if _, err = a.Exchange(context.Background(), " "); err == nil {
			t.Fatal("empty code accepted")
		}
		server.Close()
	}
	if _, err := NewOAuthApp("s3", "a", "b"); err == nil {
		t.Fatal("unknown provider accepted")
	}
	if _, err := NewOAuthApp("gdrive", "a", ""); err == nil {
		t.Fatal("missing secret accepted")
	}
}
