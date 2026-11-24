package seekbar

import (
	"context"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"
)

// probeOrder is the preference used for the recommended backend.
var probeOrder = []string{"vaapi", "qsv", "cuda", "videotoolbox", "d3d11va", "dxva2"}

// ProbeHWAccel reports the hardware decoders ffmpeg was built with
// (compiled) and the ones whose device actually opens on this host
// (available), in preference order. Listing -hwaccels alone says nothing
// about drivers or /dev/dri access, so every compiled backend is opened once
// with -init_hw_device and a one-frame null encode. Each try is bounded.
func ProbeHWAccel(ctx context.Context) (available, compiled []string) {
	compiled = HWAccels(ctx)
	bin := FFmpegPath()
	if bin == "" || len(compiled) == 0 {
		return []string{}, compiled
	}
	ok := make([]bool, len(probeOrder))
	var wg sync.WaitGroup
	for i, backend := range probeOrder {
		if !contains(compiled, backend) {
			continue
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			ok[i] = openHWDevice(ctx, bin, backend)
		}()
	}
	wg.Wait()
	available = []string{}
	for i, backend := range probeOrder {
		if ok[i] {
			available = append(available, backend)
		}
	}
	return available, compiled
}

func openHWDevice(ctx context.Context, bin, backend string) bool {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	device := backend + "=probe"
	if backend == "vaapi" {
		if node := strings.TrimSpace(os.Getenv("TGDL_VAAPI_DEVICE")); node != "" {
			device += ":" + node
		}
	}
	cmd := exec.CommandContext(ctx, bin, "-hide_banner", "-loglevel", "error", "-nostdin",
		"-init_hw_device", device, "-f", "lavfi", "-i", "nullsrc=s=64x64:d=0.1", "-frames:v", "1", "-f", "null", "-")
	return cmd.Run() == nil
}
