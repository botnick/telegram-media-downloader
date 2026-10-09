package backup

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/binary"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"
)

type fixtureSFTP struct {
	t                           *testing.T
	listener                    net.Listener
	root                        string
	mu                          sync.Mutex
	signer                      ssh.Signer
	clientKey                   ssh.PublicKey
	connections                 map[net.Conn]bool
	wg                          sync.WaitGroup
	passwords, keys, handshakes atomic.Int32
	stallWrite                  atomic.Bool
	writeStarted                chan struct{}
	noExtensions                bool
}

func fixtureSSHKey(t *testing.T) (ed25519.PrivateKey, ssh.Signer) {
	t.Helper()
	_, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	signer, err := ssh.NewSignerFromKey(private)
	if err != nil {
		t.Fatal(err)
	}
	return private, signer
}
func newFixtureSFTP(t *testing.T) *fixtureSFTP {
	t.Helper()
	_, signer := fixtureSSHKey(t)
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	f := &fixtureSFTP{t: t, listener: l, root: t.TempDir(), signer: signer, connections: map[net.Conn]bool{}, writeStarted: make(chan struct{}, 1)}
	f.wg.Add(1)
	go func() {
		defer f.wg.Done()
		for {
			conn, err := l.Accept()
			if err != nil {
				return
			}
			f.mu.Lock()
			f.connections[conn] = true
			f.mu.Unlock()
			f.wg.Add(1)
			go f.serve(conn)
		}
	}()
	t.Cleanup(func() {
		_ = l.Close()
		f.mu.Lock()
		for c := range f.connections {
			_ = c.Close()
		}
		f.mu.Unlock()
		f.wg.Wait()
	})
	return f
}
func (f *fixtureSFTP) config() map[string]any {
	host, port, _ := net.SplitHostPort(f.listener.Addr().String())
	n, _ := strconv.Atoi(port)
	f.mu.Lock()
	pin := ssh.FingerprintSHA256(f.signer.PublicKey())
	f.mu.Unlock()
	return map[string]any{"host": host, "port": n, "username": "fixture", "password": "fixture-password", "remoteRoot": filepath.ToSlash(filepath.Join(f.root, "backup")), "hostKey": pin}
}
func (f *fixtureSFTP) provider() *sftpProvider {
	f.t.Helper()
	p, err := newSFTP(f.config(), nil)
	if err != nil {
		f.t.Fatal(err)
	}
	f.t.Cleanup(func() { _ = p.Close() })
	return p
}
func (f *fixtureSFTP) serve(raw net.Conn) {
	defer f.wg.Done()
	defer raw.Close()
	defer func() { f.mu.Lock(); delete(f.connections, raw); f.mu.Unlock() }()
	cfg := &ssh.ServerConfig{PasswordCallback: func(meta ssh.ConnMetadata, password []byte) (*ssh.Permissions, error) {
		f.passwords.Add(1)
		if meta.User() == "fixture" && string(password) == "fixture-password" {
			return nil, nil
		}
		return nil, errors.New("incorrect fixture password")
	}, PublicKeyCallback: func(_ ssh.ConnMetadata, key ssh.PublicKey) (*ssh.Permissions, error) {
		f.keys.Add(1)
		f.mu.Lock()
		accepted := f.clientKey != nil && bytes.Equal(f.clientKey.Marshal(), key.Marshal())
		f.mu.Unlock()
		if accepted {
			return nil, nil
		}
		return nil, errors.New("unrecognized fixture public key")
	}}
	f.mu.Lock()
	cfg.AddHostKey(f.signer)
	f.mu.Unlock()
	conn, chans, requests, err := ssh.NewServerConn(raw, cfg)
	if err != nil {
		return
	}
	defer conn.Close()
	f.handshakes.Add(1)
	closed := make(chan struct{})
	go func() { _ = conn.Wait(); close(closed) }()
	go ssh.DiscardRequests(requests)
	var sessions sync.WaitGroup
	for incoming := range chans {
		if incoming.ChannelType() != "session" {
			_ = incoming.Reject(ssh.UnknownChannelType, "session required")
			continue
		}
		channel, requests, err := incoming.Accept()
		if err != nil {
			continue
		}
		sessions.Add(1)
		go func() {
			defer sessions.Done()
			defer channel.Close()
			for request := range requests {
				var subsystem struct{ Name string }
				_ = ssh.Unmarshal(request.Payload, &subsystem)
				if request.Type != "subsystem" || subsystem.Name != "sftp" {
					_ = request.Reply(false, nil)
					continue
				}
				_ = request.Reply(true, nil)
				wire := &fixtureSFTPWire{Channel: channel, fixture: f, closed: closed, first: true}
				server, err := sftp.NewServer(wire)
				if err != nil {
					return
				}
				_ = server.Serve()
				_ = server.Close()
				return
			}
		}()
	}
	sessions.Wait()
	<-closed
}

