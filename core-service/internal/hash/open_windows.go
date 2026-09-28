//go:build windows

package hash

import (
	"os"
	"path/filepath"
	"strings"
	"syscall"
)

const fileFlagSequentialScan = 0x08000000

// Windows error codes that errors.Is(fs.ErrNotExist/ErrPermission) does
// not cover, mapped the way libuv maps them for Node.
const (
	errorSharingViolation = syscall.Errno(32)
	errorLockViolation    = syscall.Errno(33)
	errorInvalidName      = syscall.Errno(123)
	errorFilenameExcedRng = syscall.Errno(206)
	errorDirectory        = syscall.Errno(267)
	errorCantResolve      = syscall.Errno(1921)
	errorTooManyOpenFiles = syscall.Errno(4)
)

// openShared opens path for reading with FILE_SHARE_DELETE, like libuv
// does for Node. os.Open leaves that flag out, and a file held open
// without it cannot be deleted or renamed by the app until the hash
// finishes (download-time dedup unlinks the fresh copy right after
// hashing it).
func openShared(path string) (*os.File, error) {
	p, err := syscall.UTF16PtrFromString(extendedPath(path))
	if err != nil {
		return nil, &os.PathError{Op: "open", Path: path, Err: err}
	}
	h, err := syscall.CreateFile(
		p,
		syscall.GENERIC_READ,
		syscall.FILE_SHARE_READ|syscall.FILE_SHARE_WRITE|syscall.FILE_SHARE_DELETE,
		nil,
		syscall.OPEN_EXISTING,
		syscall.FILE_ATTRIBUTE_NORMAL|fileFlagSequentialScan,
		0,
	)
	if err != nil {
		return nil, &os.PathError{Op: "open", Path: path, Err: err}
	}
	return os.NewFile(uintptr(h), path), nil
}

// extendedPath returns the \\?\ form of an absolute path so paths longer
// than MAX_PATH open (Node does the same with path.toNamespacedPath).
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

func platformCode(errno syscall.Errno) string {
	switch errno {
	case syscall.ERROR_FILE_NOT_FOUND, syscall.ERROR_PATH_NOT_FOUND, errorInvalidName, errorCantResolve:
		return "ENOENT"
	case syscall.ERROR_ACCESS_DENIED:
		return "EACCES"
	case errorSharingViolation, errorLockViolation:
		return "EBUSY"
	case errorFilenameExcedRng:
		return "ENAMETOOLONG"
	case errorDirectory:
		return "ENOTDIR"
	case errorTooManyOpenFiles:
		return "EMFILE"
	}
	return ""
}
