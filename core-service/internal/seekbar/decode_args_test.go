package seekbar

import (
	"slices"
	"strings"
	"testing"
)

func TestDecodeArgsKeepsVAAPIFramesOnTheGPU(t *testing.T) {
	req := request{Interval: 4.5, TileWidth: 160, Cols: 10, Rows: 24, HWAccel: "VAAPI"}
	args, filter := decodeArgs(req)
	if !slices.Equal(args, []string{"-hwaccel", "vaapi", "-hwaccel_output_format", "vaapi"}) {
		t.Fatalf("args=%q", args)
	}
	want := "scale_vaapi=w=160:h=-2:format=nv12,hwdownload,format=nv12,fps=1/4.500000,tile=10x24"
	if filter != want {
		t.Fatalf("filter=%q want %q", filter, want)
	}

	t.Setenv("TGDL_VAAPI_DEVICE", "/dev/dri/renderD129")
	args, _ = decodeArgs(req)
	if !slices.Equal(args[len(args)-2:], []string{"-hwaccel_device", "/dev/dri/renderD129"}) {
		t.Fatalf("device not passed: %q", args)
	}
}

func TestDecodeArgsOtherBackendsAndCPU(t *testing.T) {
	cpuFilter := "fps=1/2.000000,scale=160:-2:flags=fast_bilinear,tile=4x3"
	for hw, wantArgs := range map[string][]string{
		"":      nil,
		"none":  nil,
		"bogus": nil,
		"cuda":  {"-hwaccel", "cuda"},
		"qsv":   {"-hwaccel", "qsv"},
	} {
		args, filter := decodeArgs(request{Interval: 2, TileWidth: 160, Cols: 4, Rows: 3, HWAccel: hw})
		if !slices.Equal(args, wantArgs) || filter != cpuFilter {
			t.Errorf("%q: args=%q filter=%q", hw, args, filter)
		}
		if strings.Contains(filter, "vaapi") {
			t.Errorf("%q: unexpected GPU filter %q", hw, filter)
		}
	}
}
