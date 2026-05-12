package ffmpeg

import (
	"bytes"
	"context"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// HWAccelBackend names a single ffmpeg `-hwaccel` mode. Backends listed
// here all map to flags ffmpeg accepts on at least one platform. The
// service auto-detection narrows this down to what actually initialises
// on the running host.
type HWAccelBackend string

const (
	HWNone         HWAccelBackend = ""
	HWCUDA         HWAccelBackend = "cuda"
	HWQSV          HWAccelBackend = "qsv"
	HWVAAPI        HWAccelBackend = "vaapi"
	HWVideoToolbox HWAccelBackend = "videotoolbox"
	HWV4L2M2M      HWAccelBackend = "v4l2m2m"
	HWD3D11        HWAccelBackend = "d3d11va"
)

// PlatformDefaults returns the preferred hwaccel candidates for the
// current OS / arch — used by `auto` mode to pick a sensible first
// backend to probe. Order matters: list the highest-quality backend
// first so the probe sticks with it when available.
func PlatformDefaults() []HWAccelBackend {
	switch runtime.GOOS {
	case "darwin":
		return []HWAccelBackend{HWVideoToolbox}
	case "windows":
		// d3d11va is the native Windows GPU path and works on any
		// DirectX 11 GPU without NVIDIA drivers. Prefer it over CUDA
		// which requires the NVIDIA runtime. QSV is Intel-only.
		return []HWAccelBackend{HWD3D11, HWCUDA, HWQSV}
	case "linux":
		if runtime.GOARCH == "arm" || runtime.GOARCH == "arm64" {
			// Raspberry Pi + ARM NAS — V4L2 M2M is the standard
			// hwaccel for Pi 4 / Pi 5; VAAPI lands on some
			// Rockchip / ARM Mali boards.
			return []HWAccelBackend{HWV4L2M2M, HWVAAPI}
		}
		// x86 Linux: VAAPI covers Intel + AMD; CUDA for NVIDIA;
		// QSV is Intel-specific.
		return []HWAccelBackend{HWVAAPI, HWCUDA, HWQSV}
	}
	return nil
}

// CompiledIn returns the set of backends the local ffmpeg was built
// with. `ffmpeg -hwaccels` lists every method present in the binary;
// the auto-detect routine still has to verify each one against the
// running host (driver / device file / GPU).
func CompiledIn(ctx context.Context, ffmpegBin string) ([]HWAccelBackend, error) {
	if ffmpegBin == "" {
		ffmpegBin = "ffmpeg"
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, ffmpegBin, "-hide_banner", "-hwaccels")
	var out, stderr bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return nil, err
	}
	known := map[string]HWAccelBackend{
		"cuda": HWCUDA, "nvdec": HWCUDA,
		"qsv": HWQSV, "vaapi": HWVAAPI, "videotoolbox": HWVideoToolbox,
		"v4l2m2m": HWV4L2M2M, "d3d11va": HWD3D11,
	}
	var got []HWAccelBackend
	seen := map[HWAccelBackend]bool{}
	for _, raw := range strings.Split(out.String(), "\n") {
		name := strings.ToLower(strings.TrimSpace(raw))
		if name == "" || name == "hardware acceleration methods:" {
			continue
		}
		if b, ok := known[name]; ok && !seen[b] {
			got = append(got, b)
			seen[b] = true
		}
	}
	return got, nil
}

// ProbeAvailable runs a tiny lavfi-driven encode against each candidate
// to verify it can actually initialise a device on this host. Backends
// that compile in but lack a driver / device file are dropped here.
// Each probe gets a hard 5s timeout.
//
// The probe strategy differs per backend:
//   - d3d11va: uses -hwaccel d3d11va with a null decode to test device init
//   - vaapi:   needs -vaapi_device to open the render node
//   - others:  -init_hw_device <backend>=hw is sufficient
func ProbeAvailable(ctx context.Context, ffmpegBin string, candidates []HWAccelBackend) []HWAccelBackend {
	return ProbeAvailableWithDevice(ctx, ffmpegBin, candidates, "")
}

