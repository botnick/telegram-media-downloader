package telegram

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"io"
	"net"
	"testing"
	"time"

	"github.com/gotd/td/bin"
	"github.com/gotd/td/mtproxy/obfuscated2"
	"github.com/gotd/td/proto/codec"
	"github.com/gotd/td/telegram/dcs"
)

func tlsRecord(kind byte, b []byte) []byte {
	return append([]byte{kind, 3, 3, byte(len(b) >> 8), byte(len(b))}, b...)
}
func readTestTLSRecord(r io.Reader) (byte, []byte, error) {
	var h [5]byte
	if _, err := io.ReadFull(r, h[:]); err != nil {
		return 0, nil, err
	}
	b := make([]byte, int(binary.BigEndian.Uint16(h[3:])))
	_, err := io.ReadFull(r, b)
	return h[0], b, err
}

type testTLSStream struct {
	rw      io.ReadWriter
	pending []byte
}

func (s *testTLSStream) Read(b []byte) (int, error) {
	for len(s.pending) == 0 {
		kind, p, err := readTestTLSRecord(s.rw)
		if err != nil {
			return 0, err
		}
		if kind == 0x14 {
			continue
		}
		if kind != 0x17 {
			return 0, errors.New("expected application record")
		}
		s.pending = p
	}
	n := copy(b, s.pending)
	s.pending = s.pending[n:]
	return n, nil
}
func (s *testTLSStream) Write(b []byte) (int, error) {
	_, err := s.rw.Write(tlsRecord(0x17, b))
	if err != nil {
		return 0, err
	}
	return len(b), nil
}

func TestMTProxyFakeTLSHandshakeDataAndMalformedReply(t *testing.T) {
	key := bytes.Repeat([]byte{0xab}, 16)
	for _, mode := range []string{"valid", "short", "short-complete", "wrong-type", "bad-digest", "oversized"} {
		t.Run(mode, func(t *testing.T) {
			done := make(chan error, 1)
			resolver, err := newProxyResolver(&ProxyConfig{Type: "mtproxy", Host: "proxy.example", Port: 443, Secret: "ee" + hex.EncodeToString(key) + hex.EncodeToString([]byte("www.example.com"))}, func(context.Context, string, string) (net.Conn, error) {
				c, s := net.Pipe()
				go func() {
					defer s.Close()
					_ = s.SetDeadline(time.Now().Add(2 * time.Second))
					kind, hello, e := readTestTLSRecord(s)
					if e != nil {
						done <- e
						return
					}
					if kind != 0x16 || len(hello) < 38 || !bytes.Contains(hello, []byte("www.example.com")) {
						done <- errors.New("wrong client hello or SNI")
						return
					}
					switch mode {
					case "short-complete":
						packet := tlsRecord(0x16, []byte{0})
						packet = append(packet, tlsRecord(0x14, []byte{1})...)
						packet = append(packet, tlsRecord(0x17, []byte{0})...)
						_, e = s.Write(packet)
						done <- e
						return
					case "short":
						_, e = s.Write(tlsRecord(0x16, []byte{0}))
						done <- e
						return
					case "wrong-type":
						_, e = s.Write(tlsRecord(0x17, make([]byte, 38)))
						done <- e
						return
					case "oversized":
						_, e = s.Write([]byte{0x16, 3, 3, 0xff, 0xff})
						done <- e
						return
					}
					serverHello := make([]byte, 38)
					serverHello[0] = 2
					serverHello[3] = 34
					serverHello[4] = 3
					serverHello[5] = 3
					reply := tlsRecord(0x16, serverHello)
					reply = append(reply, tlsRecord(0x14, []byte{1})...)
					reply = append(reply, tlsRecord(0x17, []byte("fixture"))...)
					mac := hmac.New(sha256.New, key)
					mac.Write(hello[6:38])
					mac.Write(reply)
					copy(reply[11:43], mac.Sum(nil))
					if mode == "bad-digest" {
						reply[11] ^= 1
					}
					if _, e = s.Write(reply); e != nil {
						done <- e
						return
					}
					if mode == "bad-digest" {
						done <- nil
						return
					}
					stream := &testTLSStream{rw: s}
					rw, meta, e := obfuscated2.Accept(stream, key)
					if e == nil && int16(meta.DC) != -2 {
						e = errors.New("FakeTLS media DC not negative")
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
				return c, nil
			})
			if err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			conn, err := resolver.MediaOnly(ctx, 2, dcs.List{})
			if mode == "valid" {
				if err != nil {
					t.Fatal(err)
				}
				exchangeProxy(t, conn)
			} else if err == nil || conn != nil {
				t.Fatal("malformed proxy response accepted")
			}
			if e := <-done; e != nil && mode == "valid" {
				t.Fatal(e)
			}
		})
	}
}
