package backup

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/rand/v2"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

// Shared plumbing for the OAuth-based REST transports (Google Drive, Dropbox):
// provider lifetime, refresh-token exchange, bounded responses, sanitized
// errors and retry/backoff with Retry-After support.

const (
	cloudResponseLimit = 8 << 20
	cloudAttempts      = 5
	cloudMaxRetryAfter = 2 * time.Minute
	cloudTokenSkew     = time.Minute
)

type cloudLife struct {
	service string
	ctx     context.Context
	cancel  context.CancelFunc
	wg      sync.WaitGroup
	mu      sync.Mutex
	closed  bool
}

func newCloudLife(service string) *cloudLife {
	ctx, cancel := context.WithCancel(context.Background())
	return &cloudLife{service: service, ctx: ctx, cancel: cancel}
}

// begin joins an operation to the provider lifetime, so Close cancels and
// waits for every in-flight request.
func (l *cloudLife) begin(ctx context.Context) (context.Context, func(), error) {
	l.mu.Lock()
	if l.closed {
		l.mu.Unlock()
		return nil, nil, fmt.Errorf("%s provider is closed", l.service)
	}
	l.wg.Add(1)
	l.mu.Unlock()
	ctx, cancel := context.WithCancel(ctx)
	stop := context.AfterFunc(l.ctx, cancel)
	return ctx, func() { stop(); cancel(); l.wg.Done() }, nil
}
func (l *cloudLife) close() {
	l.mu.Lock()
	l.closed = true
	l.cancel()
	l.mu.Unlock()
	l.wg.Wait()
}

// cloudError never carries a response body or message text: only a short,
// charset-restricted protocol code may reach logs and the dashboard.
type cloudError struct {
	service, op string
	status      int
	code        string
	hint        string
	retry       bool
	retryAfter  time.Duration
	body        []byte // provider-specific parsing only; never formatted
}

func (e *cloudError) Error() string {
	code := e.code
	if code == "" {
		code = "service error"
	}
	msg := fmt.Sprintf("%s %s: %s (HTTP %d)", e.service, e.op, code, e.status)
	if e.hint != "" {
		msg += ". " + e.hint
	}
	return msg
}

// cloudCode keeps an identifier-like prefix of an untrusted service code.
func cloudCode(s string) string {
	var b strings.Builder
	for _, r := range s {
		if b.Len() >= 80 || !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '_' || r == '/' || r == '.' || r == '-') {
			break
		}
		b.WriteRune(r)
	}
	return strings.TrimRight(b.String(), "/.")
}

// cloudText makes a short service-provided display value safe to show.
func cloudText(s string) string {
	s = strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f || r == utf8.RuneError {
			return -1
		}
		return r
	}, s)
	if len(s) > 120 {
		s = strings.ToValidUTF8(s[:120], "")
	}
	return s
}

type cloudAPI struct {
	service   string
	client    *http.Client
	transport *http.Transport
	decode    func(status int, body []byte) (code string, retry bool)
	backoff   time.Duration
	maxDelay  time.Duration

	tokenURL  string
	tokenForm url.Values
	tokenHint string
	tokenMu   sync.Mutex
	access    string
	expiry    time.Time
}

func newCloudAPI(service, tokenURL string, form url.Values, hint string, decode func(int, []byte) (string, bool)) *cloudAPI {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.MaxIdleConnsPerHost = 4
	transport.ResponseHeaderTimeout = 90 * time.Second
	transport.TLSHandshakeTimeout = 10 * time.Second
	transport.IdleConnTimeout = time.Minute
	dialer := &net.Dialer{Timeout: 30 * time.Second, KeepAlive: 30 * time.Second}
	transport.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
		conn, err := dialer.DialContext(ctx, network, address)
		if err != nil {
			return nil, err
		}
		return &remoteWriteConn{Conn: conn}, nil
	}
	client := &http.Client{
		Transport: &backupHTTPTransport{base: transport, readTimeout: remoteIdleTimeout},
		// Bearer tokens must never follow a redirect to another origin.
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	return &cloudAPI{service: service, client: client, transport: transport, decode: decode, backoff: time.Second, maxDelay: 30 * time.Second, tokenURL: tokenURL, tokenForm: form, tokenHint: hint}
}

