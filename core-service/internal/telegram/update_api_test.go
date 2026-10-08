package telegram

import (
	"context"
	"errors"
	"fmt"
	"github.com/botnick/telegram-media-downloader/core-service/internal/store"
	gotd "github.com/gotd/td/telegram"
	"github.com/gotd/td/telegram/updates"
	"github.com/gotd/td/tg"
	"testing"
	"time"
)

type reviewStorage struct {
	*UpdateState
	advanced chan struct{}
}

func (s *reviewStorage) SetChannelPts(ctx context.Context, u, c int64, p int) error {
	err := s.UpdateState.SetChannelPts(ctx, u, c, p)
	if p == 20 && err == nil {
		select {
		case <-s.advanced:
		default:
			close(s.advanced)
		}
	}
	return err
}

type reviewAPI struct{ advanced chan struct{} }

func (a reviewAPI) UpdatesGetState(context.Context) (*tg.UpdatesState, error) {
	return nil, errors.New("unexpected state fetch")
}
func (a reviewAPI) UpdatesGetDifference(ctx context.Context, r *tg.UpdatesGetDifferenceRequest) (tg.UpdatesDifferenceClass, error) {
	select {
	case <-a.advanced:
		return &tg.UpdatesDifferenceEmpty{Date: 1, Seq: 1}, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}
func (a reviewAPI) UpdatesGetChannelDifference(ctx context.Context, r *tg.UpdatesGetChannelDifferenceRequest) (tg.UpdatesChannelDifferenceClass, error) {
	if r.Pts != 10 {
		return &tg.UpdatesChannelDifferenceEmpty{Final: true, Pts: 20}, nil
	}
	return &tg.UpdatesChannelDifference{Final: true, Pts: 20, OtherUpdates: []tg.UpdateClass{&tg.UpdateEditChannelMessage{Pts: 0, PtsCount: 0, Message: &tg.Message{ID: 1, Date: 1, PeerID: &tg.PeerChannel{ChannelID: 42}, Media: &tg.MessageMediaDocument{Document: &tg.Document{ID: 99, Size: 4, DCID: 2}}}}}}, nil
}
func TestChannelDifferenceFailureKeepsCursorBeforeAsynchronousDispatch(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	db, err := store.Open(ctx, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer db.Reader.Close()
	defer db.Writer.Close()
	state := &UpdateState{Writer: db.Writer, Reader: db.Reader, AccountID: "one", OnFailure: func(error) { cancel() }}
	if err = state.SetState(ctx, 1, updates.State{Pts: 1, Qts: 0, Date: 1, Seq: 1}); err != nil {
		t.Fatal(err)
	}
	if err = state.SetChannelPts(ctx, 1, 42, 10); err != nil {
		t.Fatal(err)
	}
	if err = state.SetChannelAccessHash(ctx, 1, 42, 99); err != nil {
		t.Fatal(err)
	}
	advanced := make(chan struct{})
	s := &reviewStorage{state, advanced}
	observed := make(chan int, 1)
	handler := state.GuardHandler(func(ctx context.Context, u tg.UpdatesClass) error {
		pts, _, err := state.GetChannelPts(ctx, 1, 42)
		if err != nil {
			return err
		}
		observed <- pts
		return errors.New("durable sink failed")
	})
	manager := updates.New(updates.Config{Storage: s, AccessHasher: state, Handler: gotd.UpdateHandlerFunc(handler)})
	api := durableUpdateAPI{API: reviewAPI{advanced}, state: state, handle: handler}
	_ = manager.Run(ctx, api, 1, updates.AuthOptions{})
	select {
	case pts := <-observed:
		if pts != 10 {
			t.Fatalf("channel cursor advanced to %d BEFORE durable handler failed (expected 10)", pts)
		}
	default:
		t.Fatal("handler was not invoked")
	}
}

type oversizedDifferenceAPI struct{ reviewAPI }

func (oversizedDifferenceAPI) UpdatesGetDifference(context.Context, *tg.UpdatesGetDifferenceRequest) (tg.UpdatesDifferenceClass, error) {
	return &tg.UpdatesDifferenceTooLong{Pts: 99}, nil
}
func (oversizedDifferenceAPI) UpdatesGetChannelDifference(context.Context, *tg.UpdatesGetChannelDifferenceRequest) (tg.UpdatesChannelDifferenceClass, error) {
	return &tg.UpdatesChannelDifferenceTooLong{Dialog: &tg.Dialog{Pts: 99}}, nil
}
func TestOversizedDifferencesNeverReachCursorManager(t *testing.T) {
	for _, channel := range []int64{0, 42} {
		t.Run(fmt.Sprint(channel), func(t *testing.T) {
			ctx := context.Background()
			db, err := store.Open(ctx, t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			defer db.Reader.Close()
			defer db.Writer.Close()
			s := &UpdateState{Writer: db.Writer, Reader: db.Reader, AccountID: "one"}
			if err = s.SetState(ctx, 1, updates.State{Pts: 10}); err != nil {
				t.Fatal(err)
			}
			observed := int64(-1)
			api := durableUpdateAPI{API: oversizedDifferenceAPI{}, state: s, onGap: func(id int64) { observed = id }}
			if channel == 0 {
				_, err = api.UpdatesGetDifference(ctx, &tg.UpdatesGetDifferenceRequest{Pts: 10})
			} else {
				_, err = api.UpdatesGetChannelDifference(ctx, &tg.UpdatesGetChannelDifferenceRequest{Channel: &tg.InputChannel{ChannelID: channel}})
			}
			if err == nil || observed != channel {
				t.Fatalf("gap=%d err=%v", observed, err)
			}
			if err = s.SetPts(ctx, 1, 99); err == nil {
				t.Fatal("gap did not latch cursor writes")
			}
			state, _, err := s.GetState(ctx, 1)
			if err != nil || state.Pts != 10 {
				t.Fatalf("lost recovery cursor: %+v %v", state, err)
			}
		})
	}
}
