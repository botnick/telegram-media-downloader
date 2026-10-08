package session

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	gotdSession "github.com/gotd/td/session"
)

func TestEncryptedStorageRoundTripTamperAndCancellation(t *testing.T) {
	path := filepath.Join(t.TempDir(), "native.enc")
	s, err := NewEncryptedStorage(path, "test-secret")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.LoadSession(context.Background()); !errors.Is(err, gotdSession.ErrNotFound) {
		t.Fatalf("missing file: %v", err)
	}
	plain := []byte(`{"authKey":"this is only test data"}`)
	if err := s.StoreSession(context.Background(), plain); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(raw, plain) || bytes.Contains(raw, []byte(base64.StdEncoding.EncodeToString(plain))) {
		t.Fatal("plaintext stored")
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" && info.Mode().Perm() != 0600 {
		t.Fatalf("session permissions=%v", info.Mode())
	}
	reopened, err := NewEncryptedStorage(path, "test-secret")
	if err != nil {
		t.Fatal(err)
	}
	got, err := reopened.LoadSession(context.Background())
	if err != nil || !bytes.Equal(got, plain) {
		t.Fatalf("round trip failed: %v", err)
	}
	wrong, _ := NewEncryptedStorage(path, "wrong-secret")
	if _, err := wrong.LoadSession(context.Background()); err == nil {
		t.Fatal("wrong secret accepted")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := s.StoreSession(ctx, []byte("replacement")); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancel error %v", err)
	}
	after, _ := os.ReadFile(path)
	if !bytes.Equal(after, raw) {
		t.Fatal("cancelled store replaced session")
	}
	var envelope nativeEnvelope
	if err := json.Unmarshal(raw, &envelope); err != nil {
		t.Fatal(err)
	}
	envelope.Ciphertext[0] ^= 1
	tampered, _ := json.Marshal(envelope)
	if err := os.WriteFile(path, tampered, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := s.LoadSession(context.Background()); err == nil {
		t.Fatal("tampering accepted")
	}
	files, err := os.ReadDir(filepath.Dir(path))
	if err != nil || len(files) != 1 {
		t.Fatalf("temporary files remain: %d %v", len(files), err)
	}
}

func TestTelethonIPv6Session(t *testing.T) {
	raw := make([]byte, 1+16+2+256)
	raw[0] = 2
	raw[1] = 0x20
	raw[2] = 1
	raw[16] = 1
	raw[17] = 1
	raw[18] = 0xbb
	for i := 19; i < len(raw); i++ {
		raw[i] = byte(i)
	}
	data, err := ParseGramJSStringSession("1" + base64.StdEncoding.EncodeToString(raw))
	if err != nil || data.Addr != "[2001::1]:443" {
		t.Fatalf("IPv6 parse %s %v", data.Addr, err)
	}
}
