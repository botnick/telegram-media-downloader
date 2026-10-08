//go:build linux

package download

import (
	"fmt"
	"os"
	"syscall"
)

func fileFingerprint(f *os.File, info os.FileInfo) (string, error) {
	s := info.Sys().(*syscall.Stat_t)
	return fmt.Sprintf("linux:%d:%d:%d:%d", s.Dev, s.Ino, s.Ctim.Sec, s.Ctim.Nsec), nil
}
