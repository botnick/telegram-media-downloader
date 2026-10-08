//go:build !linux && !darwin && !windows

package download

import "errors"

func publishExclusive(from, to string) error {
	return errors.New("exclusive media publication requires Linux, macOS or Windows")
}
