package front

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httputil"
	"os"
	"strings"
	"time"
)

// Headers between the front server and Node. Clients can't send them: the
// front server deletes every X-Tgdl-* request header first.
const (
	hdrFront      = "X-Tgdl-Front"       // per-spawn token: "this request came through tgdl-core"
	hdrClientAddr = "X-Tgdl-Client-Addr" // the client's socket address, Node's spelling
)

func (s *Server) forward(w http.ResponseWriter, r *http.Request) {
	s.stats.proxied.Add(1)
	s.proxy.ServeHTTP(&proxyWriter{ResponseWriter: w, r: r}, r)
}

// rewrite builds the request to Node: same method, target, Host and
// headers (X-Forwarded-* included, exactly as the client sent them), plus
// the token and the client's address.
func (s *Server) rewrite(pr *httputil.ProxyRequest) {
	pr.Out.URL.Scheme = "http"
	pr.Out.URL.Host = s.cfg.Upstream
	// The query exactly as sent: ReverseProxy re-encodes one with a ';' or
	// a malformed escape (dropping pairs it can't parse); Node takes it raw.
	pr.Out.URL.RawQuery = pr.In.URL.RawQuery
	pr.Out.URL.ForceQuery = pr.In.URL.ForceQuery
	// The path exactly as sent too (url.URL would re-escape raw UTF-8 or
	// an unusual escape; for a target only Node can parse, RequestURI is
	// the original — see rawtarget.go).
	if p, _, _ := strings.Cut(pr.In.RequestURI, "?"); strings.HasPrefix(p, "/") && !strings.HasPrefix(p, "//") {
		pr.Out.URL.Opaque = p
	}
	pr.Out.Host = pr.In.Host
	for _, k := range []string{"X-Forwarded-For", "X-Forwarded-Host", "X-Forwarded-Proto"} {
		if v, ok := pr.In.Header[k]; ok {
			pr.Out.Header[k] = append([]string(nil), v...)
		}
	}
	pr.Out.Header[hdrFront] = []string{s.cfg.UpstreamToken}
	pr.Out.Header[hdrClientAddr] = []string{s.clientAddr(pr.In)}
}

// modifyResponse strips the private headers from Node's answer.
func (s *Server) modifyResponse(resp *http.Response) error {
	for k := range resp.Header {
		if strings.HasPrefix(k, "X-Tgdl-") {
			delete(resp.Header, k)
		}
	}
	return nil
}

func (s *Server) proxyError(w http.ResponseWriter, r *http.Request, err error) {
	if errors.Is(err, context.Canceled) || errors.Is(r.Context().Err(), context.Canceled) {
		return // the client went away
	}
	s.stats.errors.Add(1)
	s.log.Warn("proxy error", "path", r.URL.Path, "err", err)
	w.WriteHeader(http.StatusBadGateway)
}

// proxyWriter restores what httputil.ReverseProxy drops or Go's server
// would add on the way out (Node's Connection / Keep-Alive pair, header
// spelling, no Content-Type sniffing).
type proxyWriter struct {
	http.ResponseWriter
	r           *http.Request
	wroteHeader bool
}

func (pw *proxyWriter) WriteHeader(code int) {
	if pw.wroteHeader {
		return
	}
	if code >= 100 && code < 200 && code != http.StatusSwitchingProtocols {
		pw.ResponseWriter.WriteHeader(code)
		return
	}
	pw.wroteHeader = true
	h := pw.Header()
	respellHeaders(h)
	if _, ok := h["Content-Type"]; !ok {
		h["Content-Type"] = nil // don't sniff: Node sent none
	}
	keep304Headers(h, code)
	setConnectionHeaders(pw.ResponseWriter, pw.r)
	pw.ResponseWriter.WriteHeader(code)
}

func (pw *proxyWriter) Write(b []byte) (int, error) {
	if !pw.wroteHeader {
		pw.WriteHeader(http.StatusOK)
	}
	return pw.ResponseWriter.Write(b)
}

