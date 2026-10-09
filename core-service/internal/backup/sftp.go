package backup

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"os"
	"path"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"
)

type sshHostCheck func(context.Context, string, ssh.PublicKey, string) error
type sshHostError struct{ message string }

func (e *sshHostError) Error() string { return e.message }

func (m *Manager) checkSSHHost(ctx context.Context, address string, key ssh.PublicKey, pin string) error {
	if pin != "" && pin != ssh.FingerprintSHA256(key) {
		return &sshHostError{"SSH host key does not match the configured fingerprint"}
	}
	tx, err := m.opts.Writer.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if pin != "" {
		// An administrator's explicit verified pin authorizes a host-key rotation.
		_, err = tx.ExecContext(ctx, `INSERT INTO native_backup_host_keys(address,public_key) VALUES(?,?) ON CONFLICT(address) DO UPDATE SET public_key=excluded.public_key`, address, key.Marshal())
	} else {
		_, err = tx.ExecContext(ctx, `INSERT OR IGNORE INTO native_backup_host_keys(address,public_key) VALUES(?,?)`, address, key.Marshal())
	}
	if err != nil {
		return err
	}
	var stored []byte
	if err = tx.QueryRowContext(ctx, `SELECT public_key FROM native_backup_host_keys WHERE address=?`, address).Scan(&stored); err != nil {
		return err
	}
	if !bytes.Equal(stored, key.Marshal()) {
		return &sshHostError{"SSH host key changed; verify the server and set its trusted SHA256 fingerprint before reconnecting"}
	}
	return tx.Commit()
}

type sftpSettings struct {
	address, username, root, pin string
	auth                         ssh.AuthMethod
	checkHost                    sshHostCheck
}
type sftpProvider struct {
	settings    sftpSettings
	ctx         context.Context
	cancel      context.CancelFunc
	gate        chan struct{}
	wg          sync.WaitGroup
	mu          sync.Mutex
	closed      bool
	raw         net.Conn
	fingerprint string
	// These fields are owned by the gate; Close waits for operations to join.
	client *sftp.Client
	ssh    *ssh.Client
	dead   chan struct{}
}

