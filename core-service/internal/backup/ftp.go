package backup

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"path"
	"strconv"
	"strings"
	"sync"
	"time"
)

type ftpSettings struct {
	address, username, password, root, secure, passive string
	tls                                                *tls.Config
}
type ftpProvider struct {
	settings ftpSettings
	ctx      context.Context
	cancel   context.CancelFunc
	mu       sync.Mutex
	closed   bool
	wg       sync.WaitGroup
	gate     chan struct{}
	session  *ftpSession // operation gate owns this pointer
	timeout  time.Duration
	journal  *transferJournal
}

func newFTP(cfg map[string]any) (*ftpProvider, error) {
	host := strings.Trim(strings.TrimSpace(text(cfg["host"])), "[]")
	if host == "" || strings.ContainsAny(host, "/\\\x00\r\n\t ") {
		return nil, ftpProblem("invalid FTP host")
	}
	secure := ""
	switch value := cfg["secure"].(type) {
	case nil:
	case string:
		secure = value
	case bool:
		secure = strconv.FormatBool(value)
	default:
		return nil, ftpProblem("invalid FTP TLS mode")
	}
	if secure == "" {
		secure = "false"
	}
	if secure != "false" && secure != "control" && secure != "true" {
		return nil, ftpProblem("invalid FTP TLS mode")
	}
	port := 21
	if secure == "true" {
		port = 990
	}
	if v, ok := cfg["port"]; ok && v != nil && v != "" {
		port = integer(v, 0)
	}
	if port < 1 || port > 65535 {
		return nil, ftpProblem("invalid FTP port")
	}
	username := text(cfg["username"])
	if username == "" {
		username = text(cfg["user"])
	}
	if username == "" {
		username = "anonymous"
	}
	password := text(cfg["password"])
	if !ftpSafeArgument(username) || !ftpSafeArgument(password) {
		return nil, ftpProblem("invalid FTP credentials")
	}
	root := strings.TrimRight(text(cfg["remoteRoot"]), "/")
	if root == "" {
		root = "/"
	}
	if !path.IsAbs(root) || path.Clean(root) != root || strings.Contains(root, "\\") || !ftpSafeArgument(root) {
		return nil, ftpProblem("remoteRoot must be a clean absolute POSIX path")
	}
	passive := text(cfg["passiveMode"])
	if passive == "" {
		passive = "auto"
	}
	if passive != "auto" && passive != "epsv" && passive != "pasv" {
		return nil, ftpProblem("invalid FTP passive mode")
	}
	var tlsConfig *tls.Config
	if secure != "false" {
		tlsConfig = &tls.Config{ServerName: host, MinVersion: tls.VersionTLS12, ClientSessionCache: tls.NewLRUClientSessionCache(8)}
		if pem := text(cfg["tlsCA"]); pem != "" {
			pool := x509.NewCertPool()
			if !pool.AppendCertsFromPEM([]byte(pem)) {
				return nil, ftpProblem("invalid FTP CA certificate")
			}
			tlsConfig.RootCAs = pool
		}
	} else if text(cfg["tlsCA"]) != "" {
		return nil, ftpProblem("FTP CA certificate requires a TLS mode")
	}
	ctx, cancel := context.WithCancel(context.Background())
	return &ftpProvider{settings: ftpSettings{net.JoinHostPort(host, strconv.Itoa(port)), username, password, root, secure, passive, tlsConfig}, ctx: ctx, cancel: cancel, gate: make(chan struct{}, 1), timeout: remoteIdleTimeout}, nil
}
func ftpError(ctx context.Context, op string, err error) error {
	if err == nil {
		return nil
	}
	if ctx.Err() != nil {
		return fmt.Errorf("FTP %s: %w", op, ctx.Err())
	}
	var policy ftpProblem
	if errors.As(err, &policy) {
		return fmt.Errorf("FTP %s: %w", op, policy)
	}
	var status *ftpReplyError
	if errors.As(err, &status) {
		return fmt.Errorf("FTP %s: %w", op, status)
	}
	var verify *tls.CertificateVerificationError
	if errors.As(err, &verify) {
		return fmt.Errorf("FTP %s: TLS certificate verification failed", op)
	}
	if errors.Is(err, fs.ErrNotExist) {
		return fmt.Errorf("FTP %s: %w", op, fs.ErrNotExist)
	}
	var timeout net.Error
	if errors.As(err, &timeout) && timeout.Timeout() {
		return fmt.Errorf("FTP %s: network timeout", op)
	}
	// Do not echo server replies, credentials, TLS certificate names or paths.
	return fmt.Errorf("FTP %s failed", op)
}
func (p *ftpProvider) with(ctx context.Context, op string, prepare func(context.Context) error, fn func(context.Context, *ftpSession) error) (err error) {
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		return ftpProblem("FTP provider is closed")
	}
	p.wg.Add(1)
	p.mu.Unlock()
	defer p.wg.Done()
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	stopLife := context.AfterFunc(p.ctx, cancel)
	defer stopLife()
	select {
	case p.gate <- struct{}{}:
		defer func() { <-p.gate }()
	case <-ctx.Done():
		return ctx.Err()
	}
	if err = ctx.Err(); err != nil {
		return err
	}
	if prepare != nil {
		if err = prepare(ctx); err != nil {
			return err
		}
	}
	connecting := p.session == nil
	if connecting {
		p.session = &ftpSession{ctx: ctx, tls: p.settings.tls, passive: p.settings.passive, timeout: p.timeout, connections: map[*ftpWire]bool{}}
	}
	c := p.session
	c.ctx = ctx
	stopped := make(chan struct{})
	stop := context.AfterFunc(ctx, func() { c.close(); close(stopped) })
	defer func() {
		if !stop() {
			<-stopped
		}
		if ctx.Err() != nil {
			err = ctx.Err()
		}
		if err != nil {
			c.close()
			p.session = nil
		}
		err = ftpError(ctx, op, err)
	}()
	if connecting {
		if err = c.connect(p.settings); err != nil {
			return err
		}
	}
	return fn(ctx, c)
}
func (p *ftpProvider) Close() error {
	p.mu.Lock()
	p.closed = true
	p.cancel()
	p.mu.Unlock()
	p.wg.Wait()
	// Close can be called repeatedly/concurrently; serialize the idle pointer.
	p.gate <- struct{}{}
	if p.session != nil {
		p.session.close()
		p.session = nil
	}
	<-p.gate
	return nil
}
func ftpObject(name string) error {
	if err := validObject(name); err != nil || name == "." || !ftpSafeArgument(name) {
		return ftpProblem("invalid FTP object path")
	}
	return nil
}
func (c *ftpSession) lookup(dir, name string) (*ftpEntry, error) {
	var found *ftpEntry
	err := c.entries(dir, func(e ftpEntry) error {
		if e.name == name {
			if found != nil {
				return ftpProblem("duplicate FTP directory entry")
			}
			found = &e
		}
		return nil
	})
	return found, err
}
func (c *ftpSession) directory(full string, create bool) error {
	current := "/"
	for _, part := range strings.Split(strings.TrimPrefix(full, "/"), "/") {
		if part == "" {
			continue
		}
		entry, err := c.lookup(current, part)
		if err != nil {
			return err
		}
		next := path.Join(current, part)
		if entry == nil {
			if !create {
				return fs.ErrNotExist
			}
			mkErr := c.expect("MKD", next, 257)
			if mkErr != nil {
				var reply *ftpReplyError
				if !errors.As(mkErr, &reply) {
					return mkErr
				}
			}
			// Confirm creation, including a competing mkdir. A 550 alone never
			// establishes either absence or an existing accessible directory.
			entry, err = c.lookup(current, part)
			if err != nil {
				return err
			}
			if entry == nil {
				if mkErr != nil {
					return mkErr
				}
				return ftpProblem("FTP directory not visible after creation")
			}
		}
		if entry.kind != "dir" {
			return ftpProblem("FTP path component is not a directory")
		}
		current = next
	}
	return nil
}
func (p *ftpProvider) file(c *ftpSession, name string, create bool) (string, *ftpEntry, error) {
	if err := ftpObject(name); err != nil {
		return "", nil, err
	}
	full := path.Join(p.settings.root, name)
	if err := c.directory(path.Dir(full), create); err != nil {
		return "", nil, err
	}
	entry, err := c.lookup(path.Dir(full), path.Base(full))
	if err != nil {
		return "", nil, err
	}
	if entry != nil && entry.kind != "file" {
		return "", nil, ftpProblem("FTP target is not a regular file")
	}
	return full, entry, nil
}
func ftpDigest(c *ftpSession, name string, size int64) ([]byte, int64, error) {
	conn, err := c.data("RETR", name)
	if err != nil {
		return nil, 0, err
	}
	digest, n, err := fileDigest(c.ctx, io.LimitReader(conn, size+1))
	if err == nil && n > size {
		err = ftpProblem("FTP object exceeds expected size")
	}
	return digest, n, c.finishData(conn, err)
}

