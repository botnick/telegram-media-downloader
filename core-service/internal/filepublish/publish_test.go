package filepublish

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestExclusiveFileAndDirectoryPublication(t *testing.T) {
	for _, directory := range []bool{false, true} {
		t.Run(map[bool]string{false: "file", true: "directory"}[directory], func(t *testing.T) {
			root := t.TempDir()
			dir, err := os.Open(root)
			if err != nil {
				t.Fatal(err)
			}
			defer dir.Close()
			if directory {
				if err = os.Mkdir(filepath.Join(root, "source"), 0700); err != nil {
					t.Fatal(err)
				}
				if err = os.Mkdir(filepath.Join(root, "target"), 0700); err != nil {
					t.Fatal(err)
				}
			} else {
				if err = os.WriteFile(filepath.Join(root, "source"), []byte("new"), 0600); err != nil {
					t.Fatal(err)
				}
				if err = os.WriteFile(filepath.Join(root, "target"), []byte("keep"), 0600); err != nil {
					t.Fatal(err)
				}
			}
			if err = ExclusiveAt(dir, "source", "target"); err == nil {
				t.Fatal("replaced an existing target")
			}
			if _, err = os.Stat(filepath.Join(root, "source")); err != nil {
				t.Fatal("source lost", err)
			}
			if err = ExclusiveAt(dir, "source", "../escape"); err == nil {
				t.Fatal("accepted traversal")
			}
			if err = ExclusiveAt(dir, "source", "new-target"); err != nil {
				t.Fatal(err)
			}
			if _, err = os.Stat(filepath.Join(root, "source")); !errors.Is(err, os.ErrNotExist) {
				t.Fatal("source retained", err)
			}
			if _, err = os.Stat(filepath.Join(root, "new-target")); err != nil {
				t.Fatal("missing publication", err)
			}
		})
	}
}
