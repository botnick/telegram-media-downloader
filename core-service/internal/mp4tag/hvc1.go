// Package mp4tag relabels HEVC sample entries in MP4 files so Apple players
// accept them.
//
// MP4 allows two sample entry types for HEVC: 'hvc1' (parameter sets live in
// the hvcC box) and 'hev1' (parameter sets may also appear in-band). Safari
// and every iOS browser (they all use WebKit) refuse 'hev1' with
// MEDIA_ERR_SRC_NOT_SUPPORTED, while Chrome, Firefox and VLC play both. When
// the hvcC box already carries a VPS, SPS and PPS, the stream is a valid
// 'hvc1' stream as-is, so renaming the four-byte type is a lossless fix: the
// file size and every sample stay byte-identical. This is the same change
// `ffmpeg -c copy -tag:v hvc1` makes, without rewriting the file.
package mp4tag

import (
	"encoding/binary"
	"errors"
	"io"
)

// File is the subset of *os.File the relabeller needs.
type File interface {
	io.ReaderAt
	io.WriterAt
}

const (
	maxDepth = 8
	// visualSampleEntryHeader is the fixed part of a VisualSampleEntry
	// (ISO/IEC 14496-12 §12.1.3) after the 8-byte box header: 6 reserved,
	// data_reference_index(2) and 70 bytes of visual fields.
	visualSampleEntryHeader = 78
	// hvcCFixed is the HEVCDecoderConfigurationRecord before numOfArrays
	// (ISO/IEC 14496-15 §8.3.3.1).
	hvcCFixed = 22
	nalVPS    = 32
	nalSPS    = 33
	nalPPS    = 34
)

var containers = map[string]bool{"moov": true, "trak": true, "mdia": true, "minf": true, "stbl": true}

// RelabelHEV1 renames every 'hev1' sample entry whose hvcC box carries VPS,
// SPS and PPS to 'hvc1'. It returns how many entries it changed. Files that
// are not MP4, have no HEVC track, or whose parameter sets are only in-band
// are left untouched and return (0, nil).
func RelabelHEV1(f File, size int64) (int, error) {
	if size < 16 {
		return 0, nil
	}
	var head [8]byte
	if _, err := f.ReadAt(head[:], 0); err != nil {
		return 0, nil
	}
	if string(head[4:8]) != "ftyp" {
		return 0, nil
	}
	var offsets []int64
	if err := walk(f, 0, size, 0, &offsets); err != nil {
		return 0, err
	}
	for i, off := range offsets {
		if _, err := f.WriteAt([]byte("hvc1"), off); err != nil {
			return i, err
		}
	}
	return len(offsets), nil
}

type box struct {
	start, size, header int64
	kind                string
}

func readBox(f File, pos, end int64) (box, bool, error) {
	if pos+8 > end {
		return box{}, false, nil
	}
	var hdr [16]byte
	if _, err := f.ReadAt(hdr[:8], pos); err != nil {
		return box{}, false, err
	}
	b := box{start: pos, size: int64(binary.BigEndian.Uint32(hdr[:4])), header: 8, kind: string(hdr[4:8])}
	switch b.size {
	case 1:
		if pos+16 > end {
			return box{}, false, nil
		}
		if _, err := f.ReadAt(hdr[8:16], pos+8); err != nil {
			return box{}, false, err
		}
		b.size = int64(binary.BigEndian.Uint64(hdr[8:16]))
		b.header = 16
	case 0:
		b.size = end - pos
	}
	if b.size < b.header || b.size > end-pos {
		return box{}, false, nil
	}
	return b, true, nil
}

func walk(f File, start, end int64, depth int, out *[]int64) error {
	if depth > maxDepth {
		return nil
	}
	for pos := start; ; {
		b, ok, err := readBox(f, pos, end)
		if err != nil || !ok {
			return err
		}
		switch {
		case containers[b.kind]:
			if err := walk(f, b.start+b.header, b.start+b.size, depth+1, out); err != nil {
				return err
			}
		case b.kind == "stsd":
			if err := stsd(f, b, out); err != nil {
				return err
			}
		}
		pos = b.start + b.size
	}
}

// stsd is a full box: version/flags(4), entry_count(4), then sample entries.
func stsd(f File, b box, out *[]int64) error {
	end := b.start + b.size
	pos := b.start + b.header + 8
	var count [4]byte
	if _, err := f.ReadAt(count[:], b.start+b.header+4); err != nil {
		return nil
	}
	for n := binary.BigEndian.Uint32(count[:]); n > 0; n-- {
		entry, ok, err := readBox(f, pos, end)
		if err != nil || !ok {
			return err
		}
		if entry.kind == "hev1" && entry.header == 8 && hasParameterSets(f, entry) {
			*out = append(*out, entry.start+4)
		}
		pos = entry.start + entry.size
	}
	return nil
}

func hasParameterSets(f File, entry box) bool {
	end := entry.start + entry.size
	for pos := entry.start + entry.header + visualSampleEntryHeader; ; {
		child, ok, err := readBox(f, pos, end)
		if err != nil || !ok {
			return false
		}
		if child.kind == "hvcC" {
			return parameterSetsIn(f, child)
		}
		pos = child.start + child.size
	}
}

func parameterSetsIn(f File, b box) bool {
	body := b.size - b.header
	if body < hvcCFixed+1 || body > 1<<20 {
		return false
	}
	buf := make([]byte, body)
	if _, err := f.ReadAt(buf, b.start+b.header); err != nil && !errors.Is(err, io.EOF) {
		return false
	}
	seen := map[byte]bool{}
	p := hvcCFixed + 1
	for arrays := int(buf[hvcCFixed]); arrays > 0; arrays-- {
		if p+3 > len(buf) {
			return false
		}
		nalType := buf[p] & 0x3f
		nalus := int(binary.BigEndian.Uint16(buf[p+1 : p+3]))
		p += 3
		for ; nalus > 0; nalus-- {
			if p+2 > len(buf) {
				return false
			}
			length := int(binary.BigEndian.Uint16(buf[p : p+2]))
			p += 2 + length
			if p > len(buf) {
				return false
			}
			if length > 0 {
				seen[nalType] = true
			}
		}
	}
	return seen[nalVPS] && seen[nalSPS] && seen[nalPPS]
}
