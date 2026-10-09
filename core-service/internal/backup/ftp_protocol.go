package backup

import (
	"bufio"
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"net"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

// This client deliberately uses machine-readable RFC 3659 listings. It never
// guesses file types from LIST text or changes the configured TLS policy.
type ftpProblem string

func (e ftpProblem) Error() string { return string(e) }

type ftpReplyError struct{ code int }

func (e *ftpReplyError) Error() string { return fmt.Sprintf("FTP server returned status %d", e.code) }

type ftpSession struct {
	ctx         context.Context // assigned by the provider's operation gate
	conn        net.Conn
	reader      *bufio.Reader
	peer        string
	tls         *tls.Config
	passive     string
	timeout     time.Duration
	mu          sync.Mutex
	closed      bool
	connections map[*ftpWire]bool
}
type ftpWire struct {
	net.Conn
	session *ftpSession
	control bool
}

func (c *ftpWire) Read(b []byte) (int, error) {
	if err := c.deadline(true); err != nil {
		return 0, err
	}
	return c.Conn.Read(b)
}
func (c *ftpWire) Write(b []byte) (int, error) {
	if err := c.deadline(false); err != nil {
		return 0, err
	}
	return c.Conn.Write(b)
}
func (c *ftpWire) deadline(read bool) error {
	if c.control {
		return nil
	}
	deadline := time.Now().Add(c.session.timeout)
	if read {
		return c.Conn.SetReadDeadline(deadline)
	}
	return c.Conn.SetWriteDeadline(deadline)
}
func (c *ftpWire) Close() error {
	err := c.Conn.Close()
	c.session.mu.Lock()
	delete(c.session.connections, c)
	c.session.mu.Unlock()
	return err
}
func (c *ftpSession) track(raw net.Conn, control bool) (net.Conn, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		_ = raw.Close()
		return nil, ftpProblem("FTP session is closed")
	}
	w := &ftpWire{raw, c, control}
	c.connections[w] = true
	return w, nil
}
func (c *ftpSession) close() {
	c.mu.Lock()
	c.closed = true
	// Close the raw transports without callbacks under the registry mutex.
	for w := range c.connections {
		_ = w.Conn.Close()
	}
	clear(c.connections)
	c.mu.Unlock()
}
func ftpSafeArgument(s string) bool {
	return len(s) <= 8192 && utf8.ValidString(s) && !strings.ContainsAny(s, "\x00\r\n")
}

