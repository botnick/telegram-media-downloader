//go:build windows

package front

import "syscall"

func errnoString(e syscall.Errno) string {
	switch e {
	case 10048: // WSAEADDRINUSE
		return "EADDRINUSE"
	case 10013: // WSAEACCES
		return "EACCES"
	case 10049: // WSAEADDRNOTAVAIL
		return "EADDRNOTAVAIL"
	}
	return ""
}
