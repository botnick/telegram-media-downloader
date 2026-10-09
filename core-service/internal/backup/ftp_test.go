package backup

import (
	"bufio"
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type fixtureFTP struct {
	t                                                                                    testing.TB
	root                                                                                 string
	fs                                                                                   *os.Root
	listener                                                                             net.Listener
	mode                                                                                 string
	tls                                                                                  *tls.Config
	ca                                                                                   string
	mu                                                                                   sync.Mutex
	connections                                                                          map[net.Conn]bool
	listeners                                                                            map[net.Listener]bool
	listing                                                                              map[string]string
	commands                                                                             []string
	wg                                                                                   sync.WaitGroup
	passwords, plainPasswords, controls, dataTLS, stores, retrieves                      atomic.Int32
	denyDelete, denyListing, failRename, corruptUpload, omitMLST, stallUpload, refuseTLS atomic.Bool
	uploadStarted                                                                        chan struct{}
}

func newFixtureFTP(t testing.TB, mode string) *fixtureFTP {
	t.Helper()
	dir := t.TempDir()
	root, err := os.OpenRoot(dir)
	if err != nil {
		t.Fatal(err)
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	cert := &x509.Certificate{SerialNumber: big.NewInt(42), Subject: pkix.Name{CommonName: "FTP fixture"}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour), IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign | x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}, IPAddresses: []net.IP{net.ParseIP("127.0.0.1")}, DNSNames: []string{"localhost"}}
	der, err := x509.CreateCertificate(rand.Reader, cert, cert, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	f := &fixtureFTP{t: t, root: dir, fs: root, listener: l, mode: mode, tls: &tls.Config{MinVersion: tls.VersionTLS12, Certificates: []tls.Certificate{{Certificate: [][]byte{der}, PrivateKey: key}}}, ca: string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})), connections: map[net.Conn]bool{}, listeners: map[net.Listener]bool{l: true}, listing: map[string]string{}, uploadStarted: make(chan struct{}, 1)}
	f.wg.Add(1)
	go func() {
		defer f.wg.Done()
		for {
			c, e := l.Accept()
			if e != nil {
				return
			}
			f.track(c)
			f.wg.Add(1)
			go func() { defer f.wg.Done(); defer f.untrack(c); defer c.Close(); f.serve(c) }()
		}
	}()
	t.Cleanup(func() {
		f.mu.Lock()
		for l := range f.listeners {
			_ = l.Close()
		}
		for c := range f.connections {
			_ = c.Close()
		}
		f.mu.Unlock()
		f.wg.Wait()
		_ = root.Close()
	})
	return f
}
func (f *fixtureFTP) track(c net.Conn)   { f.mu.Lock(); f.connections[c] = true; f.mu.Unlock() }
func (f *fixtureFTP) untrack(c net.Conn) { f.mu.Lock(); delete(f.connections, c); f.mu.Unlock() }
func (f *fixtureFTP) config() map[string]any {
	host, port, _ := net.SplitHostPort(f.listener.Addr().String())
	n, _ := strconv.Atoi(port)
	cfg := map[string]any{"host": host, "port": n, "username": "fixture", "password": "fixture-private-pass", "remoteRoot": "/backup", "secure": f.mode}
	if f.mode != "false" {
		cfg["tlsCA"] = f.ca
	}
	return cfg
}
func (f *fixtureFTP) provider() *ftpProvider {
	f.t.Helper()
	p, e := newFTP(f.config())
	if e != nil {
		f.t.Fatal(e)
	}
	f.t.Cleanup(func() { _ = p.Close() })
	return p
}
func ftpFixturePath(arg string) string {
	v := strings.TrimPrefix(path.Clean(arg), "/")
	if v == "" {
		return "."
	}
	return v
}
func (f *fixtureFTP) machineListing(dir string) (string, error) {
	f.mu.Lock()
	override, ok := f.listing[dir]
	f.mu.Unlock()
	if ok {
		return override, nil
	}
	h, e := f.fs.Open(ftpFixturePath(dir))
	if e != nil {
		return "", e
	}
	defer h.Close()
	entries, e := h.ReadDir(-1)
	if e != nil {
		return "", e
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Name() < entries[j].Name() })
	var b strings.Builder
	for _, d := range entries {
		info, e := d.Info()
		if e != nil {
			return "", e
		}
		kind := "file"
		if info.IsDir() {
			kind = "dir"
		}
		if info.Mode()&os.ModeSymlink != 0 {
			kind = "OS.unix=slink"
		}
		fmt.Fprintf(&b, "type=%s;size=%d;modify=20261009010000.125; %s\r\n", kind, info.Size(), d.Name())
	}
	return b.String(), nil
}
func (f *fixtureFTP) serve(raw net.Conn) {
	f.controls.Add(1)
	c := raw
	secure := false
	protected := false
	_ = raw.SetDeadline(time.Now().Add(30 * time.Second))
	if f.mode == "true" {
		tc := tls.Server(c, f.tls)
		if tc.Handshake() != nil {
			return
		}
		c = tc
		secure = true
	}
	reader := bufio.NewReader(c)
	reply := func(code int, msg string) bool { _, e := fmt.Fprintf(c, "%d %s\r\n", code, msg); return e == nil }
	if !reply(220, "Fixture ready") {
		return
	}
	var passive net.Listener
	var from string
	defer func() {
		if passive != nil {
			_ = passive.Close()
		}
	}()
	for {
		line, e := reader.ReadString('\n')
		if e != nil {
			return
		}
		line = strings.TrimSuffix(strings.TrimSuffix(line, "\n"), "\r")
		verb, arg, _ := strings.Cut(line, " ")
		f.mu.Lock()
		f.commands = append(f.commands, verb)
		f.mu.Unlock()
		switch verb {
		case "AUTH":
			if f.refuseTLS.Load() || f.mode != "control" || arg != "TLS" {
				reply(534, "TLS refused")
				continue
			}
			if !reply(234, "TLS ready") {
				return
			}
			tc := tls.Server(c, f.tls)
			if tc.Handshake() != nil {
				return
			}
			c = tc
			secure = true
			reader = bufio.NewReader(c)
		case "USER":
			reply(331, "Password required")
		case "PASS":
			f.passwords.Add(1)
			if !secure {
				f.plainPasswords.Add(1)
			}
			if arg != "fixture-private-pass" || f.mode != "false" && !secure {
				reply(530, "denied fixture-private-pass")
			} else {
				reply(230, "Logged in")
			}
		case "PBSZ":
			reply(200, "ok")
		case "PROT":
			protected = arg == "P"
			reply(200, "ok")
		case "FEAT":
			if f.omitMLST.Load() {
				reply(211, "No machine listings")
			} else {
				_, _ = io.WriteString(c, "211-Features\r\n MLST type*;size*;modify*;\r\n UTF8\r\n211 End\r\n")
			}
		case "TYPE", "OPTS":
			reply(200, "ok")
		case "EPSV", "PASV":
			if passive != nil {
				_ = passive.Close()
				f.mu.Lock()
				delete(f.listeners, passive)
				f.mu.Unlock()
			}
			passive, e = net.Listen("tcp", "127.0.0.1:0")
			if e != nil {
				reply(425, "cannot listen")
				continue
			}
			f.mu.Lock()
			f.listeners[passive] = true
			f.mu.Unlock()
			port := passive.Addr().(*net.TCPAddr).Port
			if verb == "EPSV" {
				reply(229, fmt.Sprintf("Entering passive (|||%d|)", port))
			} else {
				reply(227, fmt.Sprintf("Entering passive (203,0,113,99,%d,%d)", port/256, port%256))
			} // third-party advertised IP must be ignored
		case "MLSD", "STOR", "RETR":
			if passive == nil {
				reply(425, "no data listener")
				continue
			}
			var list string
			var file *os.File
			if verb == "MLSD" {
				if f.denyListing.Load() {
					reply(550, "permission denied fixture-private-pass")
					continue
				}
				list, e = f.machineListing(arg)
			}
			if verb == "STOR" {
				file, e = f.fs.OpenFile(ftpFixturePath(arg), os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0600)
			}
			if verb == "RETR" {
				file, e = f.fs.Open(ftpFixturePath(arg))
				f.retrieves.Add(1)
			}
			if e != nil {
				reply(550, "not available")
				continue
			}
			if !reply(150, "Data follows") {
				if file != nil {
					file.Close()
				}
				return
			}
			dc, e := passive.Accept()
			if e != nil {
				if file != nil {
					file.Close()
				}
				return
			}
			f.track(dc)
			_ = dc.SetDeadline(time.Now().Add(30 * time.Second))
			wire := net.Conn(dc)
			if protected {
				tc := tls.Server(dc, f.tls)
				e = tc.Handshake()
				if e == nil {
					f.dataTLS.Add(1)
					wire = tc
				}
			}
			if e == nil {
				switch verb {
				case "MLSD":
					_, e = io.WriteString(wire, list)
				case "RETR":
					_, e = io.Copy(wire, file)
				case "STOR":
					f.stores.Add(1)
					if f.stallUpload.Load() {
						_, _ = io.CopyN(file, wire, 1024)
						_ = file.Sync()
						select {
						case f.uploadStarted <- struct{}{}:
						default:
						}
						for f.stallUpload.Load() {
							time.Sleep(5 * time.Millisecond)
						}
					}
					_, e = io.Copy(file, wire)
					_ = file.Sync()
					if f.corruptUpload.Load() {
						_, _ = file.WriteAt([]byte("!"), 0)
					}
				}
			}
			if file != nil {
				_ = file.Close()
			}
			_ = wire.Close()
			f.untrack(dc)
			_ = passive.Close()
			f.mu.Lock()
			delete(f.listeners, passive)
			f.mu.Unlock()
			passive = nil
			if e != nil {
				reply(426, "Transfer failed")
			} else {
				reply(226, "Transfer complete")
			}
		case "MKD":
			e = f.fs.Mkdir(ftpFixturePath(arg), 0700)
			if e != nil {
				reply(550, "cannot mkdir")
			} else {
				reply(257, "Created")
			}
		case "RMD":
			e = f.fs.Remove(ftpFixturePath(arg))
			if e != nil {
				reply(550, "cannot rmdir")
			} else {
				reply(250, "Removed")
			}
		case "DELE":
			if f.denyDelete.Load() {
				reply(550, "permission denied fixture-private-pass")
				continue
			}
			e = f.fs.Remove(ftpFixturePath(arg))
			if e != nil {
				reply(550, "cannot delete")
			} else {
				reply(250, "Deleted")
			}
		case "RNFR":
			from = arg
			reply(350, "Ready")
		case "RNTO":
			if f.failRename.Load() {
				reply(550, "rename denied")
				continue
			}
			e = f.fs.Rename(ftpFixturePath(from), ftpFixturePath(arg))
			if e != nil {
				reply(550, "cannot rename")
			} else {
				reply(250, "Renamed")
			}
		case "QUIT":
			reply(221, "Bye")
			return
		default:
			reply(502, "Unsupported")
		}
	}
}

