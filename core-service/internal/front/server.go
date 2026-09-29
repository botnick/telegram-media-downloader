// Package front is tgdl-core's front server (`tgdl-core front`): it owns
// the app's public port, answers the media routes itself and hands every
// other request to the Node server on 127.0.0.1.
//
// Node stays the authority. Go answers a request itself only when it is
// certain Node would have answered it the same way with no side effects:
//
//   - GET/HEAD /files/<path> (local files), /photos/<name> and
//     /api/thumbs/<id> cache hits, for a request that is authenticated by
//     a file token or a session cookie that needs no renewal;
//   - everything that decides the response — Range, conditional
//     requests, Content-Type, Content-Disposition — reproduces the Node
//     code path (send / serve-static / checkAuth) exactly; the security
//     and cache headers (HSTS, CSP and the rest of helmet, Cache-Control)
//     are the ones Node's own middlewares produce, pushed over the control
//     channel on every config change; any branch it doesn't reproduce (416, 412,
//     redirects, 401s, renewals, HEIC transcoding, auto-prune on 404, …)
//     goes to Node.
//
// For a proxied request Node may still hand the byte streaming back
// ("X-Tgdl-Accel", like nginx's X-Accel-Redirect): Node has run its whole
// middleware chain and `send`, and Go writes Node's headers and streams
// the byte range from disk, so file bytes never cross Node's event loop.
//
// Node sees every proxied request as it would have seen the client: the
// Host and X-Forwarded-* headers are passed through untouched and the
// client's socket address travels in X-Tgdl-Client-Addr (trusted only
// with the per-spawn X-Tgdl-Front token), so req.ip, req.protocol,
// isLocalRequest, forceHttps and the rate limits evaluate the app's own
// `trust proxy` setting against the real client.
package front

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httputil"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/botnick/telegram-media-downloader/core-service/internal/hash"
	"github.com/botnick/telegram-media-downloader/core-service/internal/parent"
	"github.com/botnick/telegram-media-downloader/core-service/internal/version"
)

// Server is the front server.
type Server struct {
	cfg       Config
	log       *slog.Logger
	state     atomic.Pointer[State]
	trust     trustProxy
	sessions  *sessionStore
	roots     *hash.Roots
	downloads rootDir
	photos    rootDir
	thumbs    rootDir
	proxy     *httputil.ReverseProxy
	transport *http.Transport
	dualStack bool
	stats     frontStats
	startedAt time.Time
	listen    string
}

type frontStats struct {
	requests  atomic.Int64
	fastFiles atomic.Int64
	fastPhoto atomic.Int64
	fastThumb atomic.Int64
	proxied   atomic.Int64
	accel     atomic.Int64
	tunnels   atomic.Int64
	openWS    atomic.Int64
	bytes     atomic.Int64
	errors    atomic.Int64
	dbErrors  atomic.Int64
}

// rootDir is a directory the fast path serves from, with its real path
// (Node's fs.realpath of it) resolved lazily — the directory may not exist
// yet when tgdl-core starts.
type rootDir struct {
	lex  string
	mu   sync.Mutex
	real string
}

