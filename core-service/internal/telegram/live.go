package telegram

import (
	"context"
	"errors"
)

// MediaEvent is the metadata available from a Telegram update before any
// bytes are fetched. The identity is reserved at this point, which makes
// live updates and history catch-up share one dedup gate.
type MediaEvent struct {
	Identity  MediaIdentity
	FinalPath string
}

var ErrEventDuplicate = errors.New("telegram media event is already queued")

// LiveMonitor owns the pre-download reservation boundary. The enqueue
// callback should hand the event to download.Manager.DownloadReserved; if it
// fails, the reservation is released so a later retry can proceed.
type LiveMonitor struct {
	Index *DedupIndex
}

func NewLiveMonitor(index *DedupIndex) *LiveMonitor {
	if index == nil {
		index = NewDedupIndex()
	}
	return &LiveMonitor{Index: index}
}

// Accept reserves an event and invokes enqueue exactly once. A duplicate is
// acknowledged without invoking the callback, so repeated Telegram updates
// never trigger another download request.
func (m *LiveMonitor) Accept(ctx context.Context, event MediaEvent, enqueue func(context.Context, MediaEvent) error) error {
	if m == nil || m.Index == nil || enqueue == nil {
		return errors.New("live monitor is not configured")
	}
	if !m.Index.Reserve(event.Identity) {
		return ErrEventDuplicate
	}
	if err := enqueue(ctx, event); err != nil {
		m.Index.Release(event.Identity)
		return err
	}
	return nil
}

// Run consumes a source until it closes or the context is cancelled. Duplicate
// events are filtered but do not stop the stream; the first enqueue error is
// returned after the event reservation is released.
func (m *LiveMonitor) Run(ctx context.Context, source <-chan MediaEvent, enqueue func(context.Context, MediaEvent) error) error {
	if source == nil {
		return errors.New("live event source is nil")
	}
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case event, ok := <-source:
			if !ok {
				return nil
			}
			if err := m.Accept(ctx, event, enqueue); err != nil && !errors.Is(err, ErrEventDuplicate) {
				return err
			}
		}
	}
}
