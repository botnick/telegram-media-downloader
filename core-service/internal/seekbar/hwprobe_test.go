package seekbar

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"testing"
)

// fakeFFmpeg lists vaapi, qsv and cuda as compiled in, but only a vaapi
// device on the expected render node opens.
func fakeFFmpeg(t *testing.T) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("shell script ffmpeg")
	}
	bin := filepath.Join(t.TempDir(), "ffmpeg")
	script := `#!/bin/sh
for a in "$@"; do
  case "$a" in
    -hwaccels) printf 'Hardware acceleration methods:\nvdpau\ncuda\nvaapi\nqsv\n'; exit 0;;
    vaapi=probe:/dev/dri/renderD129) exit 0;;
  esac
done
exit 1
`
	if err := os.WriteFile(bin, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("FFMPEG_PATH", bin)
}

func TestProbeHWAccelReportsOnlyDevicesThatOpen(t *testing.T) {
	fakeFFmpeg(t)
	t.Setenv("TGDL_VAAPI_DEVICE", "/dev/dri/renderD129")
	available, compiled := ProbeHWAccel(context.Background())
	if !slices.Equal(compiled, []string{"cuda", "vaapi", "qsv"}) {
		t.Fatalf("compiled=%q", compiled)
	}
	if !slices.Equal(available, []string{"vaapi"}) {
		t.Fatalf("available=%q", available)
	}

	t.Setenv("TGDL_VAAPI_DEVICE", "/dev/dri/renderD128")
	if available, _ = ProbeHWAccel(context.Background()); len(available) != 0 {
		t.Fatalf("a device that does not open was reported: %q", available)
	}
}
