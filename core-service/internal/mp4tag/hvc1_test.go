package mp4tag

import (
	"bytes"
	"encoding/binary"
	"os"
	"path/filepath"
	"testing"
)

func mkbox(kind string, payload ...[]byte) []byte {
	body := bytes.Join(payload, nil)
	out := make([]byte, 8, 8+len(body))
	binary.BigEndian.PutUint32(out, uint32(8+len(body)))
	copy(out[4:], kind)
	return append(out, body...)
}

func hvcC(nalTypes ...byte) []byte {
	cfg := make([]byte, hvcCFixed, 64)
	cfg[0] = 1 // configurationVersion
	cfg = append(cfg, byte(len(nalTypes)))
	for _, t := range nalTypes {
		cfg = append(cfg, 0x80|t, 0, 1, 0, 2, 0x40, 0x01) // one 2-byte NAL unit
	}
	return mkbox("hvcC", cfg)
}

func sampleEntry(kind string, children ...[]byte) []byte {
	return mkbox(kind, append([][]byte{make([]byte, visualSampleEntryHeader)}, children...)...)
}

func movie(entries ...[]byte) []byte {
	stsdBody := [][]byte{{0, 0, 0, 0}, binary.BigEndian.AppendUint32(nil, uint32(len(entries)))}
	stsd := mkbox("stsd", append(stsdBody, entries...)...)
	moov := mkbox("moov", mkbox("mvhd", make([]byte, 100)), mkbox("trak", mkbox("mdia", mkbox("minf", mkbox("stbl", stsd)))))
	return bytes.Join([][]byte{mkbox("ftyp", []byte("isom\x00\x00\x02\x00isom")), mkbox("mdat", bytes.Repeat([]byte{0xab}, 64)), moov}, nil)
}

func relabel(t *testing.T, data []byte) (int, []byte) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "clip.mp4")
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	f, err := os.OpenFile(path, os.O_RDWR, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	n, err := RelabelHEV1(f, int64(len(data)))
	if err != nil {
		t.Fatalf("RelabelHEV1: %v", err)
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return n, got
}

func TestRelabelHEV1WithParameterSets(t *testing.T) {
	src := movie(sampleEntry("hev1", hvcC(nalVPS, nalSPS, nalPPS)))
	n, got := relabel(t, src)
	if n != 1 {
		t.Fatalf("changed %d entries, want 1", n)
	}
	if len(got) != len(src) {
		t.Fatalf("size changed: %d -> %d", len(src), len(got))
	}
	if bytes.Contains(got, []byte("hev1")) || !bytes.Contains(got, []byte("hvc1")) {
		t.Fatal("sample entry was not renamed to hvc1")
	}
	diff := 0
	for i := range src {
		if src[i] != got[i] {
			diff++
		}
	}
	if diff != 2 { // h-e-v-1 -> h-v-c-1
		t.Fatalf("%d bytes changed, want 2", diff)
	}
}

func TestRelabelHEV1LeavesUnsafeOrForeignFilesAlone(t *testing.T) {
	for name, data := range map[string][]byte{
		"in-band parameter sets only": movie(sampleEntry("hev1", hvcC(nalVPS, nalPPS))),
		"no hvcC box":                 movie(sampleEntry("hev1")),
		"already hvc1":                movie(sampleEntry("hvc1", hvcC(nalVPS, nalSPS, nalPPS))),
		"h264":                        movie(sampleEntry("avc1", mkbox("avcC", make([]byte, 8)))),
		"not an mp4":                  bytes.Repeat([]byte("matroska"), 8),
		"truncated moov":              movie(sampleEntry("hev1", hvcC(nalVPS, nalSPS, nalPPS)))[:150],
		"tiny":                        []byte("ftyp"),
	} {
		t.Run(name, func(t *testing.T) {
			n, got := relabel(t, data)
			if n != 0 || !bytes.Equal(got, data) {
				t.Fatalf("changed=%d, file modified=%v", n, !bytes.Equal(got, data))
			}
		})
	}
}

func TestRelabelHEV1CorruptLengthsDoNotPanic(t *testing.T) {
	src := movie(sampleEntry("hev1", hvcC(nalVPS, nalSPS, nalPPS)))
	path := filepath.Join(t.TempDir(), "c.mp4")
	for i := 0; i < len(src); i++ {
		for _, v := range []byte{0x00, 0xff, 0x01} {
			data := append([]byte(nil), src...)
			data[i] = v
			if err := os.WriteFile(path, data, 0o600); err != nil {
				t.Fatal(err)
			}
			f, err := os.OpenFile(path, os.O_RDWR, 0)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := RelabelHEV1(f, int64(len(data))); err != nil {
				t.Errorf("byte %d=%#x: %v", i, v, err)
			}
			f.Close()
		}
	}
}
