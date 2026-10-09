package main

import (
	"bytes"
	"strings"
	"testing"

	"github.com/botnick/telegram-media-downloader/core-service/internal/version"
)

func TestRunVersionDoesNotRequireServerConfig(t *testing.T) {
	var out, errOut bytes.Buffer
	if code := run([]string{"version"}, &out, &errOut); code != 0 {
		t.Fatalf("version exit code = %d stderr=%s", code, errOut.String())
	}
	if !strings.HasPrefix(out.String(), "tgdl-server "+version.AppVersion+" ") {
		t.Fatalf("version output = %q", out.String())
	}
}
