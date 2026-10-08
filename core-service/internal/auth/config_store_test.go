package auth

import (
	"context"
	"testing"

	"github.com/botnick/telegram-media-downloader/core-service/internal/store"
)

func TestConfigStoreLoginAndSetup(t *testing.T) {
	db, err := store.Open(context.Background(), t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer db.Writer.Close()
	defer db.Reader.Close()
	cs := ConfigStore{DB: db.Writer}
	if err := cs.SetAdminPassword(context.Background(), "correct horse"); err != nil {
		t.Fatal(err)
	}
	role, configured, err := cs.Login(context.Background(), "correct horse")
	if err != nil || !configured || role != "admin" {
		t.Fatalf("login = role %q configured %v err %v", role, configured, err)
	}
	role, configured, err = cs.Login(context.Background(), "wrong")
	if err != nil || !configured || role != "" {
		t.Fatalf("wrong login = role %q configured %v err %v", role, configured, err)
	}
}
