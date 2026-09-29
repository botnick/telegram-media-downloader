//go:build linux

package fsx

import "syscall"

// Linux-only entries of libuv's UV_ERRNO_MAP.
var osErrnoNames = map[syscall.Errno]string{
	syscall.ENONET:    "ENONET",
	syscall.EREMOTEIO: "EREMOTEIO",
	syscall.EUNATCH:   "EUNATCH",
	syscall.ENODATA:   "ENODATA",
}

func mtimeOf(s *syscall.Stat_t) (int64, int64) {
	return int64(s.Mtim.Sec), int64(s.Mtim.Nsec)
}