// Inspect actual SFTP packets to suspend a write and to emulate a v3 server
// without extensions, without changing package globals or provider internals.
type fixtureSFTPWire struct {
	ssh.Channel
	fixture *fixtureSFTP
	closed  <-chan struct{}
	pending []byte
	first   bool
}

func (w *fixtureSFTPWire) Read(b []byte) (int, error) {
	if len(w.pending) == 0 {
		var header [4]byte
		if _, err := io.ReadFull(w.Channel, header[:]); err != nil {
			return 0, err
		}
		n := binary.BigEndian.Uint32(header[:])
		if n == 0 || n > 1<<20 {
			return 0, errors.New("invalid SFTP packet")
		}
		packet := make([]byte, 4+int(n))
		copy(packet, header[:])
		if _, err := io.ReadFull(w.Channel, packet[4:]); err != nil {
			return 0, err
		}
		if packet[4] == 6 && w.fixture.stallWrite.Swap(false) {
			w.fixture.writeStarted <- struct{}{}
			<-w.closed
			return 0, io.EOF
		}
		w.pending = packet
	}
	n := copy(b, w.pending)
	w.pending = w.pending[n:]
	return n, nil
}
func (w *fixtureSFTPWire) Write(b []byte) (int, error) {
	if w.first {
		w.first = false
		if w.fixture.noExtensions && len(b) >= 9 && b[4] == 2 {
			version := append([]byte(nil), b[:9]...)
			binary.BigEndian.PutUint32(version[:4], 5)
			_, err := w.Channel.Write(version)
			return len(b), err
		}
	}
	return w.Channel.Write(b)
}

func TestSFTPWireUploadDedupListDeleteAndConnectionReuse(t *testing.T) {
	f := newFixtureSFTP(t)
	p := f.provider()
	ctx := context.Background()
	content := bytes.Repeat([]byte("real SSH encrypted payload"), 8192)
	var previous int64
	result, err := p.Upload(ctx, "ไทย/folder/file +%.bin", bytes.NewReader(content), int64(len(content)), func(n int64) {
		if n < previous || n > int64(len(content)) {
			t.Errorf("invalid progress %d", n)
		}
		previous = n
	})
	if err != nil || result.Skipped || previous != int64(len(content)) {
		t.Fatalf("upload: %+v %v", result, err)
	}
	name := filepath.Join(f.root, "backup", "ไทย", "folder", "file +%.bin")
	b, err := os.ReadFile(name)
	if err != nil || !bytes.Equal(b, content) {
		t.Fatal("incorrect remote bytes", err)
	}
	info, err := os.Stat(name)
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatal("remote file permissions", err)
	}
	result, err = p.Upload(ctx, "ไทย/folder/file +%.bin", bytes.NewReader(content), int64(len(content)), nil)
	if err != nil || !result.Skipped {
		t.Fatalf("dedup: %+v %v", result, err)
	}
	if err = os.WriteFile(name, bytes.Repeat([]byte{2}, len(content)), 0600); err != nil {
		t.Fatal(err)
	}
	result, err = p.Upload(ctx, "ไทย/folder/file +%.bin", bytes.NewReader(content), int64(len(content)), nil)
	if err != nil || result.Skipped {
		t.Fatalf("corrupt existing bytes: %+v %v", result, err)
	}
	if _, err = p.Upload(ctx, "empty", bytes.NewReader(nil), 0, nil); err != nil {
		t.Fatal(err)
	}
	result, err = p.Upload(ctx, "empty", bytes.NewReader(nil), 0, nil)
	if err != nil || !result.Skipped {
		t.Fatal("empty dedup", err)
	}
	list, err := p.List(ctx, "ไทย/")
	if err != nil || len(list) != 1 || list[0].Path != "ไทย/folder/file +%.bin" {
		t.Fatalf("listing: %+v %v", list, err)
	}
	if err = p.Delete(ctx, "ไทย/folder/file +%.bin"); err != nil {
		t.Fatal(err)
	}
	if err = p.Delete(ctx, "ไทย/folder/file +%.bin"); err != nil {
		t.Fatal(err)
	}
	detail, err := p.Test(ctx)
	if err != nil || !strings.Contains(detail, text(f.config()["hostKey"])) {
		t.Fatalf("probe: %s %v", detail, err)
	}
	if f.handshakes.Load() != 1 {
		t.Fatalf("did not reuse SSH connection: %d", f.handshakes.Load())
	}
}

