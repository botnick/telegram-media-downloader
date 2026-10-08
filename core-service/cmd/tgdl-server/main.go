package main

import (
	"context"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"runtime"
	"strings"

	"github.com/botnick/telegram-media-downloader/core-service/internal/app"
	"github.com/botnick/telegram-media-downloader/core-service/internal/config"
	"github.com/botnick/telegram-media-downloader/core-service/internal/version"
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
	a, err := app.New(context.Background(), app.Config{DataDir: cfg.DataDir, Port: cfg.Port, CookieName: cfg.CookieName, SessionTTL: cfg.SessionTTL})
	if err != nil {
		_, _ = fmt.Fprintln(stderr, err)
		return 1
	}
	defer a.Close()
	log.Printf("tgdl-server listening on :%d", cfg.Port)
	if err := http.ListenAndServe(fmt.Sprintf(":%d", cfg.Port), a.Handler()); err != nil {
		_, _ = fmt.Fprintln(stderr, err)
		return 1
	}
	return 0
}
