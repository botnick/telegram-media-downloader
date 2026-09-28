package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/signal"
	"syscall"

	"github.com/botnick/telegram-media-downloader/core-service/internal/front"
)

// exitBind is the exit status of `tgdl-core front` when the public port
// can't be bound (the JSON error line on stdout carries the errno name).
const exitBind = 3

// runFront runs the front server (`tgdl-core front`, settings from env —
// see internal/front.Config).
func runFront(stdin io.Reader, stdout, stderr io.Writer) int {
	cfg, err := front.FromEnv(os.Getenv)
	if err != nil {
		fmt.Fprintln(stderr, "tgdl-core:", err)
		return 2
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := front.Run(ctx, cfg, stdin, stdout, newLogger(stderr, cfg.LogLevel)); err != nil {
		fmt.Fprintln(stderr, "tgdl-core:", err)
		var be *front.BindError
		if errors.As(err, &be) {
			return exitBind
		}
		return 1
	}
	return 0
}