type ftpProgressWriter struct {
	writer   io.Writer
	total    int64
	progress func(int64)
}

func (w *ftpProgressWriter) Write(b []byte) (int, error) {
	n, err := w.writer.Write(b)
	w.total += int64(n)
	if n > 0 && w.progress != nil {
		w.progress(w.total)
	}
	return n, err
}

func (p *ftpProvider) Upload(ctx context.Context, name string, src io.ReadSeeker, size int64, progress func(int64)) (result UploadResult, err error) {
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		return result, ftpProblem("provider is closed")
	}
	p.wg.Add(1)
	p.mu.Unlock()
	defer p.wg.Done()
	if err = ftpObject(name); err != nil {
		return result, err
	}
	if size < 0 || size == 1<<63-1 {
		return result, ftpProblem("invalid backup source size")
	}
	var digest []byte
	var owned string
	var lease *transferLease
	err = p.with(ctx, "upload", func(ctx context.Context) error {
		if _, e := src.Seek(0, io.SeekStart); e != nil {
			return e
		}
		var n int64
		var e error
		digest, n, e = fileDigest(ctx, io.LimitReader(src, size+1))
		if e != nil {
			return e
		}
		if n != size {
			return ftpProblem("backup source size changed during inspection")
		}
		_, e = src.Seek(0, io.SeekStart)
		return e
	}, func(ctx context.Context, c *ftpSession) error {
		full, entry, e := p.file(c, name, true)
		if e != nil {
			return e
		}
		if entry != nil && entry.size == size {
			hash, n, e := ftpDigest(c, full, size)
			if e != nil {
				return e
			}
			if n == size && bytes.Equal(hash, digest) {
				result = UploadResult{Bytes: size, ETag: hex.EncodeToString(digest), Skipped: true}
				return nil
			}
		}
		temp, e := randomSFTPName(".tgdl-ftp-")
		if e != nil {
			return e
		}
		owned = path.Join(path.Dir(full), temp)
		lease, e = p.journal.track(ctx, "ftp-temp", owned, "")
		if e != nil {
			owned = ""
			return e
		}
		// MKD reserves an exclusive namespace. STOR itself cannot create files
		// exclusively; never STOR a random name directly in a shared directory.
		if e = c.expect("MKD", owned, 257); e != nil {
			var reply *ftpReplyError
			if errors.As(e, &reply) {
				owned = ""
				e = errors.Join(e, lease.finish(true, e))
				lease = nil
			}
			return e
		}
		payload := path.Join(owned, "payload")
		conn, e := c.data("STOR", payload)
		if e != nil {
			return e
		}
		hash := sha256.New()
		reader := &pacedReader{ctx, io.TeeReader(io.LimitReader(src, size+1), hash), uploadPacerFrom(ctx)}
		writer := &ftpProgressWriter{writer: conn, progress: progress}
		n, e := io.CopyBuffer(writer, reader, make([]byte, 64<<10))
		e = c.finishData(conn, e)
		if e != nil {
			return e
		}
		if n != size || !bytes.Equal(digest, hash.Sum(nil)) {
			return ftpProblem("backup source changed during FTP transfer")
		}
		remote, n, e := ftpDigest(c, payload, size)
		if e != nil {
			return e
		}
		if n != size || !bytes.Equal(digest, remote) {
			return ftpProblem("FTP stored bytes do not match the source")
		}
		if _, _, e = p.file(c, name, false); e != nil {
			return e
		}
		if e = c.expect("RNFR", payload, 350); e != nil {
			return e
		}
		if e = c.expect("RNTO", full, 250); e != nil {
			return e
		}
		// A successful rename removes only our staged payload; its empty
		// directory still belongs to the journal until removal is confirmed.
		result = UploadResult{Bytes: size, ETag: hex.EncodeToString(digest)}
		if e = c.expect("RMD", owned, 250); e != nil {
			return e
		}
		remaining, e := c.lookup(path.Dir(owned), path.Base(owned))
		if e != nil {
			return e
		}
		if remaining != nil {
			return ftpProblem("FTP staging remains after cleanup")
		}
		owned = ""
		return lease.finish(true, nil)
	})
	if owned != "" {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		cleaner := newFTPSettings(p.settings, p.timeout)
		e := cleaner.removeOwnedTemporary(cleanupCtx, owned)
		_ = cleaner.Close()
		err = errors.Join(err, e, lease.finish(e == nil, e))
	}
	return result, err
}
func newFTPSettings(settings ftpSettings, timeout time.Duration) *ftpProvider {
	ctx, cancel := context.WithCancel(context.Background())
	return &ftpProvider{settings: settings, ctx: ctx, cancel: cancel, gate: make(chan struct{}, 1), timeout: timeout}
}
func (p *ftpProvider) removeOwnedTemporary(ctx context.Context, owned string) error {
	base := path.Base(owned)
	suffix := strings.TrimPrefix(base, ".tgdl-ftp-")
	decoded, e := hex.DecodeString(suffix)
	root := strings.TrimSuffix(p.settings.root, "/") + "/"
	if !strings.HasPrefix(owned, root) || path.Clean(owned) != owned || suffix == base || e != nil || len(decoded) != 16 {
		return ftpProblem("invalid FTP cleanup path")
	}
	return p.with(ctx, "cleanup", nil, func(ctx context.Context, c *ftpSession) error {
		if e := c.directory(path.Dir(owned), false); errors.Is(e, fs.ErrNotExist) {
			return nil
		} else if e != nil {
			return e
		}
		entry, e := c.lookup(path.Dir(owned), base)
		if e != nil {
			return e
		}
		if entry == nil {
			return nil
		}
		if entry.kind != "dir" {
			return ftpProblem("FTP cleanup target is not a directory")
		}
		entries := []ftpEntry{}
		if e = c.entries(owned, func(e ftpEntry) error {
			entries = append(entries, e)
			if len(entries) > 1 {
				return ftpProblem("FTP staging contains unexpected objects")
			}
			return nil
		}); e != nil {
			return e
		}
		if len(entries) > 0 {
			if entries[0].name != "payload" || entries[0].kind != "file" {
				return ftpProblem("FTP staging contains an unexpected object")
			}
			if e = c.expect("DELE", path.Join(owned, "payload"), 250); e != nil {
				return e
			}
		}
		if e = c.expect("RMD", owned, 250); e != nil {
			return e
		}
		entry, e = c.lookup(path.Dir(owned), base)
		if e != nil {
			return e
		}
		if entry != nil {
			return ftpProblem("FTP staging remains after cleanup")
		}
		return nil
	})
}
func (p *ftpProvider) Delete(ctx context.Context, name string) error {
	if err := ftpObject(name); err != nil {
		return err
	}
	return p.with(ctx, "delete", nil, func(ctx context.Context, c *ftpSession) error {
		full, entry, e := p.file(c, name, false)
		if errors.Is(e, fs.ErrNotExist) {
			return nil
		}
		if e != nil {
			return e
		}
		if entry == nil {
			return nil
		}
		if e = c.expect("DELE", full, 250); e != nil {
			return e
		}
		_, entry, e = p.file(c, name, false)
		if e != nil {
			return e
		}
		if entry != nil {
			return ftpProblem("FTP object remains after deletion")
		}
		return nil
	})
}
func (p *ftpProvider) List(ctx context.Context, prefix string) (out []Object, err error) {
	out = []Object{}
	prefix = strings.TrimSuffix(prefix, "/")
	if prefix != "" {
		if err = ftpObject(prefix); err != nil {
			return nil, err
		}
	}
	err = p.with(ctx, "list", nil, func(ctx context.Context, c *ftpSession) error {
		pending := []string{prefix}
		count := 0
		for len(pending) > 0 {
			dir := pending[len(pending)-1]
			pending = pending[:len(pending)-1]
			full := path.Join(p.settings.root, dir)
			if e := c.directory(full, false); errors.Is(e, fs.ErrNotExist) && dir == prefix {
				return nil
			} else if e != nil {
				return e
			}
			if e := c.entries(full, func(e ftpEntry) error {
				count++
				if count > 100000 {
					return ftpProblem("FTP recursive listing exceeds 100000 entries")
				}
				if strings.HasPrefix(e.name, ".tgdl-ftp-") {
					return nil
				}
				name := path.Join(dir, e.name)
				switch e.kind {
				case "dir":
					pending = append(pending, name)
				case "file":
					out = append(out, Object{Path: name, Size: e.size, Modified: e.modified})
				}
				return nil
			}); e != nil {
				return e
			}
		}
		return nil
	})
	return out, err
}
func (p *ftpProvider) Test(ctx context.Context) (string, error) {
	name, err := randomSFTPName(".tgdl-probe-")
	if err != nil {
		return "", err
	}
	data := "tgdl backup write probe"
	if _, err = p.Upload(ctx, name, strings.NewReader(data), int64(len(data)), nil); err != nil {
		return "", err
	}
	if err = p.Delete(ctx, name); err != nil {
		return "", err
	}
	return "Wrote, verified + removed FTP probe at " + p.settings.root, nil
}