func TestSFTPChangedSourceKeepsOriginalAndCleansTemporary(t *testing.T) {
	f := newFixtureSFTP(t)
	p := f.provider()
	ctx := context.Background()
	if _, err := p.Upload(ctx, "object", strings.NewReader("original"), 8, nil); err != nil {
		t.Fatal(err)
	}
	src := &changedS3Source{Reader: bytes.NewReader(bytes.Repeat([]byte{1}, 1<<20)), after: bytes.Repeat([]byte{2}, 1<<20)}
	_, err := p.Upload(ctx, "object", src, 1<<20, nil)
	if err == nil || !strings.Contains(err.Error(), "source changed") {
		t.Fatalf("changed source: %v", err)
	}
	b, err := os.ReadFile(filepath.Join(f.root, "backup", "object"))
	if err != nil || string(b) != "original" {
		t.Fatal("original was replaced", err)
	}
	entries, err := os.ReadDir(filepath.Join(f.root, "backup"))
	if err != nil || len(entries) != 1 {
		t.Fatalf("temporary file leaked: %v %v", entries, err)
	}
}

func TestSFTPCancelAndCloseCleanTemporaryAndJoin(t *testing.T) {
	for _, shutdown := range []bool{false, true} {
		t.Run(fmt.Sprint(shutdown), func(t *testing.T) {
			f := newFixtureSFTP(t)
			p := f.provider()
			ctx := context.Background()
			if _, err := p.Upload(ctx, "object", strings.NewReader("original"), 8, nil); err != nil {
				t.Fatal(err)
			}
			f.stallWrite.Store(true)
			op, cancel := context.WithCancel(ctx)
			defer cancel()
			data := bytes.Repeat([]byte{1}, 2<<20)
			result := make(chan error, 1)
			go func() { _, err := p.Upload(op, "object", bytes.NewReader(data), int64(len(data)), nil); result <- err }()
			select {
			case <-f.writeStarted:
			case <-time.After(5 * time.Second):
				t.Fatal("write did not start")
			}
			closed := make(chan struct{})
			if shutdown {
				go func() { _ = p.Close(); close(closed) }()
			} else {
				cancel()
				close(closed)
			}
			select {
			case err := <-result:
				if !errors.Is(err, context.Canceled) {
					t.Fatalf("cancel error: %v", err)
				}
			case <-time.After(5 * time.Second):
				t.Fatal("cancel/cleanup did not join")
			}
			select {
			case <-closed:
			case <-time.After(time.Second):
				t.Fatal("close did not return")
			}
			entries, err := os.ReadDir(filepath.Join(f.root, "backup"))
			if err != nil || len(entries) != 1 {
				t.Fatalf("temporary leaked: %v %v", entries, err)
			}
			b, err := os.ReadFile(filepath.Join(f.root, "backup", "object"))
			if err != nil || string(b) != "original" {
				t.Fatal("cancellation replaced original", err)
			}
			if !shutdown {
				if _, err = p.Upload(ctx, "next", strings.NewReader("next"), 4, nil); err != nil {
					t.Fatal("next operation did not reconnect", err)
				}
			}
		})
	}
}

func TestSFTPRejectsSymlinkEscapes(t *testing.T) {
	f := newFixtureSFTP(t)
	p := f.provider()
	ctx := context.Background()
	if _, err := p.Test(ctx); err != nil {
		t.Fatal(err)
	}
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "file"), []byte("outside"), 0600); err != nil {
		t.Fatal(err)
	}
	for _, link := range []struct{ name, target string }{{"parent", outside}, {"file", filepath.Join(outside, "file")}} {
		if err := os.Symlink(link.target, filepath.Join(f.root, "backup", link.name)); err != nil {
			t.Fatal(err)
		}
	}
	for _, name := range []string{"parent/file", "file", "../escape"} {
		if _, err := p.Upload(ctx, name, strings.NewReader("bad"), 3, nil); err == nil {
			t.Fatalf("followed %s", name)
		}
		if err := p.Delete(ctx, name); err == nil {
			t.Fatalf("deleted via %s", name)
		}
	}
	list, err := p.List(ctx, "")
	if err != nil || len(list) != 0 {
		t.Fatalf("listed symlinks: %+v %v", list, err)
	}
	b, err := os.ReadFile(filepath.Join(outside, "file"))
	if err != nil || string(b) != "outside" {
		t.Fatal("outside changed", err)
	}
}

