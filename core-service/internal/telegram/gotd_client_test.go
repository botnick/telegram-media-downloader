package telegram

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestNewGotdClientValidatesCredentialsBeforeNetwork(t *testing.T) {
	if _, err := NewGotdClient(GotdConfig{AppID: 0, AppHash: "hash", SessionPath: t.TempDir() + "/session"}); err == nil {
		t.Fatal("expected app id validation error")
	}
	if _, err := NewGotdClient(GotdConfig{AppID: 123, AppHash: "", SessionPath: t.TempDir() + "/session"}); err == nil {
		t.Fatal("expected app hash validation error")
	}
}

func TestNativeSessionMustHaveSecretAndNeverReimportsCorruptState(t *testing.T) {
	path := filepath.Join(t.TempDir(), "native.enc")
	if _, err := NewGotdClient(GotdConfig{AppID: 123, AppHash: "hash", SessionPath: path}); err == nil {
		t.Error("unencrypted native storage accepted")
	}
	if err := os.WriteFile(path, []byte("corrupt native session"), 0600); err != nil {
		t.Fatal(err)
	}
	_, err := NewGotdClient(GotdConfig{AppID: 123, AppHash: "hash", SessionPath: path, SessionSecret: "secret", EncryptedSessionPath: path + ".legacy"})
	if err == nil || !strings.Contains(err.Error(), "native Telegram session") {
		t.Fatalf("corrupt native session was not rejected directly: %v", err)
	}
	content, err := os.ReadFile(path)
	if err != nil || string(content) != "corrupt native session" {
		t.Error("corrupt session was overwritten")
	}
}
