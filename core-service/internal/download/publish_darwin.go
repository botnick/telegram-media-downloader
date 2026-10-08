//go:build darwin

package download

import "golang.org/x/sys/unix"

func publishExclusive(from, to string) error {
	return unix.RenamexNp(from, to, unix.RENAME_EXCL)
}
