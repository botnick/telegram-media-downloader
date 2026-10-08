package telegram

import (
	"context"
	"errors"
	"testing"
)

func TestLiveMonitorReservesBeforeEnqueueAndFiltersDuplicates(t *testing.T) {
	m := NewLiveMonitor(nil)
	event := MediaEvent{Identity: MediaIdentity{Kind: "photo", ID: "42", Size: 10}, FinalPath: "42.jpg"}
	called := 0
	enqueue := func(context.Context, MediaEvent) error { called++; return nil }
	if err := m.Accept(context.Background(), event, enqueue); err != nil {
		t.Fatal(err)
	}
	if err := m.Accept(context.Background(), event, enqueue); !errors.Is(err, ErrEventDuplicate) {
		t.Fatalf("duplicate error = %v", err)
	}
	if called != 1 || !m.Index.Has(event.Identity) {
		t.Fatalf("called=%d reserved=%v", called, m.Index.Has(event.Identity))
	}
}

func TestLiveMonitorReleasesWhenQueueRejects(t *testing.T) {
	m := NewLiveMonitor(nil)
	event := MediaEvent{Identity: MediaIdentity{Kind: "document", ID: "7", Size: 99}}
	reject := errors.New("queue full")
	if err := m.Accept(context.Background(), event, func(context.Context, MediaEvent) error { return reject }); !errors.Is(err, reject) {
		t.Fatalf("error = %v", err)
	}
	if m.Index.Has(event.Identity) {
		t.Fatal("reservation leaked after enqueue failure")
	}
}

func TestLiveMonitorRunContinuesPastDuplicates(t *testing.T) {
	m := NewLiveMonitor(nil)
	event := MediaEvent{Identity: MediaIdentity{Kind: "video", ID: "8", Size: 1}}
	source := make(chan MediaEvent, 2)
	source <- event
	source <- event
	close(source)
	called := 0
	if err := m.Run(context.Background(), source, func(context.Context, MediaEvent) error { called++; return nil }); err != nil {
		t.Fatal(err)
	}
	if called != 1 {
		t.Fatalf("enqueue called %d times", called)
	}
}
