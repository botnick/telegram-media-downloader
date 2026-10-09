package backup

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Independent high-level standard AEAD, not the streaming implementation.
func standardPayload(t *testing.T, data, key []byte) []byte {
	t.Helper()
	b, err := aes.NewCipher(key)
	if err != nil {
		t.Fatal(err)
	}
	g, err := cipher.NewGCM(b)
	if err != nil {
		t.Fatal(err)
	}
	header := append([]byte("TGDB\x01"), bytes.Repeat([]byte{0x12}, 12)...)
	return g.Seal(header, header[5:], data, nil)
}

func TestDecryptPublishesOnlyAuthenticatedBytes(t *testing.T) {
	ctx := context.Background()
	key := bytes.Repeat([]byte{3}, 32)
	plain := bytes.Repeat([]byte("private media"), 10000)
	valid := standardPayload(t, plain, key)
	for _, which := range []string{"valid", "wrong-key", "wrong-tag", "truncated", "cancelled", "existing"} {
		t.Run(which, func(t *testing.T) {
			dir := t.TempDir()
			input, output := filepath.Join(dir, "input"), filepath.Join(dir, "output")
			blob := bytes.Clone(valid)
			useKey := bytes.Clone(key)
			useCtx := ctx
			switch which {
			case "wrong-key":
				useKey[0] ^= 1
			case "wrong-tag":
				blob[len(blob)-1] ^= 1
			case "truncated":
				blob = blob[:len(blob)-1]
			case "cancelled":
				var cancel context.CancelFunc
				useCtx, cancel = context.WithCancel(ctx)
				cancel()
			case "existing":
				if err := os.WriteFile(output, []byte("keep"), 0600); err != nil {
					t.Fatal(err)
				}
			}
			if err := os.WriteFile(input, blob, 0600); err != nil {
				t.Fatal(err)
			}
			err := decryptFileKey(useCtx, input, output, useKey)
			if which == "valid" {
				if err != nil {
					t.Fatal(err)
				}
				got, e := os.ReadFile(output)
				if e != nil || !bytes.Equal(got, plain) {
					t.Fatal("wrong plaintext", e)
				}
			} else {
				if err == nil {
					t.Fatal("invalid input accepted")
				}
				got, e := os.ReadFile(output)
				if which == "existing" {
					if e != nil || string(got) != "keep" {
						t.Fatal("overwrote existing file")
					}
				} else if !errors.Is(e, os.ErrNotExist) {
					t.Fatal("published unauthenticated bytes", e)
				}
			}
			entries, err := os.ReadDir(dir)
			if err != nil {
				t.Fatal(err)
			}
			for _, entry := range entries {
				if strings.HasPrefix(entry.Name(), ".tgdb-") {
					t.Fatal("temporary plaintext left behind")
				}
			}
		})
	}
}

