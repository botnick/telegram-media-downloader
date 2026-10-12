package app

import "testing"

func TestHWAccelCascade(t *testing.T) {
	cfg := func(thumbs, seekbar any) map[string]any {
		return map[string]any{"advanced": map[string]any{"thumbs": map[string]any{"hwaccel": thumbs}, "seekbar": map[string]any{"hwaccel": seekbar}}}
	}
	for _, tc := range []struct {
		name, env       string
		config          map[string]any
		thumbs, seekbar string
	}{
		{"cpu by default", "", cfg("", nil), "", ""},
		{"config", "", cfg("qsv", nil), "qsv", "qsv"},
		{"env wins over config", " CUDA ", cfg("qsv", ""), "cuda", "cuda"},
		{"unknown env ignored", "opencl", cfg("vaapi", "auto"), "vaapi", "vaapi"},
		{"seekbar override", "cuda", cfg("vaapi", "videotoolbox"), "cuda", "videotoolbox"},
		{"seekbar none forces cpu", "cuda", cfg("vaapi", "none"), "cuda", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("FFMPEG_HWACCEL", tc.env)
			thumbs, _ := objectAt(tc.config, "advanced", "thumbs")["hwaccel"].(string)
			if got := resolveHWAccel(tc.env, thumbs); got != tc.thumbs {
				t.Fatalf("thumbs backend %q, want %q", got, tc.thumbs)
			}
			if got := seekbarHWAccelFor(tc.config); got != tc.seekbar {
				t.Fatalf("seekbar backend %q, want %q", got, tc.seekbar)
			}
		})
	}
}
