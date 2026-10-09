package app

import (
	"bufio"
	"compress/gzip"
	"compress/zlib"
	"context"
	"errors"
	"io"
	"mime"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/andybalholm/brotli"
)

type responseCompressor interface {
	io.WriteCloser
	Flush() error
	Reset(io.Writer)
}
type compressionPool struct {
	level                     int
	slots                     chan struct{}
	pools                     map[string]chan responseCompressor
	waitTimeout, writeTimeout time.Duration
}

func newCompressionPool(level int) *compressionPool {
	return &compressionPool{level: level, slots: make(chan struct{}, 8), waitTimeout: 30 * time.Second, writeTimeout: 30 * time.Second, pools: map[string]chan responseCompressor{"gzip": make(chan responseCompressor, 2), "deflate": make(chan responseCompressor, 2), "br": make(chan responseCompressor, 2)}}
}

var errCompressionBusy = errors.New("response compression capacity exhausted")

func (p *compressionPool) acquire(ctx context.Context, encoding string, dst io.Writer) (responseCompressor, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	select {
	case p.slots <- struct{}{}:
	default:
		timer := time.NewTimer(p.waitTimeout)
		defer timer.Stop()
		select {
		case p.slots <- struct{}{}:
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-timer.C:
			return nil, errCompressionBusy
		}
	}
	select {
	case w := <-p.pools[encoding]:
		w.Reset(dst)
		return w, nil
	default:
	}
	var w responseCompressor
	var err error
	switch encoding {
	case "gzip":
		w, err = gzip.NewWriterLevel(dst, p.level)
	case "deflate":
		w, err = zlib.NewWriterLevel(dst, p.level)
	case "br":
		w = brotli.NewWriterOptions(dst, brotli.WriterOptions{Quality: p.level, LGWin: 18})
	default:
		err = errors.New("unsupported content encoding")
	}
	if err != nil {
		<-p.slots
	}
	return w, err
}
func (p *compressionPool) release(encoding string, w responseCompressor) {
	w.Reset(io.Discard) // do not retain a response or request through the pool
	select {
	case p.pools[encoding] <- w:
	default:
	}
	<-p.slots
}

