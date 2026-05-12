package ffmpeg

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"io"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
)

// SpritePlan is the deterministic layout decision for one clip. The
// service stamps these numbers into the JSON sidecar so the frontend
// can map hover-position → tile-index without round-tripping.
type SpritePlan struct {
	Frames      int     // total tiles in the sprite
	IntervalSec float64 // seconds between adjacent tile centres
	Cols        int
	Rows        int
	TileW       int
	TileH       int // 0 = unknown (computed from final image dims)
}

// durationTier maps a duration ceiling to a target frame density and
// absolute frame budget. Longer clips get more frames automatically so
// the seekbar is never sparse, while very short clips stay dense too.
type durationTier struct {
	upTo        float64 // inclusive ceiling in seconds
	density     float64 // target seconds per frame
	absoluteMax int     // frame budget for this tier
}

var spriteTiers = []durationTier{
	{15, 0.5, 30},
	{60, 1.0, 60},
	{300, 3.0, 100},
	{900, 5.0, 180},
	{1800, 7.0, 300},
	{3600, 9.0, 450},
	{7200, 12.0, 600},
	{math.MaxFloat64, 18.0, 720},
}

// Plan picks the tile grid for a given duration + thumb config.
//
// Dynamic tiers: each duration range gets its own density and frame budget,
// so a 1-second clip and a 2-hour clip both get full seekbar coverage with
// no blank stretches. The user-supplied targetIntervalSec overrides the tier
// density; maxTiles acts as a hard cap on top of the tier budget.
// The final intervalSec is recomputed so the last sample lands on the
// clip's final second.
func Plan(durationSec float64, targetIntervalSec float64, columns, maxTiles, tileWidth int) SpritePlan {
	// Pick tier
	tier := spriteTiers[len(spriteTiers)-1]
	for _, t := range spriteTiers {
		if durationSec <= t.upTo {
			tier = t
			break
		}
	}

	// Effective density: user interval wins; floor at 0.5 s/frame
	density := tier.density
	if targetIntervalSec > 0 {
		density = math.Max(0.5, targetIntervalSec)
	}

	frames := int(math.Ceil(durationSec / density))
	if frames < 8 {
		frames = 8
	}
	// Tier cap first, then optional user hard cap
	if frames > tier.absoluteMax {
		frames = tier.absoluteMax
	}
	if maxTiles > 0 && frames > maxTiles {
		frames = maxTiles
	}

	interval := durationSec / float64(frames)
	if columns < 2 {
		columns = 10
	}
	if columns > 50 {
		columns = 50
	}
	rows := int(math.Ceil(float64(frames) / float64(columns)))
	if tileWidth < 40 {
		tileWidth = 160
	}
	return SpritePlan{
		Frames:      frames,
		IntervalSec: interval,
		Cols:        columns,
		Rows:        rows,
		TileW:       tileWidth,
	}
}

