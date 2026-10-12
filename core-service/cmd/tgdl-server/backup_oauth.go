package main

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/botnick/telegram-media-downloader/core-service/internal/backup"
)

// backupOAuth prints the refresh token for a Google Drive or Dropbox backup
// destination. It needs no server data directory and stores nothing.
func backupOAuth(args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	if len(args) != 1 || (args[0] != "gdrive" && args[0] != "dropbox") {
		fmt.Fprintln(stderr, "usage: tgdl-server backup-oauth gdrive|dropbox")
		if len(args) == 1 && (args[0] == "--help" || args[0] == "-h") {
			return 0
		}
		return 2
	}
	provider := args[0]
	in := bufio.NewReader(stdin)
	ask := func(prompt string) string {
		fmt.Fprint(stdout, prompt)
		line, _ := in.ReadString('\n')
		return strings.TrimSpace(line)
	}
	idLabel, secretLabel := "OAuth client ID: ", "OAuth client secret: "
	if provider == "dropbox" {
		idLabel, secretLabel = "App key: ", "App secret: "
	}
	app, err := backup.NewOAuthApp(provider, ask(idLabel), ask(secretLabel))
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 2
	}
	fmt.Fprintf(stdout, "\n1) Open this address in a browser (any computer) and allow access:\n\n   %s\n\n", app.AuthorizeURL())
	if provider == "gdrive" {
		fmt.Fprintln(stdout, "2) The browser then fails to load a 127.0.0.1 page. That is expected:")
		fmt.Fprintln(stdout, "   copy the whole address from the address bar (it contains code=...).")
	} else {
		fmt.Fprintln(stdout, "2) Copy the access code Dropbox shows.")
	}
	pasted := ask("\nPaste it here: ")
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	token, err := app.Exchange(ctx, pasted)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	fmt.Fprintf(stdout, "\nRefresh token (paste it into the destination form; keep it secret):\n%s\n", token)
	return 0
}
