package telegram

import (
	"os"
	"path/filepath"
	"testing"
)

func TestSavedSessionDiscoveryMergesNativeAndImportedAccount(t *testing.T) {
	root := t.TempDir()
	native := filepath.Join(root, "sessions", "native")
	if err := os.MkdirAll(native, 0700); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"session.enc", "sessions/one.enc", "sessions/native/one.enc", "sessions/native/two.enc"} {
		if err := os.WriteFile(filepath.Join(root, name), []byte("discovery-only fixture"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	accounts, err := SavedSessions(root)
	if err != nil {
		t.Fatal(err)
	}
	if len(accounts) != 2 {
		t.Fatalf("duplicate or legacy account selected: %+v", accounts)
	}
	found := false
	for _, a := range accounts {
		if a.ID == "one" {
			found = true
			if a.ImportPath == "" || a.NativePath != filepath.Join(native, "one.enc") {
				t.Fatalf("lost import/native paths: %+v", a)
			}
		}
	}
	if !found {
		t.Fatal("imported account missing")
	}
}
