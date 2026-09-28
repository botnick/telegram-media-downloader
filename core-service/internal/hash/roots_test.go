package hash

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// link makes a directory link at `at` pointing to `target`: a symlink
// where allowed, a junction on Windows without the symlink privilege.
func link(t *testing.T, target, at string) {
	t.Helper()
	if err := os.Symlink(target, at); err == nil {
		return
	}
	if runtime.GOOS != "windows" {
		t.Skip("cannot create a directory link here")
	}
	out, err := exec.Command("cmd", "/c", "mklink", "/J", at, target).CombinedOutput()
	if err != nil {
		t.Skipf("cannot create a junction: %v %s", err, out)
	}
}

func mustResolve(t *testing.T, r *Roots, p string) string {
	t.Helper()
	got, err := r.Resolve(p)
	if err != nil {
		t.Fatalf("Resolve(%q): %v", p, err)
	}
	return got
}

func wantCode(t *testing.T, r *Roots, p, code string) {
	t.Helper()
	if _, err := r.Resolve(p); err == nil || errCode(err) != code {
		t.Fatalf("Resolve(%q) = %v, want %s", p, err, code)
	}
}

func errCode(err error) string { return code(err) }

func sameFile(t *testing.T, a, b string) bool {
	t.Helper()
	sa, err1 := os.Stat(a)
	sb, err2 := os.Stat(b)
	return err1 == nil && err2 == nil && os.SameFile(sa, sb)
}

func TestRootsInside(t *testing.T) {
	root := t.TempDir()
	p := write(t, root, filepath.Join("G1", "images", "ไฟล์ 🎬.jpg"), []byte("x"))
	r, _ := NewRoots([]string{root})
	got := mustResolve(t, r, p)
	if !sameFile(t, got, p) {
		t.Fatalf("resolved %q is not %q", got, p)
	}
	res, err := File(context.Background(), got)
	if err != nil || res.Size != 1 {
		t.Fatalf("File(%q) = %+v, %v", got, res, err)
	}
}

func TestRootsOutside(t *testing.T) {
	root := t.TempDir()
	other := t.TempDir()
	p := write(t, other, "secret.bin", []byte("x"))
	r, _ := NewRoots([]string{root})
	wantCode(t, r, p, "EOUTSIDE")
	// A sibling that merely shares the root's name as a prefix.
	sib := root + "-evil"
	if err := os.MkdirAll(sib, 0o755); err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(sib)
	wantCode(t, r, write(t, sib, "x.bin", []byte("x")), "EOUTSIDE")
	// Outside and missing: refused before the file system is asked, so
	// the answer doesn't reveal whether it exists.
	wantCode(t, r, filepath.Join(other, "does-not-exist"), "EOUTSIDE")
}

func TestRootsDotDotTraversal(t *testing.T) {
	root := t.TempDir()
	other := t.TempDir()
	write(t, other, "secret.bin", []byte("x"))
	r, _ := NewRoots([]string{root})
	sep := string(filepath.Separator)
	for _, p := range []string{
		root + sep + ".." + sep + filepath.Base(other) + sep + "secret.bin",
		root + sep + "a" + sep + ".." + sep + ".." + sep + filepath.Base(other) + sep + "secret.bin",
		root + sep + "..",
	} {
		wantCode(t, r, p, "EOUTSIDE")
	}
	// ".." that stays inside is fine.
	p := write(t, root, filepath.Join("a", "b.bin"), []byte("x"))
	got := mustResolve(t, r, root+sep+"a"+sep+"c"+sep+".."+sep+"b.bin")
	if !sameFile(t, got, p) {
		t.Fatalf("resolved %q", got)
	}
}

func TestRootsSymlinkEscapingRoot(t *testing.T) {
	root := t.TempDir()
	other := t.TempDir()
	write(t, other, "secret.bin", []byte("x"))
	link(t, other, filepath.Join(root, "escape"))
	r, _ := NewRoots([]string{root})
	wantCode(t, r, filepath.Join(root, "escape", "secret.bin"), "EOUTSIDE")
}

func TestRootsSymlinkInsideRoot(t *testing.T) {
	root := t.TempDir()
	target := filepath.Join(root, "real")
	p := write(t, target, "a.bin", []byte("x"))
	link(t, target, filepath.Join(root, "alias"))
	r, _ := NewRoots([]string{root})
	got := mustResolve(t, r, filepath.Join(root, "alias", "a.bin"))
	if !sameFile(t, got, p) {
		t.Fatalf("resolved %q", got)
	}
}

// Downloads dir that is itself a link (e.g. /app/data/downloads -> /mnt/hdd):
// paths written either way are accepted.
func TestRootThatIsALink(t *testing.T) {
	base := t.TempDir()
	real := filepath.Join(base, "hdd")
	p := write(t, real, "clip.mp4", []byte("x"))
	alias := filepath.Join(base, "downloads")
	link(t, real, alias)
	r, _ := NewRoots([]string{alias})
	for _, q := range []string{filepath.Join(alias, "clip.mp4"), p} {
		if got := mustResolve(t, r, q); !sameFile(t, got, p) {
			t.Fatalf("Resolve(%q) = %q", q, got)
		}
	}
}

func TestRootsMissingFileInsideIsENOENT(t *testing.T) {
	root := t.TempDir()
	r, _ := NewRoots([]string{root})
	wantCode(t, r, filepath.Join(root, "gone.bin"), "ENOENT")
}

func TestRootsEmptyRefusesEverything(t *testing.T) {
	dir := t.TempDir()
	p := write(t, dir, "a.bin", []byte("x"))
	for _, r := range []*Roots{nil, func() *Roots { r, _ := NewRoots(nil); return r }()} {
		wantCode(t, r, p, "EOUTSIDE")
	}
}

func TestRootsIgnoreRelativeEntries(t *testing.T) {
	r, warnings := NewRoots([]string{"relative/dir", "", "  "})
	if r.Len() != 0 || len(warnings) != 1 {
		t.Fatalf("len=%d warnings=%v", r.Len(), warnings)
	}
}

func TestRootsCreatedAfterStart(t *testing.T) {
	base := t.TempDir()
	root := filepath.Join(base, "downloads")
	r, _ := NewRoots([]string{root}) // doesn't exist yet
	p := write(t, root, "later.bin", []byte("x"))
	if got := mustResolve(t, r, p); !sameFile(t, got, p) {
		t.Fatalf("resolved %q", got)
	}
}

func TestRootsRequestValidation(t *testing.T) {
	r, _ := NewRoots([]string{t.TempDir()})
	wantCode(t, r, "", "EINVAL")
	wantCode(t, r, "relative/file.bin", "EINVAL")
	wantCode(t, r, string(filepath.Separator)+"x\x00y", "EINVAL")
}

func TestRootsWindowsCaseInsensitive(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("case-insensitive paths are a Windows thing")
	}
	root := t.TempDir()
	p := write(t, root, "Clip.MP4", []byte("x"))
	r, _ := NewRoots([]string{strings.ToUpper(root)})
	if got := mustResolve(t, r, strings.ToLower(p)); !sameFile(t, got, p) {
		t.Fatalf("resolved %q", got)
	}
}

func TestParseRoots(t *testing.T) {
	sep := string(filepath.ListSeparator)
	got := ParseRoots("/a" + sep + "/b")
	if len(got) != 2 || got[0] != "/a" || got[1] != "/b" {
		t.Fatalf("ParseRoots = %q", got)
	}
}