func (c *ftpSession) reply() (int, []string, error) {
	lines := []string{}
	total := 0
	code := 0
	multi := false
	for {
		if err := c.ctx.Err(); err != nil {
			return 0, nil, err
		}
		line, err := c.reader.ReadSlice('\n')
		if err != nil {
			return 0, nil, err
		}
		total += len(line)
		if total > 64<<10 {
			return 0, nil, ftpProblem("FTP reply exceeds 64 KiB")
		}
		if len(line) < 2 || line[len(line)-2] != '\r' {
			return 0, nil, ftpProblem("FTP reply is not CRLF terminated")
		}
		s := string(line[:len(line)-2])
		lines = append(lines, s)
		if code == 0 {
			if len(s) < 4 || s[0] < '1' || s[0] > '5' || s[1] < '0' || s[1] > '9' || s[2] < '0' || s[2] > '9' || s[3] != ' ' && s[3] != '-' {
				return 0, nil, ftpProblem("invalid FTP reply")
			}
			code, _ = strconv.Atoi(s[:3])
			multi = s[3] == '-'
			if !multi {
				return code, lines, nil
			}
		} else if strings.HasPrefix(s, fmt.Sprintf("%03d ", code)) {
			return code, lines, nil
		}
	}
}
func (c *ftpSession) command(verb, arg string) (int, []string, error) {
	if !ftpSafeArgument(arg) {
		return 0, nil, ftpProblem("invalid FTP command argument")
	}
	if err := c.ctx.Err(); err != nil {
		return 0, nil, err
	}
	if err := c.conn.SetDeadline(time.Now().Add(c.timeout)); err != nil {
		return 0, nil, err
	}
	line := verb
	if arg != "" {
		line += " " + arg
	}
	line += "\r\n"
	if err := payloadWrite(c.conn, []byte(line)); err != nil {
		return 0, nil, err
	}
	return c.reply()
}
func (c *ftpSession) expect(verb, arg string, codes ...int) error {
	code, _, err := c.command(verb, arg)
	if err != nil {
		return err
	}
	for _, want := range codes {
		if code == want {
			return nil
		}
	}
	return &ftpReplyError{code}
}
func (c *ftpSession) connect(settings ftpSettings) error {
	raw, err := (&net.Dialer{Timeout: c.timeout, KeepAlive: 30 * time.Second}).DialContext(c.ctx, "tcp", settings.address)
	if err != nil {
		return err
	}
	addr := raw.RemoteAddr().(*net.TCPAddr)
	c.peer = addr.IP.String()
	if addr.Zone != "" {
		c.peer += "%" + addr.Zone
	}
	c.conn, err = c.track(raw, true)
	if err != nil {
		return err
	}
	if err = c.conn.SetDeadline(time.Now().Add(c.timeout)); err != nil {
		return err
	}
	if settings.secure == "true" {
		t := tls.Client(c.conn, c.tls)
		handshakeCtx, cancel := context.WithTimeout(c.ctx, c.timeout)
		err = t.HandshakeContext(handshakeCtx)
		cancel()
		if err != nil {
			return err
		}
		c.conn = t
	}
	c.reader = bufio.NewReaderSize(c.conn, 8192)
	code, _, err := c.reply()
	if err != nil {
		return err
	}
	if code != 220 {
		return &ftpReplyError{code}
	}
	if settings.secure == "control" {
		if err = c.expect("AUTH", "TLS", 234); err != nil {
			return err
		}
		t := tls.Client(c.conn, c.tls)
		handshakeCtx, cancel := context.WithTimeout(c.ctx, c.timeout)
		err = t.HandshakeContext(handshakeCtx)
		cancel()
		if err != nil {
			return err
		}
		c.conn = t
		c.reader = bufio.NewReaderSize(t, 8192)
	}
	code, _, err = c.command("USER", settings.username)
	if err != nil {
		return err
	}
	if code == 331 {
		if err = c.expect("PASS", settings.password, 230); err != nil {
			return err
		}
	} else if code != 230 {
		return &ftpReplyError{code}
	}
	if c.tls != nil {
		if err = c.expect("PBSZ", "0", 200); err != nil {
			return err
		}
		if err = c.expect("PROT", "P", 200); err != nil {
			return err
		}
	}
	code, features, err := c.command("FEAT", "")
	if err != nil {
		return err
	}
	if code != 211 {
		return ftpProblem("FTP backup requires RFC 3659 MLST/MLSD support")
	}
	mlst, utf8Support := false, false
	for _, line := range features {
		f := strings.Fields(strings.TrimSpace(line))
		if len(f) > 0 {
			switch strings.ToUpper(f[0]) {
			case "MLST":
				mlst = true
			case "UTF8":
				utf8Support = true
			}
		}
	}
	if !mlst {
		return ftpProblem("FTP backup requires RFC 3659 MLST/MLSD support")
	}
	if utf8Support {
		if err = c.expect("OPTS", "UTF8 ON", 200, 202); err != nil {
			return err
		}
	}
	return c.expect("TYPE", "I", 200)
}

func ftpDigits(value string) bool {
	if value == "" {
		return false
	}
	for _, v := range value {
		if v < '0' || v > '9' {
			return false
		}
	}
	return true
}

func ftpPassivePort(message string, extended bool) (int, error) {
	start, end := strings.LastIndex(message, "("), strings.LastIndex(message, ")")
	if start < 0 || end <= start {
		return 0, ftpProblem("invalid FTP passive response")
	}
	body := message[start+1 : end]
	port := 0
	if extended {
		if len(body) < 5 || body[0] < 33 || body[0] > 126 || body[0] != body[1] || body[0] != body[2] || body[len(body)-1] != body[0] {
			return 0, ftpProblem("invalid FTP extended passive response")
		}
		digits := body[3 : len(body)-1]
		if !ftpDigits(digits) {
			return 0, ftpProblem("invalid FTP passive port")
		}
		var err error
		port, err = strconv.Atoi(digits)
		if err != nil {
			return 0, ftpProblem("invalid FTP passive port")
		}
	} else {
		parts := strings.Split(body, ",")
		if len(parts) != 6 {
			return 0, ftpProblem("invalid FTP passive response")
		}
		for i, part := range parts {
			if !ftpDigits(part) {
				return 0, ftpProblem("invalid FTP passive octet")
			}
			v, e := strconv.Atoi(part)
			if e != nil || v < 0 || v > 255 {
				return 0, ftpProblem("invalid FTP passive octet")
			}
			if i == 4 {
				port = v * 256
			}
			if i == 5 {
				port += v
			}
		}
	}
	if port < 1 || port > 65535 {
		return 0, ftpProblem("invalid FTP passive port")
	}
	return port, nil
}
func (c *ftpSession) data(verb, name string) (net.Conn, error) {
	extended := c.passive == "epsv" || c.passive == "auto" && strings.Contains(c.peer, ":")
	command, want := "PASV", 227
	if extended {
		command, want = "EPSV", 229
	}
	code, lines, err := c.command(command, "")
	if err != nil {
		return nil, err
	}
	if code != want {
		return nil, &ftpReplyError{code}
	}
	port, err := ftpPassivePort(lines[len(lines)-1], extended)
	if err != nil {
		return nil, err
	}
	// Never connect to a host supplied in a PASV reply. Use the already
	// authenticated control peer; this also handles ordinary NAT servers.
	raw, err := (&net.Dialer{Timeout: c.timeout}).DialContext(c.ctx, "tcp", net.JoinHostPort(c.peer, strconv.Itoa(port)))
	if err != nil {
		return nil, err
	}
	conn, err := c.track(raw, false)
	if err != nil {
		return nil, err
	}
	code, _, err = c.command(verb, name)
	if err != nil {
		_ = conn.Close()
		return nil, err
	}
	if code != 125 && code != 150 {
		_ = conn.Close()
		return nil, &ftpReplyError{code}
	}
	if c.tls != nil {
		t := tls.Client(conn, c.tls)
		handshakeCtx, cancel := context.WithTimeout(c.ctx, c.timeout)
		err = t.HandshakeContext(handshakeCtx)
		cancel()
		if err != nil {
			_ = conn.Close()
			return nil, err
		}
		conn = t
	}
	return conn, nil
}
func (c *ftpSession) finishData(conn net.Conn, err error) error {
	err = errors.Join(err, conn.Close())
	if err != nil {
		return err
	}
	if err = c.conn.SetDeadline(time.Now().Add(c.timeout)); err != nil {
		return err
	}
	code, _, err := c.reply()
	if err != nil {
		return err
	}
	if code != 226 && code != 250 {
		return &ftpReplyError{code}
	}
	return nil
}

