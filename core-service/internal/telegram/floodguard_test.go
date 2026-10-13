package telegram

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/gotd/td/bin"
	"github.com/gotd/td/tgerr"
	"golang.org/x/time/rate"
)

type scriptedInvoker struct {
	errs  []error
	calls int
}

func (s *scriptedInvoker) Invoke(context.Context, bin.Encoder, bin.Decoder) error {
	s.calls++
	if len(s.errs) == 0 {
		return nil
	}
	err := s.errs[0]
	s.errs = s.errs[1:]
	return err
}

func floodErr(seconds int) error {
	return &tgerr.Error{Code: 420, Type: "FLOOD_WAIT", Argument: seconds}
}

func withFastFlood(t *testing.T) {
	t.Helper()
	threshold, margin := floodSleepThreshold, floodGateMargin
	floodSleepThreshold, floodGateMargin = 2*time.Second, 10*time.Millisecond
	t.Cleanup(func() { floodSleepThreshold, floodGateMargin = threshold, margin })
}

func TestFloodGuardSleepsThroughShortWaitAndRetries(t *testing.T) {
	withFastFlood(t)
	g := newFloodGuard()
	next := &scriptedInvoker{errs: []error{floodErr(1)}}
	started := time.Now()
	if err := g.invoke(context.Background(), next, nil, nil); err != nil {
		t.Fatal(err)
	}
	if next.calls != 2 || time.Since(started) < time.Second {
		t.Fatalf("calls=%d waited=%s", next.calls, time.Since(started))
	}
}

func TestFloodGuardReturnsLongWaitAndClosesAccountGate(t *testing.T) {
	withFastFlood(t)
	g := newFloodGuard()
	next := &scriptedInvoker{errs: []error{floodErr(30)}}
	err := g.invoke(context.Background(), next, nil, nil)
	if d, ok := tgerr.AsFloodWait(err); !ok || d != 30*time.Second || next.calls != 1 {
		t.Fatalf("err=%v calls=%d", err, next.calls)
	}
	until := g.FloodWaitUntil()
	if until.IsZero() || time.Until(until) < 29*time.Second {
		t.Fatalf("gate not closed: %v", until)
	}
	// Other requests of the account wait for the gate instead of hitting Telegram.
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	other := &scriptedInvoker{}
	if err := g.invoke(ctx, other, nil, nil); !errors.Is(err, context.DeadlineExceeded) || other.calls != 0 {
		t.Fatalf("gated call err=%v calls=%d", err, other.calls)
	}
}

func TestFloodGuardStopsInlineRetriesAndPassesOtherErrors(t *testing.T) {
	withFastFlood(t)
	floodInlineRetries = 1
	t.Cleanup(func() { floodInlineRetries = 3 })
	g := newFloodGuard()
	g.limiter = rate.NewLimiter(rate.Inf, 1)
	next := &scriptedInvoker{errs: []error{floodErr(0), floodErr(0), floodErr(0)}}
	if _, ok := tgerr.AsFloodWait(g.invoke(context.Background(), next, nil, nil)); !ok || next.calls != 2 {
		t.Fatalf("calls=%d", next.calls)
	}
	plain := errors.New("FILE_REFERENCE_EXPIRED")
	if err := g.invoke(context.Background(), &scriptedInvoker{errs: []error{plain}}, nil, nil); !errors.Is(err, plain) {
		t.Fatalf("err=%v", err)
	}
}

type scriptedPool struct{ *scriptedInvoker }

func (scriptedPool) Close() error { return nil }

// A file Telegram refuses on every retry must fail its attempt as an ordinary
// error: left as a flood wait the library retries it forever and each retry
// closes the account gate for every other download.
func TestSharedInvokerFailsFileThatKeepsFlooding(t *testing.T) {
	withFastFlood(t)
	floodInlineRetries = 1
	t.Cleanup(func() { floodInlineRetries = 3 })
	g := newFloodGuard()
	g.limiter = rate.NewLimiter(rate.Inf, 1)
	next := &scriptedInvoker{errs: []error{floodErr(0), floodErr(0), floodErr(0)}}
	err := sharedInvoker{scriptedPool{next}, g}.Invoke(context.Background(), nil, nil)
	if _, flood := tgerr.AsFloodWait(err); err == nil || flood || next.calls != 2 {
		t.Fatalf("err=%v calls=%d", err, next.calls)
	}
	// A long wait is the account's: it stays a flood wait and is rescheduled.
	long := &scriptedInvoker{errs: []error{floodErr(30)}}
	g = newFloodGuard()
	if _, flood := tgerr.AsFloodWait(sharedInvoker{scriptedPool{long}, g}.Invoke(context.Background(), nil, nil)); !flood {
		t.Fatal("long wait lost its flood type")
	}
}

// A request that dies with its connection is asked again instead of failing
// the file; an answer from Telegram is not retried.
func TestSharedInvokerRetriesLostConnection(t *testing.T) {
	delay := connectionRetryDelay
	connectionRetryDelay = time.Millisecond
	t.Cleanup(func() { connectionRetryDelay = delay })
	g := newFloodGuard()
	lost := errors.New("invoke pool: rpcDoRequest: retryUntilAck: engine forcibly closed: context canceled")
	next := &scriptedInvoker{errs: []error{lost, errors.New("write tcp 1.2.3.4:1->5.6.7.8:443: write: broken pipe")}}
	if err := (sharedInvoker{scriptedPool{next}, g}).Invoke(context.Background(), nil, nil); err != nil || next.calls != 3 {
		t.Fatalf("err=%v calls=%d", err, next.calls)
	}
	refused := &tgerr.Error{Code: 400, Type: "FILE_REFERENCE_EXPIRED"}
	next = &scriptedInvoker{errs: []error{refused}}
	if err := (sharedInvoker{scriptedPool{next}, g}).Invoke(context.Background(), nil, nil); !errors.Is(err, refused) || next.calls != 1 {
		t.Fatalf("err=%v calls=%d", err, next.calls)
	}
	// The caller's own cancellation is not a lost connection.
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	next = &scriptedInvoker{errs: []error{lost, lost}}
	_ = (sharedInvoker{scriptedPool{next}, g}).Invoke(ctx, nil, nil)
	if next.calls > 1 {
		t.Fatalf("retried after cancel: calls=%d", next.calls)
	}
}
