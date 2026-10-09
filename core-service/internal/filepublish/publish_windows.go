//go:build windows

package filepublish

import (
	"golang.org/x/sys/windows"
	"os"
	"unsafe"
)

// NT rename uses the open directory as the destination root, so replacing
// an ancestor with a junction cannot redirect publication outside the library.
func renameExclusiveAt(dir *os.File, from, to string) error {
	name, err := windows.NewNTUnicodeString(from)
	if err != nil {
		return err
	}
	attrs := windows.OBJECT_ATTRIBUTES{ObjectName: name, RootDirectory: windows.Handle(dir.Fd())}
	attrs.Length = uint32(unsafe.Sizeof(attrs))
	var status windows.IO_STATUS_BLOCK
	var source windows.Handle
	err = windows.NtCreateFile(&source, windows.DELETE, &attrs, &status, nil, 0, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, windows.FILE_OPEN, windows.FILE_OPEN_REPARSE_POINT, 0, 0)
	if err != nil {
		return ntError(err)
	}
	defer windows.CloseHandle(source)
	target, err := windows.UTF16FromString(to)
	if err != nil {
		return err
	}
	type renameInfo struct {
		Replace uint32
		Root    windows.Handle
		Length  uint32
		Name    [1]uint16
	}
	size := int(unsafe.Sizeof(renameInfo{})) + 2*(len(target)-1)
	buf := make([]byte, size)
	info := (*renameInfo)(unsafe.Pointer(&buf[0]))
	info.Root = windows.Handle(dir.Fd())
	info.Length = uint32(2 * (len(target) - 1))
	copy(unsafe.Slice(&info.Name[0], len(target)-1), target[:len(target)-1])
	return ntError(windows.NtSetInformationFile(source, &status, &buf[0], uint32(size), windows.FileRenameInformation))
}

func ntError(err error) error {
	if status, ok := err.(windows.NTStatus); ok {
		return status.Errno()
	}
	return err
}
