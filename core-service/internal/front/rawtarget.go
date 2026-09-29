package front

import (
	"bytes"
	"io"
	"net"
	"strconv"
)

// Node's HTTP parser accepts a request target with a malformed
// percent-escape (GET /files/%E0%A4%A) and the app answers it — /files
// with 400 "Bad request", Express's router with its decode error —
// while Go's net/http refuses such a target with a bare 400 before any
// handler runs. rawTargetListener lets those requests through: on the
// way in it rewrites each stray '%' of the request line's path to "%25"
// (so net/http parses it) and adds a header, whose name carries a
// per-process random suffix no client can guess, holding the original
// target. ServeHTTP restores it and the request goes to Node verbatim.
//
// To find request lines on a keep-alive connection it follows the
// framing: headers up to the blank line, then a Content-Length body.
// Anything it can't follow exactly — Transfer-Encoding, an unusual
// Content-Length, folded headers, CONNECT, an upgrade — switches the
// connection to plain pass-through, i.e. to net/http's own behaviour.
// Requests with well-formed targets are never changed.

const maxRawLine = 64 << 10

type rawTargetListener struct {
	net.Listener
	header string // "X-Tgdl-Raw-<random>"
}

func (l *rawTargetListener) Accept() (net.Conn, error) {
	c, err := l.Listener.Accept()
	if err != nil {
		return nil, err
	}
	return &rawTargetConn{Conn: c, header: l.header}, nil
}

const (
	rtLine = iota
	rtHeaders
	rtBody
	rtPass
)

type rawTargetConn struct {
	net.Conn
	header string

	state    int
	out      []byte // transformed bytes not yet returned by Read
	line     []byte // the line being collected (request line / header)
	bodyLeft int64
	buf      [16 << 10]byte

	// the header block being read
	method   string
	cl       int64
	clSeen   bool
	passNext bool // switch to pass-through after this header block
}

func (c *rawTargetConn) Read(p []byte) (int, error) {
	for len(c.out) == 0 {
		switch c.state {
		case rtPass:
			return c.Conn.Read(p)
		case rtBody:
			if int64(len(p)) > c.bodyLeft {
				p = p[:c.bodyLeft]
			}
			n, err := c.Conn.Read(p)
			c.bodyLeft -= int64(n)
			if c.bodyLeft == 0 {
				c.state = rtLine
			}
			return n, err
		}
		n, err := c.Conn.Read(c.buf[:])
		c.feed(c.buf[:n])
		if len(c.out) > 0 {
			break
		}
		if err != nil {
			if len(c.line) > 0 { // a partial line at EOF: hand it over as is
				c.out, c.line = c.line, nil
				break
			}
			return 0, err
		}
	}
	n := copy(p, c.out)
	c.out = c.out[n:]
	if len(c.out) == 0 {
		c.out = nil
	}
	return n, nil
}

// feed runs the framing state machine over bytes read from the client.
func (c *rawTargetConn) feed(b []byte) {
	for len(b) > 0 {
		switch c.state {
		case rtPass:
			c.out = append(c.out, b...)
			return
		case rtBody:
			n := int64(len(b))
			if n > c.bodyLeft {
				n = c.bodyLeft
			}
			c.out = append(c.out, b[:n]...)
			b = b[n:]
			c.bodyLeft -= n
			if c.bodyLeft == 0 {
				c.state = rtLine
			}
			continue
		}
		i := bytes.IndexByte(b, '\n')
		if i < 0 {
			c.line = append(c.line, b...)
			if len(c.line) > maxRawLine {
				c.out = append(c.out, c.line...)
				c.line = nil
				c.state = rtPass
			}
			return
		}
		c.line = append(c.line, b[:i+1]...)
		b = b[i+1:]
		line := c.line
		c.line = nil
		if c.state == rtLine {
			c.requestLine(line)
		} else {
			c.headerLine(line)
		}
	}
}

