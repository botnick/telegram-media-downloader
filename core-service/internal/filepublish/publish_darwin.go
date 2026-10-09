//go:build darwin

package filepublish

import "os"

import "golang.org/x/sys/unix"

func renameExclusiveAt(dir *os.File, from, to string) error {
	return unix.RenameatxNp(int(dir.Fd()), from, int(dir.Fd()), to, unix.RENAME_EXCL)
}
