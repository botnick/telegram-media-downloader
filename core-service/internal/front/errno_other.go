//go:build !windows

package front

import "syscall"

func errnoString(e syscall.Errno) string {
	switch e {
	case syscall.EADDRINUSE:
		return "EADDRINUSE"
	case syscall.EACCES, syscall.EPERM:
		return "EACCES"
	case syscall.EADDRNOTAVAIL:
		return "EADDRNOTAVAIL"
	}
	return ""
}