type ftpEntry struct {
	name, kind string
	size       int64
	modified   time.Time
}

func parseFTPEntry(line string) (ftpEntry, error) {
	var entry ftpEntry
	facts, name, ok := strings.Cut(line, " ")
	if !ok || !strings.HasSuffix(facts, ";") || name == "" {
		return entry, ftpProblem("malformed FTP machine listing")
	}
	entry.name = name
	seen := map[string]bool{}
	for _, fact := range strings.Split(strings.TrimSuffix(facts, ";"), ";") {
		key, value, ok := strings.Cut(fact, "=")
		key = strings.ToLower(key)
		if !ok || key == "" || seen[key] || len(seen) >= 64 {
			return entry, ftpProblem("invalid FTP listing facts")
		}
		seen[key] = true
		switch key {
		case "type":
			entry.kind = strings.ToLower(value)
		case "size":
			n, err := strconv.ParseInt(value, 10, 64)
			if err != nil || n < 0 {
				return entry, ftpProblem("invalid FTP file size")
			}
			entry.size = n
		case "modify":
			v, err := time.Parse("20060102150405.999999999", value)
			if err != nil {
				return entry, ftpProblem("invalid FTP modification time")
			}
			entry.modified = v
		}
	}
	if entry.kind == "cdir" || entry.kind == "pdir" {
		return entry, nil
	}
	if err := validObject(name); err != nil || name == "." || strings.Contains(name, "/") || !ftpSafeArgument(name) {
		return entry, ftpProblem("unsafe FTP listing name")
	}
	switch {
	case entry.kind == "file":
		if !seen["size"] {
			return entry, ftpProblem("FTP file listing lacks size")
		}
	case entry.kind == "dir":
	case strings.HasPrefix(entry.kind, "os.unix=slink"), strings.HasPrefix(entry.kind, "os.unix=symlink"):
		entry.kind = "link"
	default:
		return entry, ftpProblem("unsupported FTP listing type")
	}
	return entry, nil
}
func (c *ftpSession) entries(dir string, visit func(ftpEntry) error) error {
	conn, err := c.data("MLSD", dir)
	if err != nil {
		return err
	}
	limited := &io.LimitedReader{R: conn, N: 64 << 20}
	scanner := bufio.NewScanner(limited)
	scanner.Buffer(make([]byte, 8192), 8192)
	count := 0
	seen := map[string]bool{}
	for scanner.Scan() {
		if count++; count > 100000 {
			err = ftpProblem("FTP directory exceeds 100000 entries")
			break
		}
		var entry ftpEntry
		entry, err = parseFTPEntry(scanner.Text())
		if err != nil {
			break
		}
		if entry.kind == "cdir" || entry.kind == "pdir" {
			continue
		}
		if seen[entry.name] {
			err = ftpProblem("duplicate FTP directory entry")
			break
		}
		seen[entry.name] = true
		if err = visit(entry); err != nil {
			break
		}
	}
	if err == nil {
		err = scanner.Err()
	}
	if err == nil && limited.N == 0 {
		err = ftpProblem("FTP directory exceeds 64 MiB")
	}
	return c.finishData(conn, err)
}
