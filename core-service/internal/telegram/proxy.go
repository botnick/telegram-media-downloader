package telegram

import (
	"context"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/netip"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gotd/td/telegram/dcs"
	"github.com/gotd/td/tg"
	"github.com/gotd/td/transport"
	"golang.org/x/net/proxy"
)

// ProxyConfig is a private connection snapshot, never an HTTP response.
// A nil config explicitly selects direct connections; invalid settings fail.
type ProxyConfig struct {
	Type, Host                 string
	Port                       int
	Username, Password, Secret string
}

func ParseProxy(raw any) (*ProxyConfig, error) {
	if raw == nil {
		return nil, nil
	}
	m, ok := raw.(map[string]any)
	if !ok {
		return nil, errors.New("Telegram proxy must be an object or null")
	}
	p := &ProxyConfig{}
	for key, dst := range map[string]*string{"type": &p.Type, "host": &p.Host, "username": &p.Username, "password": &p.Password, "secret": &p.Secret} {
		if value := m[key]; value != nil {
			s, ok := value.(string)
			if !ok {
				return nil, fmt.Errorf("Telegram proxy %s must be text", key)
			}
			*dst = s
		}
	}
	var port string
	switch v := m["port"].(type) {
	case string:
		port = v
	case float64:
		port = strconv.FormatFloat(v, 'f', -1, 64)
	case int:
		port = strconv.Itoa(v)
	case int64:
		port = strconv.FormatInt(v, 10)
	case json.Number:
		port = string(v)
	}
	var err error
	p.Port, err = strconv.Atoi(port)
	if err != nil {
		return nil, errors.New("Telegram proxy port must be an integer from 1 to 65535")
	}
	return normalizeProxy(*p)
}

func normalizeProxy(p ProxyConfig) (*ProxyConfig, error) {
	p.Type = strings.ToLower(strings.TrimSpace(p.Type))
	if p.Type == "" {
		p.Type = "socks5"
	}
	p.Host = strings.TrimSpace(p.Host)
	if strings.HasPrefix(p.Host, "[") && strings.HasSuffix(p.Host, "]") {
		p.Host = p.Host[1 : len(p.Host)-1]
	}
	if !validProxyHost(p.Host) {
		return nil, errors.New("Telegram proxy host is invalid")
	}
	if p.Port < 1 || p.Port > 65535 {
		return nil, errors.New("Telegram proxy port must be an integer from 1 to 65535")
	}
	switch p.Type {
	case "socks5":
		if len(p.Username) > 255 || len(p.Password) > 255 || (p.Username == "") != (p.Password == "") {
			return nil, errors.New("SOCKS5 requires both username and password, each 1-255 bytes, or neither")
		}
	case "socks4":
		if strings.ContainsRune(p.Username, 0) || len(p.Username) > 255 {
			return nil, errors.New("SOCKS4 user ID is invalid")
		}
		if p.Password != "" {
			return nil, errors.New("SOCKS4 does not support passwords; use SOCKS5")
		}
	case "mtproxy":
		p.Secret = strings.TrimSpace(p.Secret)
		if _, err := proxySecret(p.Secret); err != nil {
			return nil, err
		}
	case "http":
		return nil, errors.New("HTTP Telegram proxies are not supported; use SOCKS4, SOCKS5 or MTProxy")
	default:
		return nil, errors.New("Unknown Telegram proxy type; use SOCKS4, SOCKS5 or MTProxy")
	}
	return &p, nil
}

func validProxyHost(host string) bool {
	if host == "" || len(host) > 253 {
		return false
	}
	if ip, err := netip.ParseAddr(host); err == nil {
		return ip.Zone() == "" && !ip.IsUnspecified() && !ip.IsMulticast()
	}
	for _, label := range strings.Split(strings.TrimSuffix(host, "."), ".") {
		if len(label) == 0 || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
			return false
		}
		for _, c := range label {
			if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '-') {
				return false
			}
		}
	}
	return true
}

func proxySecret(s string) ([]byte, error) {
	invalid := errors.New("MTProxy secret must be a 16-byte key, a dd key, or an ee key with a valid TLS hostname, encoded as hex or base64url")
	if len(s) > 1024 {
		return nil, invalid
	}
	b, err := hex.DecodeString(s)
	if err != nil {
		b, err = base64.RawURLEncoding.DecodeString(strings.TrimRight(s, "="))
	}
	if err != nil {
		return nil, invalid
	}
	if len(b) == 16 || len(b) == 17 && b[0] == 0xdd {
		return b, nil
	}
	if len(b) > 17 && b[0] == 0xee {
		host := string(b[17:])
		if validProxyHost(host) && !strings.Contains(host, ":") {
			return b, nil
		}
	}
	return nil, invalid
}

