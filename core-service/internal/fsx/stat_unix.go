//go:build !windows

package fsx

import (
	"errors"
	"io"
	"os"
	"sort"
	"syscall"
)

// FastStatAvailable is a Windows notion; always false here.
func FastStatAvailable() bool { return false }

// CodeOf names an errno the way Node does (libuv's UV_ERRNO_MAP; anything
// else is UNKNOWN).
func CodeOf(errno syscall.Errno) string {
	if c, ok := uvErrnoNames[errno]; ok {
		return c
	}
	return codeUnknown
}

func codeOfErr(err error) string {
	var errno syscall.Errno
	if errors.As(err, &errno) {
		return CodeOf(errno)
	}
	return codeUnknown
}

func fromStatT(s *syscall.Stat_t) Stat {
	sec, nsec := mtimeOf(s)
	st := Stat{
		Size:    s.Size,
		MtimeMs: msFromTimeSpec(float64(sec), float64(nsec)),
	}
	switch s.Mode & syscall.S_IFMT {
	case syscall.S_IFREG:
		st.IsFile = true
	case syscall.S_IFDIR:
		st.IsDir = true
	}
	return st
}

func stat(path string) (syscall.Stat_t, error) {
	var s syscall.Stat_t
	for {
		err := syscall.Stat(path, &s)
		if err != syscall.EINTR {
			return s, err
		}
	}
}

func lstat(path string) (syscall.Stat_t, error) {
	var s syscall.Stat_t
	for {
		err := syscall.Lstat(path, &s)
		if err != syscall.EINTR {
			return s, err
		}
	}
}

// StatPath stats path like fs.stat (following links). code is "" on
// success, else Node's err.code; link reports that the final component
// is a symlink whose target the caller has to check for containment.
//
// lstat first: for anything but a symlink it is the same answer as
// stat(2) with one call. A symlink, or any failure, is answered by stat(2)
// itself so the code is exactly the one libuv would get.
func StatPath(path string) (Stat, string, bool) {
	ls, err := lstat(path)
	if err == nil && ls.Mode&syscall.S_IFMT != syscall.S_IFLNK {
		return fromStatT(&ls), "", false
	}
	s, err := stat(path)
	if err != nil {
		return Stat{}, codeOfErr(err), false
	}
	return fromStatT(&s), "", true
}

// ReadDir lists dir like fs.readdir(dir, { withFileTypes: true }):
// libuv's scandir(3) with an strcmp sort. The directory is opened with
// O_DIRECTORY | O_NONBLOCK like glibc's opendir, so a FIFO fails with
// ENOTDIR instead of blocking.
func ReadDir(dir string) ([]Dirent, string) {
	var fd int
	var err error
	for {
		fd, err = syscall.Open(dir, syscall.O_RDONLY|syscall.O_CLOEXEC|syscall.O_DIRECTORY|syscall.O_NONBLOCK, 0)
		if err != syscall.EINTR {
			break
		}
	}
	if err != nil {
		return nil, codeOfErr(err)
	}
	f := os.NewFile(uintptr(fd), dir)
	defer f.Close()
	var ents []os.DirEntry
	for {
		batch, rerr := f.ReadDir(1024)
		ents = append(ents, batch...)
		if rerr == io.EOF || (rerr == nil && len(batch) == 0) {
			break
		}
		if rerr != nil {
			return nil, codeOfErr(rerr)
		}
	}
	sort.Slice(ents, func(i, j int) bool {
		return ents[i].Name() < ents[j].Name() // strcmp order
	})
	out := make([]Dirent, 0, len(ents))
	for _, e := range ents {
		kind := KindUnknown
		t := e.Type()
		switch {
		case t&os.ModeDir != 0:
			kind = KindDir
		case t&os.ModeSymlink != 0:
			kind = KindLink
		case t&os.ModeNamedPipe != 0:
			kind = KindFifo
		case t&os.ModeSocket != 0:
			kind = KindSocket
		case t&os.ModeCharDevice != 0:
			kind = KindChar
		case t&os.ModeDevice != 0:
			kind = KindBlock
		case t.IsRegular():
			kind = KindFile
		}
		out = append(out, Dirent{Name: nodeString([]byte(e.Name())), Kind: kind})
	}
	return out, ""
}
