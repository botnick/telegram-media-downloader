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
	"github.com/botnick/telegram-media-downloader/seekbar-service/internal/ffmpeg"
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
	if cfg.Thumb.Format == "webp" && !ffmpeg.HasEncoder(context.Background(), cfg.FFmpeg.Path, "libwebp") {
		log.Warn("libwebp encoder absent from ffmpeg build — falling back to jpeg",
			"ffmpeg", cfg.FFmpeg.Path,
			"hint", "install ffmpeg with --enable-libwebp or set thumb.format: jpeg in config")
		cfg.Thumb.Format = "jpeg"
	}

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
	pool.Start(ctx)

	srv := api.New(cfg, log, pool)
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
		log.Info("shutdown signal", "signal", sig.String())
	case err := <-errCh:
		log.Error("http listener failed", "err", err)
	}

	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer shutdownCancel()
	_ = server.Shutdown(shutdownCtx)
	pool.Stop()
	log.Info("seekbar-service stopped")
}
