package main

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"os"

	"github.com/botnick/telegram-media-downloader/core-service/internal/app"
	"github.com/botnick/telegram-media-downloader/core-service/internal/config"
)

func main() {
	cfg, err := config.FromFullEnv(os.Getenv)
	if err != nil {
		log.Fatal(err)
	}
	a, err := app.New(context.Background(), app.Config{DataDir: cfg.DataDir, Port: cfg.Port, CookieName: cfg.CookieName, SessionTTL: cfg.SessionTTL})
	if err != nil {
		log.Fatal(err)
	}
	defer a.Close()
	log.Printf("tgdl-server listening on :%d", cfg.Port)
	log.Fatal(http.ListenAndServe(fmt.Sprintf(":%d", cfg.Port), a.Handler()))
}