// BuildArgs returns the full ffmpeg argv (excluding the binary itself)
// for a single sprite encode. The encoder choice depends on `format`:
//   - "webp" / "" → -c:v libwebp
//   - "jpeg" / "jpg" → -q:v <derived from quality>
//
// hwBackend is used to inject the appropriate pixel-format download step
// when hardware-accelerated decoding is active:
//   - VAAPI: hwdownload,format=nv12 (explicit format required)
//   - CUDA / D3D11VA: hwdownload (ffmpeg converts format automatically)
//   - Others: no download step needed
func BuildArgs(srcAbs, dstTmp string, plan SpritePlan, format string, quality int, hwArgs []string, extraArgs string, hwBackend HWAccelBackend) []string {
	if quality <= 0 {
		quality = 70
	}
	if quality > 100 {
		quality = 100
	}

	// Build the hwdownload prefix for GPU-decoded pixel data.
	//
	// VAAPI: hwdownload transfers the VAAPI surface to system memory.
	// We follow with format=yuv420p to normalise driver-specific surface
	// formats (Intel outputs NV12, AMD/Mesa may output YUV420P, Rockchip
	// may output NV12 or YUV420P depending on the kernel version). The
	// scale filter that follows accepts any planar YUV format.
	//
	// CUDA / D3D11VA: hwdownload without a format pin; ffmpeg selects the
	// appropriate pixel format for the NVDEC / D3D11VA decode surface, and
	// the scale filter converts as needed.
	var hwDownload string
	switch hwBackend {
	case HWVAAPI:
		hwDownload = "hwdownload,format=yuv420p,"
	case HWCUDA, HWD3D11:
		hwDownload = "hwdownload,"
	}

	// scale=W:-2 preserves aspect ratio while snapping height to a
	// multiple of 2 (required by most codecs). The :flags=fast_bilinear
	// chooses the fastest scaling algorithm — quality is irrelevant for
	// small sprite thumbnails. force_original_aspect_ratio=decrease would
	// be redundant here (since -2 already handles AR) and can cause
	// "width not divisible" errors in older ffmpeg builds, so we omit it.
	filter := fmt.Sprintf(
		"%sfps=1/%s,scale=%d:-2:flags=fast_bilinear,tile=%dx%d",
		hwDownload,
		strconv.FormatFloat(plan.IntervalSec, 'f', 6, 64),
		plan.TileW, plan.Cols, plan.Rows,
	)
	args := []string{"-hide_banner", "-loglevel", "error"}
	args = append(args, hwArgs...)
	args = append(args,
		"-i", srcAbs,
		"-frames:v", "1",
		"-an",
		// Use all available CPU threads for the decode+scale pipeline.
		// ffmpeg interprets 0 as "auto" (one thread per logical CPU up
		// to the internal cap).
		"-threads", "0",
		"-vf", filter,
	)
	switch strings.ToLower(format) {
	case "jpeg", "jpg":
		// Map quality 1..100 to ffmpeg -q:v 31..2 (lower is better).
		qv := 31 - (quality * 29 / 100)
		if qv < 2 {
			qv = 2
		}
		if qv > 31 {
			qv = 31
		}
		args = append(args, "-q:v", strconv.Itoa(qv))
	default:
		// libwebp encoder flags:
		//   -deadline realtime -cpu-used 8 → fastest encode path; the
		//   quality/compression_level pair still controls output fidelity.
		//   For sprite sheets where speed matters more than last-drop
		//   compression efficiency this is a significant throughput win.
		args = append(args,
			"-c:v", "libwebp",
			"-quality", strconv.Itoa(quality),
			"-compression_level", "6",
			"-deadline", "realtime",
			"-cpu-used", "8",
			"-f", "webp",
		)
	}
	if extra := strings.TrimSpace(extraArgs); extra != "" {
		for _, a := range strings.Fields(extra) {
			// Reject flags that could read/write arbitrary files or
			// alter I/O in dangerous ways.  Only output-tuning flags
			// like -preset, -crf, -q:v, -b:v should reach here.
			lower := strings.ToLower(a)
			if lower == "-i" || lower == "-f" ||
				strings.HasPrefix(lower, "-filter") ||
				lower == "-vf" || lower == "-af" ||
				lower == "-map" || lower == "-c" ||
				lower == "-codec" ||
				strings.HasPrefix(lower, "-c:") ||
				lower == "-safe" {
				continue
			}
			args = append(args, a)
		}
	}
	args = append(args, "-y", dstTmp)
	return args
}

// Run executes an ffmpeg invocation and surfaces stderr on failure.
// Caller owns the context (and any timeout it carries).
func Run(ctx context.Context, ffmpegBin string, args []string) error {
	if ffmpegBin == "" {
		ffmpegBin = "ffmpeg"
	}
	cmd := exec.CommandContext(ctx, ffmpegBin, args...)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		tail := stderr.String()
		if len(tail) > 400 {
			tail = tail[len(tail)-400:]
		}
		return fmt.Errorf("ffmpeg: %w (stderr: %s)", err, strings.TrimSpace(tail))
	}
	return nil
}

// AtomicRename moves `tmp` to `dst` after an fsync so a crash mid-write
// can't leave a half-flushed sprite mistaken for a valid cache hit.
func AtomicRename(tmp, dst string) error {
	if f, err := os.OpenFile(tmp, os.O_RDWR, 0); err == nil {
		_ = f.Sync()
		_ = f.Close()
	}
	return os.Rename(tmp, dst)
}

// TempPath produces a randomised .tmp path next to `target` so concurrent
// workers writing different sprites don't collide on filename.
func TempPath(target string) string {
	dir := filepath.Dir(target)
	base := filepath.Base(target)
	var b [4]byte
	_, _ = rand.Read(b[:])
	return filepath.Join(dir, "."+base+".tmp."+hex.EncodeToString(b[:]))
}