func newSFTP(cfg map[string]any, check sshHostCheck) (*sftpProvider, error) {
	host := strings.TrimSpace(text(cfg["host"]))
	if host == "" {
		return nil, errors.New("host required")
	}
	if strings.ContainsAny(host, "/\\\x00\r\n\t ") {
		return nil, errors.New("invalid SFTP host")
	}
	host = strings.Trim(host, "[]")
	port := 22
	if v, ok := cfg["port"]; ok && v != "" && v != nil {
		port = integer(v, 0)
	}
	if port < 1 || port > 65535 {
		return nil, errors.New("invalid SFTP port")
	}
	username := text(cfg["username"])
	if username == "" {
		return nil, errors.New("username required")
	}
	root := strings.TrimRight(text(cfg["remoteRoot"]), "/")
	if root == "" && text(cfg["remoteRoot"]) == "/" {
		root = "/"
	}
	if !path.IsAbs(root) || strings.ContainsAny(root, "\\\x00") || path.Clean(root) != root {
		return nil, errors.New("remoteRoot must be a clean absolute POSIX path")
	}
	pin := strings.TrimSpace(text(cfg["hostKey"]))
	if pin != "" {
		b, err := base64.RawStdEncoding.DecodeString(strings.TrimPrefix(pin, "SHA256:"))
		if !strings.HasPrefix(pin, "SHA256:") || err != nil || len(b) != 32 {
			return nil, errors.New("hostKey must be an SSH SHA256 fingerprint")
		}
	}
	if pin == "" && check == nil {
		return nil, errors.New("SFTP requires a hostKey fingerprint or persistent host-key store")
	}
	var auth ssh.AuthMethod
	if pem := text(cfg["privateKey"]); pem != "" {
		var signer ssh.Signer
		var err error
		if pass := text(cfg["passphrase"]); pass != "" {
			signer, err = ssh.ParsePrivateKeyWithPassphrase([]byte(pem), []byte(pass))
		} else {
			signer, err = ssh.ParsePrivateKey([]byte(pem))
		}
		if err != nil {
			return nil, errors.New("invalid SFTP private key or passphrase")
		}
		auth = ssh.PublicKeys(signer)
	} else if password := text(cfg["password"]); password != "" {
		auth = ssh.Password(password)
	} else {
		return nil, errors.New("password or privateKey required")
	}
	return newSFTPSettings(sftpSettings{net.JoinHostPort(strings.ToLower(host), strconv.Itoa(port)), username, root, pin, auth, check}), nil
}
func newSFTPSettings(settings sftpSettings) *sftpProvider {
	ctx, cancel := context.WithCancel(context.Background())
	return &sftpProvider{settings: settings, ctx: ctx, cancel: cancel, gate: make(chan struct{}, 1)}
}
func sftpError(ctx context.Context, op string, err error) error {
	if err == nil {
		return nil
	}
	if ctx.Err() != nil {
		return fmt.Errorf("SFTP %s: %w", op, ctx.Err())
	}
	var host *sshHostError
	if errors.As(err, &host) {
		return host
	}
	var status *sftp.StatusError
	if errors.As(err, &status) {
		return fmt.Errorf("SFTP %s failed (status %d)", op, status.Code)
	}
	if errors.Is(err, fs.ErrNotExist) {
		return fmt.Errorf("SFTP %s: %w", op, fs.ErrNotExist)
	}
	return fmt.Errorf("SFTP %s failed", op)
}
func (p *sftpProvider) disconnect() {
	p.mu.Lock()
	raw := p.raw
	p.raw = nil
	p.mu.Unlock()
	if raw != nil {
		_ = raw.Close()
	}
	if p.client != nil {
		_ = p.client.Close()
		p.client = nil
	}
	if p.ssh != nil {
		_ = p.ssh.Close()
		_ = p.ssh.Wait()
		p.ssh = nil
	}
	if p.dead != nil {
		<-p.dead
		p.dead = nil
	}
}
func (p *sftpProvider) connection(ctx context.Context) error {
	if p.client != nil {
		select {
		case <-p.dead:
			p.disconnect()
		default:
			return nil
		}
	}
	dialCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	raw, err := (&net.Dialer{Timeout: 30 * time.Second, KeepAlive: 30 * time.Second}).DialContext(dialCtx, "tcp", p.settings.address)
	if err != nil {
		return sftpError(dialCtx, "connect", err)
	}
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		_ = raw.Close()
		return context.Canceled
	}
	p.raw = raw
	p.mu.Unlock()
	stop := context.AfterFunc(dialCtx, func() { _ = raw.Close() })
	defer stop()
	sshConfig := &ssh.ClientConfig{User: p.settings.username, Auth: []ssh.AuthMethod{p.settings.auth}, HostKeyCallback: func(_ string, _ net.Addr, key ssh.PublicKey) error {
		fingerprint := ssh.FingerprintSHA256(key)
		if p.settings.pin != "" && p.settings.pin != fingerprint {
			return &sshHostError{"SSH host key does not match the configured fingerprint"}
		}
		if p.settings.checkHost != nil {
			if err := p.settings.checkHost(dialCtx, p.settings.address, key, p.settings.pin); err != nil {
				return err
			}
		}
		p.mu.Lock()
		p.fingerprint = fingerprint
		p.mu.Unlock()
		return nil
	}}
	conn, chans, reqs, err := ssh.NewClientConn(&remoteDeadlineConn{Conn: raw}, p.settings.address, sshConfig)
	if err != nil {
		p.disconnect()
		return sftpError(dialCtx, "connect/authenticate", err)
	}
	p.ssh = ssh.NewClient(conn, chans, reqs)
	p.client, err = sftp.NewClient(p.ssh, sftp.MaxConcurrentRequestsPerFile(16), sftp.MaxPacket(32<<10))
	if err != nil {
		p.disconnect()
		return sftpError(dialCtx, "start subsystem", err)
	}
	p.dead = make(chan struct{})
	client, dead := p.client, p.dead
	go func() { _ = client.Wait(); close(dead) }()
	return nil
}
func (p *sftpProvider) with(ctx context.Context, op string, fn func(context.Context, *sftp.Client) error) error {
	return p.withPrepared(ctx, op, nil, fn)
}
func (p *sftpProvider) withPrepared(ctx context.Context, op string, prepare func(context.Context) error, fn func(context.Context, *sftp.Client) error) error {
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		return errors.New("SFTP provider is closed")
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
	if err := ctx.Err(); err != nil {
		return err
	}
	if prepare != nil {
		if err := prepare(ctx); err != nil {
			return err
		}
	}
	if err := p.connection(ctx); err != nil {
		return err
	}
	p.mu.Lock()
	raw := p.raw
	p.mu.Unlock()
	stopped := make(chan struct{})
	stop := context.AfterFunc(ctx, func() { _ = raw.Close(); close(stopped) })
	defer func() {
		if !stop() {
			<-stopped
		}
		if ctx.Err() != nil {
			p.disconnect()
		}
	}()
	return fn(ctx, p.client)
}
func (p *sftpProvider) Close() error {
	p.mu.Lock()
	p.closed = true
	p.cancel()
	if p.raw != nil {
		_ = p.raw.Close()
	}
	p.mu.Unlock()
	p.wg.Wait()
	p.gate <- struct{}{}
	p.disconnect()
	<-p.gate
	return nil
}