// ProbeAvailableWithDevice is like ProbeAvailable but accepts an explicit
// VAAPI device path (passed through from config.FFmpeg.VAAPIDevice).
func ProbeAvailableWithDevice(ctx context.Context, ffmpegBin string, candidates []HWAccelBackend, vaapiDevice string) []HWAccelBackend {
	if ffmpegBin == "" {
		ffmpegBin = "ffmpeg"
	}
	if vaapiDevice == "" {
		vaapiDevice = "/dev/dri/renderD128"
	}
	var out []HWAccelBackend
	for _, b := range candidates {
		if b == "" {
			continue
		}
		pctx, cancel := context.WithTimeout(ctx, 5*time.Second)
		var args []string
		switch b {
		case HWD3D11:
			// d3d11va does not support -init_hw_device in all ffmpeg
			// builds; instead test via a decode-path hwaccel probe that
			// opens the D3D11 device. A null lavfi source decoded with
			// hwaccel d3d11va is enough to verify driver availability.
			args = []string{
				"-hide_banner", "-v", "error",
				"-hwaccel", "d3d11va",
				"-f", "lavfi", "-i", "nullsrc=s=64x64:d=0.1",
				"-frames:v", "1", "-f", "null", "-",
			}
		case HWVAAPI:
			args = []string{
				"-hide_banner", "-v", "error",
				"-vaapi_device", vaapiDevice,
				"-f", "lavfi", "-i", "nullsrc=s=64x64:d=0.1",
				"-vf", "format=nv12,hwupload",
				"-frames:v", "1", "-f", "null", "-",
			}
		case HWV4L2M2M:
			// v4l2m2m: init_hw_device is not supported. Only accept if
			// at least one /dev/video* device node exists on this host —
			// without a real device the hwaccel will silently fail at
			// encode time. On non-Linux hosts there are no such nodes.
			cancel()
			if runtime.GOOS == "linux" {
				matches, globErr := filepath.Glob("/dev/video*")
				if globErr == nil && len(matches) > 0 {
					out = append(out, b)
				}
			}
			continue
		default:
			args = []string{
				"-hide_banner", "-v", "error",
				"-init_hw_device", string(b) + "=hw",
				"-f", "lavfi", "-i", "nullsrc=s=2x2:d=0.04",
				"-frames:v", "1", "-f", "null", "-",
			}
		}
		var stderr bytes.Buffer
		cmd := exec.CommandContext(pctx, ffmpegBin, args...)
		cmd.Stderr = &stderr
		err := cmd.Run()
		cancel()
		if err == nil {
			out = append(out, b)
		}
	}
	return out
}

// Resolve picks an hwaccel backend based on the configured mode. `auto`
// runs CompiledIn + ProbeAvailableWithDevice + PlatformDefaults; explicit
// modes validate against the compiled-in set. Returns `("", nil)` when
// CPU is the right choice (mode `none` / `cpu` / nothing usable).
//
// vaapiDevice is the /dev/dri/renderD* path used when probing VAAPI; an
// empty string falls back to the default /dev/dri/renderD128.
func Resolve(ctx context.Context, ffmpegBin, mode, vaapiDevice string) (HWAccelBackend, error) {
	mode = strings.ToLower(strings.TrimSpace(mode))
	switch mode {
	case "none", "cpu", "":
		return HWNone, nil
	case "auto":
		// Pass — fall through to detection.
	default:
		// Explicit pick — trust it but verify the binary supports it
		// (cheaper than the full probe).
		compiled, err := CompiledIn(ctx, ffmpegBin)
		if err != nil {
			return HWNone, err
		}
		want := HWAccelBackend(mode)
		for _, b := range compiled {
			if b == want {
				return want, nil
			}
		}
		return HWNone, nil
	}
	compiled, err := CompiledIn(ctx, ffmpegBin)
	if err != nil {
		return HWNone, err
	}
	// Order: platform preference ∩ compiled-in. Anything left over
	// from compiled-in tacked on the end as a fallback.
	prefs := PlatformDefaults()
	seen := map[HWAccelBackend]bool{}
	var ordered []HWAccelBackend
	for _, b := range prefs {
		for _, c := range compiled {
			if b == c && !seen[b] {
				ordered = append(ordered, b)
				seen[b] = true
			}
		}
	}
	for _, c := range compiled {
		if !seen[c] {
			ordered = append(ordered, c)
			seen[c] = true
		}
	}
	avail := ProbeAvailableWithDevice(ctx, ffmpegBin, ordered, vaapiDevice)
	if len(avail) == 0 {
		return HWNone, nil
	}
	return avail[0], nil
}

// Args returns the ffmpeg flags to prepend to the input for a given
// backend. VAAPI needs `-vaapi_device <path>` and `-hwaccel_output_format
// vaapi` so decoded frames stay on the VAAPI surface (required for the
// hwdownload step in the filter chain). CUDA/D3D11VA only need -hwaccel.
func Args(b HWAccelBackend, vaapiDevice string) []string {
	if b == HWNone {
		return nil
	}
	switch b {
	case HWVAAPI:
		dev := vaapiDevice
		if dev == "" {
			dev = "/dev/dri/renderD128"
		}
		// -hwaccel_output_format vaapi keeps decoded frames on the VAAPI
		// surface so the hwdownload filter can transfer them to system
		// memory. Without this flag ffmpeg may auto-download frames and
		// the hwdownload step in the filter chain fails.
		return []string{
			"-hwaccel", "vaapi",
			"-vaapi_device", dev,
			"-hwaccel_output_format", "vaapi",
		}
	default:
		return []string{"-hwaccel", string(b)}
	}
}
