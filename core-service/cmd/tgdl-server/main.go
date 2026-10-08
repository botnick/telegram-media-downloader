package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"runtime"
	"strings"
	"syscall"
	"time"

	"github.com/botnick/telegram-media-downloader/core-service/internal/app"
	"github.com/botnick/telegram-media-downloader/core-service/internal/config"
	"github.com/botnick/telegram-media-downloader/core-service/internal/version"
	"github.com/botnick/telegram-media-downloader/core-service/internal/webassets"
)

func main() {
	os.Exit(run(os.Args[1:], os.Stdout, os.Stderr))
}

func run(args []string, stdout, stderr io.Writer) int {
	if len(args) > 0 {
		switch strings.ToLower(args[0]) {
		case "version", "--version", "-v":
			_, _ = fmt.Fprintf(stdout, "tgdl-server %s %s/%s %s\n", version.Version, runtime.GOOS, runtime.GOARCH, runtime.Version())
			return 0
		case "help", "--help", "-h":
			_, _ = io.WriteString(stdout, "usage: tgdl-server [version]\nTGDL_DATA_DIR is required for the server.\n")
			return 0
		}
	}
	cfg, err := config.FromFullEnv(os.Getenv)
	if err != nil {
		_, _ = fmt.Fprintln(stderr, err)
		return 2
	}
	static, err := fs.Sub(webassets.FS, "public")
	if err != nil {
		_, _ = fmt.Fprintln(stderr, err)
		return 1
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	a, err := app.New(ctx, app.Config{DataDir: cfg.DataDir, Port: cfg.Port, Static: static, CookieName: cfg.CookieName, SessionTTL: cfg.SessionTTL, Output: stdout, SecureCookies: os.Getenv("TGDL_SECURE_COOKIES") == "1"})
	if err != nil {
		_, _ = fmt.Fprintln(stderr, err)
		return 1
	}
	defer a.Close()
	log.Printf("tgdl-server listening on :%d", cfg.Port)
	server := &http.Server{Addr: fmt.Sprintf(":%d", cfg.Port), Handler: a.Handler(), ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 90 * time.Second, MaxHeaderBytes: 1 << 20}
	if err := serve(ctx, server); err != nil {
		_, _ = fmt.Fprintln(stderr, err)
		return 1
	}
	return 0
}

func serve(ctx context.Context, server *http.Server) error {
	listener, err := net.Listen("tcp", server.Addr)
	if err != nil {
		return err
	}
	done := make(chan error, 1)
	go func() { done <- server.Serve(sanitizeListener{Listener: listener}) }()
	select {
	case err := <-done:
		return err
	case <-ctx.Done():
		shutdown, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		err := server.Shutdown(shutdown)
		if err != nil {
			_ = server.Close()
		}
		listenErr := <-done
		if errors.Is(listenErr, http.ErrServerClosed) {
			listenErr = nil
		}
		return errors.Join(err, listenErr)
	}
}
