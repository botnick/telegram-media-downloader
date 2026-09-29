// tgdl-core is the Go companion process of telegram-media-downloader.
//
// The Node app spawns `tgdl-core serve` and talks to it over HTTP on
// 127.0.0.1. Node stays the only process that opens db.sqlite; tgdl-core
// only reads the files it is asked about.
//
//	tgdl-core serve            run the HTTP service (config from env, see internal/config)
//	tgdl-core version          print the version
//	tgdl-core hash <path>...   print SHA-256 digests, sha256sum style (--json for JSON lines)
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"strconv"
	"syscall"
	"time"

	"github.com/botnick/telegram-media-downloader/core-service/internal/api"
	"github.com/botnick/telegram-media-downloader/core-service/internal/config"
	"github.com/botnick/telegram-media-downloader/core-service/internal/hash"
	"github.com/botnick/telegram-media-downloader/core-service/internal/parent"
	"github.com/botnick/telegram-media-downloader/core-service/internal/version"
)

const usage = `usage:
  tgdl-core serve              run the HTTP service on 127.0.0.1
  tgdl-core front              run the front server on the app's port (see internal/front)
  tgdl-core version            print the version
  tgdl-core hash [--json] <path>...
                               print SHA-256 digests

serve reads its settings from the environment:
  TGDL_CORE_TOKEN        shared secret for X-API-Token (required)
  TGDL_CORE_ALLOW_ROOTS  directories files may be read from, separated like PATH
                         (":" on Linux/macOS, ";" on Windows); empty = refuse all
  TGDL_CORE_PORT         port on 127.0.0.1 (default 0 = any free port)
  TGDL_CORE_WATCH_STDIN  1 = exit when stdin closes (set by the Node app)
  TGDL_CORE_LOG_LEVEL    debug | info | warn | error
  HASH_WORKER_POOL_SIZE  files hashed at once (same rules as the Node pool)
`

func main() {
	os.Exit(run(os.Args[1:], os.Stdin, os.Stdout, os.Stderr))
}

func run(args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		fmt.Fprint(stderr, usage)
		return 2
	}
	switch args[0] {
	case "serve":
		cfg, err := config.FromEnv(os.Getenv, runtime.NumCPU())
		if err != nil {
			fmt.Fprintln(stderr, "tgdl-core:", err)
			return 2
		}
		ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
		defer stop()
		if err := serve(ctx, cfg, stdin, stdout, newLogger(stderr, cfg.LogLevel)); err != nil {
			fmt.Fprintln(stderr, "tgdl-core:", err)
			return 1
		}
		return 0
	case "front":
		return runFront(stdin, stdout, stderr)
	case "version", "--version", "-v":
		fmt.Fprintf(stdout, "%s %s %s/%s %s\n", version.Service, version.Version, runtime.GOOS, runtime.GOARCH, runtime.Version())
		return 0
	case "hash":
		return runHash(args[1:], stdout, stderr)
	case "help", "-h", "--help":
		fmt.Fprint(stdout, usage)
		return 0
	}
	fmt.Fprintf(stderr, "tgdl-core: unknown command %q\n\n%s", args[0], usage)
	return 2
}

func newLogger(w io.Writer, level string) *slog.Logger {
	var lv slog.Level
	switch level {
	case "debug":
		lv = slog.LevelDebug
	case "warn", "warning":
		lv = slog.LevelWarn
	case "error":
		lv = slog.LevelError
	default:
		lv = slog.LevelInfo
	}
	return slog.New(slog.NewTextHandler(w, &slog.HandlerOptions{Level: lv}))
}

// listening is the single JSON line printed on stdout once the listener
// is bound. The Node parent reads the address from it, so there is no
// race between picking a free port and binding it.
type listening struct {
	Event   string `json:"event"`
	Addr    string `json:"addr"`
	Version string `json:"version"`
	PID     int    `json:"pid"`
}

// serve runs until ctx is done, stdin closes (when cfg.WatchStdin), or the
// listener fails.
func serve(ctx context.Context, cfg config.Config, stdin io.Reader, stdout io.Writer, log *slog.Logger) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	if cfg.WatchStdin {
		parent.WatchStdin(stdin, func() {
			log.Info("stdin closed; parent is gone, shutting down")
			cancel()
		})
	}

	ln, err := net.Listen("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(cfg.Port)))
	if err != nil {
		return fmt.Errorf("listen: %w", err)
	}
	addr := ln.Addr().String()

	roots, warnings := hash.NewRoots(cfg.AllowRoots)
	for _, w := range warnings {
		log.Warn(w)
	}
	if roots.Len() == 0 {
		log.Warn("TGDL_CORE_ALLOW_ROOTS is empty: every hash request will be refused (EOUTSIDE)")
	}

	srv := &http.Server{
		Handler:           api.New(cfg.Token, cfg.HashConcurrency, roots, log).Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		// No WriteTimeout: a multi-GB hash legitimately takes minutes.
		// The caller's own deadline cancels the request context instead.
		IdleTimeout:    2 * time.Minute,
		MaxHeaderBytes: 16 << 10,
	}

	errCh := make(chan error, 1)
	go func() {
		if err := srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- err
		}
		close(errCh)
	}()

	line, _ := json.Marshal(listening{Event: "listening", Addr: addr, Version: version.Version, PID: os.Getpid()})
	fmt.Fprintf(stdout, "%s\n", line)
	log.Info("tgdl-core listening", "addr", addr, "version", version.Version, "hash_concurrency", cfg.HashConcurrency, "allow_roots", roots.Len())

	var serveErr error
	select {
	case <-ctx.Done():
	case serveErr = <-errCh:
	}

	shutdownCtx, done := context.WithTimeout(context.Background(), 3*time.Second)
	defer done()
	_ = srv.Shutdown(shutdownCtx)
	log.Info("tgdl-core stopped")
	return serveErr
}

func runHash(args []string, stdout, stderr io.Writer) int {
	asJSON := false
	var paths []string
	for _, a := range args {
		if a == "--json" {
			asJSON = true
			continue
		}
		paths = append(paths, a)
	}
	if len(paths) == 0 {
		fmt.Fprint(stderr, usage)
		return 2
	}
	status := 0
	enc := json.NewEncoder(stdout)
	for _, p := range paths {
		abs, err := filepath.Abs(p)
		if err != nil {
			fmt.Fprintf(stderr, "tgdl-core: %s: %v\n", p, err)
			status = 1
			continue
		}
		res, err := hash.File(context.Background(), abs)
		if err != nil {
			code := "EIO"
			var he *hash.Error
			if errors.As(err, &he) {
				code = he.Code
			}
			if asJSON {
				_ = enc.Encode(map[string]any{"path": p, "error": map[string]string{"code": code, "message": err.Error()}})
			} else {
				fmt.Fprintf(stderr, "tgdl-core: %s: %v\n", p, err)
			}
			status = 1
			continue
		}
		if asJSON {
			_ = enc.Encode(map[string]any{"path": p, "sha256": res.SHA256, "size": res.Size, "mtimeMs": res.MtimeMs})
		} else {
			fmt.Fprintf(stdout, "%s  %s\n", res.SHA256, p)
		}
	}
	return status
}
