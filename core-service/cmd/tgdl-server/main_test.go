package main

import (
	"bytes"
	"strings"
	"testing"
)

func TestRunVersionDoesNotRequireServerConfig(t *testing.T) {
	var out, errOut bytes.Buffer
	if code := run([]string{"version"}, &out, &errOut); code != 0 {
		t.Fatalf("version exit code = %d stderr=%s", code, errOut.String())
	}
	if !strings.Contains(out.String(), "tgdl-server") || !strings.Contains(out.String(), "0.4.0") {
		t.Fatalf("version output = %q", out.String())
	}
}