func (pw *proxyWriter) Flush() {
	if !pw.wroteHeader {
		pw.WriteHeader(http.StatusOK)
	}
	if f, ok := pw.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

func (pw *proxyWriter) Unwrap() http.ResponseWriter { return pw.ResponseWriter }

// copyRange streams n bytes of f from start. The response is aborted (the
// connection closed) if the file turns out shorter, as Node's stream
// would end early.
func (s *Server) copyRange(w io.Writer, f *os.File, start, n int64) {
	if n == 0 {
		return
	}
	if _, err := f.Seek(start, io.SeekStart); err != nil {
		panic(http.ErrAbortHandler)
	}
	// *io.LimitedReader over *os.File lets net/http use sendfile.
	written, err := io.Copy(w, io.LimitReader(f, n))
	s.stats.bytes.Add(written)
	if written < n && err == nil {
		panic(http.ErrAbortHandler)
	}
}

// ---- WebSocket / Upgrade -------------------------------------------------

// isUpgrade matches what makes Node emit 'upgrade': an Upgrade header and
// a Connection header containing the "upgrade" token.
func isUpgrade(r *http.Request) bool {
	if r.Header.Get("Upgrade") == "" {
		return false
	}
	for _, v := range r.Header.Values("Connection") {
		for _, t := range strings.Split(v, ",") {
			if strings.EqualFold(strings.TrimSpace(t), "upgrade") {
				return true
			}
		}
	}
	return false
}

// tunnel hands an upgrade request to Node over a raw TCP connection and
// copies bytes both ways. Node's answer — the 101 handshake or its bare
// "HTTP/1.1 401 Unauthorized" — reaches the client byte for byte.
func (s *Server) tunnel(w http.ResponseWriter, r *http.Request) {
	s.stats.tunnels.Add(1)
	up, err := net.DialTimeout("tcp", s.cfg.Upstream, 5*time.Second)
	if err != nil {
		s.stats.errors.Add(1)
		w.WriteHeader(http.StatusBadGateway)
		return
	}
	hj, ok := w.(http.Hijacker)
	if !ok {
		_ = up.Close()
		w.WriteHeader(http.StatusInternalServerError)
		return
	}
	conn, brw, err := hj.Hijack()
	if err != nil {
		_ = up.Close()
		return
	}
	_ = conn.SetDeadline(time.Time{})
	s.stats.openWS.Add(1)
	defer s.stats.openWS.Add(-1)
	defer conn.Close()
	defer up.Close()

	var b strings.Builder
	fmt.Fprintf(&b, "%s %s %s\r\nHost: %s\r\n", r.Method, r.RequestURI, r.Proto, r.Host)
	for k, vv := range r.Header {
		for _, v := range vv {
			fmt.Fprintf(&b, "%s: %s\r\n", k, v)
		}
	}
	fmt.Fprintf(&b, "%s: %s\r\n%s: %s\r\n\r\n", hdrFront, s.cfg.UpstreamToken, hdrClientAddr, s.clientAddr(r))
	if _, err := io.WriteString(up, b.String()); err != nil {
		return
	}
	done := make(chan struct{}, 2)
	go func() {
		_, _ = io.Copy(up, brw.Reader) // bytes the client already sent, then the socket
		closeWrite(up)
		done <- struct{}{}
	}()
	go func() {
		_, _ = io.Copy(conn, bufio.NewReaderSize(up, 32<<10))
		closeWrite(conn)
		done <- struct{}{}
	}()
	<-done
	// One side finished; give the other a moment to drain, then close.
	select {
	case <-done:
	case <-time.After(5 * time.Second):
	}
}

func closeWrite(c net.Conn) {
	if tc, ok := c.(interface{ CloseWrite() error }); ok {
		_ = tc.CloseWrite()
		return
	}
	_ = c.Close()
}
