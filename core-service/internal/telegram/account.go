package telegram

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	sessionconv "github.com/botnick/telegram-media-downloader/core-service/internal/session"
	"github.com/gotd/td/session"
	gotd "github.com/gotd/td/telegram"
	"github.com/gotd/td/telegram/updates"
	"github.com/gotd/td/tg"
)

type SavedSession struct {
	ID, NativePath, ImportPath string
	Modified                   time.Time
}

// SavedSessions never selects two clients for a native file and its original
// imported session. Native state stays in its own directory, preserving the
// original encrypted session until migration is verified.
func SavedSessions(dataDir string) ([]SavedSession, error) {
	root := filepath.Join(dataDir, "sessions")
	byID := map[string]SavedSession{}
	for _, native := range []bool{false, true} {
		dir := root
		if native {
			dir = filepath.Join(root, "native")
		}
		entries, err := os.ReadDir(dir)
		if err != nil {
			if os.IsNotExist(err) {
				continue
			}
			return nil, err
		}
		for _, entry := range entries {
			if !strings.HasSuffix(entry.Name(), ".enc") {
				continue
			}
			info, err := entry.Info()
			if err != nil {
				return nil, err
			}
			if !info.Mode().IsRegular() {
				return nil, fmt.Errorf("session %q is not a regular file", entry.Name())
			}
			id := strings.TrimSuffix(entry.Name(), ".enc")
			if id == "" {
				return nil, errors.New("invalid empty account id")
			}
			saved, found := byID[id]
			if !found {
				saved = SavedSession{ID: id, NativePath: filepath.Join(root, "native", id+".enc"), Modified: info.ModTime()}
			}
			if !native {
				saved.ImportPath = filepath.Join(root, entry.Name())
			}
			byID[id] = saved
		}
	}
	// A legacy single-account file is imported under one stable ID only when
	// no multi-account session exists. No second connection shares its key.
	if len(byID) == 0 {
		legacy := filepath.Join(dataDir, "session.enc")
		if info, err := os.Lstat(legacy); err == nil {
			if !info.Mode().IsRegular() {
				return nil, errors.New("legacy Telegram session is not a regular file")
			}
			byID["legacy"] = SavedSession{ID: "legacy", NativePath: filepath.Join(root, "native", "legacy.enc"), ImportPath: legacy, Modified: info.ModTime()}
		} else if !os.IsNotExist(err) {
			return nil, err
		}
	}
	out := make([]SavedSession, 0, len(byID))
	for _, saved := range byID {
		out = append(out, saved)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Modified.Equal(out[j].Modified) {
			return out[i].ID < out[j].ID
		}
		return out[i].Modified.Before(out[j].Modified)
	})
	return out, nil
}

type Account struct {
	*GotdClient
	updates     *updates.Manager
	fingerprint string
	state       *UpdateState
	handle      func(context.Context, tg.UpdatesClass) error
	onGap       func(int64)
	selfID      int64
}

func NewAccount(cfg GotdConfig, state *UpdateState, handle func(context.Context, tg.UpdatesClass) error, onGap func(int64)) (*Account, error) {
	if state == nil || handle == nil {
		return nil, errors.New("account update storage and handler are required")
	}
	manager := updates.New(updates.Config{Storage: state, AccessHasher: state, Handler: gotd.UpdateHandlerFunc(state.GuardHandler(handle)), OnChannelTooLong: onGap})
	cfg.UpdateHandler = manager
	client, err := NewGotdClient(cfg)
	if err != nil {
		return nil, err
	}
	storage, err := sessionconv.NewEncryptedStorage(cfg.SessionPath, cfg.SessionSecret)
	if err != nil {
		return nil, err
	}
	data, err := (&session.Loader{Storage: storage}).Load(context.Background())
	if err != nil {
		return nil, err
	}
	sum := sha256.Sum256(data.AuthKey)
	return &Account{GotdClient: client, updates: manager, fingerprint: hex.EncodeToString(sum[:]), state: state, handle: state.GuardHandler(handle), onGap: onGap}, nil
}
func (a *Account) Fingerprint() string { return a.fingerprint }
func (a *Account) Run(ctx context.Context, ready func()) error {
	defer a.updates.Reset()
	return a.GotdClient.Run(ctx, func(ctx context.Context) error {
		status, err := a.client.Auth().Status(ctx)
		if err != nil {
			return err
		}
		if !status.Authorized || status.User == nil {
			return errors.New("Telegram session expired; sign in again in Accounts")
		}
		api := durableUpdateAPI{API: a.API(), state: a.state, handle: a.handle, onGap: a.onGap}
		a.selfID = status.User.ID
		return a.updates.Run(ctx, api, status.User.ID, updates.AuthOptions{IsBot: status.User.Bot, OnStart: func(context.Context) { ready() }})
	})
}