type cloudRequest struct {
	op     string
	method string
	url    string
	header http.Header
	// body is rebuilt for every attempt; nil sends no body.
	body func() (io.Reader, int64)
	// progress/part route upload-body reads through the shared pacer.
	progress *transferProgress
	part     int64
	// accept lists non-2xx statuses returned to the caller instead of failing.
	accept []int
	// once disables automatic retries of transport and retriable service
	// failures, for requests whose outcome the caller must establish itself.
	once   bool
	noAuth bool
}
type cloudResponse struct {
	status int
	header http.Header
	body   []byte
}

func (c *cloudAPI) close() { c.transport.CloseIdleConnections() }

// token returns a cached access token, refreshing it shortly before expiry.
func (c *cloudAPI) token(ctx context.Context, stale string) (string, error) {
	c.tokenMu.Lock()
	defer c.tokenMu.Unlock()
	if c.access != "" && c.access != stale && time.Now().Before(c.expiry) {
		return c.access, nil
	}
	c.access = ""
	form := c.tokenForm.Encode()
	res, err := c.do(ctx, cloudRequest{op: "token refresh", method: http.MethodPost, url: c.tokenURL, noAuth: true,
		header: http.Header{"Content-Type": {"application/x-www-form-urlencoded"}},
		body:   func() (io.Reader, int64) { return strings.NewReader(form), int64(len(form)) }})
	if err != nil {
		var ce *cloudError
		if errors.As(err, &ce) && (ce.code == "invalid_grant" || ce.code == "invalid_client" || ce.code == "unauthorized_client") {
			ce.hint = c.tokenHint
		}
		return "", err
	}
	var out struct {
		AccessToken string `json:"access_token"`
		ExpiresIn   int64  `json:"expires_in"`
		TokenType   string `json:"token_type"`
	}
	if err = json.Unmarshal(res.body, &out); err != nil || out.AccessToken == "" || (out.TokenType != "" && !strings.EqualFold(out.TokenType, "bearer")) {
		return "", fmt.Errorf("%s token refresh: invalid token response", c.service)
	}
	lifetime := time.Duration(max(out.ExpiresIn, 0)) * time.Second
	if lifetime == 0 {
		lifetime = time.Hour
	}
	c.access = out.AccessToken
	c.expiry = time.Now().Add(max(lifetime-cloudTokenSkew, lifetime/2))
	return c.access, nil
}

