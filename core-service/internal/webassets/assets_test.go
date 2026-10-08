package webassets

import (
	"io/fs"
	"testing"
)

func TestEmbeddedSPAHasEntryPoint(t *testing.T) {
	if _, err := fs.ReadFile(FS, "public/index.html"); err != nil {
		t.Fatalf("embedded index.html: %v", err)
	}
}
