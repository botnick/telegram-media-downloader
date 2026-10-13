package app

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestThumbFileRejectsStub(t *testing.T) {
	dir := t.TempDir()
	stub := filepath.Join(dir, "stub.webp")
	if err := os.WriteFile(stub, []byte("\x00\x00\x00\x00\xf8\xff\xff\xff"), 0o600); err != nil {
		t.Fatal(err)
	}
	if thumbFileNonEmpty(stub) {
		t.Fatal("8-byte stub accepted as a thumbnail")
	}
	real := filepath.Join(dir, "real.webp")
	if err := os.WriteFile(real, []byte("RIFF\x04\x00\x00\x00WEBPVP8 "), 0o600); err != nil {
		t.Fatal(err)
	}
	if !thumbFileNonEmpty(real) {
		t.Fatal("WebP header rejected")
	}
}

// A still must not be seeked: ffmpeg exits 0 past the end of one image and
// writes an 8-byte stub.
func TestRenderGalleryThumbStill(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg not installed")
	}
	dir := t.TempDir()
	src := filepath.Join(dir, "in.png")
	if out, err := exec.Command("ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=red:s=64x48", "-frames:v", "1", "-y", src).CombinedOutput(); err != nil {
		t.Skipf("ffmpeg cannot make a fixture: %v %s", err, out)
	}
	tmp := filepath.Join(dir, "out.webp")
	if !renderGalleryThumb(context.Background(), src, tmp, []string{""}, false) || !thumbFileNonEmpty(tmp) {
		t.Fatal("still thumbnail not rendered as WebP")
	}
}

func TestThumbMissCacheHoldsUntilFileChanges(t *testing.T) {
	source := filepath.Join(t.TempDir(), "sticker.tgs")
	if err := os.WriteFile(source, []byte{0x1f, 0x8b, 0}, 0o600); err != nil {
		t.Fatal(err)
	}
	var cache thumbMissCache
	if cache.known(7, source) {
		t.Fatal("empty cache reported a miss")
	}
	cache.add(7, source)
	if !cache.known(7, source) {
		t.Fatal("recorded miss was not remembered")
	}
	if err := os.WriteFile(source, []byte("replaced by a good download"), 0o600); err != nil {
		t.Fatal(err)
	}
	if cache.known(7, source) {
		t.Fatal("miss survived the file being replaced")
	}
}
