package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
	"unicode/utf16"
	"unicode/utf8"
)

// setupDashboard talks to the running server from its own network namespace.
// In Docker, run this with exec -i; the public setup route remains local-only.
func setupDashboard(args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	flags := flag.NewFlagSet("setup", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	passwordStdin := flags.Bool("password-stdin", false, "read a password from standard input")
	usage := "usage: tgdl-server setup --password-stdin < password-file\nRun beside the running server (inside the same container for Docker). PORT defaults to 3000.\n"
	if err := flags.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			_, _ = io.WriteString(stdout, usage)
			return 0
		}
		_, _ = io.WriteString(stderr, usage)
		return 2
	}
	if !*passwordStdin || flags.NArg() != 0 {
		_, _ = io.WriteString(stderr, usage)
		return 2
	}
	port := 3000
	if raw := strings.TrimSpace(os.Getenv("PORT")); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n < 1 || n > 65535 {
			_, _ = fmt.Fprintln(stderr, "PORT must be between 1 and 65535")
			return 2
		}
		port = n
	}
	host := "127.0.0.1"
	if raw := strings.TrimSpace(os.Getenv("TGDL_BIND_HOST")); raw != "" {
		ip := net.ParseIP(raw)
		if ip == nil || (!ip.IsLoopback() && !ip.IsUnspecified()) {
			_, _ = fmt.Fprintln(stderr, "Initial setup requires a loopback listener; use TGDL_BIND_HOST=127.0.0.1 while configuring the password")
			return 2
		}
		if ip.IsLoopback() {
			host = ip.String()
		} else if ip.To4() == nil {
			host = "::1"
		}
	}
	raw, err := io.ReadAll(io.LimitReader(stdin, 4099))
	if err != nil {
		_, _ = fmt.Fprintln(stderr, "Cannot read password from standard input")
		return 2
	}
	password := strings.TrimSuffix(strings.TrimSuffix(string(raw), "\n"), "\r")
	if len(password) > 4096 || !utf8.ValidString(password) || strings.ContainsAny(password, "\r\n") || len(utf16.Encode([]rune(password))) < 8 {
		_, _ = fmt.Fprintln(stderr, "Password must be a single UTF-8 line, at least 8 characters and at most 4096 bytes")
		return 2
	}
	body, _ := json.Marshal(map[string]string{"password": password})
	// Never send credentials through environment proxies or follow redirects.
	client := &http.Client{
		Timeout:       15 * time.Second,
		Transport:     &http.Transport{DisableKeepAlives: true},
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	defer client.CloseIdleConnections()
	response, err := client.Post("http://"+net.JoinHostPort(host, strconv.Itoa(port))+"/api/auth/setup", "application/json", bytes.NewReader(body))
	if err != nil {
		_, _ = fmt.Fprintln(stderr, "Cannot reach setup endpoint; start the server and run setup on the same machine or inside its container")
		return 1
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		if response.StatusCode == http.StatusConflict {
			_, _ = fmt.Fprintln(stderr, "Dashboard is already configured; sign in to change its password")
		} else {
			_, _ = fmt.Fprintf(stderr, "Setup rejected (HTTP %d); check the server logs\n", response.StatusCode)
		}
		return 1
	}
	var result struct{ Success bool }
	if err := json.NewDecoder(io.LimitReader(response.Body, 4096)).Decode(&result); err != nil || !result.Success {
		_, _ = fmt.Fprintln(stderr, "Invalid setup response; check the server logs")
		return 1
	}
	_, _ = fmt.Fprintln(stdout, "Dashboard password configured. Sign in through the web dashboard.")
	return 0
}
