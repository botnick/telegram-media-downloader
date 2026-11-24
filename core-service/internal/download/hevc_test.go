package download

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"os"
	"path/filepath"
	"testing"

	"github.com/botnick/telegram-media-downloader/core-service/internal/telegram"
)

func testBox(kind string, payload ...[]byte) []byte {
	body := bytes.Join(payload, nil)
	out := binary.BigEndian.AppendUint32(nil, uint32(8+len(body)))
	return append(append(out, kind...), body...)
}

// hev1Clip is a minimal MP4 whose only video sample entry is 'hev1' with
// VPS, SPS and PPS in its hvcC box.
func hev1Clip() []byte {
	cfg := append(make([]byte, 22), 3)
	for _, nal := range []byte{32, 33, 34} {
		cfg = append(cfg, 0x80|nal, 0, 1, 0, 2, 0x40, 0x01)
	}
	entry := testBox("hev1", make([]byte, 78), testBox("hvcC", cfg))
	stsd := testBox("stsd", []byte{0, 0, 0, 0, 0, 0, 0, 1}, entry)
	moov := testBox("moov", testBox("trak", testBox("mdia", testBox("minf", testBox("stbl", stsd)))))
	return bytes.Join([][]byte{testBox("ftyp", []byte("isom\x00\x00\x02\x00isom")), moov, testBox("mdat", bytes.Repeat([]byte{7}, 256))}, nil)
}

func ingestClip(t *testing.T, library *Library, id string, msg int64, data []byte) (Record, []byte) {
	t.Helper()
	item := Item{GroupID: "1", GroupName: "One", MessageID: msg, Name: "clip" + id + ".mp4", Type: "video", Identity: telegram.MediaIdentity{Kind: "document", ID: id, Size: int64(len(data))}}
	record, err := library.Ingest(context.Background(), item, fakeClient{data: data})
	if err != nil {
		t.Fatal(err)
	}
	onDisk, err := os.ReadFile(filepath.Join(library.root, record.Path))
	if err != nil {
		t.Fatal(err)
	}
	return record, onDisk
}

func TestIngestRelabelsHEV1AndHashesPublishedBytes(t *testing.T) {
	dir := t.TempDir()
	library, db := openTestLibrary(t, dir)
	src := hev1Clip()
	record, onDisk := ingestClip(t, library, "1", 1, src)
	if len(onDisk) != len(src) || !bytes.Contains(onDisk, []byte("hvc1")) || bytes.Contains(onDisk, []byte("hev1")) {
		t.Fatalf("published file not relabelled (size %d -> %d)", len(src), len(onDisk))
	}
	sum := sha256.Sum256(onDisk)
	want := hex.EncodeToString(sum[:])
	var stored string
	if err := db.Reader.QueryRow(`SELECT file_hash FROM downloads WHERE id=?`, record.ID).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if stored != want || record.SHA256 != want {
		t.Fatalf("catalog hash %q / record %q, want hash of published bytes %q", stored, record.SHA256, want)
	}
	// The same original bytes under another Telegram id must still be
	// recognised as a duplicate of the relabelled file.
	second, _ := ingestClip(t, library, "2", 2, src)
	if !second.Reused || second.Path != record.Path {
		t.Fatalf("identical upload not deduplicated: first=%+v second=%+v", record, second)
	}
}

func TestIngestKeepsTelegramBytesWhenRelabelDisabled(t *testing.T) {
	t.Setenv("TGDL_HEVC_HVC1", "0")
	library, _ := openTestLibrary(t, t.TempDir())
	src := hev1Clip()
	_, onDisk := ingestClip(t, library, "1", 1, src)
	if !bytes.Equal(onDisk, src) {
		t.Fatal("file changed although TGDL_HEVC_HVC1=0")
	}
}

func TestIngestLeavesNonMP4Untouched(t *testing.T) {
	library, _ := openTestLibrary(t, t.TempDir())
	src := []byte("not an mp4 but mentions hev1 somewhere")
	_, onDisk := ingestClip(t, library, "1", 1, src)
	if !bytes.Equal(onDisk, src) {
		t.Fatal("non-MP4 file modified")
	}
}
