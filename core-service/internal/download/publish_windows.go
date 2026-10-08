//go:build windows

package download

import "golang.org/x/sys/windows"

func publishExclusive(from, to string) error {
	source, err := windows.UTF16PtrFromString(from)
	if err != nil {
		return err
	}
	destination, err := windows.UTF16PtrFromString(to)
	if err != nil {
		return err
	}
	// Do not set REPLACE_EXISTING or COPY_ALLOWED: publication must remain
	// exclusive and within the volume holding the completed temporary file.
	return windows.MoveFileEx(source, destination, windows.MOVEFILE_WRITE_THROUGH)
}