func TestFTPWireModesIntegrityDedupListingAndDelete(t *testing.T) {
	for _, mode := range []string{"false", "control", "true"} {
		for _, passive := range []string{"auto", "epsv"} {
			t.Run(mode+"/"+passive, func(t *testing.T) {
				f := newFixtureFTP(t, mode)
				cfg := f.config()
				cfg["passiveMode"] = passive
				p, err := newFTP(cfg)
				if err != nil {
					t.Fatal(err)
				}
				defer p.Close()
				ctx := context.Background()
				data := strings.Repeat("ไทย; data", 12000)
				name := "ไทย/nested/movie.bin"
				last := int64(0)
				result, err := p.Upload(ctx, name, strings.NewReader(data), int64(len(data)), func(n int64) {
					if n < last || n > int64(len(data)) {
						t.Error("invalid progress", n)
					}
					last = n
				})
				if err != nil || result.Skipped || result.Bytes != int64(len(data)) || last != int64(len(data)) {
					t.Fatal("upload", result, err)
				}
				got, err := os.ReadFile(filepath.Join(f.root, "backup", filepath.FromSlash(name)))
				if err != nil || string(got) != data {
					t.Fatal("wrong stored bytes", err)
				}
				result, err = p.Upload(ctx, name, strings.NewReader(data), int64(len(data)), nil)
				if err != nil || !result.Skipped || f.stores.Load() != 1 {
					t.Fatal("content dedup", result, err)
				}
				changed := "!" + data[1:]
				result, err = p.Upload(ctx, name, strings.NewReader(changed), int64(len(changed)), nil)
				if err != nil || result.Skipped || f.stores.Load() != 2 {
					t.Fatal("equal-size corruption was skipped", err)
				}
				if _, err = p.Upload(ctx, "empty.bin", bytes.NewReader(nil), 0, nil); err != nil {
					t.Fatal("empty file", err)
				}
				objects, err := p.List(ctx, "")
				if err != nil || len(objects) != 2 {
					t.Fatal("list", objects, err)
				}
				if err = p.Delete(ctx, name); err != nil {
					t.Fatal(err)
				}
				if err = p.Delete(ctx, name); err != nil {
					t.Fatal("missing delete", err)
				}
				if _, err = p.Test(ctx); err != nil {
					t.Fatal("write probe", err)
				}
				if f.controls.Load() != 1 {
					t.Fatal("healthy control connection was not reused", f.controls.Load())
				}
				if mode != "false" && (f.plainPasswords.Load() != 0 || f.dataTLS.Load() == 0) {
					t.Fatal("FTPS did not protect both channels")
				}
				if mode == "false" && f.dataTLS.Load() != 0 {
					t.Fatal("explicit plaintext configuration ignored")
				}
				entries, err := os.ReadDir(filepath.Join(f.root, "backup/ไทย/nested"))
				if err != nil || len(entries) != 0 {
					t.Fatal("temporary ownership leaked", entries, err)
				}
			})
		}
	}
}
func TestFTPSRejectsUntrustedCertificateAndTLSRefusalBeforeCredentials(t *testing.T) {
	for _, mode := range []string{"control", "true"} {
		t.Run(mode, func(t *testing.T) {
			f := newFixtureFTP(t, mode)
			cfg := f.config()
			delete(cfg, "tlsCA")
			p, err := newFTP(cfg)
			if err != nil {
				t.Fatal(err)
			}
			defer p.Close()
			if _, err = p.Test(context.Background()); err == nil || !strings.Contains(err.Error(), "certificate verification") {
				t.Fatal("untrusted certificate accepted", err)
			}
			if f.passwords.Load() != 0 {
				t.Fatal("credentials sent before certificate verification")
			}
		})
	}
	f := newFixtureFTP(t, "control")
	f.refuseTLS.Store(true)
	p := f.provider()
	if _, err := p.Test(context.Background()); err == nil {
		t.Fatal("AUTH TLS refusal ignored")
	}
	if f.passwords.Load() != 0 {
		t.Fatal("TLS refusal sent plaintext credentials")
	}
}
func TestFTPRejectsSourceMutationAndStoredCorruptionBeforeRename(t *testing.T) {
	for _, fault := range []string{"source", "remote", "rename"} {
		t.Run(fault, func(t *testing.T) {
			f := newFixtureFTP(t, "false")
			p := f.provider()
			ctx := context.Background()
			plain := "correct original"
			if _, err := p.Upload(ctx, "a.bin", strings.NewReader(plain), int64(len(plain)), nil); err != nil {
				t.Fatal(err)
			}
			var src io.ReadSeeker = strings.NewReader("replacement data")
			if fault == "source" {
				src = &changedS3Source{Reader: bytes.NewReader([]byte("replacement data")), after: []byte("REPLACEMENT data")}
			}
			if fault == "remote" {
				f.corruptUpload.Store(true)
			}
			if fault == "rename" {
				f.failRename.Store(true)
			}
			if _, err := p.Upload(ctx, "a.bin", src, int64(len("replacement data")), nil); err == nil {
				t.Fatal("fault accepted")
			}
			got, err := os.ReadFile(filepath.Join(f.root, "backup/a.bin"))
			if err != nil || string(got) != plain {
				t.Fatal("original file lost", err)
			}
			entries, err := os.ReadDir(filepath.Join(f.root, "backup"))
			if err != nil || len(entries) != 1 {
				t.Fatal("temporary not cleaned", entries, err)
			}
		})
	}
}
func TestFTPDoesNotTreatDeniedListingOrDeleteAsMissing(t *testing.T) {
	f := newFixtureFTP(t, "false")
	p := f.provider()
	ctx := context.Background()
	if _, err := p.Upload(ctx, "a.bin", strings.NewReader("abc"), 3, nil); err != nil {
		t.Fatal(err)
	}
	f.denyDelete.Store(true)
	err := p.Delete(ctx, "a.bin")
	if err == nil || strings.Contains(err.Error(), "fixture-private-pass") {
		t.Fatal("denial hidden or leaked", err)
	}
	f.denyListing.Store(true)
	if _, err = p.List(ctx, ""); err == nil {
		t.Fatal("denied listing reported as empty")
	}
	if err = p.Delete(ctx, "missing"); err == nil {
		t.Fatal("denied parent reported as missing file")
	}
}
func TestFTPRejectsMalformedMetadataAndSymlinks(t *testing.T) {
	for _, line := range []string{"garbage\r\n", "type=file;size=no; a\r\n", "type=file; a\r\n", "type=dir; ../escape\r\n", "type=file;size=1;size=2; a\r\n", "type=unknown; a\r\n"} {
		t.Run(strconv.Itoa(len(line))+line[:4], func(t *testing.T) {
			f := newFixtureFTP(t, "false")
			f.mu.Lock()
			f.listing["/"] = line
			f.mu.Unlock()
			p := f.provider()
			if _, err := p.Upload(context.Background(), "a", strings.NewReader("x"), 1, nil); err == nil {
				t.Fatal("malformed listing silently ignored")
			}
			if f.stores.Load() != 0 {
				t.Fatal("STOR after invalid listing")
			}
		})
	}
	f := newFixtureFTP(t, "false")
	if err := os.Mkdir(filepath.Join(f.root, "elsewhere"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("elsewhere", filepath.Join(f.root, "backup")); err != nil {
		t.Fatal(err)
	}
	p := f.provider()
	if _, err := p.Upload(context.Background(), "escaped", strings.NewReader("x"), 1, nil); err == nil {
		t.Fatal("followed directory symlink")
	}
}
func TestFTPRequiresMachineListingAndValidConfiguration(t *testing.T) {
	f := newFixtureFTP(t, "false")
	f.omitMLST.Store(true)
	p := f.provider()
	if _, err := p.Test(context.Background()); err == nil || !strings.Contains(err.Error(), "MLST/MLSD") {
		t.Fatal("missing machine listing not reported", err)
	}
	for key, value := range map[string]any{"host": "bad\r\nUSER injected", "username": "bad\n", "password": "bad\r", "secure": "invalid", "port": 70000, "remoteRoot": "/a/../b", "passiveMode": "invalid"} {
		cfg := f.config()
		cfg[key] = value
		if p, e := newFTP(cfg); e == nil {
			p.Close()
			t.Fatal("bad config accepted", key)
		}
	}
}

func TestFTPAutomaticEncryptedMirrorResumesAfterRestart(t *testing.T) {
	f := newFixtureFTP(t, "control")
	m, db, dir := fixtureManager(t, nil)
	ctx := context.Background()
	id, _ := fixtureDestination(t, m, "ftp", f.config(), true)
	if _, err := m.Encryption(ctx, id, true, "fixture encrypted", false); err != nil {
		t.Fatal(err)
	}
	if err := m.Pause(ctx, id, true); err != nil {
		t.Fatal(err)
	}
	data := strings.Repeat("queued private data", 10000)
	addSource(t, db, dir, "fresh/a.bin", data, 99)
	m.Close()
	next, err := NewManager(ctx, m.opts)
	if err != nil {
		t.Fatal(err)
	}
	defer next.Close()
	if _, err = next.Encryption(ctx, id, true, "fixture encrypted", true); err != nil {
		t.Fatal(err)
	}
	if err = next.Pause(ctx, id, false); err != nil {
		t.Fatal(err)
	}
	waitBackup(t, next, id, 1, 0)
	waitTransferJournal(t, next, 0)
	info, err := next.RecoveryInfo(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	salt, _ := hex.DecodeString(info.SaltHex)
	output := filepath.Join(dir, "decrypted")
	if err = DecryptFile(ctx, filepath.Join(f.root, "backup/fresh/a.bin"), output, "fixture encrypted", salt); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(output)
	if err != nil || string(got) != data {
		t.Fatal("encrypted FTP queue changed data", err)
	}
}

func TestFTPLowRateDoesNotExpireNetworkDeadlines(t *testing.T) {
	f := newFixtureFTP(t, "control")
	p := f.provider()
	p.timeout = 100 * time.Millisecond
	ctx := withUploadPacer(context.Background(), newUploadPacer(30))
	start := time.Now()
	result, err := p.Upload(ctx, "slow", strings.NewReader(strings.Repeat("x", 40)), 40, nil)
	if err != nil || result.Bytes != 40 {
		t.Fatal("pacing mistaken for timeout", result, err)
	}
	if time.Since(start) < time.Second {
		t.Fatal("pacing ignored")
	}
}

func TestFTPProcessKillRecoversOwnedStagingAndQueuedFile(t *testing.T) {
	f := newFixtureFTP(t, "false")
	m, db, dir := fixtureManager(t, nil)
	id, _ := fixtureDestination(t, m, "ftp", f.config(), true)
	if err := m.Pause(context.Background(), id, true); err != nil {
		t.Fatal(err)
	}
	data := strings.Repeat("z", 256<<10)
	addSource(t, db, dir, "crash.bin", data, 91)
	m.Close()
	f.stallUpload.Store(true)
	t.Cleanup(func() { f.stallUpload.Store(false) })
	cmd, done := startCrashHelper(t, dir, id)
	select {
	case <-f.uploadStarted:
	case <-done:
		t.Fatal("child exited early")
	case <-time.After(10 * time.Second):
		t.Fatal("upload did not begin")
	}
	var owned string
	if err := db.Reader.QueryRow(`SELECT remote_path FROM native_backup_transfers WHERE provider='ftp' AND kind='ftp-temp' AND state='active'`).Scan(&owned); err != nil {
		t.Fatal("bytes sent before durable ownership", err)
	}
	st, err := os.Stat(filepath.Join(f.root, strings.TrimPrefix(owned, "/"), "payload"))
	if err != nil || st.Size() == 0 {
		t.Fatal("no actual partial bytes", err)
	}
	if err = cmd.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	<-done
	f.stallUpload.Store(false)
	next, err := NewManager(context.Background(), m.opts)
	if err != nil {
		t.Fatal(err)
	}
	defer next.Close()
	waitBackup(t, next, id, 1, 0)
	waitTransferJournal(t, next, 0)
	got, err := os.ReadFile(filepath.Join(f.root, "backup/crash.bin"))
	if err != nil || string(got) != data {
		t.Fatal("queued file not recovered", err)
	}
	if _, err = os.Stat(filepath.Join(f.root, strings.TrimPrefix(owned, "/"))); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("old owned staging retained", err)
	}
}

func TestFTPCleanupRetainsOriginalDestinationAfterDeletion(t *testing.T) {
	f := newFixtureFTP(t, "control")
	m, db, _ := fixtureManager(t, nil)
	ctx := context.Background()
	id, d := fixtureDestination(t, m, "ftp", f.config(), false)
	p, err := m.provider(ctx, d, f.config())
	if err != nil {
		t.Fatal(err)
	}
	defer p.Close()
	f.corruptUpload.Store(true)
	f.denyDelete.Store(true)
	if _, err = p.Upload(ctx, "target.bin", strings.NewReader("correct bytes"), 13, nil); err == nil {
		t.Fatal("corrupt remote upload accepted")
	}
	var owned string
	if err = db.Reader.QueryRow(`SELECT remote_path FROM native_backup_transfers WHERE destination_id=? AND state='pending'`, id).Scan(&owned); err != nil {
		t.Fatal("failed cleanup lost durable ownership", err)
	}
	if err = os.WriteFile(filepath.Join(f.root, "backup/unrelated"), []byte("preserve"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err = m.Remove(ctx, id); err != nil {
		t.Fatal(err)
	}
	f.denyDelete.Store(false)
	f.corruptUpload.Store(false)
	if _, err = db.Writer.Exec(`UPDATE native_backup_transfers SET next_retry_at=0`); err != nil {
		t.Fatal(err)
	}
	waitTransferJournal(t, m, 0)
	if _, err = os.Stat(filepath.Join(f.root, strings.TrimPrefix(owned, "/"))); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("staging survived destination deletion cleanup", err)
	}
	got, err := os.ReadFile(filepath.Join(f.root, "backup/unrelated"))
	if err != nil || string(got) != "preserve" {
		t.Fatal("cleanup touched unrelated data", err)
	}
}

func TestFTPJournalFailurePreventsRemotePayloadCreation(t *testing.T) {
	f := newFixtureFTP(t, "false")
	m, db, _ := fixtureManager(t, nil)
	ctx := context.Background()
	_, d := fixtureDestination(t, m, "ftp", f.config(), false)
	p, err := m.provider(ctx, d, f.config())
	if err != nil {
		t.Fatal(err)
	}
	defer p.Close()
	if _, err = db.Writer.Exec(`CREATE TRIGGER reject_ftp_journal BEFORE INSERT ON native_backup_transfers BEGIN SELECT RAISE(ABORT,'fixture failure'); END`); err != nil {
		t.Fatal(err)
	}
	if _, err = p.Upload(ctx, "target.bin", strings.NewReader("abc"), 3, nil); err == nil {
		t.Fatal("transfer ignored ownership failure")
	}
	if f.stores.Load() != 0 {
		t.Fatal("bytes sent without durable ownership")
	}
	entries, err := os.ReadDir(filepath.Join(f.root, "backup"))
	if err != nil || len(entries) != 0 {
		t.Fatal("unowned remote reservation created", entries, err)
	}
}

func TestFTPProviderCloseCancelsAndJoinsUploadCleanup(t *testing.T) {
	f := newFixtureFTP(t, "false")
	p := f.provider()
	f.stallUpload.Store(true)
	t.Cleanup(func() { f.stallUpload.Store(false) })
	done := make(chan error, 1)
	go func() {
		_, err := p.Upload(context.Background(), "cancel.bin", strings.NewReader(strings.Repeat("x", 8<<20)), 8<<20, nil)
		done <- err
	}()
	select {
	case <-f.uploadStarted:
	case <-time.After(3 * time.Second):
		t.Fatal("upload not started")
	}
	closed := make(chan struct{})
	go func() { _ = p.Close(); close(closed) }()
	select {
	case <-closed:
	case <-time.After(3 * time.Second):
		t.Fatal("Close failed to join upload")
	}
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatal("cancellation lost", err)
		}
	case <-time.After(500 * time.Millisecond):
		t.Fatal("Close returned before upload cleanup")
	}
	f.stallUpload.Store(false)
	entries, err := os.ReadDir(filepath.Join(f.root, "backup"))
	if err != nil || len(entries) != 0 {
		t.Fatal("cancel left partial/final bytes", entries, err)
	}
	if _, err = p.List(context.Background(), ""); err == nil {
		t.Fatal("closed provider accepted work")
	}
}

func TestFTPControlReplyHasWholeCommandDeadline(t *testing.T) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	done := make(chan struct{})
	go func() {
		defer close(done)
		c, e := l.Accept()
		if e != nil {
			return
		}
		defer c.Close()
		_ = c.SetDeadline(time.Now().Add(2 * time.Second))
		_, _ = io.WriteString(c, "220 Ready\r\n")
		r := bufio.NewReader(c)
		for {
			line, e := r.ReadString('\n')
			if e != nil {
				return
			}
			switch {
			case strings.HasPrefix(line, "USER"):
				_, _ = io.WriteString(c, "331 Password\r\n")
			case strings.HasPrefix(line, "PASS"):
				_, _ = io.WriteString(c, "230 Welcome\r\n")
			case strings.HasPrefix(line, "FEAT"):
				for i := 0; i < 100; i++ {
					if _, e = io.WriteString(c, "2"); e != nil {
						return
					}
					time.Sleep(10 * time.Millisecond)
				}
				return
			}
		}
	}()
	host, port, _ := net.SplitHostPort(l.Addr().String())
	p, err := newFTP(map[string]any{"host": host, "port": port, "username": "fixture", "remoteRoot": "/"})
	if err != nil {
		t.Fatal(err)
	}
	defer p.Close()
	p.timeout = 80 * time.Millisecond
	start := time.Now()
	if _, err = p.Test(context.Background()); err == nil || !strings.Contains(err.Error(), "timeout") {
		t.Fatal("slow incomplete reply accepted", err)
	}
	if time.Since(start) > 500*time.Millisecond {
		t.Fatal("reply deadline was extended by trickle bytes")
	}
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("fixture connection not closed")
	}
}