// ReadImageDims returns the pixel dimensions of a WebP or JPEG file by
// parsing only the image header bytes — no imaging library required.
//
// WebP layout (RIFF container):
//
//	[0-3]   "RIFF"
//	[4-7]   file size (LE uint32)
//	[8-11]  "WEBP"
//	[12-15] chunk FourCC — "VP8 " (lossy), "VP8L" (lossless), "VP8X" (extended)
//	Lossy VP8 bitstream starts at byte 20; canvas W/H are 14-bit LE at [26] and [28].
//	For VP8X extended: canvas W-1 is 24-bit LE at [24], H-1 is 24-bit LE at [27].
//
// JPEG: scan for SOF0 (0xFFC0) / SOF2 (0xFFC2) markers; height is at +5 (big-endian uint16),
// width at +7.
func ReadImageDims(path string) (w, h int, err error) {
	f, err := os.Open(path)
	if err != nil {
		return 0, 0, err
	}
	defer f.Close()

	// Read enough header bytes for both formats.
	// WebP extended header needs ~34 bytes; JPEG may need to scan further.
	hdr := make([]byte, 36)
	if _, err := io.ReadFull(f, hdr); err != nil {
		return 0, 0, fmt.Errorf("read header: %w", err)
	}

	// ---- WebP ----------------------------------------------------------------
	if string(hdr[0:4]) == "RIFF" && string(hdr[8:12]) == "WEBP" {
		fourcc := string(hdr[12:16])
		switch fourcc {
		case "VP8 ": // lossy — width/height packed in two 14-bit LE fields
			// The VP8 bitstream starts at byte 20 (after "VP8 " + 4-byte size + 3-byte frame tag).
			// Bytes 23-26 contain the signature. Width (14 bits) is at bytes 26-27 LE,
			// height (14 bits) is at bytes 28-29 LE.
			if len(hdr) >= 30 {
				rawW := binary.LittleEndian.Uint16(hdr[26:28]) & 0x3FFF
				rawH := binary.LittleEndian.Uint16(hdr[28:30]) & 0x3FFF
				return int(rawW), int(rawH), nil
			}
		case "VP8L": // lossless — signature 0x2F at byte 20; W/H packed in next 4 bytes
			// Byte 20: 0x2F signature. Bytes 21-24: 28 bits encoding (w-1) in [0:13] and (h-1) in [14:27].
			if len(hdr) >= 25 {
				bits := binary.LittleEndian.Uint32(hdr[21:25])
				rawW := (bits & 0x3FFF) + 1
				rawH := ((bits >> 14) & 0x3FFF) + 1
				return int(rawW), int(rawH), nil
			}
		case "VP8X": // extended — 24-bit LE (canvas_width-1) at byte 24, (canvas_height-1) at byte 27
			if len(hdr) >= 30 {
				cw := uint32(hdr[24]) | uint32(hdr[25])<<8 | uint32(hdr[26])<<16
				ch := uint32(hdr[27]) | uint32(hdr[28])<<8 | uint32(hdr[29])<<16
				return int(cw + 1), int(ch + 1), nil
			}
		}
		return 0, 0, fmt.Errorf("unrecognised WebP sub-format: %q", fourcc)
	}

	// ---- JPEG ----------------------------------------------------------------
	if hdr[0] == 0xFF && hdr[1] == 0xD8 {
		// Rewind to start and scan for SOF markers (up to 1 MiB to handle large JFIF headers).
		if _, err := f.Seek(0, io.SeekStart); err != nil {
			return 0, 0, err
		}
		const maxScan = 1 << 20
		data, err := io.ReadAll(io.LimitReader(f, maxScan))
		if err != nil {
			return 0, 0, err
		}
		for i := 0; i+8 < len(data); i++ {
			if data[i] != 0xFF {
				continue
			}
			marker := data[i+1]
			// SOF0 = 0xC0, SOF1 = 0xC1, SOF2 = 0xC2 (progressive)
			if marker == 0xC0 || marker == 0xC1 || marker == 0xC2 {
				// segHeight = big-endian uint16 at i+5, segWidth at i+7
				imgH := int(data[i+5])<<8 | int(data[i+6])
				imgW := int(data[i+7])<<8 | int(data[i+8])
				return imgW, imgH, nil
			}
			// Skip over this segment using its length field.
			// The length field is a big-endian uint16 at [i+2]..[i+3]
			// and includes its own 2 bytes but not the 2-byte marker
			// prefix. Total segment = 2 (marker) + segLen bytes.
			// After i += segLen the loop's i++ brings us to the next
			// segment's 0xFF byte (i += segLen+1 == 2+segLen-1 advance).
			if i+4 <= len(data) {
				segLen := int(data[i+2])<<8 | int(data[i+3])
				if segLen >= 2 {
					i += segLen // loop increment adds 1 more
				}
			}
		}
		return 0, 0, fmt.Errorf("JPEG: SOF marker not found")
	}

	return 0, 0, fmt.Errorf("unrecognised image format (magic: %X %X)", hdr[0], hdr[1])
}