type proxyResolver struct {
	config ProxyConfig
	dial   dcs.DialFunc
}

func newProxyResolver(p *ProxyConfig, dial dcs.DialFunc) (dcs.Resolver, error) {
	if p == nil {
		return nil, nil
	}
	normalized, err := normalizeProxy(*p)
	if err != nil {
		return nil, err
	}
	if dial == nil {
		dial = (&net.Dialer{Timeout: 30 * time.Second, KeepAlive: 30 * time.Second}).DialContext
	}
	return &proxyResolver{config: *normalized, dial: dial}, nil
}
func (p *proxyResolver) Primary(ctx context.Context, dc int, list dcs.List) (transport.Conn, error) {
	return p.resolve(ctx, dc, list, "primary")
}
func (p *proxyResolver) MediaOnly(ctx context.Context, dc int, list dcs.List) (transport.Conn, error) {
	return p.resolve(ctx, dc, list, "media")
}
func (p *proxyResolver) CDN(ctx context.Context, dc int, list dcs.List) (transport.Conn, error) {
	return p.resolve(ctx, dc, list, "cdn")
}

// Give each raced destination its own handshake lifetime. Cancellation of the
// losing attempts must not close the connection already returned to gotd.
func (p *proxyResolver) resolve(ctx context.Context, dc int, list dcs.List, kind string) (transport.Conn, error) {
	if p.config.Type == "mtproxy" {
		return p.connect(ctx, dc, list, kind)
	}
	options := []tg.DCOption{}
	for _, option := range dcs.FindDCs(list.Options, dc, false) {
		if kind == "primary" && !option.MediaOnly && !option.CDN || kind == "media" && option.MediaOnly || kind == "cdn" && option.CDN {
			options = append(options, option)
		}
	}
	if len(options) == 0 {
		return nil, fmt.Errorf("no %s addresses for Telegram DC %d", kind, dc)
	}
	if len(options) == 1 {
		return p.connect(ctx, dc, dcs.List{Test: list.Test, Options: options}, kind)
	}
	ctx, cancel := context.WithCancel(ctx)
	var workers sync.WaitGroup
	defer workers.Wait()
	defer cancel()
	type result struct {
		conn transport.Conn
		err  error
	}
	results := make(chan result)
	for _, option := range options {
		workers.Add(1)
		go func() {
			defer workers.Done()
			conn, err := p.connect(ctx, dc, dcs.List{Test: list.Test, Options: []tg.DCOption{option}}, kind)
			select {
			case results <- result{conn, err}:
			case <-ctx.Done():
				if conn != nil {
					_ = conn.Close()
				}
			}
		}()
	}
	var failures error
	for range options {
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case result := <-results:
			if result.err == nil {
				return result.conn, nil
			}
			failures = errors.Join(failures, result.err)
		}
	}
	return nil, failures
}

// A scope bounds the entire proxy + MTProto transport handshake. gotd's
// handshake does not itself observe cancellation. Each attempt owns its socket
// until its transport handshake finishes, then transfers ownership to gotd.
type proxyHandshake struct {
	mu    sync.Mutex
	ended bool
	conns []net.Conn
}

func (s *proxyHandshake) add(c net.Conn, deadline time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.ended {
		_ = c.Close()
		return context.Canceled
	}
	if err := c.SetDeadline(deadline); err != nil {
		_ = c.Close()
		return err
	}
	s.conns = append(s.conns, c)
	return nil
}
func (s *proxyHandshake) finish(keep bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.ended = true
	for _, c := range s.conns {
		if keep {
			_ = c.SetDeadline(time.Time{})
		} else {
			_ = c.Close()
		}
	}
}

type contextProxyDialer struct{ dial dcs.DialFunc }

func (d contextProxyDialer) Dial(network, address string) (net.Conn, error) {
	return d.dial(context.Background(), network, address)
}
func (d contextProxyDialer) DialContext(ctx context.Context, network, address string) (net.Conn, error) {
	return d.dial(ctx, network, address)
}