// SFTP v3 has no directory-handle-relative open. Refuse symlinks on every path
// component, but require a trusted remote account/filesystem to prevent swaps
// between Lstat and Open. A malicious SFTP server cannot be confined client-side.
func sftpDirectory(ctx context.Context, c *sftp.Client, dir string, create bool) error {
	current := "/"
	for _, component := range strings.Split(strings.TrimPrefix(dir, "/"), "/") {
		if component == "" {
			continue
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		current = path.Join(current, component)
		st, err := c.Lstat(current)
		if os.IsNotExist(err) && create {
			made := c.Mkdir(current)
			if made == nil {
				if err = c.Chmod(current, 0700); err != nil {
					return err
				}
			}
			st, err = c.Lstat(current)
			if made != nil && err != nil {
				return made
			}
		}
		if err != nil {
			return err
		}
		if !st.IsDir() || st.Mode()&os.ModeSymlink != 0 {
			return errors.New("SFTP path component is not a real directory")
		}
	}
	return nil
}
func (p *sftpProvider) file(ctx context.Context, c *sftp.Client, name string, parents bool) (string, fs.FileInfo, error) {
	if err := validObject(name); err != nil || name == "." {
		return "", nil, errors.New("invalid SFTP object path")
	}
	full := path.Join(p.settings.root, name)
	if err := sftpDirectory(ctx, c, path.Dir(full), parents); err != nil {
		return "", nil, err
	}
	st, err := c.Lstat(full)
	if os.IsNotExist(err) {
		return full, nil, nil
	}
	if err != nil {
		return "", nil, err
	}
	if !st.Mode().IsRegular() {
		return "", nil, errors.New("SFTP object is not a regular file")
	}
	return full, st, nil
}
func randomSFTPName(prefix string) (string, error) {
	var id [16]byte
	if _, err := rand.Read(id[:]); err != nil {
		return "", err
	}
	return prefix + hex.EncodeToString(id[:]), nil
}
func (p *sftpProvider) removeTemporary(name string) error {
	// A canceled session is unusable. Cleanup opens the same pinned endpoint with
	// a fresh, bounded lifetime and never changes host or authentication methods.
	cleanup := newSFTPSettings(p.settings)
	defer cleanup.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	return cleanup.with(ctx, "remove temporary", func(ctx context.Context, c *sftp.Client) error {
		if err := sftpDirectory(ctx, c, path.Dir(name), false); err != nil {
			return sftpError(ctx, "remove temporary", err)
		}
		err := c.Remove(name)
		if os.IsNotExist(err) {
			return nil
		}
		return sftpError(ctx, "remove temporary", err)
	})
}
func (p *sftpProvider) Upload(ctx context.Context, name string, src io.ReadSeeker, size int64, progress func(int64)) (result UploadResult, err error) {
	if size < 0 || size == 1<<63-1 {
		return result, errors.New("invalid backup source size")
	}
	if err := validObject(name); err != nil || name == "." {
		return result, errors.New("invalid SFTP object path")
	}
	var digest []byte
	err = p.withPrepared(ctx, "upload", func(ctx context.Context) (err error) {
		if _, err = src.Seek(0, io.SeekStart); err != nil {
			return err
		}
		var n int64
		digest, n, err = fileDigest(ctx, io.LimitReader(src, size+1))
		if err != nil {
			return err
		}
		if n != size {
			return errors.New("backup source size changed during inspection")
		}
		_, err = src.Seek(0, io.SeekStart)
		return err
	}, func(ctx context.Context, c *sftp.Client) (err error) {
		full, st, err := p.file(ctx, c, name, true)
		if err != nil {
			return sftpError(ctx, "inspect destination", err)
		}
		if st != nil && st.Size() == size {
			f, e := c.Open(full)
			if e != nil {
				return sftpError(ctx, "open existing", e)
			}
			hash, n, e := fileDigest(ctx, io.LimitReader(f, size+1))
			e = errors.Join(e, f.Close())
			if e != nil {
				return sftpError(ctx, "verify existing", e)
			}
			if n == size && bytes.Equal(digest, hash) {
				result = UploadResult{Bytes: size, ETag: hex.EncodeToString(digest), Skipped: true}
				return nil
			}
		}
		_, atomicRename := c.HasExtension("posix-rename@openssh.com")
		if st != nil && !atomicRename {
			return errors.New("SFTP server must support posix-rename@openssh.com to replace an existing file atomically")
		}
		tempName, e := randomSFTPName(".tgdl-part-")
		if e != nil {
			return e
		}
		temp := path.Join(path.Dir(full), tempName)
		out, e := c.OpenFile(temp, os.O_CREATE|os.O_EXCL|os.O_WRONLY)
		if e != nil {
			return sftpError(ctx, "create temporary", e)
		}
		published := false
		defer func() {
			_ = out.Close()
			if !published {
				if e := p.removeTemporary(temp); e != nil {
					err = errors.Join(err, e)
				}
			}
		}()
		if e = out.Chmod(0600); e != nil {
			return sftpError(ctx, "set private permissions", e)
		}
		hash := sha256.New()
		tracker := newTransferProgress(size, progress)
		reader := &sftpProgressReader{r: io.TeeReader(contextReader{ctx, io.LimitReader(src, size+1)}, hash), tracker: tracker}
		n, e := out.ReadFromWithConcurrency(reader, 16)
		if e != nil {
			return sftpError(ctx, "write", e)
		}
		if n != size || !bytes.Equal(digest, hash.Sum(nil)) {
			return errors.New("backup source changed during SFTP transfer")
		}
		if version, ok := c.HasExtension("fsync@openssh.com"); ok && version == "1" {
			if e = out.Sync(); e != nil {
				return sftpError(ctx, "sync", e)
			}
		}
		info, e := out.Stat()
		if e != nil {
			return sftpError(ctx, "verify upload", e)
		}
		if info.Size() != size {
			return errors.New("SFTP uploaded file has an unexpected size")
		}
		if e = out.Close(); e != nil {
			return sftpError(ctx, "close upload", e)
		}
		if e = ctx.Err(); e != nil {
			return e
		}
		// Recheck path components immediately before publication.
		if _, _, e = p.file(ctx, c, name, false); e != nil {
			return sftpError(ctx, "inspect publication path", e)
		}
		if atomicRename {
			e = c.PosixRename(temp, full)
		} else {
			e = c.Rename(temp, full)
		}
		if e != nil {
			return sftpError(ctx, "publish", e)
		}
		published = true
		result = UploadResult{Bytes: size, ETag: hex.EncodeToString(digest)}
		return nil
	})
	return result, err
}

type sftpProgressReader struct {
	r       io.Reader
	tracker *transferProgress
	total   int64
}

func (r *sftpProgressReader) Read(b []byte) (int, error) {
	n, err := r.r.Read(b)
	r.total += int64(n)
	r.tracker.read(0, r.total)
	return n, err
}
func (p *sftpProvider) Test(ctx context.Context) (string, error) {
	name, err := randomSFTPName(".tgdl-probe-")
	if err != nil {
		return "", err
	}
	content := "tgdl backup write probe"
	if _, err = p.Upload(ctx, name, strings.NewReader(content), int64(len(content)), nil); err != nil {
		return "", err
	}
	if err = p.Delete(ctx, name); err != nil {
		return "", err
	}
	p.mu.Lock()
	fingerprint := p.fingerprint
	p.mu.Unlock()
	return "Wrote + removed probe at " + p.settings.root + "; SSH host key " + fingerprint, nil
}
func (p *sftpProvider) Delete(ctx context.Context, name string) error {
	return p.with(ctx, "delete", func(ctx context.Context, c *sftp.Client) error {
		full, st, err := p.file(ctx, c, name, false)
		if os.IsNotExist(err) || err == nil && st == nil {
			return nil
		}
		if err != nil {
			return sftpError(ctx, "inspect delete", err)
		}
		err = c.Remove(full)
		if os.IsNotExist(err) {
			return nil
		}
		return sftpError(ctx, "delete", err)
	})
}
func (p *sftpProvider) List(ctx context.Context, prefix string) (out []Object, err error) {
	out = []Object{}
	raw := strings.TrimSuffix(prefix, "/")
	if raw != "" {
		if e := validObject(raw); e != nil {
			return nil, e
		}
	}
	err = p.with(ctx, "list", func(ctx context.Context, c *sftp.Client) error {
		full := path.Join(p.settings.root, raw)
		if e := sftpDirectory(ctx, c, full, false); e != nil {
			if os.IsNotExist(e) {
				return nil
			}
			return sftpError(ctx, "inspect listing directory", e)
		}
		pending := []string{raw}
		for len(pending) > 0 {
			dir := pending[len(pending)-1]
			pending = pending[:len(pending)-1]
			if e := sftpDirectory(ctx, c, path.Join(p.settings.root, dir), false); e != nil {
				return sftpError(ctx, "inspect listing directory", e)
			}
			entries, e := c.ReadDirContext(ctx, path.Join(p.settings.root, dir))
			if e != nil {
				return sftpError(ctx, "list directory", e)
			}
			for _, entry := range entries {
				if entry.Name() == "." || entry.Name() == ".." {
					continue
				}
				if e = validObject(entry.Name()); e != nil || strings.Contains(entry.Name(), "/") {
					return errors.New("SFTP returned an invalid directory entry")
				}
				name := path.Join(dir, entry.Name())
				if entry.Mode()&os.ModeSymlink != 0 {
					continue
				}
				if entry.IsDir() {
					pending = append(pending, name)
				} else if entry.Mode().IsRegular() && !strings.HasPrefix(entry.Name(), ".tgdl-part-") {
					if entry.Size() < 0 {
						return errors.New("SFTP returned a negative file size")
					}
					out = append(out, Object{Path: name, Size: entry.Size(), Modified: entry.ModTime()})
				}
			}
		}
		return nil
	})
	return out, err
}
