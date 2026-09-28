//go:build darwin

package fsx

import "syscall"

// macOS-only entries of libuv's UV_ERRNO_MAP.
var osErrnoNames = map[syscall.Errno]string{
	syscall.EFTYPE:  "EFTYPE",
	syscall.ENODATA: "ENODATA",
}

func mtimeOf(s *syscall.Stat_t) (int64, int64) {
	return s.Mtimespec.Sec, s.Mtimespec.Nsec
}
