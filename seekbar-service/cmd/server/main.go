// seekbar-service HTTP entry point.
package main

import (
	"context"
	"flag"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/botnick/telegram-media-downloader/seekbar-service/internal/api"
	"github.com/botnick/telegram-media-downloader/seekbar-service/internal/config"
	"github.com/botnick/telegram-media-downloader/seekbar-service/internal/logx"
	"github.com/botnick/telegram-media-downloader/seekbar-service/internal/worker"
)

func main() {
	configPath := flag.String("config", "", "path to config.yaml (env SEEKBAR_CONFIG also accepted)")
	flag.Parse()

	cfg, err := config.Load(*configPath)
	if err != nil {
		fmt.Fprintln(os.Stderr, "config:", err)
		os.Exit(2)
	}
	log := logx.New(cfg.Log.Level, cfg.Log.Format)
	log.Info("seekbar-service starting",
		"listen", cfg.HTTP.Listen,
		"output", cfg.Storage.OutputDir,
		"concurrency", cfg.Jobs.Concurrency,
		"hwaccel", cfg.FFmpeg.HWAccel,
	)
	if err := os.MkdirAll(cfg.Storage.OutputDir, 0o755); err != nil {
		log.Error("cannot create output_dir", "err", err)
		os.Exit(1)
	}
	if cfg.Storage.TempDir != cfg.Storage.OutputDir {
		_ = os.MkdirAll(cfg.Storage.TempDir, 0o755)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	pool := worker.NewPool(cfg, log)
	// Start the pool; hwaccel detection runs inside Start and returns
	// the resolved backend so we can share it with the HTTP server
	// without probing twice.
	resolvedHWA := pool.Start(ctx, "")
	log.Info("hwaccel resolved", "backend", string(resolvedHWA))

	srv := api.New(cfg, log, pool)
	// Kick off background ffmpeg-version probe; pass the resolved hwaccel
	// string so the server doesn't probe a second time.
	srv.Init(string(resolvedHWA))

	server := &http.Server{
		Addr:         cfg.HTTP.Listen,
		Handler:      srv.Routes(),
		ReadTimeout:  30 * time.Second,
		WriteTimeout: 5 * time.Minute,
		IdleTimeout:  120 * time.Second,
	}

	errCh := make(chan error, 1)
	go func() {
		log.Info("http listening", "addr", cfg.HTTP.Listen)
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			errCh <- err
		}
	}()

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	select {
	case sig := <-sigCh:
		log.Info("shutdown signal received, draining (30s)", "signal", sig.String())
	case err := <-errCh:
		log.Error("http listener failed", "err", err)
	}

	// 30-second drain: finish in-progress jobs, reject new HTTP requests.
	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer shutdownCancel()
	_ = server.Shutdown(shutdownCtx)

	// Cancel the worker pool context so idle goroutines exit, then
	// wait for any in-flight ffmpeg processes to finish.
	cancel()
	pool.Stop()
	log.Info("seekbar-service stopped")
}
