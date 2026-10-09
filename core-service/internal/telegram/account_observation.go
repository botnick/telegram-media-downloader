package telegram

import (
	"context"
	"errors"
	"sync"
)

// accountObservation separates an authenticated connection from durable update
// recovery. Browsing and manual downloads need only the former. Promotion uses
// the same connection, so active transfers and dialog leases remain valid.
// Each Account owns one run; the controller constructs a new one after stopping.
type accountObservation struct {
	requested chan struct{}
	ready     chan struct{}
	done      chan struct{}
	once      sync.Once
	err       error // published by closing done
}

func newAccountObservation() *accountObservation {
	return &accountObservation{requested: make(chan struct{}), ready: make(chan struct{}), done: make(chan struct{})}
}

func (o *accountObservation) run(ctx context.Context, ready func(), jobsOnly bool, observe func(context.Context, func()) error) (err error) {
	defer func() { o.err = err; close(o.done) }()
	if jobsOnly {
		ready()
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-o.requested:
		}
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	return observe(ctx, func() {
		close(o.ready)
		if !jobsOnly {
			ready()
		}
	})
}

func (o *accountObservation) start(ctx context.Context) error {
	o.once.Do(func() { close(o.requested) })
	select {
	case <-o.done:
		if o.err != nil {
			return o.err
		}
		return errors.New("Telegram connection ended before observation started")
	case <-ctx.Done():
		return ctx.Err()
	case <-o.ready:
		return nil
	}
}
