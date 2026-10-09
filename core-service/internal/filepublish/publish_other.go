//go:build !linux && !darwin && !windows

package filepublish

import "os"

import "errors"

func renameExclusiveAt(dir *os.File, from, to string) error {
	return errors.New("exclusive publication requires Linux, macOS or Windows")
}
