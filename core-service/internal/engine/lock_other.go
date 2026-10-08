//go:build !linux && !darwin && !windows

package engine

import "errors"

func acquireLock(path string) (func(), error) {
	return nil, errors.New("engine ownership requires Linux, macOS or Windows")
}
