package main

import (
	"bufio"
	"bytes"
	"net"
	"sync"
)

// sanitizeConn lets malformed percent escapes reach the application's normal
// error path. net/http otherwise rejects the request before Handler runs,
// which would skip the dashboard security headers and media error contract.
type sanitizeConn struct {
	net.Conn
	once    sync.Once
	reader  *bufio.Reader
	pending []byte
	err     error
}

func (c *sanitizeConn) Read(p []byte) (int, error) {
	c.once.Do(func() {
		c.reader = bufio.NewReader(c.Conn)
		head, err := c.reader.ReadBytes('\n')
		if err != nil {
			c.err = err
			return
		}
		c.pending = sanitizeRequestLine(head)
	})
	if len(c.pending) > 0 {
		n := copy(p, c.pending)
		c.pending = c.pending[n:]
		return n, nil
	}
	if c.err != nil {
		readErr := c.err
		c.err = nil
		return 0, readErr
	}
	return c.reader.Read(p)
}

func sanitizeRequestLine(line []byte) []byte {
	space := bytes.IndexByte(line, ' ')
	if space < 0 {
		return line
	}
	end := bytes.IndexByte(line[space+1:], ' ')
	if end < 0 {
		return line
	}
	end += space + 1
	var out bytes.Buffer
	out.Grow(len(line))
	out.Write(line[:space+1])
	for i := space + 1; i < end; i++ {
		if line[i] == '%' && (i+2 >= end || !isHex(line[i+1]) || !isHex(line[i+2])) {
			out.WriteString("%25")
			continue
		}
		out.WriteByte(line[i])
	}
	out.Write(line[end:])
	return out.Bytes()
}

func isHex(c byte) bool {
	return c >= '0' && c <= '9' || c >= 'a' && c <= 'f' || c >= 'A' && c <= 'F'
}

type sanitizeListener struct{ net.Listener }

func (l sanitizeListener) Accept() (net.Conn, error) {
	c, err := l.Listener.Accept()
	if err != nil {
		return nil, err
	}
	return &sanitizeConn{Conn: c}, nil
}
