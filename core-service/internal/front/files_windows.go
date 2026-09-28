//go:build windows

package front

import (
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"unsafe"
)

const (
	fileFlagSequentialScan  = 0x08000000
	fileFlagBackupSemantics = 0x02000000
	volumeNameDOS           = 0x0
)

var procGetFinalPathNameByHandleW = syscall.NewLazyDLL("kernel32.dll").NewProc("GetFinalPathNameByHandleW")

// openShared opens a file for reading with FILE_SHARE_DELETE, like libuv
// does for Node's fs streams, so the app can delete or rename a file while
// it is being streamed.
func openShared(path string) (*os.File, error) {
	p, err := syscall.UTF16PtrFromString(extendedPath(path))
	if err != nil {
		return nil, &os.PathError{Op: "open", Path: path, Err: err}
	}
	h, err := syscall.CreateFile(p, syscall.GENERIC_READ,
		syscall.FILE_SHARE_READ|syscall.FILE_SHARE_WRITE|syscall.FILE_SHARE_DELETE,
		nil, syscall.OPEN_EXISTING, syscall.FILE_ATTRIBUTE_NORMAL|fileFlagSequentialScan, 0)
	if err != nil {
		return nil, &os.PathError{Op: "open", Path: path, Err: err}
	}
	return os.NewFile(uintptr(h), path), nil
}

// extendedPath returns the \\?\ form of an absolute path so long paths open.
func extendedPath(path string) string {
	if strings.HasPrefix(path, `\\?\`) || strings.HasPrefix(path, `\\.\`) {
		return path
	}
	p := filepath.Clean(path)
	if strings.HasPrefix(p, `\\`) {
		return `\\?\UNC\` + p[2:]
	}
	if len(p) >= 2 && p[1] == ':' {
		return `\\?\` + p
	}
	return p
}

// finalPathOfHandle is libuv's fs__realpath_handle, i.e. what Node's
// fs.realpath returns: GetFinalPathNameByHandleW(VOLUME_NAME_DOS) with the
// \\?\ (or \\?\UNC\ → \\) prefix removed.
func finalPathOfHandle(h syscall.Handle) (string, error) {
	n, _, err := procGetFinalPathNameByHandleW.Call(uintptr(h), 0, 0, volumeNameDOS)
	if n == 0 {
		return "", err
	}
	buf := make([]uint16, n+1)
	m, _, err := procGetFinalPathNameByHandleW.Call(uintptr(h), uintptr(unsafe.Pointer(&buf[0])), uintptr(len(buf)), volumeNameDOS)
	if m == 0 || m > uintptr(len(buf)) {
		return "", err
	}
	s := syscall.UTF16ToString(buf[:m])
	switch {
	case strings.HasPrefix(s, `\\?\UNC\`):
		return `\` + s[7:], nil
	case strings.HasPrefix(s, `\\?\`):
		return s[4:], nil
	}
	return "", syscall.Errno(6) // ERROR_INVALID_HANDLE
}

// realPathOfFile is Node's fs.realpath of the file f was opened from.
func realPathOfFile(f *os.File, _ string) (string, error) {
	return finalPathOfHandle(syscall.Handle(f.Fd()))
}

// realDir is Node's fs.realpath of a directory.
func realDir(dir string) (string, error) {
	p, err := syscall.UTF16PtrFromString(extendedPath(dir))
	if err != nil {
		return "", err
	}
	h, err := syscall.CreateFile(p, 0, 0, nil, syscall.OPEN_EXISTING,
		syscall.FILE_ATTRIBUTE_NORMAL|fileFlagBackupSemantics, 0)
	if err != nil {
		return "", err
	}
	defer syscall.CloseHandle(h)
	return finalPathOfHandle(h)
}
