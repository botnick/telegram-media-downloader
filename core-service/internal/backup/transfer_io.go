package backup

import (
	"context"
	"io"
	"net"
	"net/http"
	"sync"
	"time"

	"golang.org/x/time/rate"
)

const remoteIdleTimeout = time.Minute

type uploadPacerKey struct{}
type uploadPacer struct {
	limiter *rate.Limiter
	chunk   int
}

func newUploadPacer(bytesPerSecond int64) *uploadPacer {
	if bytesPerSecond <= 0 {
		return nil
	}
	chunk := int(min(int64(32<<10), max(int64(1), bytesPerSecond/10)))
	return &uploadPacer{rate.NewLimiter(rate.Limit(bytesPerSecond), chunk), chunk}
}
func withUploadPacer(ctx context.Context, p *uploadPacer) context.Context {
	return context.WithValue(ctx, uploadPacerKey{}, p)
}
func uploadPacerFrom(ctx context.Context) *uploadPacer {
	p, _ := ctx.Value(uploadPacerKey{}).(*uploadPacer)
	return p
}

type pacedReader struct {
	ctx    context.Context
	reader io.Reader
	pacer  *uploadPacer
}

func (r pacedReader) Read(b []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	if r.pacer != nil && len(b) > r.pacer.chunk {
		b = b[:r.pacer.chunk]
	}
	n, err := r.reader.Read(b)
	if r.pacer != nil && n > 0 {
		if e := r.pacer.limiter.WaitN(r.ctx, n); e != nil {
			if r.ctx.Err() != nil {
				e = r.ctx.Err()
			}
			return 0, e
		}
	}
	return n, err
}

// A write deadline measures network backpressure, not time spent preparing or
// pacing a body. Read liveness belongs to the HTTP response / SFTP requests.
type remoteWriteConn struct{ net.Conn }

func (c *remoteWriteConn) Write(b []byte) (int, error) {
	_ = c.Conn.SetWriteDeadline(time.Now().Add(remoteIdleTimeout))
	return c.Conn.Write(b)
}

type uploadBodyKey struct{}
type uploadBodyControl struct {
	progress *transferProgress
	part     int64
}

func withUploadBody(ctx context.Context, progress *transferProgress, part int64) context.Context {
	return context.WithValue(ctx, uploadBodyKey{}, uploadBodyControl{progress, part})
}

// Only the final HTTP transport reads are paced/count as progress. SDK signing
// and checksum passes remain unthrottled; retries consume bandwidth again.
type backupHTTPTransport struct {
	base        http.RoundTripper
	readTimeout time.Duration
}

func (t *backupHTTPTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	ctx, cancel := context.WithCancelCause(req.Context())
	r := req.Clone(ctx)
	if control, ok := ctx.Value(uploadBodyKey{}).(uploadBodyControl); ok && r.Body != nil {
		wrap := func(body io.ReadCloser) io.ReadCloser {
			bodyCtx, bodyCancel := context.WithCancel(ctx)
			return &pacedHTTPBody{original: body, reader: pacedReader{bodyCtx, body, uploadPacerFrom(ctx)}, cancel: bodyCancel, control: control}
		}
		r.Body = wrap(r.Body)
		if get := r.GetBody; get != nil {
			r.GetBody = func() (io.ReadCloser, error) {
				b, err := get()
				if err != nil {
					return nil, err
				}
				return wrap(b), nil
			}
		}
	}
	response, err := t.base.RoundTrip(r)
	if err != nil {
		cancel(context.Canceled)
		return nil, err
	}
	timeout := t.readTimeout
	if timeout <= 0 {
		timeout = remoteIdleTimeout
	}
	timer := time.AfterFunc(timeout, func() { cancel(context.DeadlineExceeded) })
	timer.Stop()
	response.Body = &timedHTTPBody{body: response.Body, cancel: func() { cancel(context.Canceled) }, timer: timer, timeout: timeout}
	return response, nil
}

type pacedHTTPBody struct {
	original io.ReadCloser
	reader   pacedReader
	cancel   context.CancelFunc
	control  uploadBodyControl
	position int64
}

func (b *pacedHTTPBody) Read(p []byte) (int, error) {
	n, err := b.reader.Read(p)
	b.position += int64(n)
	if n > 0 {
		b.control.progress.read(b.control.part, b.position)
	}
	return n, err
}
func (b *pacedHTTPBody) Close() error { b.cancel(); return b.original.Close() }

type timedHTTPBody struct {
	body    io.ReadCloser
	cancel  context.CancelFunc
	timeout time.Duration
	timer   *time.Timer
	once    sync.Once
}

func (b *timedHTTPBody) Read(p []byte) (int, error) {
	// Waiting between Read calls is local processing. Only a blocked network
	// body Read starts the timer; a partial response cannot stall indefinitely.
	b.timer.Reset(b.timeout)
	n, err := b.body.Read(p)
	b.timer.Stop()
	return n, err
}
func (b *timedHTTPBody) Close() error {
	b.once.Do(func() { b.timer.Stop(); b.cancel() })
	return b.body.Close()
}
