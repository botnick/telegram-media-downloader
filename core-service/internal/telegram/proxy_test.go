package telegram

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gotd/td/bin"
	"github.com/gotd/td/mtproxy/obfuscated2"
	"github.com/gotd/td/proto/codec"
	"github.com/gotd/td/telegram/dcs"
	"github.com/gotd/td/tg"
	"github.com/gotd/td/transport"
)

func TestProxyConfigRejectsInvalidWithoutExposingCredentials(t *testing.T) {
	key := strings.Repeat("ab", 16)
	for _, secret := range []string{key, "dd" + key, "ee" + key + hex.EncodeToString([]byte("www.example.com")), base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{1}, 16))} {
		if _, err := ParseProxy(map[string]any{"type": "mtproxy", "host": "proxy.example", "port": 443, "secret": secret}); err != nil {
			t.Fatal(err)
		}
	}
	invalid := []any{false, "proxy", map[string]any{}, map[string]any{"host": "host", "port": 1.5}, map[string]any{"host": "host", "port": 65536}, map[string]any{"host": "host/path", "port": 1080}, map[string]any{"host": "user:private@host", "port": 1080}, map[string]any{"host": "host", "port": 1080, "password": "do-not-print"}, map[string]any{"type": "http", "host": "host", "port": 8080}, map[string]any{"type": "socks4", "host": "host", "port": 1080, "password": "do-not-print"}, map[string]any{"type": "mtproxy", "host": "host", "port": 443, "secret": "do-not-print"}, map[string]any{"type": "mtproxy", "host": "host", "port": 443, "secret": "ee" + key}, map[string]any{"type": "mtproxy", "host": "host", "port": 443, "secret": "dd" + key + "6162"}}
	for i, raw := range invalid {
		if p, err := ParseProxy(raw); err == nil || p != nil || strings.Contains(err.Error(), "do-not-print") {
			t.Fatalf("invalid case %d not safely rejected", i)
		}
	}
	if p, err := ParseProxy(nil); err != nil || p != nil {
		t.Fatal("null must disable proxy")
	}
	p, err := ParseProxy(map[string]any{"type": " SOCKS5 ", "host": "[::1]", "port": "1080"})
	if err != nil || p.Host != "::1" || p.Type != "socks5" {
		t.Fatalf("IPv6 config: %v", err)
	}
	cfg := GotdConfig{AppID: 1, AppHash: "fixture", SessionPath: filepath.Join(t.TempDir(), "session.enc"), SessionSecret: "fixture", Proxy: &ProxyConfig{Type: "mtproxy", Host: "host", Port: 443, Secret: "do-not-print"}}
	if _, err := NewGotdClient(cfg); err == nil || strings.Contains(err.Error(), "do-not-print") {
		t.Fatal("client ignored invalid proxy or exposed secret")
	}
}