func TestSFTPServerWithoutAtomicReplaceKeepsOriginal(t *testing.T) {
	f := newFixtureSFTP(t)
	f.noExtensions = true
	p := f.provider()
	ctx := context.Background()
	if _, err := p.Upload(ctx, "file", strings.NewReader("original"), 8, nil); err != nil {
		t.Fatal("new file failed", err)
	}
	_, err := p.Upload(ctx, "file", strings.NewReader("replacement"), 11, nil)
	if err == nil || !strings.Contains(err.Error(), "posix-rename") {
		t.Fatalf("unsafe replacement accepted: %v", err)
	}
	b, err := os.ReadFile(filepath.Join(f.root, "backup", "file"))
	if err != nil || string(b) != "original" {
		t.Fatal("existing file lost", err)
	}
}

func TestSFTPHostKeyPersistenceRejectsChangeBeforeAuthentication(t *testing.T) {
	f := newFixtureSFTP(t)
	m, db, _ := fixtureManager(t, nil)
	ctx := context.Background()
	cfg := f.config()
	delete(cfg, "hostKey")
	d, err := m.Create(ctx, map[string]any{"name": "SFTP fixture", "provider": "sftp", "enabled": false, "config": cfg})
	if err != nil {
		t.Fatal(err)
	}
	id := d["id"].(int64)
	if ok, detail, err := m.Test(ctx, id); err != nil || !ok {
		t.Fatalf("first connection: %v %s %v", ok, detail, err)
	}
	var count int
	if err = db.Reader.QueryRow(`SELECT count(*) FROM native_backup_host_keys`).Scan(&count); err != nil || count != 1 {
		t.Fatal("host key not persisted", err)
	}
	m.Close()
	next, err := NewManager(ctx, m.opts)
	if err != nil {
		t.Fatal(err)
	}
	defer next.Close()
	if ok, detail, err := next.Test(ctx, id); err != nil || !ok {
		t.Fatalf("restart pin: %v %s %v", ok, detail, err)
	}
	before := f.passwords.Load()
	_, newKey := fixtureSSHKey(t)
	f.mu.Lock()
	f.signer = newKey
	f.mu.Unlock()
	if ok, detail, err := next.Test(ctx, id); err != nil || ok || !strings.Contains(detail, "host key changed") {
		t.Fatalf("changed key: %v %s %v", ok, detail, err)
	}
	if f.passwords.Load() != before {
		t.Fatal("password sent to changed host")
	}
	pin := ssh.FingerprintSHA256(newKey.PublicKey())
	if _, err = next.Update(ctx, id, map[string]any{"config": map[string]any{"hostKey": pin}}); err != nil {
		t.Fatal(err)
	}
	if ok, detail, err := next.Test(ctx, id); err != nil || !ok {
		t.Fatalf("explicit trusted rotation: %v %s %v", ok, detail, err)
	}
	public, err := next.Config(ctx, id)
	if err != nil || public["hostKey"] != pin || public["password"] != nil {
		t.Fatal("host key not visible or password leaked", err)
	}
}