func (d *rootDir) realPath() (string, bool) {
	if d.lex == "" {
		return "", false
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.real == "" {
		r, err := realDir(d.lex)
		if err != nil {
			return "", false
		}
		d.real = r
	}
	return d.real, true
}

// New builds a Server from cfg.
func New(cfg Config, log *slog.Logger) *Server {
	roots, warnings := hash.NewRoots(cfg.AllowRoots)
	for _, w := range warnings {
		log.Warn(w)
	}
	s := &Server{
		cfg:       cfg,
		log:       log,
		trust:     parseTrustProxy(cfg.TrustProxy),
		roots:     roots,
		downloads: rootDir{lex: cfg.DownloadsDir},
		photos:    rootDir{lex: cfg.PhotosDir},
		thumbs:    rootDir{lex: cfg.ThumbsDir},
		startedAt: time.Now(),
	}
	if !s.trust.exact {
		log.Warn("TRUST_PROXY not reproduced by the front server; with forceHttps on, media requests go through Node", "value", cfg.TrustProxy)
	}
	if cfg.DBPath != "" {
		s.sessions = newSessionStore(cfg.DBPath)
	}
	s.transport = &http.Transport{
		Proxy:                  nil,
		DialContext:            (&net.Dialer{Timeout: 5 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
		MaxIdleConns:           512,
		MaxIdleConnsPerHost:    512,
		IdleConnTimeout:        30 * time.Second, // well under Node's keepAliveTimeout (65 s)
		DisableCompression:     true,             // pass Accept-Encoding / Content-Encoding through untouched
		MaxResponseHeaderBytes: 1 << 20,
		WriteBufferSize:        64 << 10,
		ReadBufferSize:         64 << 10,
	}
	s.proxy = &httputil.ReverseProxy{
		Rewrite:        s.rewrite,
		Transport:      s.transport,
		ModifyResponse: s.modifyResponse,
		ErrorHandler:   s.proxyError,
		ErrorLog:       slog.NewLogLogger(log.Handler(), slog.LevelDebug),
	}
	return s
}

// ServeHTTP is the public handler.
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.stats.requests.Add(1)
	// Private headers from the client never reach Node.
	for k := range r.Header {
		if strings.HasPrefix(k, "X-Tgdl-") {
			delete(r.Header, k)
		}
	}
	if isUpgrade(r) {
		s.tunnel(w, r)
		return
	}
	if s.serveFast(w, r) {
		return
	}
	s.forward(w, r)
}

// clientAddr is the peer address the way Node's socket.remoteAddress
// spells it: on a dual-stack listener an IPv4 client is "::ffff:a.b.c.d".
func (s *Server) clientAddr(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	ip := net.ParseIP(host)
	if ip == nil {
		return host
	}
	if v4 := ip.To4(); v4 != nil {
		if s.dualStack {
			return "::ffff:" + v4.String()
		}
		return v4.String()
	}
	return ip.String()
}

// ---- control channel ---------------------------------------------------

// Control is the token-gated API on 127.0.0.1 the Node app talks to.
func (s *Server) Control() http.Handler {
	private := http.NewServeMux()
	private.HandleFunc("POST /v1/front/state", s.handleState)
	private.HandleFunc("GET /v1/front/stats", s.handleStats)
	private.HandleFunc("/", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": map[string]string{"code": "ENOTFOUND", "message": "no such route"}})
	})
	root := http.NewServeMux()
	root.HandleFunc("GET /health", s.handleHealth)
	root.Handle("/", s.requireToken(private))
	return root
}

func (s *Server) requireToken(next http.Handler) http.Handler {
	token := []byte(s.cfg.Token)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if subtle.ConstantTimeCompare([]byte(r.Header.Get("X-API-Token")), token) != 1 {
			writeJSON(w, http.StatusUnauthorized, map[string]any{"error": map[string]string{"code": "EAUTH", "message": "missing or wrong X-API-Token"}})
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	var sv int64
	if st := s.state.Load(); st != nil {
		sv = st.Version
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":       true,
		"service":  version.Service,
		"version":  version.Version,
		"mode":     "front",
		"features": []string{"front"},
		"pid":      os.Getpid(),
		"go":       runtime.Version(),
		"platform": runtime.GOOS + "/" + runtime.GOARCH,
		"front":    map[string]any{"listen": s.listen, "stateVersion": sv},
	})
}

func (s *Server) handleState(w http.ResponseWriter, r *http.Request) {
	st, err := decodeState(r.Body)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": map[string]string{"code": "EINVAL", "message": err.Error()}})
		return
	}
	s.state.Store(st)
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleStats(w http.ResponseWriter, _ *http.Request) {
	st := &s.stats
	writeJSON(w, http.StatusOK, map[string]any{
		"uptimeSec": int64(time.Since(s.startedAt).Seconds()),
		"requests":  st.requests.Load(),
		"fast": map[string]int64{
			"files":  st.fastFiles.Load(),
			"photos": st.fastPhoto.Load(),
			"thumbs": st.fastThumb.Load(),
		},
		"proxied":    st.proxied.Load(),
		"accel":      st.accel.Load(),
		"websockets": map[string]int64{"total": st.tunnels.Load(), "open": st.openWS.Load()},
		"bytes":      st.bytes.Load(),
		"errors":     st.errors.Load(),
		"dbErrors":   st.dbErrors.Load(),
	})
}

// ---- running -----------------------------------------------------------

// BindError is returned by Run when the public port can't be bound; Code
// is the errno name Node would report (EADDRINUSE, EACCES, …).
type BindError struct {
	Code string
	Err  error
}

func (e *BindError) Error() string { return fmt.Sprintf("listen: %s: %v", e.Code, e.Err) }
func (e *BindError) Unwrap() error { return e.Err }

type event struct {
	Event   string `json:"event"`
	Addr    string `json:"addr,omitempty"`
	Front   string `json:"front,omitempty"`
	Code    string `json:"code,omitempty"`
	Message string `json:"message,omitempty"`
	Version string `json:"version,omitempty"`
	PID     int    `json:"pid,omitempty"`
}

func emit(w io.Writer, ev event) {
	b, _ := json.Marshal(ev)
	fmt.Fprintf(w, "%s\n", b)
}

// Run binds the control and public listeners, prints one JSON line on
// stdout ({"event":"listening",…} or {"event":"error","code":…}) and
// serves until ctx is done or stdin closes (cfg.WatchStdin).
func Run(ctx context.Context, cfg Config, stdin io.Reader, stdout io.Writer, log *slog.Logger) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	if cfg.WatchStdin {
		parent.WatchStdin(stdin, func() {
			log.Info("stdin closed; parent is gone, shutting down")
			cancel()
		})
	}
	s := New(cfg, log)
	defer func() {
		if s.sessions != nil {
			s.sessions.close()
		}
	}()

	ctl, err := net.Listen("tcp", net.JoinHostPort("127.0.0.1", fmt.Sprint(cfg.ControlPort)))
	if err != nil {
		emit(stdout, event{Event: "error", Code: errnoName(err), Message: err.Error()})
		return fmt.Errorf("control listen: %w", err)
	}
	pub, err := net.Listen("tcp", cfg.Listen)
	if err != nil {
		_ = ctl.Close()
		code := errnoName(err)
		emit(stdout, event{Event: "error", Code: code, Message: err.Error()})
		return &BindError{Code: code, Err: err}
	}
	if a, ok := pub.Addr().(*net.TCPAddr); ok && a.IP.To4() == nil {
		s.dualStack = true
	}
	s.listen = pub.Addr().String()

	ctlSrv := &http.Server{
		Handler:           s.Control(),
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       2 * time.Minute,
		MaxHeaderBytes:    16 << 10,
	}
	pubSrv := &http.Server{
		Handler: s,
		// Node: headersTimeout 70 s, keepAliveTimeout 65 s. No read or
		// write deadline: videos stream for as long as they play, and
		// uploads are bounded by Node's own requestTimeout.
		ReadHeaderTimeout: 70 * time.Second,
		IdleTimeout:       65 * time.Second,
		// Node's default --max-http-header-size is 16 KiB; Go adds 4 KiB
		// of slack to this value.
		MaxHeaderBytes: 12 << 10,
		ErrorLog:       slog.NewLogLogger(log.Handler(), slog.LevelDebug),
	}
	errCh := make(chan error, 2)
	go func() { errCh <- serveErr(ctlSrv.Serve(ctl)) }()
	go func() { errCh <- serveErr(pubSrv.Serve(pub)) }()

	emit(stdout, event{Event: "listening", Addr: ctl.Addr().String(), Front: s.listen, Version: version.Version, PID: os.Getpid()})
	log.Info("tgdl-core front listening", "front", s.listen, "control", ctl.Addr().String(), "upstream", cfg.Upstream, "version", version.Version)

	var runErr error
	select {
	case <-ctx.Done():
	case runErr = <-errCh:
	}
	shutdownCtx, done := context.WithTimeout(context.Background(), 3*time.Second)
	defer done()
	_ = pubSrv.Shutdown(shutdownCtx)
	_ = ctlSrv.Shutdown(shutdownCtx)
	s.transport.CloseIdleConnections()
	log.Info("tgdl-core front stopped")
	return runErr
}

func serveErr(err error) error {
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}

// errnoName maps a listen error to the code Node's server 'error' event
// would carry.
func errnoName(err error) string {
	var errno syscall.Errno
	if errors.As(err, &errno) {
		if name := errnoString(errno); name != "" {
			return name
		}
	}
	return "EUNKNOWN"
}

// isUnder reports whether p lies inside dir (both cleaned, absolute).
func isUnder(dir, p string) bool {
	rel, err := filepath.Rel(dir, p)
	return err == nil && filepath.IsLocal(rel)
}
