// Package filepublish atomically publishes files or directories under an open
// directory handle without replacing an existing destination.
package filepublish

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
)

func ExclusiveAt(dir *os.File, from, to string) error {
	for _, name := range []string{from, to} {
		if name == "" || name == "." || name == ".." || filepath.Base(name) != name || strings.ContainsAny(name, "/\\:\x00") {
			return errors.New("publication requires leaf filenames")
		}
	}
	return renameExclusiveAt(dir, from, to)
}
