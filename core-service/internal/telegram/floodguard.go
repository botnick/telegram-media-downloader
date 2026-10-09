package telegram

import (
	"context"
	"sync"
	"time"

	"github.com/gotd/td/bin"
	gotd "github.com/gotd/td/telegram"
	"github.com/gotd/td/tg"
	"github.com/gotd/td/tgerr"
	"golang.org/x/time/rate"
)

// Flood protection for one account, shared by its main connection and the
// per-DC download pools (which gotd does not pass through middlewares).
//
//   - Every RPC waits for the account's flood gate and a request-rate limit.
//   - FLOOD_WAIT closes the gate for the whole account for the wait Telegram
//     asked for, so other workers stop instead of digging the wait deeper.
//   - Waits up to floodSleepThreshold are slept through and retried (as
//     gramJS did with floodSleepThreshold = 60 s); longer waits are returned
//     to the caller, which reschedules the work after the gate reopens.
var (
	floodSleepThreshold = 60 * time.Second
	floodInlineRetries  = 3
	floodGateMargin     = time.Second
	accountRequestRate  = rate.Limit(60)
	accountRequestBurst = 60
)

type floodGuard struct {
	limiter *rate.Limiter
	mu      sync.Mutex
	until   time.Time
}

func newFloodGuard() *floodGuard {
	return &floodGuard{limiter: rate.NewLimiter(accountRequestRate, accountRequestBurst)}
}

// FloodWaitUntil reports when the account's flood gate reopens (zero when open).
func (g *floodGuard) FloodWaitUntil() time.Time {
	g.mu.Lock()
	defer g.mu.Unlock()
	if time.Now().After(g.until) {
		return time.Time{}
	}
	return g.until
}

func (g *floodGuard) close(d time.Duration) time.Time {
	g.mu.Lock()
	defer g.mu.Unlock()
	if until := time.Now().Add(d + floodGateMargin); until.After(g.until) {
		g.until = until
	}
	return g.until
}

func (g *floodGuard) wait(ctx context.Context) error {
	for {
		g.mu.Lock()
		delay := time.Until(g.until)
		g.mu.Unlock()
		if delay <= 0 {
			return g.limiter.Wait(ctx)
		}
		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-timer.C:
		}
	}
}

func (g *floodGuard) invoke(ctx context.Context, next tg.Invoker, input bin.Encoder, output bin.Decoder) error {
	for attempt := 0; ; attempt++ {
		if err := g.wait(ctx); err != nil {
			return err
		}
		err := next.Invoke(ctx, input, output)
		d, flood := tgerr.AsFloodWait(err)
		if !flood {
			return err
		}
		g.close(d)
		if d > floodSleepThreshold || attempt >= floodInlineRetries {
			return err
		}
	}
}

// Middleware guards the account's main connection.
func (g *floodGuard) Middleware() gotd.Middleware {
	return gotd.MiddlewareFunc(func(next tg.Invoker) gotd.InvokeFunc {
		return func(ctx context.Context, input bin.Encoder, output bin.Decoder) error {
			return g.invoke(ctx, next, input, output)
		}
	})
}

// guardedInvoker applies the same guard to a download pool connection.
type guardedInvoker struct {
	gotd.CloseInvoker
	guard *floodGuard
}

func (i guardedInvoker) Invoke(ctx context.Context, input bin.Encoder, output bin.Decoder) error {
	return i.guard.invoke(ctx, i.CloseInvoker, input, output)
}