func TestEncryptedMirrorAcrossNativeProviders(t *testing.T) {
	for _, provider := range []string{"local", "s3", "sftp"} {
		t.Run(provider, func(t *testing.T) {
			m, db, dir := fixtureManager(t, nil)
			ctx := context.Background()
			cfg := map[string]any{"rootPath": filepath.Join(dir, "target")}
			var s3 *fixtureS3
			var sftp *fixtureSFTP
			if provider == "s3" {
				s3 = newFixtureS3(t)
				cfg = s3.config()
			}
			if provider == "sftp" {
				sftp = newFixtureSFTP(t)
				cfg = sftp.config()
			}
			d, err := m.Create(ctx, map[string]any{"name": "encrypted fixture", "provider": provider, "config": cfg})
			if err != nil {
				t.Fatal(err)
			}
			id := d["id"].(int64)
			if _, err = m.Encryption(ctx, id, true, "exact test pass\n", false); err != nil {
				t.Fatal(err)
			}
			info, err := m.RecoveryInfo(ctx, id)
			if err != nil {
				t.Fatal(err)
			}
			plain := strings.Repeat("private bytes", 10000)
			if provider == "s3" {
				plain = strings.Repeat("private bytes", 750000)
			}
			addSource(t, db, dir, "fresh/media.bin", plain, 44)
			m.Wake()
			waitBackup(t, m, id, 1, 0)
			var blob []byte
			switch provider {
			case "local":
				blob, err = os.ReadFile(filepath.Join(dir, "target/fresh/media.bin"))
			case "sftp":
				blob, err = os.ReadFile(filepath.Join(sftp.root, "backup/fresh/media.bin"))
			case "s3":
				s3.mu.Lock()
				if s3.creates != 1 || s3.completes != 1 {
					t.Error("encrypted queue did not use multipart transfer")
				}
				blob = bytes.Clone(s3.objects["library/ไทย/fresh/media.bin"].data)
				s3.mu.Unlock()
			}
			if err != nil {
				t.Fatal(err)
			}
			if len(blob) != len(plain)+33 || string(blob[:5]) != "TGDB\x01" {
				t.Fatal("provider did not receive TGDB ciphertext")
			}
			salt, _ := hex.DecodeString(info.SaltHex)
			key, err := payloadKey("exact test pass\n", salt)
			if err != nil {
				t.Fatal(err)
			}
			b, _ := aes.NewCipher(key)
			g, _ := cipher.NewGCM(b)
			got, err := g.Open(nil, blob[5:17], blob[17:], nil)
			if err != nil || string(got) != plain {
				t.Fatal("provider ciphertext is not standard GCM", err)
			}
			var stages int
			if err = db.Reader.QueryRow(`SELECT count(*) FROM native_backup_staging`).Scan(&stages); err != nil || stages != 0 {
				t.Fatal("staging ownership retained", err)
			}
			jobs, err := m.Jobs(ctx, id, "", 10, 0, false)
			if err != nil || jobs[0]["bytes_uploaded"] != int64(len(blob)) {
				t.Fatalf("wrong encrypted accounting: %v %v", jobs, err)
			}
			m.Close() // before fixture transport cleanup
		})
	}
}

