package telegram

import (
	"encoding/binary"
	"errors"
	"io"
	"net"
)

// The pinned FakeTLS parser assumes its three ServerHello records contain a
// 32-byte digest at offset 11. Validate the untrusted record envelope before
// passing it to that parser; malformed records fail before digest processing.
// After this bounded prefix is consumed the socket streams normally.
type proxyTLSConn struct {
	net.Conn
	checked bool
	prefix  []byte
}

func (c *proxyTLSConn) Read(b []byte) (int, error) {
	if len(b) == 0 {
		return 0, nil
	}
	if !c.checked {
		var prefix []byte
		for n, want := range []byte{0x16, 0x14, 0x17} {
			var header [5]byte
			if _, err := io.ReadFull(c.Conn, header[:]); err != nil {
				return 0, err
			}
			size := int(binary.BigEndian.Uint16(header[3:]))
			if header[0] != want || header[1] != 3 || size > 18432 || n == 0 && size < 38 || n == 1 && size != 1 {
				return 0, errors.New("invalid MTProxy TLS handshake record")
			}
			offset := len(prefix)
			prefix = append(prefix, header[:]...)
			prefix = append(prefix, make([]byte, size)...)
			if _, err := io.ReadFull(c.Conn, prefix[offset+5:]); err != nil {
				return 0, err
			}
		}
		c.prefix = prefix
		c.checked = true
	}
	if len(c.prefix) > 0 {
		n := copy(b, c.prefix)
		if n == len(c.prefix) {
			c.prefix = nil
		} else {
			c.prefix = c.prefix[n:]
		}
		return n, nil
	}
	return c.Conn.Read(b)
}