func TestFTPBooleanTLSAndStrictPassiveParsing(t *testing.T) {
	f := newFixtureFTP(t, "true")
	cfg := f.config()
	cfg["secure"] = true
	p, err := newFTP(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer p.Close()
	if _, err = p.Test(context.Background()); err != nil {
		t.Fatal("legacy boolean TLS mode", err)
	}
	if f.plainPasswords.Load() != 0 {
		t.Fatal("boolean TLS downgraded to plaintext")
	}
	for _, value := range []string{"229 (|||0|)", "229 (|||65536|)", "229 (|||x|)", "229 (||1|)", "229 (|||+123|)", "229 (|||-123|)"} {
		if _, err := ftpPassivePort(value, true); err == nil {
			t.Fatal("invalid EPSV accepted", value)
		}
	}
	for _, value := range []string{"227 (1,2,3,4,256,1)", "227 (1,2,3,4,0,0)", "227 (1,2,3,4,1)", "227 (1,2,3,4,+1,2)"} {
		if _, err := ftpPassivePort(value, false); err == nil {
			t.Fatal("invalid PASV accepted", value)
		}
	}
}

func FuzzFTPRemoteMetadata(f *testing.F) {
	f.Add("type=file;size=123;modify=20261009010000; movie.bin")
	f.Add("type=OS.unix=slink;size=3; link")
	f.Add("229 Extended (|||12345|)")
	f.Add("227 Passive (1,2,3,4,120,30)")
	f.Fuzz(func(t *testing.T, input string) {
		if len(input) > 8192 {
			return
		}
		if entry, err := parseFTPEntry(input); err == nil && entry.kind != "cdir" && entry.kind != "pdir" {
			if ftpObject(entry.name) != nil || strings.Contains(entry.name, "/") || entry.size < 0 {
				t.Fatal("unsafe listing accepted")
			}
		}
		for _, extended := range []bool{false, true} {
			if port, err := ftpPassivePort(input, extended); err == nil && (port < 1 || port > 65535) {
				t.Fatal("unsafe passive port accepted")
			}
		}
	})
}

func BenchmarkFTPVerifiedUpload1MiB(b *testing.B) {
	for _, mode := range []string{"false", "control"} {
		b.Run(mode, func(b *testing.B) {
			f := newFixtureFTP(b, mode)
			p := f.provider()
			data := bytes.Repeat([]byte{0xa7}, 1<<20)
			if _, err := p.Test(context.Background()); err != nil {
				b.Fatal(err)
			}
			b.SetBytes(int64(len(data)))
			b.ReportAllocs()
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				if _, err := p.Upload(context.Background(), fmt.Sprintf("file-%d.bin", i), bytes.NewReader(data), int64(len(data)), nil); err != nil {
					b.Fatal(err)
				}
			}
		})
	}
}