func TestNativeSnapshotRestoreEncryptedAndPlaintext(t *testing.T) {
	for _, encrypted := range []bool{false, true} {
		t.Run(fmt.Sprint(encrypted), func(t *testing.T) {
			m, db, dir := fixtureManager(t, nil)
			ctx := context.Background()
			target := filepath.Join(dir, "target")
			id := addLocal(t, m, target, "snapshot")
			if err := os.MkdirAll(filepath.Join(dir, "sessions/native"), 0700); err != nil {
				t.Fatal(err)
			}
			files := map[string]string{"secret.key": "fixture-key", "sessions/native/account.enc": "fixture-encrypted-session", "config.json": "{\"groups\":[]}"}
			for name, data := range files {
				if err := os.WriteFile(filepath.Join(dir, name), []byte(data), 0600); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := db.Writer.Exec(`INSERT INTO kv(key,value,updated_at) VALUES('restore-test','preserve',0)`); err != nil {
				t.Fatal(err)
			}
			epochJSON := `"` + strings.Repeat("ab", 32) + `"`
			if _, err := db.Writer.Exec(`INSERT INTO kv(key,value,updated_at) VALUES('cluster_catalog_epoch',?,0)`, epochJSON); err != nil {
				t.Fatal(err)
			}
			opts := RestoreOptions{Plaintext: !encrypted}
			if encrypted {
				if _, err := m.Encryption(ctx, id, true, "restore-pass", false); err != nil {
					t.Fatal(err)
				}
				info, err := m.RecoveryInfo(ctx, id)
				if err != nil {
					t.Fatal(err)
				}
				opts.Passphrase = "restore-pass"
				opts.Salt, _ = hex.DecodeString(info.SaltHex)
			}
			if err := m.Run(ctx, id); err != nil {
				t.Fatal(err)
			}
			waitBackup(t, m, id, 1, 0)
			jobs, err := m.Jobs(ctx, id, "", 10, 0, false)
			if err != nil {
				t.Fatal(err)
			}
			input := filepath.Join(target, jobs[0]["remote_path"].(string))
			output := filepath.Join(dir, "restored")
			if !encrypted {
				t.Chdir(dir)
				output = "restored"
			}
			result, err := RestoreSnapshot(ctx, input, output+string(filepath.Separator), opts)
			if err != nil {
				t.Fatal(err)
			}
			if result.Files != 4 {
				t.Fatalf("unexpected restored files: %v", result)
			}
			for name, data := range files {
				got, e := os.ReadFile(filepath.Join(output, name))
				if e != nil || string(got) != data {
					t.Fatal("restore changed data", name, e)
				}
			}
			restored, err := sql.Open("sqlite", filepath.Join(output, "db.sqlite"))
			if err != nil {
				t.Fatal(err)
			}
			defer restored.Close()
			var value string
			if err = restored.QueryRow(`SELECT value FROM kv WHERE key='restore-test'`).Scan(&value); err != nil || value != "preserve" {
				t.Fatal("snapshot lost committed database value", err)
			}
			if err = restored.QueryRow(`SELECT value FROM kv WHERE key='cluster_catalog_epoch'`).Scan(&value); err != nil || value == epochJSON || len(value) != 66 {
				t.Fatal("restored catalog kept old epoch", value, err)
			}
			if err = db.Reader.QueryRow(`SELECT value FROM kv WHERE key='cluster_catalog_epoch'`).Scan(&value); err != nil || value != epochJSON {
				t.Fatal("restore changed source epoch", value, err)
			}
			if _, err = RestoreSnapshot(ctx, input, output, opts); !errors.Is(err, os.ErrExist) {
				t.Fatal("existing directory accepted", err)
			}
			if encrypted {
				opts.Passphrase = "wrong"
				if _, err = RestoreSnapshot(ctx, input, filepath.Join(dir, "invalid"), opts); err == nil {
					t.Fatal("wrong snapshot key accepted")
				}
				if _, err = os.Stat(filepath.Join(dir, "invalid")); !errors.Is(err, os.ErrNotExist) {
					t.Fatal("published failed snapshot")
				}
			}
		})
	}
}

type snapshotEntry struct {
	name string
	kind byte
	data []byte
}

func archiveFixture(t *testing.T, entries []snapshotEntry) []byte {
	t.Helper()
	var out bytes.Buffer
	gz := gzip.NewWriter(&out)
	tw := tar.NewWriter(gz)
	for _, entry := range entries {
		h := &tar.Header{Name: entry.name, Typeflag: entry.kind, Mode: 0777, Size: int64(len(entry.data))}
		if entry.kind == tar.TypeSymlink || entry.kind == tar.TypeLink {
			h.Linkname = "../../outside"
			h.Size = 0
		}
		if err := tw.WriteHeader(h); err != nil {
			t.Fatal(err)
		}
		if h.Size > 0 {
			if _, err := tw.Write(entry.data); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}
	return out.Bytes()
}

func TestSnapshotRejectsUnsafeAndCorruptArchives(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	name := filepath.Join(dir, "fixture.db")
	db, err := sql.Open("sqlite", name)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(`CREATE TABLE downloads(id INTEGER); CREATE TABLE kv(key TEXT,value TEXT)`); err != nil {
		t.Fatal(err)
	}
	if err = db.Close(); err != nil {
		t.Fatal(err)
	}
	validDB, err := os.ReadFile(name)
	if err != nil {
		t.Fatal(err)
	}
	database := snapshotEntry{"db.sqlite", tar.TypeReg, validDB}
	cases := []struct {
		name    string
		entries []snapshotEntry
		opts    RestoreOptions
		corrupt bool
	}{
		{"traversal", []snapshotEntry{database, {"sessions/../../outside", tar.TypeReg, []byte("bad")}}, RestoreOptions{}, false},
		{"symlink", []snapshotEntry{database, {"sessions/a", tar.TypeSymlink, nil}}, RestoreOptions{}, false},
		{"hardlink", []snapshotEntry{database, {"sessions/a", tar.TypeLink, nil}}, RestoreOptions{}, false},
		{"duplicate", []snapshotEntry{database, database}, RestoreOptions{}, false},
		{"missing-db", []snapshotEntry{{"config.json", tar.TypeReg, []byte("{}")}}, RestoreOptions{}, false},
		{"bad-db", []snapshotEntry{{"db.sqlite", tar.TypeReg, []byte("not SQLite")}}, RestoreOptions{}, false},
		{"bad-json", []snapshotEntry{database, {"config.json", tar.TypeReg, []byte("[]")}}, RestoreOptions{}, false},
		{"missing-session-key", []snapshotEntry{database, {"sessions/native/a.enc", tar.TypeReg, []byte("cipher")}}, RestoreOptions{}, false},
		{"byte-limit", []snapshotEntry{database}, RestoreOptions{MaxBytes: 1}, false},
		{"entry-limit", []snapshotEntry{database, {"config.json", tar.TypeReg, []byte("{}")}}, RestoreOptions{MaxFiles: 1}, false},
		{"gzip-checksum", []snapshotEntry{database}, RestoreOptions{}, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			root := t.TempDir()
			input, output := filepath.Join(root, "input"), filepath.Join(root, "output")
			blob := archiveFixture(t, tc.entries)
			if tc.corrupt {
				blob[len(blob)-8] ^= 1
			}
			if err := os.WriteFile(input, blob, 0600); err != nil {
				t.Fatal(err)
			}
			tc.opts.Plaintext = true
			if _, err := RestoreSnapshot(ctx, input, output, tc.opts); err == nil {
				t.Fatal("bad snapshot accepted")
			}
			entries, err := os.ReadDir(root)
			if err != nil || len(entries) != 1 || entries[0].Name() != "input" {
				t.Fatal("failed restore left files", err)
			}
		})
	}
}

func TestEncryptedStagingRecoveryUsesOnlyDurableOwnership(t *testing.T) {
	m, db, dir := fixtureManager(t, nil)
	m.Close()
	folder := filepath.Join(dir, "backups")
	if err := os.MkdirAll(folder, 0700); err != nil {
		t.Fatal(err)
	}
	foreign := ".tgdb-stage-" + strings.Repeat("f", 32)
	if err := os.WriteFile(filepath.Join(folder, foreign), []byte("preserve"), 0600); err != nil {
		t.Fatal(err)
	}
	// More than one bounded batch, with both present and already-missing files.
	for i := 0; i < 300; i++ {
		name := fmt.Sprintf(".tgdb-stage-%032x", i)
		if _, err := db.Writer.Exec(`INSERT INTO native_backup_staging(name) VALUES(?)`, name); err != nil {
			t.Fatal(err)
		}
		if i%2 == 0 {
			if err := os.WriteFile(filepath.Join(folder, name), []byte("interrupted ciphertext"), 0600); err != nil {
				t.Fatal(err)
			}
		}
	}
	next, err := NewManager(context.Background(), m.opts)
	if err != nil {
		t.Fatal(err)
	}
	defer next.Close()
	entries, err := os.ReadDir(folder)
	if err != nil || len(entries) != 1 || entries[0].Name() != foreign {
		t.Fatal("recovery removed an unowned file or retained owned files", err)
	}
	var n int
	if err = db.Reader.QueryRow(`SELECT count(*) FROM native_backup_staging`).Scan(&n); err != nil || n != 0 {
		t.Fatal("stale staging ownership", err)
	}
}
