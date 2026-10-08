//go:build windows

package download

import (
	"fmt"
	"golang.org/x/sys/windows"
	"os"
	"unsafe"
)

func fileFingerprint(f *os.File, info os.FileInfo) (string, error) {
	var id windows.ByHandleFileInformation
	if err := windows.GetFileInformationByHandle(windows.Handle(f.Fd()), &id); err != nil {
		return "", err
	}
	var basic struct {
		Creation, Access, Write, Change int64
		Attributes                      uint32
	}
	if err := windows.GetFileInformationByHandleEx(windows.Handle(f.Fd()), windows.FileBasicInfo, (*byte)(unsafe.Pointer(&basic)), uint32(unsafe.Sizeof(basic))); err != nil {
		return "", err
	}
	return fmt.Sprintf("windows:%d:%d:%d:%d", id.VolumeSerialNumber, id.FileIndexHigh, id.FileIndexLow, basic.Change), nil
}
