package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/aes"
	"crypto/cipher"
	"crypto/pbkdf2"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/botnick/telegram-media-downloader/core-service/internal/backup"
)

func TestOfflineBackupCommandsWithIndependentAEAD(t *testing.T) {
	t.Setenv("TGDL_DATA_DIR", "")
	dir := t.TempDir()
	pass := []byte("exact password\n")
	salt := bytes.Repeat([]byte{9}, 16)
	key, err := pbkdf2.Key(sha256.New, string(pass), salt, 200000, 32)
	if err != nil {
		t.Fatal(err)
	}
	b, err := aes.NewCipher(key)
	if err != nil {
		t.Fatal(err)
	}
	g, err := cipher.NewGCM(b)
	if err != nil {
		t.Fatal(err)
	}
	seal := func(data []byte) []byte {
		header := append([]byte("TGDB\x01"), bytes.Repeat([]byte{8}, 12)...)
		return g.Seal(header, header[5:], data, nil)
	}
	write := func(name string, data []byte) string {
		t.Helper()
		p := filepath.Join(dir, name)
		if e := os.WriteFile(p, data, 0600); e != nil {
			t.Fatal(e)
		}
		return p
	}
	password := write("password", pass)
	info, _ := json.Marshal(map[string]any{"success": true, "recovery": backup.RecoveryInfo{Format: "TGDB", Version: 1, KDF: "PBKDF2-HMAC-SHA256", Iterations: 200000, SaltHex: hex.EncodeToString(salt)}})
	recovery := write("recovery.json", info)
	input := write("media.tgdb", seal([]byte("fixture media")))
	output := filepath.Join(dir, "media")
	var stdout, stderr bytes.Buffer
	args := []string{"backup-decrypt", "--input", input, "--output", output, "--passphrase-file", password, "--recovery-info", recovery}
	if code := run(args, &stdout, &stderr); code != 0 {
		t.Fatalf("decrypt exit %d: %s", code, &stderr)
	}
	got, err := os.ReadFile(output)
	if err != nil || string(got) != "fixture media" {
		t.Fatal("wrong CLI output", err)
	}
	if code := run(args, &stdout, &stderr); code != 1 {
		t.Fatal("existing output accepted", code)
	}
	wrong := write("wrong", []byte("exact password"))
	// Build explicit flags so the newline case also checks secret-free errors.
	args = []string{"backup-decrypt", "--input", input, "--output", filepath.Join(dir, "wrong-output"), "--passphrase-file", wrong, "--salt-hex", hex.EncodeToString(salt)}
	stderr.Reset()
	if code := run(args, &stdout, &stderr); code != 1 {
		t.Fatal("trimmed passphrase accepted", code)
	}
	if strings.Contains(stderr.String(), string(pass)) {
		t.Fatal("passphrase in CLI error")
	}

	dbfile := filepath.Join(dir, "db.sqlite")
	db, err := sql.Open("sqlite", dbfile)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(`CREATE TABLE downloads(id INTEGER); CREATE TABLE kv(key TEXT,value TEXT);INSERT INTO kv VALUES('saved','yes')`); err != nil {
		t.Fatal(err)
	}
	if err = db.Close(); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(dbfile)
	if err != nil {
		t.Fatal(err)
	}
	var archive bytes.Buffer
	gz := gzip.NewWriter(&archive)
	tw := tar.NewWriter(gz)
	if err = tw.WriteHeader(&tar.Header{Name: "db.sqlite", Mode: 0600, Size: int64(len(raw))}); err != nil {
		t.Fatal(err)
	}
	if _, err = tw.Write(raw); err != nil {
		t.Fatal(err)
	}
	if err = tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err = gz.Close(); err != nil {
		t.Fatal(err)
	}
	for _, encrypted := range []bool{true, false} {
		name := "encrypted"
		blob := seal(archive.Bytes())
		extra := []string{"--passphrase-file", password, "--recovery-info", recovery}
		if !encrypted {
			name = "plain"
			blob = archive.Bytes()
			extra = []string{"--plaintext"}
		}
		input = write(name+".snapshot", blob)
		output = filepath.Join(dir, name+"-restored")
		args = append([]string{"backup-restore", "--input", input, "--output", output}, extra...)
		stderr.Reset()
		if code := run(args, &stdout, &stderr); code != 0 {
			t.Fatalf("restore exit %d: %s", code, &stderr)
		}
		got, err = os.ReadFile(filepath.Join(output, "db.sqlite"))
		if err != nil || !bytes.Equal(got, raw) {
			t.Fatal("CLI restore changed SQLite bytes", err)
		}
	}
}
