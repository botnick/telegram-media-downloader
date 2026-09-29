// Package fsx answers file-system questions exactly the way Node's fs
// module would on the same OS: fs.stat (follows links) and
// fs.readdir(..., { withFileTypes: true }).
//
// "Exactly" is the point. src/core/integrity.js deletes library rows only
// when a stat fails with ENOENT or ENOTDIR, so every error code here is the
// one libuv (the I/O layer under Node) reports for the same failure:
//
//   - Windows: the same system calls in the same order as libuv 1.51
//     (src/win/fs.c fs__stat_impl_from_path / fs__stat_directory /
//     fs__scandir), on the same \\?\ path Node builds with
//     toNamespacedPath, and the Win32 error translated by a copy of
//     uv_translate_sys_error (uverr_windows.go). Go's own os.Stat is not
//     used: it takes other code paths and maps, for example, an offline
//     network share (ERROR_BAD_NETPATH) to "not exist", which libuv
//     reports as UNKNOWN.
//   - Linux / macOS: stat(2) / lstat(2) / getdents, with errno named from
//     libuv's UV_ERRNO_MAP; anything outside that map is UNKNOWN, as in
//     Node. Directory entries are sorted by strcmp like libuv's scandir.
//
// Names are handed back the way Node decodes them (invalid UTF-8 / lone
// UTF-16 surrogates become U+FFFD), and paths built from them are the
// paths Node would build — so a name Node can't round-trip fails here the
// same way it fails in Node.
package fsx

import (
	"runtime"
	"unicode/utf8"
)

const isWindows = runtime.GOOS == "windows"

// Stat is the part of an fs.Stats the app uses.
type Stat struct {
	Size    int64
	MtimeMs float64
	IsFile  bool
	IsDir   bool
}

// Directory entry kinds, fs.Dirent's is*() in one word.
const (
	KindFile    = "file"
	KindDir     = "dir"
	KindLink    = "link"
	KindChar    = "char"
	KindBlock   = "block"
	KindFifo    = "fifo"
	KindSocket  = "socket"
	KindUnknown = "unknown"
)

// Dirent is one fs.Dirent: the name as Node sees it and its kind as
// reported by the directory listing (links are not followed).
type Dirent struct {
	Name string
	Kind string
}

// msFromTimeSpec is Node's msFromTimeSpec(sec, nsec) in
// lib/internal/fs/utils.js: sec * 1e3 + nsec / 1e6 in doubles.
func msFromTimeSpec(sec, nsec float64) float64 {
	return float64(sec*1e3) + float64(nsec/1e6)
}

// nodeString decodes raw name bytes the way V8 decodes UTF-8 for Node
// (WHATWG decoder, U+FFFD per maximal invalid subpart). Valid UTF-8 comes
// back unchanged.
func nodeString(b []byte) string {
	if utf8.Valid(b) {
		return string(b)
	}
	out := make([]rune, 0, len(b))
	var cp rune
	needed, seen := 0, 0
	lower, upper := byte(0x80), byte(0xBF)
	for i := 0; i < len(b); {
		c := b[i]
		if needed == 0 {
			i++
			switch {
			case c <= 0x7F:
				out = append(out, rune(c))
			case c >= 0xC2 && c <= 0xDF:
				needed, cp = 1, rune(c&0x1F)
			case c >= 0xE0 && c <= 0xEF:
				if c == 0xE0 {
					lower = 0xA0
				}
				if c == 0xED {
					upper = 0x9F
				}
				needed, cp = 2, rune(c&0x0F)
			case c >= 0xF0 && c <= 0xF4:
				if c == 0xF0 {
					lower = 0x90
				}
				if c == 0xF4 {
					upper = 0x8F
				}
				needed, cp = 3, rune(c&0x07)
			default:
				out = append(out, utf8.RuneError)
			}
			continue
		}
		if c < lower || c > upper {
			// Invalid continuation: emit U+FFFD and reprocess this byte.
			cp, needed, seen = 0, 0, 0
			lower, upper = 0x80, 0xBF
			out = append(out, utf8.RuneError)
			continue
		}
		i++
		lower, upper = 0x80, 0xBF
		cp = cp<<6 | rune(c&0x3F)
		seen++
		if seen == needed {
			out = append(out, cp)
			cp, needed, seen = 0, 0, 0
		}
	}
	if needed != 0 {
		out = append(out, utf8.RuneError)
	}
	return string(out)
}

// codeName is the fallback name for an error libuv does not know.
const codeUnknown = "UNKNOWN"