func acceptedEncoding(raw string) string {
	quality := map[string]float64{}
	for _, item := range strings.Split(raw, ",") {
		parts := strings.Split(item, ";")
		name := strings.ToLower(strings.TrimSpace(parts[0]))
		if name == "" {
			continue
		}
		q := 1.0
		if len(parts) > 2 {
			q = 0
		} else if len(parts) == 2 {
			key, value, ok := strings.Cut(strings.TrimSpace(parts[1]), "=")
			if !ok || !strings.EqualFold(key, "q") || len(value) > 5 {
				q = 0
			} else {
				value = strings.TrimSpace(value)
				valid := value == "0" || value == "1"
				if len(value) >= 2 && value[1] == '.' && (value[0] == '0' || value[0] == '1') {
					valid = true
					for _, c := range value[2:] {
						if c < '0' || c > '9' || value[0] == '1' && c != '0' {
							valid = false
						}
					}
				}
				if valid {
					q, _ = strconv.ParseFloat(value, 64)
				} else {
					q = 0
				}
			}
		}
		if previous, ok := quality[name]; !ok || q < previous {
			quality[name] = q
		}
	}
	best, score := "", 0.0
	for _, name := range []string{"br", "gzip", "deflate"} {
		q, ok := quality[name]
		if !ok {
			q = quality["*"]
		}
		if q > score {
			best, score = name, q
		}
	}
	if q, ok := quality["identity"]; ok && q > score {
		return ""
	}
	return best
}
func appendVary(h http.Header, name string) {
	for _, v := range h.Values("Vary") {
		for _, token := range strings.Split(v, ",") {
			if strings.EqualFold(strings.TrimSpace(token), name) || token == "*" {
				return
			}
		}
	}
	if old := h.Get("Vary"); old != "" {
		h.Set("Vary", old+", "+name)
	} else {
		h.Set("Vary", name)
	}
}
func compressible(h http.Header, status int) bool {
	if status < 200 || status == 204 || status == 206 || status == 304 || h.Get("Content-Encoding") != "" || h.Get("Content-Range") != "" {
		return false
	}
	for _, v := range strings.Split(strings.ToLower(h.Get("Cache-Control")), ",") {
		if strings.TrimSpace(v) == "no-transform" {
			return false
		}
	}
	typ, _, err := mime.ParseMediaType(h.Get("Content-Type"))
	if err != nil {
		return false
	}
	typ = strings.ToLower(typ)
	if strings.HasPrefix(typ, "image/") || strings.HasPrefix(typ, "video/") || strings.HasPrefix(typ, "audio/") {
		return false
	}
	return strings.HasPrefix(typ, "text/") && typ != "text/event-stream" || typ == "application/json" || typ == "application/javascript" || typ == "application/xml" || strings.HasSuffix(typ, "+json") || strings.HasSuffix(typ, "+xml")
}
func compressionRequestOptOut(r *http.Request) bool {
	if r.Header.Get("Range") != "" || r.Header.Get("X-No-Compression") != "" || r.Header.Get("Upgrade") != "" {
		return true
	}
	for _, prefix := range []string{"/files/", "/share/", "/photos/", "/api/cluster/files/"} {
		if strings.HasPrefix(r.URL.Path, prefix) {
			return true
		}
	}
	return false
}
func (p *compressionPool) middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if p.level == 0 || r.Method == "HEAD" || compressionRequestOptOut(r) {
			next.ServeHTTP(w, r)
			return
		}
		encoding := acceptedEncoding(strings.Join(r.Header.Values("Accept-Encoding"), ","))
		if encoding == "" {
			next.ServeHTTP(w, r)
			return
		}
		cw := &compressedResponse{ResponseWriter: w, request: r, pool: p, encoding: encoding}
		// Abort incomplete streams on handler panic; never turn a panic into an
		// apparently complete compressed response. The server owns recovery.
		defer cw.release()
		next.ServeHTTP(cw, r)
		if err := cw.finish(); err != nil && r.Context().Err() == nil {
			if errors.Is(err, errCompressionBusy) && !cw.started {
				w.Header().Del("Content-Length")
				writeJSONError(w, 503, "Response compression is busy")
				return
			}
			panic(http.ErrAbortHandler)
		}
	})
}

// A slow client must not retain one of the bounded encoders indefinitely.
// The deadline applies to socket output, not application work between writes.
type compressionDestination struct {
	writer  http.ResponseWriter
	timeout time.Duration
}

func (d compressionDestination) Write(b []byte) (int, error) {
	controller := http.NewResponseController(d.writer)
	err := controller.SetWriteDeadline(time.Now().Add(d.timeout))
	if err != nil && !errors.Is(err, http.ErrNotSupported) {
		return 0, err
	}
	defer controller.SetWriteDeadline(time.Time{})
	return d.writer.Write(b)
}

type compressedResponse struct {
	http.ResponseWriter
	request           *http.Request
	pool              *compressionPool
	encoding          string
	status            int
	headers           http.Header
	buffer            [1024]byte
	used              int
	started, hijacked bool
	compressor        responseCompressor
	err               error
}