func (c *rawTargetConn) requestLine(line []byte) {
	c.out = append(c.out, line...)
	content := bytes.TrimRight(line, "\r\n")
	if len(content) == 0 {
		return // stray blank line before a request: net/http decides
	}
	c.state = rtHeaders
	c.method, c.cl, c.clSeen, c.passNext = "", 0, false, false
	method, rest, ok1 := bytes.Cut(content, []byte(" "))
	target, _, ok2 := bytes.Cut(rest, []byte(" "))
	if !ok1 || !ok2 {
		c.passNext = true
		return
	}
	c.method = string(method)
	if c.method == "CONNECT" {
		c.passNext = true
	}
	fixed, changed := fixPercents(target)
	if !changed {
		return
	}
	// The line net/http parses, then the header with the original target.
	c.out = c.out[:len(c.out)-len(line)]
	c.out = append(c.out, method...)
	c.out = append(c.out, ' ')
	c.out = append(c.out, fixed...)
	c.out = append(c.out, content[len(method)+1+len(target):]...)
	c.out = append(c.out, "\r\n"...)
	c.out = append(c.out, c.header...)
	c.out = append(c.out, ": "...)
	c.out = append(c.out, target...)
	c.out = append(c.out, "\r\n"...)
}

func (c *rawTargetConn) headerLine(line []byte) {
	c.out = append(c.out, line...)
	content := bytes.TrimRight(line, "\r\n")
	if len(content) == 0 { // end of the header block
		switch {
		case c.passNext:
			c.state = rtPass
		case c.cl > 0:
			c.state, c.bodyLeft = rtBody, c.cl
		default:
			c.state = rtLine
		}
		return
	}
	if content[0] == ' ' || content[0] == '\t' {
		c.passNext = true // obsolete line folding
		return
	}
	name, value, ok := bytes.Cut(content, []byte(":"))
	if !ok {
		c.passNext = true
		return
	}
	value = bytes.Trim(value, " \t")
	switch {
	case bytes.EqualFold(name, []byte("Content-Length")):
		n, err := strconv.ParseInt(string(value), 10, 64)
		if c.clSeen || err != nil || n < 0 || len(value) == 0 || value[0] == '+' {
			c.passNext = true
			return
		}
		c.cl, c.clSeen = n, true
	case bytes.EqualFold(name, []byte("Transfer-Encoding")), bytes.EqualFold(name, []byte("Upgrade")):
		c.passNext = true
	}
}

// fixPercents rewrites every '%' of an origin-form target's path that
// doesn't start a valid escape to "%25". changed is false when there is
// nothing to fix (or the target isn't origin-form).
func fixPercents(target []byte) ([]byte, bool) {
	if len(target) == 0 || target[0] != '/' || bytes.HasPrefix(target, []byte("//")) {
		return nil, false
	}
	path, query, hasQuery := bytes.Cut(target, []byte("?"))
	bad := false
	for i := 0; i < len(path); i++ {
		if path[i] == '%' && (i+2 >= len(path) || !isHex(path[i+1]) || !isHex(path[i+2])) {
			bad = true
			break
		}
	}
	if !bad {
		return nil, false
	}
	out := make([]byte, 0, len(target)+8)
	for i := 0; i < len(path); i++ {
		if path[i] == '%' && (i+2 >= len(path) || !isHex(path[i+1]) || !isHex(path[i+2])) {
			out = append(out, "%25"...)
			continue
		}
		out = append(out, path[i])
	}
	if hasQuery {
		out = append(out, '?')
		out = append(out, query...)
	}
	return out, true
}

func isHex(b byte) bool {
	return b >= '0' && b <= '9' || b >= 'a' && b <= 'f' || b >= 'A' && b <= 'F'
}

// ReadFrom keeps net/http's sendfile path (it looks for io.ReaderFrom on
// the connection).
func (c *rawTargetConn) ReadFrom(r io.Reader) (int64, error) {
	if rf, ok := c.Conn.(io.ReaderFrom); ok {
		return rf.ReadFrom(r)
	}
	return io.Copy(writerOnly{c.Conn}, r)
}

// CloseWrite is used by net/http's lingering close and the upgrade tunnel.
func (c *rawTargetConn) CloseWrite() error {
	if cw, ok := c.Conn.(interface{ CloseWrite() error }); ok {
		return cw.CloseWrite()
	}
	return c.Conn.Close()
}

type writerOnly struct{ io.Writer }
