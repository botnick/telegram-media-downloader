//go:build linux

package download

import "os"

import "golang.org/x/sys/unix"

// Both names are leaf names under an already opened directory.
func publishExclusiveAt(dir *os.File, from, to string) error {
	return unix.Renameat2(int(dir.Fd()), from, int(dir.Fd()), to, unix.RENAME_NOREPLACE)
}
