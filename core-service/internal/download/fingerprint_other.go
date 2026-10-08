//go:build !linux && !darwin && !windows

package download

import "os"

// No persistent hash cache is trusted without an OS change token.
func fileFingerprint(f *os.File, info os.FileInfo) (string, error) { return "", nil }
