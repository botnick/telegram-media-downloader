package telegram

import "testing"

func TestNewGotdClientValidatesCredentialsBeforeNetwork(t *testing.T) {
	if _, err := NewGotdClient(GotdConfig{AppID: 0, AppHash: "hash", SessionPath: t.TempDir() + "/session"}); err == nil {
		t.Fatal("expected app id validation error")
	}
	if _, err := NewGotdClient(GotdConfig{AppID: 123, AppHash: "", SessionPath: t.TempDir() + "/session"}); err == nil {
		t.Fatal("expected app hash validation error")
	}
}