func (p *proxyResolver) connect(parent context.Context, dc int, list dcs.List, kind string) (conn transport.Conn, rerr error) {
	ctx, cancel := context.WithTimeout(parent, 30*time.Second)
	defer cancel()
	scope := &proxyHandshake{}
	closed := make(chan struct{})
	stop := context.AfterFunc(ctx, func() { scope.finish(false); close(closed) })
	defer func() {
		if !stop() {
			<-closed
		}
		if err := ctx.Err(); err != nil {
			rerr = err
		}
		scope.finish(rerr == nil)
		if rerr != nil {
			conn = nil
		}
	}()
	deadline, _ := ctx.Deadline()
	rawDial := func(call context.Context, network, address string) (net.Conn, error) {
		c, err := p.dial(call, network, address)
		if err != nil {
			return nil, err
		}
		if err = scope.add(c, deadline); err != nil {
			return nil, err
		}
		return c, nil
	}
	address := net.JoinHostPort(p.config.Host, strconv.Itoa(p.config.Port))
	var resolver dcs.Resolver
	if p.config.Type == "mtproxy" {
		secret, err := proxySecret(p.config.Secret)
		if err != nil {
			return nil, err
		}
		mtDial := rawDial
		if len(secret) > 17 && secret[0] == 0xee {
			mtDial = func(call context.Context, network, address string) (net.Conn, error) {
				c, err := rawDial(call, network, address)
				if err != nil {
					return nil, err
				}
				return &proxyTLSConn{Conn: c}, nil
			}
		}
		resolver, err = dcs.MTProxy(address, secret, dcs.MTProxyOptions{Dial: mtDial})
		if err != nil {
			return nil, errors.New("MTProxy configuration is invalid")
		}
	} else {
		var dial dcs.DialFunc
		if p.config.Type == "socks5" {
			var auth *proxy.Auth
			if p.config.Username != "" {
				auth = &proxy.Auth{User: p.config.Username, Password: p.config.Password}
			}
			d, err := proxy.SOCKS5("tcp", address, auth, contextProxyDialer{rawDial})
			if err != nil {
				return nil, errors.New("SOCKS5 configuration is invalid")
			}
			dial = d.(proxy.ContextDialer).DialContext
		} else {
			dial = func(call context.Context, _, target string) (net.Conn, error) {
				c, err := rawDial(call, "tcp", address)
				if err != nil {
					return nil, err
				}
				if err = socks4Connect(c, target, p.config.Username); err != nil {
					_ = c.Close()
					return nil, err
				}
				return c, nil
			}
		}
		resolver = dcs.Plain(dcs.PlainOptions{Dial: func(call context.Context, network, target string) (net.Conn, error) {
			c, err := dial(call, network, target)
			if err != nil {
				return nil, err
			}
			// x/net resets deadlines after SOCKS authentication. Bound the following
			// MTProto transport/obfuscation handshake as well.
			if err = c.SetDeadline(deadline); err != nil {
				_ = c.Close()
				return nil, err
			}
			return c, nil
		}})
	}
	switch kind {
	case "media":
		return resolver.MediaOnly(ctx, dc, list)
	case "cdn":
		if p.config.Type == "mtproxy" {
			return resolver.CDN(ctx, dc, list)
		}
		// Plain's CDN method is unsupported. Select only CDN entries and let its
		// normal transport code connect through the same configured SOCKS dialer.
		cdn := dcs.List{Test: list.Test}
		for _, opt := range list.Options {
			if opt.ID == dc && opt.CDN {
				opt.CDN = false
				opt.MediaOnly = false
				cdn.Options = append(cdn.Options, opt)
			}
		}
		return resolver.Primary(ctx, dc, cdn)
	default:
		return resolver.Primary(ctx, dc, list)
	}
}

func socks4Connect(c net.Conn, target, user string) error {
	host, portText, err := net.SplitHostPort(target)
	if err != nil {
		return errors.New("invalid SOCKS4 destination")
	}
	port, err := strconv.Atoi(portText)
	if err != nil || port < 1 || port > 65535 {
		return errors.New("invalid SOCKS4 destination port")
	}
	request := []byte{4, 1, byte(port >> 8), byte(port), 0, 0, 0, 1}
	domain := ""
	if ip, err := netip.ParseAddr(host); err == nil {
		ip = ip.Unmap()
		if !ip.Is4() {
			return errors.New("SOCKS4 cannot connect to IPv6 destinations")
		}
		b := ip.As4()
		copy(request[4:], b[:])
	} else {
		if !validProxyHost(host) {
			return errors.New("invalid SOCKS4 destination hostname")
		}
		domain = host
	}
	request = append(request, []byte(user)...)
	request = append(request, 0)
	if domain != "" {
		request = append(request, []byte(domain)...)
		request = append(request, 0)
	}
	if _, err = c.Write(request); err != nil {
		return err
	}
	var response [8]byte
	if _, err = io.ReadFull(c, response[:]); err != nil {
		return err
	}
	if response[0] != 0 || response[1] != 90 {
		return errors.New("SOCKS4 proxy rejected the connection")
	}
	return nil
}
