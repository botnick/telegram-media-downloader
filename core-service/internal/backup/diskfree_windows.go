//go:build windows

package backup

import "golang.org/x/sys/windows"

// FreeBytes reports the space available to this user on the volume of path.
func FreeBytes(path string) (uint64, error) {
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return 0, err
	}
	var free, total, all uint64
	if err = windows.GetDiskFreeSpaceEx(p, &free, &total, &all); err != nil {
		return 0, err
	}
	return free, nil
}
