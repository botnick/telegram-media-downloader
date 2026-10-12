package backup

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// fixtureOAuth is a refresh-token endpoint: it validates the RFC 6749 refresh
// grant and mints numbered bearer tokens that the API fixtures accept.
type fixtureOAuth struct {
	mu                    sync.Mutex
	clientID, secret, rt  string
	issued                int
	valid                 map[string]bool
	reject                string // OAuth error code to return instead of a token
	expiresIn             int
	failNext              int // transient 503s before answering
	requestsWithAuthority int
}

func newFixtureOAuth(clientID, secret, rt string) *fixtureOAuth {
	return &fixtureOAuth{clientID: clientID, secret: secret, rt: rt, valid: map[string]bool{}, expiresIn: 3600}
}
func (o *fixtureOAuth) serve(w http.ResponseWriter, r *http.Request) {
	o.mu.Lock()
	defer o.mu.Unlock()
	if r.Header.Get("Authorization") != "" {
		o.requestsWithAuthority++
	}
	if o.failNext > 0 {
		o.failNext--
		w.WriteHeader(http.StatusServiceUnavailable)
		return
	}
	if err := r.ParseForm(); err != nil || r.Method != http.MethodPost || r.PostForm.Get("grant_type") != "refresh_token" {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"error":"unsupported_grant_type"}`))
		return
	}
	if o.reject != "" || r.PostForm.Get("client_id") != o.clientID || r.PostForm.Get("client_secret") != o.secret || r.PostForm.Get("refresh_token") != o.rt {
		code := o.reject
		if code == "" {
			code = "invalid_client"
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		_, _ = fmt.Fprintf(w, `{"error":%q,"error_description":"server-private-detail %s"}`, code, o.rt)
		return
	}
	o.issued++
	token := fmt.Sprintf("access-%d", o.issued)
	o.valid[token] = true
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"access_token": token, "expires_in": o.expiresIn, "token_type": "Bearer"})
}

// authorized reports whether the request carries a currently valid token.
func (o *fixtureOAuth) authorized(r *http.Request) bool {
	o.mu.Lock()
	defer o.mu.Unlock()
	token, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	return ok && o.valid[token]
}
func (o *fixtureOAuth) revokeAll() {
	o.mu.Lock()
	defer o.mu.Unlock()
	clear(o.valid)
}
func (o *fixtureOAuth) count() int {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.issued
}

func fastRetries(api *cloudAPI) {
	api.backoff = time.Millisecond
	api.maxDelay = 5 * time.Millisecond
}

func TestCloudRetryAfterAndSanitizedCodes(t *testing.T) {
	if got := retryAfter(http.Header{"Retry-After": {"3"}}); got != 3*time.Second {
		t.Fatalf("seconds: %v", got)
	}
	if got := retryAfter(http.Header{"Retry-After": {time.Now().Add(-time.Hour).UTC().Format(http.TimeFormat)}}); got != 0 {
		t.Fatalf("past date: %v", got)
	}
	if got := cloudCode("path/not_found/..."); got != "path/not_found" {
		t.Fatalf("code: %q", got)
	}
	if got := cloudCode("ok_code secret-token-here"); got != "ok_code" {
		t.Fatalf("code with space: %q", got)
	}
	if got := cloudText("a\x00b\nc"); got != "abc" {
		t.Fatalf("text: %q", got)
	}
}

func TestCloudTokenRefreshRetriesTransientFailures(t *testing.T) {
	oauth := newFixtureOAuth("id", "secret", "rt-value-xyz")
	oauth.failNext = 2
	server := httptest.NewServer(http.HandlerFunc(oauth.serve))
	defer server.Close()
	api := newCloudAPI("Fixture", server.URL, map[string][]string{"grant_type": {"refresh_token"}, "client_id": {"id"}, "client_secret": {"secret"}, "refresh_token": {"rt-value-xyz"}}, "hint", func(int, []byte) (string, bool) { return "", false })
	fastRetries(api)
	defer api.close()
	token, err := api.token(context.Background(), "")
	if err != nil || token != "access-1" {
		t.Fatalf("token after transient failures: %q %v", token, err)
	}
	// Cached until stale.
	if again, _ := api.token(context.Background(), ""); again != token || oauth.count() != 1 {
		t.Fatal("valid access token was not reused")
	}
	if fresh, _ := api.token(context.Background(), token); fresh != "access-2" {
		t.Fatalf("stale token was not refreshed: %q", fresh)
	}
	if oauth.requestsWithAuthority != 0 {
		t.Fatal("token endpoint received a bearer token")
	}
	oauth.reject = "invalid_grant"
	_, err = api.token(context.Background(), "access-2")
	var ce *cloudError
	if !errors.As(err, &ce) || ce.code != "invalid_grant" || !strings.Contains(err.Error(), "hint") || strings.Contains(err.Error(), "private") || strings.Contains(err.Error(), "rt-value-xyz") {
		t.Fatalf("invalid_grant error: %v", err)
	}
}
