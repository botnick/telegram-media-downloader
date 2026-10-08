package engine

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

func AcquireServerOwnership(dataDir string) (func(), error) {
	if strings.TrimSpace(dataDir) == "" {
		return nil, errors.New("data directory is required")
	}
	if err := os.MkdirAll(dataDir, 0700); err != nil {
		return nil, err
	}
	release, err := acquireLock(filepath.Join(dataDir, ".tgdl-server.lock"))
	if err != nil {
		return nil, fmt.Errorf("another server owns this data directory: %w", err)
	}
	return release, nil
}
