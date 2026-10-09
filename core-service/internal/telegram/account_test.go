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
	// Node migrated session.enc into sessions/ and left it behind: with a
	// Node account file present it is a stale duplicate, as Node treated it.
	if len(accounts) != 2 {
		t.Fatalf("duplicate account selected: %+v", accounts)
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
	for _, a := range accounts {
		if a.ID == "legacy" {
			t.Fatalf("stale Node legacy session selected: %+v", a)
		}
	}
}

func TestSavedSessionDiscoveryKeepsLegacyBesideNativeAccounts(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "sessions", "native"), 0700); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"session.enc", "sessions/native/two.enc"} {
		if err := os.WriteFile(filepath.Join(root, name), []byte("discovery-only fixture"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	accounts, err := SavedSessions(root)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, a := range accounts {
		if a.ID == "legacy" && a.ImportPath == filepath.Join(root, "session.enc") {
			found = true
		}
	}
	if len(accounts) != 2 || !found {
		t.Fatalf("legacy account hidden by a native account: %+v", accounts)
	}
}

func TestSavedSessionDiscoveryRejectsAmbiguousLegacyOwnership(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "sessions", "native"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "session.enc"), []byte("old"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "sessions", "native", "legacy.enc"), []byte("different"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := SavedSessions(root); err == nil {
		t.Fatal("ambiguous legacy ownership was silently merged")
	}
}

func TestSavedSessionDiscoveryUsesLegacyImportMarker(t *testing.T) {
	root := t.TempDir()
	native := filepath.Join(root, "sessions", "native")
	if err := os.MkdirAll(native, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "session.enc"), []byte("old"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(native, "legacy.enc"), []byte("converted"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(native, "legacy.enc.imported"), []byte("legacy\n"), 0600); err != nil {
		t.Fatal(err)
	}
	accounts, err := SavedSessions(root)
	if err != nil || len(accounts) != 1 || accounts[0].ID != "legacy" || accounts[0].ImportPath != filepath.Join(root, "session.enc") {
		t.Fatalf("marker did not associate import: %+v %v", accounts, err)
	}
}
