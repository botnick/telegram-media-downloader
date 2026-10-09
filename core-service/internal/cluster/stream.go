package cluster

import (
	"context"
	"crypto/tls"
	"net"
	"net/http"
	"time"
)

// Streaming requests have an inactivity deadline rather than a total ten-second
// timeout. HTTP/1 owns each connection while its response body is being read.
type streamConn struct{ net.Conn }

func (c streamConn) Read(p []byte) (int, error) {
	_ = c.SetReadDeadline(time.Now().Add(30 * time.Second))
	return c.Conn.Read(p)
}
func (c streamConn) Write(p []byte) (int, error) {
	_ = c.SetWriteDeadline(time.Now().Add(30 * time.Second))
	return c.Conn.Write(p)
}
func newStreamClient() *http.Client {
	dialer := &net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil
	transport.ForceAttemptHTTP2 = false
	transport.TLSNextProto = map[string]func(string, *tls.Conn) http.RoundTripper{}
	transport.ResponseHeaderTimeout = 10 * time.Second
	transport.MaxResponseHeaderBytes = 64 << 10
	transport.MaxConnsPerHost = 8
	transport.MaxIdleConns = 16
	transport.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
		c, err := dialer.DialContext(ctx, network, address)
		if err != nil {
			return nil, err
		}
		return streamConn{c}, nil
	}
	return &http.Client{Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
}
func (c *Client) Stream(ctx context.Context, p Peer, method, target string, headers http.Header) (*http.Response, error) {
	if err := validateDestination(p, target); err != nil {
		return nil, err
	}
	base, _ := NormalizeURL(p.URL)
	return c.send(ctx, base, method, target, string(p.Secret), nil, headers, c.StreamHTTP)
}
