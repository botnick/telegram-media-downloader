//go:build darwin

package download

import "os"

import "golang.org/x/sys/unix"

func publishExclusiveAt(dir *os.File, from, to string) error {
	return unix.RenameatxNp(int(dir.Fd()), from, int(dir.Fd()), to, unix.RENAME_EXCL)
}