func readSOCKSRequest(c net.Conn, kind, user, password string) (string, error) {
	if kind == "socks4" {
		var head [8]byte
		if _, err := io.ReadFull(c, head[:]); err != nil {
			return "", err
		}
		if head[0] != 4 || head[1] != 1 {
			return "", errors.New("wrong SOCKS4 request")
		}
		r := bufio.NewReader(c)
		got, err := r.ReadString(0)
		if err != nil {
			return "", err
		}
		if got != user+"\x00" {
			return "", errors.New("wrong SOCKS4 user")
		}
		host := net.IP(head[4:]).String()
		if bytes.Equal(head[4:], []byte{0, 0, 0, 1}) {
			host, err = r.ReadString(0)
			if err != nil {
				return "", err
			}
			host = strings.TrimSuffix(host, "\x00")
		}
		if r.Buffered() != 0 {
			return "", errors.New("unexpected bytes before SOCKS4 reply")
		}
		return net.JoinHostPort(host, strconv.Itoa(int(binary.BigEndian.Uint16(head[2:4])))), nil
	}
	var head [2]byte
	if _, err := io.ReadFull(c, head[:]); err != nil {
		return "", err
	}
	if head[0] != 5 || head[1] == 0 {
		return "", errors.New("wrong SOCKS5 greeting")
	}
	methods := make([]byte, int(head[1]))
	if _, err := io.ReadFull(c, methods); err != nil {
		return "", err
	}
	method := byte(0)
	if user != "" {
		method = 2
	}
	if !bytes.Contains(methods, []byte{method}) {
		return "", errors.New("auth method absent")
	}
	if _, err := c.Write([]byte{5, method}); err != nil {
		return "", err
	}
	if method == 2 {
		if _, err := io.ReadFull(c, head[:]); err != nil {
			return "", err
		}
		u := make([]byte, int(head[1]))
		if _, err := io.ReadFull(c, u); err != nil {
			return "", err
		}
		var n [1]byte
		if _, err := io.ReadFull(c, n[:]); err != nil {
			return "", err
		}
		pw := make([]byte, int(n[0]))
		if _, err := io.ReadFull(c, pw); err != nil {
			return "", err
		}
		if head[0] != 1 || string(u) != user || string(pw) != password {
			return "", errors.New("wrong proxy credentials")
		}
		if _, err := c.Write([]byte{1, 0}); err != nil {
			return "", err
		}
	}
	var req [4]byte
	if _, err := io.ReadFull(c, req[:]); err != nil {
		return "", err
	}
	if req[0] != 5 || req[1] != 1 || req[2] != 0 {
		return "", errors.New("wrong SOCKS5 connect")
	}
	n := 0
	switch req[3] {
	case 1:
		n = 4
	case 4:
		n = 16
	case 3:
		var b [1]byte
		if _, err := io.ReadFull(c, b[:]); err != nil {
			return "", err
		}
		n = int(b[0])
	default:
		return "", errors.New("wrong address type")
	}
	addr := make([]byte, n)
	if _, err := io.ReadFull(c, addr); err != nil {
		return "", err
	}
	if _, err := io.ReadFull(c, head[:]); err != nil {
		return "", err
	}
	host := string(addr)
	if req[3] != 3 {
		host = net.IP(addr).String()
	}
	return net.JoinHostPort(host, strconv.Itoa(int(binary.BigEndian.Uint16(head[:])))), nil
}
func replySOCKS(c net.Conn, kind string) error {
	response := []byte{5, 0, 0, 1, 0, 0, 0, 0, 0, 0}
	if kind == "socks4" {
		response = []byte{0, 90, 0, 0, 0, 0, 0, 0}
	}
	_, err := c.Write(response)
	return err
}
func echoIntermediate(c net.Conn) error {
	var head [4]byte
	if _, err := io.ReadFull(c, head[:]); err != nil {
		return err
	}
	if head != [4]byte{0xee, 0xee, 0xee, 0xee} {
		return errors.New("missing Telegram transport header")
	}
	var b bin.Buffer
	if err := (codec.Intermediate{}).Read(c, &b); err != nil {
		return err
	}
	return (codec.Intermediate{}).Write(c, &b)
}
func proxyDC(kind, host string) dcs.List {
	return dcs.List{Options: []tg.DCOption{{ID: 2, IPAddress: host, Port: 443, MediaOnly: kind == "media", CDN: kind == "cdn"}}}
}
func resolveProxy(r dcs.Resolver, ctx context.Context, kind string, list dcs.List) (transport.Conn, error) {
	switch kind {
	case "media":
		return r.MediaOnly(ctx, 2, list)
	case "cdn":
		return r.CDN(ctx, 2, list)
	default:
		return r.Primary(ctx, 2, list)
	}
}
func exchangeProxy(t *testing.T, c transport.Conn) {
	t.Helper()
	defer c.Close()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := c.Send(ctx, &bin.Buffer{Buf: []byte("abcdefgh")}); err != nil {
		t.Fatal(err)
	}
	var b bin.Buffer
	if err := c.Recv(ctx, &b); err != nil || string(b.Buf) != "abcdefgh" {
		t.Fatalf("payload: %q %v", b.Buf, err)
	}
}

