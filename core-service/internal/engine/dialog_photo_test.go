package engine

import (
	"bytes"
	"context"
	"errors"
	"io"
	"testing"

	"github.com/botnick/telegram-media-downloader/core-service/internal/telegram"
)

type photoEngineAccount struct {
	dialogCallbackAccount
	photo func(context.Context, telegram.Dialog, io.Writer) (bool, error)
}

func (a *photoEngineAccount) DownloadDialogPhoto(ctx context.Context, dialog telegram.Dialog, w io.Writer) (bool, error) {
	return a.photo(ctx, dialog, w)
}

func TestDialogPhotoUsesReadableAccountWithoutRelistingOrFallback(t *testing.T) {
	for _, fail := range []bool{false, true} {
		t.Run(map[bool]string{false: "readable", true: "transport_error"}[fail], func(t *testing.T) {
			lists, downloads := 0, 0
			networkErr := errors.New("network failed")
			accounts := map[string]Account{}
			for _, id := range []string{"a-blocked", "b-readable", "c-other"} {
				state := "ok"
				if id == "a-blocked" {
					state = "banned"
				}
				dialog := telegram.Dialog{ID: "42", Name: id, Access: telegram.DialogAccess{State: state}}
				accounts[id] = &photoEngineAccount{dialogCallbackAccount: dialogCallbackAccount{list: func(_ context.Context, _ int, archived bool) ([]telegram.Dialog, error) {
					lists++
					if archived {
						return nil, nil
					}
					return []telegram.Dialog{dialog}, nil
				}}, photo: func(_ context.Context, d telegram.Dialog, w io.Writer) (bool, error) {
					downloads++
					if id != "b-readable" || d.Name != id {
						t.Errorf("photo bound to wrong account: %s %+v", id, d)
					}
					if fail {
						return false, networkErr
					}
					_, err := w.Write([]byte("photo"))
					return true, err
				}}
			}
			c := &Controller{state: "running", run: &running{ctx: context.Background(), accounts: accounts, ids: []string{"c-other", "a-blocked", "b-readable"}}}
			if _, err := c.Dialogs(context.Background(), 500); err != nil {
				t.Fatal(err)
			}
			session, err := c.OpenDialogs(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			defer session.Close()
			var b bytes.Buffer
			found, err := session.DownloadPhoto("42", &b)
			if fail {
				if found || !errors.Is(err, networkErr) {
					t.Fatalf("transport result=%t %v", found, err)
				}
			} else if !found || err != nil || b.String() != "photo" {
				t.Fatalf("photo=%t %q %v", found, b.String(), err)
			}
			if lists != 6 || downloads != 1 {
				t.Fatalf("listing RPCs=%d downloads=%d", lists, downloads)
			}
		})
	}
}