func TestSFTPPinnedMismatchNeverSendsCredentials(t *testing.T) {
	f := newFixtureSFTP(t)
	cfg := f.config()
	_, other := fixtureSSHKey(t)
	cfg["hostKey"] = ssh.FingerprintSHA256(other.PublicKey())
	p, err := newSFTP(cfg, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer p.Close()
	if _, err = p.Test(context.Background()); err == nil || !strings.Contains(err.Error(), "host key") {
		t.Fatalf("wrong pin: %v", err)
	}
	if f.passwords.Load() != 0 || f.keys.Load() != 0 {
		t.Fatal("credentials sent to untrusted host")
	}
}

func TestSFTPPrivateKeyAndEncryptedPrivateKey(t *testing.T) {
	for _, pass := range []string{"", "fixture-passphrase"} {
		t.Run(pass, func(t *testing.T) {
			f := newFixtureSFTP(t)
			private, signer := fixtureSSHKey(t)
			f.mu.Lock()
			f.clientKey = signer.PublicKey()
			f.mu.Unlock()
			var block *pem.Block
			var err error
			if pass == "" {
				block, err = ssh.MarshalPrivateKey(private, "")
			} else {
				block, err = ssh.MarshalPrivateKeyWithPassphrase(private, "", []byte(pass))
			}
			if err != nil {
				t.Fatal(err)
			}
			cfg := f.config()
			cfg["privateKey"] = string(pem.EncodeToMemory(block))
			cfg["passphrase"] = pass
			cfg["password"] = "intentionally-wrong-password"
			p, err := newSFTP(cfg, nil)
			if err != nil {
				t.Fatal(err)
			}
			defer p.Close()
			if _, err = p.Test(context.Background()); err != nil {
				t.Fatal("key login", err)
			}
			if f.passwords.Load() != 0 || f.keys.Load() == 0 {
				t.Fatal("private key did not take precedence")
			}
			if pass != "" {
				cfg["passphrase"] = "wrong"
				if _, err = newSFTP(cfg, nil); err == nil || strings.Contains(err.Error(), "BEGIN") || strings.Contains(err.Error(), "wrong") {
					t.Fatalf("wrong passphrase accepted/leaked: %v", err)
				}
			}
		})
	}
}

func TestSFTPAutomaticMirrorSurvivesRestart(t *testing.T) {
	f := newFixtureSFTP(t)
	m, db, dir := fixtureManager(t, nil)
	ctx := context.Background()
	cfg := f.config()
	delete(cfg, "hostKey")
	d, err := m.Create(ctx, map[string]any{"name": "SFTP mirror", "provider": "sftp", "config": cfg})
	if err != nil {
		t.Fatal(err)
	}
	id := d["id"].(int64)
	if err = m.Pause(ctx, id, true); err != nil {
		t.Fatal(err)
	}
	addSource(t, db, dir, "fresh/file.bin", "automatic mirror bytes", 51)
	m.Close()
	next, err := NewManager(ctx, m.opts)
	if err != nil {
		t.Fatal(err)
	}
	defer next.Close()
	if err = next.Pause(ctx, id, false); err != nil {
		t.Fatal(err)
	}
	waitBackup(t, next, id, 1, 0)
	b, err := os.ReadFile(filepath.Join(f.root, "backup", "fresh", "file.bin"))
	if err != nil || string(b) != "automatic mirror bytes" {
		t.Fatal("mirror bytes", err)
	}
	var count int
	if err = db.Reader.QueryRow(`SELECT count(*) FROM native_backup_host_keys`).Scan(&count); err != nil || count != 1 {
		t.Fatal("automatic mirror did not retain host key", err)
	}
}

func TestSFTPCancelSilentSSHHandshake(t *testing.T) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	done := make(chan struct{})
	go func() {
		defer close(done)
		conn, err := l.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		_, _ = io.Copy(io.Discard, conn)
	}()
	host, port, _ := net.SplitHostPort(l.Addr().String())
	_, key := fixtureSSHKey(t)
	p, err := newSFTP(map[string]any{"host": host, "port": port, "username": "fixture", "password": "fixture-password", "hostKey": ssh.FingerprintSHA256(key.PublicKey()), "remoteRoot": "/fixture"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer p.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	result := make(chan error, 1)
	go func() { _, err := p.Test(ctx); result <- err }()
	select {
	case err := <-result:
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("handshake cancellation: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("silent handshake ignored context")
	}
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("handshake socket was not closed")
	}
}

type inspectedSFTPSource struct {
	*bytes.Reader
	beforeRead func()
}

func (s *inspectedSFTPSource) Read(b []byte) (int, error) {
	if s.beforeRead != nil {
		fn := s.beforeRead
		s.beforeRead = nil
		fn()
	}
	return s.Reader.Read(b)
}
func TestSFTPInspectsSourceBeforeConnecting(t *testing.T) {
	f := newFixtureSFTP(t)
	p := f.provider()
	src := &inspectedSFTPSource{Reader: bytes.NewReader([]byte("bytes")), beforeRead: func() {
		if f.handshakes.Load() != 0 || f.passwords.Load() != 0 {
			t.Error("opened idle SSH session before source inspection")
		}
	}}
	if _, err := p.Upload(context.Background(), "file", src, 5, nil); err != nil {
		t.Fatal(err)
	}
	if f.handshakes.Load() != 1 {
		t.Fatal("upload did not connect")
	}
}
