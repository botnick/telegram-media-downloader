package download

import (
	"hash"
	"io"
	"os"
	"strings"

	"github.com/botnick/telegram-media-downloader/core-service/internal/mp4tag"
)

// HEVCRelabelEnabled reports whether new downloads get their HEVC 'hev1'
// sample entries renamed to 'hvc1' so Safari and iOS can play them. On by
// default; TGDL_HEVC_HVC1=0 (or false/off/no) keeps Telegram's bytes as-is.
func HEVCRelabelEnabled() bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv("TGDL_HEVC_HVC1"))) {
	case "0", "false", "off", "no":
		return false
	}
	return true
}

// relabelHEVC runs on the synced partial file before publication. When it
// changes the file, digest is rebuilt from the bytes on disk, so the catalog
// SHA-256, crash recovery and duplicate detection all describe the published
// file. A file it cannot parse is published unchanged: playback compatibility
// never fails a download.
func relabelHEVC(f *os.File, digest hash.Hash) (bool, error) {
	st, err := f.Stat()
	if err != nil {
		return false, nil
	}
	changed, _ := mp4tag.RelabelHEV1(f, st.Size())
	if changed == 0 {
		return false, nil
	}
	digest.Reset()
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		return true, err
	}
	_, err = io.Copy(digest, f)
	return true, err
}