func (w *compressedResponse) Unwrap() http.ResponseWriter { return w.ResponseWriter }
func (w *compressedResponse) WriteHeader(status int) {
	if w.status != 0 || w.hijacked {
		return
	}
	if status >= 100 && status < 200 && status != 101 {
		w.ResponseWriter.WriteHeader(status)
		return
	}
	w.status = status
	w.headers = w.Header().Clone()
}
func (w *compressedResponse) start(compress bool) error {
	if w.started {
		return w.err
	}
	if w.status == 0 {
		w.WriteHeader(200)
	}
	if compress {
		w.compressor, w.err = w.pool.acquire(w.request.Context(), w.encoding, compressionDestination{w.ResponseWriter, w.pool.writeTimeout})
		if w.err != nil {
			return w.err
		}
		w.headers.Del("Content-Length")
		w.headers.Set("Content-Encoding", w.encoding)
		if tag := w.headers.Get("ETag"); tag != "" && !strings.HasPrefix(tag, "W/") {
			w.headers.Set("ETag", "W/"+tag)
		}
	}
	if compressible(w.headers, w.status) || compress {
		appendVary(w.headers, "Accept-Encoding")
	}
	h := w.Header()
	clear(h)
	for k, v := range w.headers {
		h[k] = v
	}
	w.ResponseWriter.WriteHeader(w.status)
	w.started = true
	if w.used > 0 {
		_, w.err = w.writeOutput(w.buffer[:w.used])
		w.used = 0
	}
	return w.err
}
func (w *compressedResponse) output() io.Writer {
	if w.compressor != nil {
		return w.compressor
	}
	return w.ResponseWriter
}
func (w *compressedResponse) writeOutput(b []byte) (int, error) {
	n, err := w.output().Write(b)
	if n < len(b) && err == nil {
		err = io.ErrShortWrite
	}
	if err != nil {
		w.err = err
	}
	return n, err
}
func (w *compressedResponse) Write(b []byte) (int, error) {
	if w.err != nil {
		return 0, w.err
	}
	if w.hijacked {
		return 0, http.ErrHijacked
	}
	if w.status == 0 {
		w.WriteHeader(200)
	}
	if w.started {
		return w.writeOutput(b)
	}
	if _, set := w.headers["Content-Type"]; !set && len(b) > 0 {
		w.headers.Set("Content-Type", http.DetectContentType(b))
	}
	if !compressible(w.headers, w.status) {
		if err := w.start(false); err != nil {
			return 0, err
		}
		return w.writeOutput(b)
	}
	if length, err := strconv.ParseInt(w.headers.Get("Content-Length"), 10, 64); err == nil && length < 1024 {
		if err = w.start(false); err != nil {
			return 0, err
		}
		return w.writeOutput(b)
	}
	if w.used+len(b) < len(w.buffer) {
		copy(w.buffer[w.used:], b)
		w.used += len(b)
		return len(b), nil
	}
	if err := w.start(true); err != nil {
		return 0, err
	}
	return w.writeOutput(b)
}
func (w *compressedResponse) FlushError() error {
	if !w.started {
		if err := w.start(false); err != nil {
			return err
		}
	}
	if w.compressor != nil {
		if err := w.compressor.Flush(); err != nil {
			w.err = err
			return err
		}
	}
	controller := http.NewResponseController(w.ResponseWriter)
	if w.compressor != nil {
		if err := controller.SetWriteDeadline(time.Now().Add(w.pool.writeTimeout)); err != nil && !errors.Is(err, http.ErrNotSupported) {
			w.err = err
			return err
		}
		defer controller.SetWriteDeadline(time.Time{})
	}
	w.err = controller.Flush()
	return w.err
}
func (w *compressedResponse) Flush() { _ = w.FlushError() }
func (w *compressedResponse) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	if w.started || w.used > 0 {
		return nil, nil, errors.New("cannot hijack a started compressed response")
	}
	c, r, err := http.NewResponseController(w.ResponseWriter).Hijack()
	if err == nil {
		w.hijacked = true
	}
	return c, r, err
}
func (w *compressedResponse) finish() error {
	if w.hijacked {
		return nil
	}
	if w.err != nil {
		return w.err
	}
	if err := w.start(false); err != nil {
		return err
	}
	if w.compressor != nil {
		w.err = w.compressor.Close()
	}
	return w.err
}
func (w *compressedResponse) release() {
	if w.compressor != nil {
		w.pool.release(w.encoding, w.compressor)
		w.compressor = nil
		_ = http.NewResponseController(w.ResponseWriter).SetWriteDeadline(time.Time{})
	}
}
