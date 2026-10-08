//go:build !linux && !darwin && !windows

package download

import "os"

import "errors"

func publishExclusiveAt(dir *os.File, from, to string) error {
	return errors.New("exclusive media publication requires Linux, macOS or Windows")
}
