//go:build !windows

package front

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
)

func openShared(path string) (*os.File, error) { return os.Open(path) }

// realPathOfFile is Node's fs.realpath (realpath(3)) of the file f was
// opened from. On Linux /proc/self/fd names the file the descriptor really
// refers to, which also rules out a path swapped between the checks and
// the open; elsewhere the path is resolved again and must still be the
// same file.
func realPathOfFile(f *os.File, path string) (string, error) {
	if runtime.GOOS == "linux" {
		if p, err := os.Readlink("/proc/self/fd/" + strconv.Itoa(int(f.Fd()))); err == nil {
			return p, nil
		}
	}
	p, err := filepath.EvalSymlinks(path)
	if err != nil {
		return "", err
	}
	a, err := f.Stat()
	if err != nil {
		return "", err
	}
	b, err := os.Stat(p)
	if err != nil {
		return "", err
	}
	if !os.SameFile(a, b) {
		return "", errors.New("file changed while opening")
	}
	return p, nil
}

// realDir is Node's fs.realpath of a directory.
func realDir(dir string) (string, error) { return filepath.EvalSymlinks(dir) }
