package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/botnick/telegram-media-downloader/core-service/internal/config"
	"github.com/botnick/telegram-media-downloader/core-service/internal/version"
)

func TestVersionCommand(t *testing.T) {
	var out, errb bytes.Buffer
	if rc := run([]string{"version"}, nil, &out, &errb); rc != 0 {
		t.Fatalf("rc=%d stderr=%s", rc, errb.String())
	}
	if !strings.HasPrefix(out.String(), "tgdl-core "+version.Version+" ") {
		t.Fatalf("unexpected output %q", out.String())
	}
}

func TestUnknownCommand(t *testing.T) {
	var out, errb bytes.Buffer
	if rc := run([]string{"frobnicate"}, nil, &out, &errb); rc != 2 {
		t.Fatalf("rc=%d", rc)
	}
	if rc := run(nil, nil, &out, &errb); rc != 2 {
		t.Fatalf("no args: rc=%d", rc)
	}
}

func TestHashCommand(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "abc.txt")
	if err := os.WriteFile(p, []byte("abc"), 0o644); err != nil {
		t.Fatal(err)
	}
	var out, errb bytes.Buffer
	if rc := run([]string{"hash", p}, nil, &out, &errb); rc != 0 {
		t.Fatalf("rc=%d stderr=%s", rc, errb.String())
	}
	if got := out.String(); got != "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad  "+p+"\n" {
		t.Fatalf("unexpected output %q", got)
	}

	out.Reset()
	if rc := run([]string{"hash", "--json", p, filepath.Join(dir, "missing")}, nil, &out, &errb); rc != 1 {
		t.Fatalf("missing file should exit 1, got %d", rc)
	}
	lines := strings.Split(strings.TrimSpace(out.String()), "\n")
	if len(lines) != 2 || !strings.Contains(lines[0], `"size":3`) || !strings.Contains(lines[1], `"code":"ENOENT"`) {
		t.Fatalf("unexpected JSON output %q", out.String())
	}
}

func TestServeRequiresToken(t *testing.T) {
	t.Setenv("TGDL_CORE_TOKEN", "")
	var out, errb bytes.Buffer
	if rc := run([]string{"serve"}, nil, &out, &errb); rc != 2 {
		t.Fatalf("rc=%d", rc)
	}
	if !strings.Contains(errb.String(), "TGDL_CORE_TOKEN") {
		t.Fatalf("stderr %q", errb.String())
	}
}

// serve prints its address, answers /health, and exits once stdin closes.
func TestServeExitsWhenStdinCloses(t *testing.T) {
	stdinR, stdinW := io.Pipe()
	stdoutR, stdoutW := io.Pipe()
	cfg := config.Config{Token: "t", HashConcurrency: 2, WatchStdin: true}
	log := slog.New(slog.NewTextHandler(io.Discard, nil))

	done := make(chan error, 1)
	go func() { done <- serve(context.Background(), cfg, stdinR, stdoutW, log) }()

	line, err := bufio.NewReader(stdoutR).ReadString('\n')
	if err != nil {
		t.Fatal(err)
	}
	go io.Copy(io.Discard, stdoutR)
	var ev listening
	if err := json.Unmarshal([]byte(line), &ev); err != nil || ev.Event != "listening" || !strings.HasPrefix(ev.Addr, "127.0.0.1:") {
		t.Fatalf("bad listening line %q (%v)", line, err)
	}
	resp, err := http.Get("http://" + ev.Addr + "/health")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("health status %d", resp.StatusCode)
	}

	stdinW.Close()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("serve returned %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("serve did not exit after stdin closed")
	}
}