func retryAfter(h http.Header) time.Duration {
	v := strings.TrimSpace(h.Get("Retry-After"))
	if v == "" {
		return 0
	}
	if s, err := strconv.ParseInt(v, 10, 64); err == nil {
		return time.Duration(max(s, 0)) * time.Second
	}
	if t, err := http.ParseTime(v); err == nil {
		return max(time.Until(t), 0)
	}
	return 0
}
func (c *cloudAPI) delay(attempt int, hinted time.Duration) time.Duration {
	if hinted > 0 {
		return hinted
	}
	d := min(c.maxDelay, c.backoff<<min(attempt, 10))
	return d/2 + rand.N(d/2+1)
}
func sleepContext(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

func (c *cloudAPI) do(ctx context.Context, r cloudRequest) (cloudResponse, error) {
	refreshed := false
	stale := ""
	for attempt := 0; ; attempt++ {
		var used string
		res, err := c.once(ctx, r, stale, &used)
		stale = ""
		if err == nil {
			return res, nil
		}
		if ctx.Err() != nil {
			return cloudResponse{}, fmt.Errorf("%s %s: %w", c.service, r.op, ctx.Err())
		}
		var ce *cloudError
		isService := errors.As(err, &ce)
		if isService && ce.status == http.StatusUnauthorized && !r.noAuth && !refreshed {
			// An access token can be revoked or expire early: refresh once.
			refreshed = true
			stale = used
			attempt--
			continue
		}
		retriable := !isService || ce.retry
		if r.once || !retriable || attempt+1 >= cloudAttempts {
			return cloudResponse{}, err
		}
		var hinted time.Duration
		if isService {
			hinted = ce.retryAfter
		}
		if hinted > cloudMaxRetryAfter {
			return cloudResponse{}, err
		}
		if e := sleepContext(ctx, c.delay(attempt, hinted)); e != nil {
			return cloudResponse{}, fmt.Errorf("%s %s: %w", c.service, r.op, e)
		}
	}
}

func (c *cloudAPI) once(ctx context.Context, r cloudRequest, stale string, used *string) (cloudResponse, error) {
	var body io.Reader
	var length int64
	if r.body != nil {
		body, length = r.body()
	}
	reqCtx := ctx
	if r.progress != nil {
		reqCtx = withUploadBody(ctx, r.progress, r.part)
	}
	req, err := http.NewRequestWithContext(reqCtx, r.method, r.url, body)
	if err != nil {
		return cloudResponse{}, fmt.Errorf("%s %s: invalid request", c.service, r.op)
	}
	for k, v := range r.header {
		req.Header[k] = v
	}
	if r.body != nil {
		req.ContentLength = length
		if length == 0 {
			req.Body = http.NoBody
		}
	}
	if !r.noAuth {
		token, err := c.token(ctx, stale)
		if err != nil {
			return cloudResponse{}, err
		}
		*used = token
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := c.client.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return cloudResponse{}, ctx.Err()
		}
		// url.Error repeats the request URL, which for resumable uploads is a
		// capability. Report only the transport failure class.
		return cloudResponse{}, fmt.Errorf("%s %s: transport error", c.service, r.op)
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, cloudResponseLimit+1))
	if err != nil {
		if ctx.Err() != nil {
			return cloudResponse{}, ctx.Err()
		}
		return cloudResponse{}, fmt.Errorf("%s %s: transport error reading response", c.service, r.op)
	}
	if len(data) > cloudResponseLimit {
		return cloudResponse{}, &cloudError{service: c.service, op: r.op, status: resp.StatusCode, code: "response too large"}
	}
	out := cloudResponse{resp.StatusCode, resp.Header, data}
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		return out, nil
	}
	for _, s := range r.accept {
		if s == resp.StatusCode {
			return out, nil
		}
	}
	code, retry := c.decode(resp.StatusCode, data)
	if r.noAuth {
		code, retry = decodeOAuthError(data), false
	}
	if resp.StatusCode >= 300 && resp.StatusCode < 400 {
		code, retry = "unexpected redirect", false
	}
	if resp.StatusCode == http.StatusTooManyRequests || (resp.StatusCode >= 500 && resp.StatusCode != http.StatusNotImplemented) {
		retry = true
	}
	return out, &cloudError{service: c.service, op: r.op, status: resp.StatusCode, code: code, retry: retry, retryAfter: retryAfter(resp.Header), body: data}
}

// decodeOAuthError reads the RFC 6749 token-endpoint error shape.
func decodeOAuthError(body []byte) string {
	var e struct {
		Error any `json:"error"`
	}
	if json.Unmarshal(body, &e) == nil {
		if s, ok := e.Error.(string); ok {
			return cloudCode(s)
		}
	}
	return ""
}

func jsonBody(v any) (func() (io.Reader, int64), error) {
	data, err := json.Marshal(v)
	if err != nil {
		return nil, err
	}
	return func() (io.Reader, int64) { return bytes.NewReader(data), int64(len(data)) }, nil
}

// cloudInspection hashes the whole source once (SHA-256 identity plus any
// provider-specific digests), proving the declared size before remote IO.
func inspectCloudSource(ctx context.Context, src io.ReadSeeker, size int64, extra ...io.Writer) ([]byte, error) {
	if size < 0 {
		return nil, errors.New("invalid backup source size")
	}
	if _, err := src.Seek(0, io.SeekStart); err != nil {
		return nil, err
	}
	whole := sha256.New()
	n, err := io.CopyBuffer(io.MultiWriter(append([]io.Writer{whole}, extra...)...), io.LimitReader(contextReader{ctx, src}, size), make([]byte, 64<<10))
	if err != nil {
		return nil, err
	}
	var probe [1]byte
	m, e := contextReader{ctx, src}.Read(probe[:])
	if n != size || m != 0 || e == nil {
		return nil, errors.New("backup source size changed during inspection")
	}
	if !errors.Is(e, io.EOF) {
		return nil, e
	}
	_, err = src.Seek(0, io.SeekStart)
	return whole.Sum(nil), err
}