func TestSOCKSRoutesEveryDCKindAndRetainsReturnedConnection(t *testing.T) {
	for _, kind := range []string{"primary", "media", "cdn"} {
		for _, protocol := range []string{"socks4", "socks5"} {
			for _, host := range []string{"149.154.167.51", "dc.example"} {
				t.Run(protocol+"/"+kind+"/"+host, func(t *testing.T) {
					cfg := &ProxyConfig{Type: protocol, Host: "proxy.example", Port: 1080, Username: "alice"}
					if protocol == "socks5" {
						cfg.Password = "private"
					}
					done := make(chan error, 1)
					resolver, err := newProxyResolver(cfg, func(ctx context.Context, network, address string) (net.Conn, error) {
						if network != "tcp" || address != "proxy.example:1080" {
							return nil, errors.New("attempted direct connection")
						}
						client, server := net.Pipe()
						go func() {
							defer server.Close()
							_ = server.SetDeadline(time.Now().Add(2 * time.Second))
							target, e := readSOCKSRequest(server, protocol, "alice", cfg.Password)
							if e == nil && target != net.JoinHostPort(host, "443") {
								e = fmt.Errorf("wrong destination %s", target)
							}
							if e == nil {
								e = replySOCKS(server, protocol)
							}
							if e == nil {
								e = echoIntermediate(server)
							}
							done <- e
						}()
						return client, nil
					})
					if err != nil {
						t.Fatal(err)
					}
					ctx, cancel := context.WithCancel(context.Background())
					conn, err := resolveProxy(resolver, ctx, kind, proxyDC(kind, host))
					if err != nil {
						cancel()
						t.Fatal(err)
					}
					cancel()
					exchangeProxy(t, conn)
					if err := <-done; err != nil {
						t.Fatal(err)
					}
				})
			}
		}
	}
}
func TestMTProxyObfuscatedTransportAndMediaDC(t *testing.T) {
	key := bytes.Repeat([]byte{0xab}, 16)
	for _, kind := range []string{"primary", "media", "cdn"} {
		for _, prefix := range []string{"", "dd"} {
			t.Run(kind+prefix, func(t *testing.T) {
				done := make(chan error, 1)
				resolver, err := newProxyResolver(&ProxyConfig{Type: "mtproxy", Host: "proxy.example", Port: 443, Secret: prefix + hex.EncodeToString(key)}, func(_ context.Context, _, address string) (net.Conn, error) {
					if address != "proxy.example:443" {
						return nil, errors.New("direct connection")
					}
					client, server := net.Pipe()
					go func() {
						defer server.Close()
						_ = server.SetDeadline(time.Now().Add(2 * time.Second))
						rw, meta, e := obfuscated2.Accept(server, key)
						expected := int16(2)
						if kind == "media" {
							expected = -2
						}
						if e == nil && (int16(meta.DC) != expected || meta.Protocol != [4]byte{0xdd, 0xdd, 0xdd, 0xdd}) {
							e = fmt.Errorf("wrong MTProxy routing: %+v", meta)
						}
						var b bin.Buffer
						if e == nil {
							e = (codec.PaddedIntermediate{}).Read(rw, &b)
						}
						if e == nil {
							e = (codec.PaddedIntermediate{}).Write(rw, &b)
						}
						done <- e
					}()
					return client, nil
				})
				if err != nil {
					t.Fatal(err)
				}
				conn, err := resolveProxy(resolver, context.Background(), kind, dcs.List{})
				if err != nil {
					t.Fatal(err)
				}
				exchangeProxy(t, conn)
				if err := <-done; err != nil {
					t.Fatal(err)
				}
			})
		}
	}
}
func TestProxyCancellationClosesStalledHandshake(t *testing.T) {
	for _, kind := range []string{"socks4", "socks5", "mtproxy"} {
		t.Run(kind, func(t *testing.T) {
			started := make(chan struct{})
			closed := make(chan error, 1)
			cfg := &ProxyConfig{Type: kind, Host: "proxy.example", Port: 1080, Secret: "ee" + strings.Repeat("ab", 16) + hex.EncodeToString([]byte("www.example.com"))}
			resolver, err := newProxyResolver(cfg, func(context.Context, string, string) (net.Conn, error) {
				c, s := net.Pipe()
				go func() {
					defer s.Close()
					b := make([]byte, 1)
					_, err := s.Read(b)
					close(started)
					if err == nil {
						_, err = io.Copy(io.Discard, s)
					}
					closed <- err
				}()
				return c, nil
			})
			if err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			result := make(chan error, 1)
			go func() {
				c, e := resolver.Primary(ctx, 2, proxyDC("primary", "149.154.167.51"))
				if c != nil {
					c.Close()
				}
				result <- e
			}()
			select {
			case <-started:
			case <-time.After(time.Second):
				t.Fatal("no handshake")
			}
			cancel()
			select {
			case e := <-result:
				if !errors.Is(e, context.Canceled) {
					t.Fatalf("cancel: %v", e)
				}
			case <-time.After(time.Second):
				t.Fatal("handshake did not cancel")
			}
			select {
			case <-closed:
			case <-time.After(time.Second):
				t.Fatal("socket leaked")
			}
		})
	}
}
func TestProxyRacedDestinationsJoinLoserWithoutClosingWinner(t *testing.T) {
	stalled := make(chan struct{})
	loserClosed := make(chan struct{})
	winnerDone := make(chan error, 1)
	resolver, err := newProxyResolver(&ProxyConfig{Type: "socks5", Host: "proxy.example", Port: 1080}, func(context.Context, string, string) (net.Conn, error) {
		c, s := net.Pipe()
		go func() {
			defer s.Close()
			target, e := readSOCKSRequest(s, "socks5", "", "")
			if e != nil {
				winnerDone <- e
				return
			}
			if strings.HasPrefix(target, "192.0.2.1:") {
				close(stalled)
				_, _ = io.Copy(io.Discard, s)
				close(loserClosed)
				return
			}
			<-stalled
			e = replySOCKS(s, "socks5")
			if e == nil {
				e = echoIntermediate(s)
			}
			winnerDone <- e
		}()
		return c, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	list := proxyDC("primary", "192.0.2.1")
	list.Options = append(list.Options, tg.DCOption{ID: 2, IPAddress: "192.0.2.2", Port: 443})
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	conn, err := resolver.Primary(ctx, 2, list)
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-loserClosed:
	case <-time.After(time.Second):
		t.Fatal("loser not joined")
	}
	exchangeProxy(t, conn)
	if err := <-winnerDone; err != nil {
		t.Fatal(err)
	}
}
func TestProxyRejectionNeverDialsDirect(t *testing.T) {
	var dials atomic.Int64
	done := make(chan error, 1)
	resolver, err := newProxyResolver(&ProxyConfig{Type: "socks5", Host: "proxy.example", Port: 1080, Username: "u", Password: "private-password"}, func(_ context.Context, _, addr string) (net.Conn, error) {
		dials.Add(1)
		if addr != "proxy.example:1080" {
			return nil, errors.New("direct dial")
		}
		c, s := net.Pipe()
		go func() {
			defer s.Close()
			var head [2]byte
			_, e := io.ReadFull(s, head[:])
			if e == nil {
				_, e = io.CopyN(io.Discard, s, int64(head[1]))
			}
			if e == nil {
				_, e = s.Write([]byte{5, 255})
			}
			if e == nil {
				_, e = io.Copy(io.Discard, s)
			}
			done <- e
		}()
		return c, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	conn, err := resolver.Primary(context.Background(), 2, proxyDC("primary", "149.154.167.51"))
	if conn != nil || err == nil || dials.Load() != 1 || strings.Contains(err.Error(), "private-password") {
		t.Fatalf("refusal: dials=%d err=%v", dials.Load(), err)
	}
	<-done
}
func TestNativeLoginClientActuallyConnectsThroughConfiguredProxy(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	host, portText, _ := net.SplitHostPort(listener.Addr().String())
	port, _ := strconv.Atoi(portText)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	observed := make(chan error, 1)
	serverDone := make(chan struct{})
	go func() {
		defer close(serverDone)
		c, e := listener.Accept()
		if e != nil {
			observed <- e
			return
		}
		defer c.Close()
		_ = c.SetDeadline(time.Now().Add(3 * time.Second))
		_, e = readSOCKSRequest(c, "socks5", "alice", "private")
		if e == nil {
			e = replySOCKS(c, "socks5")
		}
		var header [4]byte
		if e == nil {
			_, e = io.ReadFull(c, header[:])
		}
		if e == nil && header != [4]byte{0xee, 0xee, 0xee, 0xee} {
			e = errors.New("wrong native transport")
		}
		observed <- e
		<-ctx.Done()
	}()
	client, err := NewLoginClient(GotdConfig{AppID: 1, AppHash: "fixture", SessionPath: filepath.Join(t.TempDir(), "login.enc"), SessionSecret: "fixture", Proxy: &ProxyConfig{Type: "socks5", Host: host, Port: port, Username: "alice", Password: "private"}})
	if err != nil {
		t.Fatal(err)
	}
	ended := make(chan error, 1)
	go func() {
		ended <- client.Run(ctx, func(context.Context, LoginRPC) error { return errors.New("unexpected Telegram login completion") })
	}()
	select {
	case e := <-observed:
		if e != nil {
			t.Fatal(e)
		}
	case <-time.After(4 * time.Second):
		t.Fatal("login bypassed proxy")
	}
	cancel()
	select {
	case <-ended:
	case <-time.After(3 * time.Second):
		t.Fatal("login did not stop")
	}
	<-serverDone
}

func TestSOCKS5AuthenticationRefusalClosesSocket(t *testing.T) {
	closed := make(chan struct{})
	resolver, err := newProxyResolver(&ProxyConfig{Type: "socks5", Host: "proxy.example", Port: 1080, Username: "alice", Password: "private-password"}, func(context.Context, string, string) (net.Conn, error) {
		c, s := net.Pipe()
		go func() {
			defer close(closed)
			defer s.Close()
			_ = s.SetDeadline(time.Now().Add(time.Second))
			var head [2]byte
			if _, e := io.ReadFull(s, head[:]); e != nil {
				return
			}
			if _, e := io.CopyN(io.Discard, s, int64(head[1])); e != nil {
				return
			}
			if _, e := s.Write([]byte{5, 2}); e != nil {
				return
			}
			if _, e := io.ReadFull(s, head[:]); e != nil {
				return
			}
			if _, e := io.CopyN(io.Discard, s, int64(head[1])); e != nil {
				return
			}
			var n [1]byte
			if _, e := io.ReadFull(s, n[:]); e != nil {
				return
			}
			if _, e := io.CopyN(io.Discard, s, int64(n[0])); e != nil {
				return
			}
			_, _ = s.Write([]byte{1, 1})
			_, _ = io.Copy(io.Discard, s)
		}()
		return c, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	c, err := resolver.Primary(context.Background(), 2, proxyDC("primary", "149.154.167.51"))
	if err == nil || c != nil || strings.Contains(err.Error(), "private-password") {
		t.Fatal("invalid authentication result")
	}
	select {
	case <-closed:
	case <-time.After(time.Second):
		t.Fatal("refused socket leaked")
	}
}

func TestSOCKS5IPv6AndSnapshot(t *testing.T) {
	cfg := &ProxyConfig{Type: "socks5", Host: "proxy.example", Port: 1080}
	done := make(chan error, 1)
	resolver, err := newProxyResolver(cfg, func(_ context.Context, _, addr string) (net.Conn, error) {
		if addr != "proxy.example:1080" {
			return nil, errors.New("resolver configuration was mutated")
		}
		c, s := net.Pipe()
		go func() {
			defer s.Close()
			target, e := readSOCKSRequest(s, "socks5", "", "")
			if e == nil && target != "[2001:db8::2]:443" {
				e = errors.New("wrong IPv6 target")
			}
			if e == nil {
				e = replySOCKS(s, "socks5")
			}
			if e == nil {
				e = echoIntermediate(s)
			}
			done <- e
		}()
		return c, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	cfg.Host = "changed.example"
	c, err := resolver.Primary(context.Background(), 2, proxyDC("primary", "2001:db8::2"))
	if err != nil {
		t.Fatal(err)
	}
	exchangeProxy(t, c)
	if e := <-done; e != nil {
		t.Fatal(e)
	}
}

func BenchmarkNativeSOCKS5Handshake(b *testing.B) {
	done := make(chan error, 1)
	resolver, err := newProxyResolver(&ProxyConfig{Type: "socks5", Host: "proxy.example", Port: 1080}, func(context.Context, string, string) (net.Conn, error) {
		c, s := net.Pipe()
		go func() {
			defer s.Close()
			_, e := readSOCKSRequest(s, "socks5", "", "")
			if e == nil {
				e = replySOCKS(s, "socks5")
			}
			if e == nil {
				e = (codec.Intermediate{}).ReadHeader(s)
			}
			if e == nil {
				_, e = io.Copy(io.Discard, s)
			}
			done <- e
		}()
		return c, nil
	})
	if err != nil {
		b.Fatal(err)
	}
	list := proxyDC("primary", "149.154.167.51")
	ctx := context.Background()
	b.ReportAllocs()
	b.ResetTimer()
	for range b.N {
		c, e := resolver.Primary(ctx, 2, list)
		if e != nil {
			b.Fatal(e)
		}
		_ = c.Close()
		if e = <-done; e != nil {
			b.Fatal(e)
		}
	}
}
