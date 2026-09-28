//go:build !windows

package hash

import (
	"os"
	"syscall"
)

func openShared(path string) (*os.File, error) {
	return os.Open(path)
}

func platformCode(errno syscall.Errno) string {
	switch errno {
	case syscall.ENOENT:
		return "ENOENT"
	case syscall.EACCES, syscall.EPERM:
		return "EACCES"
	case syscall.EISDIR:
		return "EISDIR"
	case syscall.ENOTDIR:
		return "ENOTDIR"
	case syscall.ELOOP:
		return "ELOOP"
	case syscall.ENAMETOOLONG:
		return "ENAMETOOLONG"
	case syscall.EMFILE, syscall.ENFILE:
		return "EMFILE"
	case syscall.EBUSY:
		return "EBUSY"
	case syscall.EIO:
		return "EIO"
	}
	return ""
}
