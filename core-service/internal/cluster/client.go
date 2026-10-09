package cluster

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"sync/atomic"
	"time"
)

type Client struct {
	Store      Store
	HTTP       *http.Client
	StreamHTTP *http.Client
	stamp      atomic.Int64
}

func NewClient(s Store) *Client {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil
	transport.MaxConnsPerHost = 8
	transport.MaxIdleConns = 16
	transport.MaxResponseHeaderBytes = 64 << 10
	return &Client{Store: s, StreamHTTP: newStreamClient(), HTTP: &http.Client{Transport: transport, Timeout: 10 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}
}
func (c *Client) Close() { c.HTTP.CloseIdleConnections(); c.StreamHTTP.CloseIdleConnections() }
func (c *Client) timestamp(ctx context.Context) (int64, error) {
	for {
		if err := ctx.Err(); err != nil {
			return 0, err
		}
		old := c.stamp.Load()
		now := time.Now().UnixMilli()
		// Milliseconds are also the replay discriminator in the released wire
		// format. Bound the lead during bursts or wall-clock rollback instead
		// of eventually emitting timestamps outside the peer's auth window.
		if old >= now+1000 {
			timer := time.NewTimer(time.Millisecond)
			select {
			case <-ctx.Done():
				timer.Stop()
				return 0, ctx.Err()
			case <-timer.C:
			}
			continue
		}
		next := max(now, old+1)
		if c.stamp.CompareAndSwap(old, next) {
			return next, nil
		}
	}
}
func (c *Client) request(ctx context.Context, base, method, target, key string, body []byte) (*http.Response, error) {
	return c.send(ctx, base, method, target, key, body, nil, c.HTTP)
}
func (c *Client) send(ctx context.Context, base, method, target, key string, body []byte, headers http.Header, client *http.Client) (*http.Response, error) {
	identity, err := c.Store.Identity(ctx)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, method, base+target, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	stamp, err := c.timestamp(ctx)
	if err != nil {
		return nil, err
	}
	req.Header.Set("X-Peer-Id", identity.PeerID)
	req.Header.Set("X-Peer-Ts", strconv.FormatInt(stamp, 10))
	req.Header.Set("X-Peer-Signature", Signature(key, method, req.URL.RequestURI(), stamp, body))
	if len(body) > 0 {
		req.Header.Set("Content-Type", "application/json")
	}
	for _, key := range []string{"Range", "If-Range", "If-None-Match", "If-Modified-Since"} {
		if v := headers.Get(key); v != "" {
			req.Header.Set(key, v)
		}
	}
	return client.Do(req)
}
func ReadJSON(res *http.Response, into any) error {
	defer res.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(res.Body, (1<<20)+1))
	if err != nil {
		return err
	}
	if len(raw) > 1<<20 {
		return errors.New("peer response exceeds 1 MiB")
	}
	return json.Unmarshal(raw, into)
}

type PairError struct{ Code, Message string }

func (e *PairError) Error() string { return e.Message }

var codePattern = regexp.MustCompile(`^[A-Z0-9]{6,16}$`)

func (c *Client) Pair(ctx context.Context, remote, token, code, selfURL, version string) (Peer, error) {
	clean, err := NormalizeURL(remote)
	if err != nil {
		return Peer{}, &PairError{"bad_url", "URL must start with http:// or https://"}
	}
	key := strings.TrimSpace(token)
	code = strings.ToUpper(strings.TrimSpace(code))
	if code != "" {
		if !codePattern.MatchString(code) {
			return Peer{}, &PairError{"bad_pairing_code", "Pairing code must be 6-16 alphanumeric characters"}
		}
		key = PairingKey(code)
	} else if !secretPattern.MatchString(key) {
		return Peer{}, &PairError{"bad_token", "Token must be 32+ hex chars"}
	}
	selfURL, err = NormalizeURL(selfURL)
	if err != nil {
		return Peer{}, &PairError{"bad_self_url", "A valid reachable URL for this instance is required"}
	}
	i, err := c.Store.Identity(ctx)
	if err != nil {
		return Peer{}, err
	}
	secret, err := NewSecret()
	if err != nil {
		return Peer{}, err
	}
	h := Handshake{PeerID: i.PeerID, Name: i.Name, URL: selfURL, Version: &version, SharedSecret: secret, PairingCode: code, Timestamp: time.Now().UnixMilli()}
	raw, err := json.Marshal(h)
	if err != nil {
		return Peer{}, err
	}
	res, err := c.request(ctx, clean, "POST", "/api/cluster/handshake", key, raw)
	if err != nil {
		_ = c.Store.Audit(ctx, "", "handshake", "outbound to "+clean+": unreachable", false)
		return Peer{}, &PairError{"unreachable", "Could not reach " + clean}
	}
	if res.StatusCode != 200 {
		res.Body.Close()
		_ = c.Store.Audit(ctx, "", "handshake", "outbound to "+clean+" → HTTP "+strconv.Itoa(res.StatusCode), false)
		kind := "remote_error"
		if res.StatusCode == 401 {
			kind = "token_invalid"
		}
		return Peer{}, &PairError{kind, "Remote handshake refused"}
	}
	var reply HandshakeReply
	if err = ReadJSON(res, &reply); err != nil {
		return Peer{}, &PairError{"bad_response", "Remote did not return valid identity"}
	}
	if reply.PeerID == i.PeerID {
		return Peer{}, &PairError{"self", "Cannot pair with self — that URL points to this same instance"}
	}
	if reply.SharedSecretAck != secret {
		return Peer{}, &PairError{"bad_response", "Remote did not acknowledge the per-pair secret"}
	}
	h = Handshake{PeerID: reply.PeerID, Name: reply.Name, URL: clean, Version: &reply.Version, SharedSecret: secret}
	return c.Store.SaveOutbound(ctx, h, key)
}
func (c *Client) Request(ctx context.Context, p Peer, method, target string, body []byte) (*http.Response, error) {
	if err := validateDestination(p, target); err != nil {
		return nil, err
	}
	base, _ := NormalizeURL(p.URL)
	return c.request(ctx, base, method, target, string(p.Secret), body)
}
func validateDestination(p Peer, target string) error {
	if p.Status == "revoked" {
		return AuthError("revoked")
	}
	if !secretPattern.Match(p.Secret) {
		return AuthError("migration_required")
	}
	_, err := NormalizeURL(p.URL)
	if err != nil {
		return err
	}
	if !strings.HasPrefix(target, "/api/cluster/") || strings.ContainsAny(target, "\r\n") {
		return errors.New("invalid peer request target")
	}
	return nil
}
