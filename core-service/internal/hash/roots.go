package hash

import (
	"errors"
	"fmt"
	"io/fs"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
)

// Roots is the set of directories tgdl-core may read files from
// (TGDL_CORE_ALLOW_ROOTS). A request for anything else is refused with
// EOUTSIDE, which the app answers by hashing the file itself.
//
// With no roots at all every path is refused: an empty allow-list never
// means "everything".
type Roots struct {
	mu    sync.Mutex
	items []*root
	// Cached forms (rebuilt when a root resolves): lexical holds every
	// root as written plus the resolved form of those that exist; real
	// holds the resolved forms only. pending: some root doesn't exist yet.
	lex     []string
	real    []string
	pending bool
}

type root struct {
	lexical string // absolute + cleaned, as configured
	real    string // lexical with symlinks / junctions resolved; "" until it exists
}

// NewRoots builds the allow-list. Relative entries are ignored (the app
// always sends absolute paths) and reported in the returned warnings.
func NewRoots(dirs []string) (*Roots, []string) {
	r := &Roots{}
	var warnings []string
	seen := map[string]bool{}
	for _, d := range dirs {
		d = strings.TrimSpace(d)
		if d == "" {
			continue
		}
		if !filepath.IsAbs(d) {
			warnings = append(warnings, fmt.Sprintf("ignoring relative allow-root %q", d))
			continue
		}
		lex := filepath.Clean(d)
		key := lex
		if runtime.GOOS == "windows" {
			key = strings.ToLower(lex)
		}
		if seen[key] {
			continue
		}
		seen[key] = true
		it := &root{lexical: lex}
		if real, err := filepath.EvalSymlinks(lex); err == nil {
			it.real = real
		}
		r.items = append(r.items, it)
	}
	r.rebuildLocked()
	return r, warnings
}

// rebuildLocked recomputes the cached forms. r.mu must be held (or r not
// yet shared).
func (r *Roots) rebuildLocked() {
	var lex, real []string
	pending := false
	for _, it := range r.items {
		lex = append(lex, it.lexical)
		if it.real != "" {
			lex = append(lex, it.real)
			real = append(real, it.real)
		} else {
			pending = true
		}
	}
	r.lex, r.real, r.pending = lex, real, pending
}

// ParseRoots splits a TGDL_CORE_ALLOW_ROOTS value: the OS path-list
// separator, like PATH (":" on Linux / macOS, ";" on Windows).
func ParseRoots(value string) []string {
	return filepath.SplitList(value)
}

// Len is the number of configured roots.
func (r *Roots) Len() int {
	if r == nil {
		return 0
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.items)
}

// List returns the configured roots as given.
func (r *Roots) List() []string {
	if r == nil {
		return nil
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]string, 0, len(r.items))
	for _, it := range r.items {
		out = append(out, it.lexical)
	}
	return out
}

// snapshot returns the cached lexical and resolved forms (read-only).
func (r *Roots) snapshot() (lexical, real []string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.lex, r.real
}

// refresh tries again to resolve roots that did not exist yet (a downloads
// dir created after tgdl-core started). Callers use it after a miss, so a
// path inside an existing root never pays for it. Reports whether
// anything changed.
func (r *Roots) refresh() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if !r.pending {
		return false
	}
	changed := false
	for _, it := range r.items {
		if it.real == "" {
			if rr, err := filepath.EvalSymlinks(it.lexical); err == nil {
				it.real = rr
				changed = true
			}
		}
	}
	if changed {
		r.rebuildLocked()
	}
	return changed
}

// anyWithin reports whether p is within one of bases.
func anyWithin(bases []string, p string) bool {
	for _, base := range bases {
		if _, ok := within(base, p); ok {
			return true
		}
	}
	return false
}

// within returns base joined with p's path relative to base when p is
// inside base (or is base), and false otherwise. filepath.Rel + IsLocal
// rejects "..", absolute results and, on Windows, other volumes; the
// result is rebuilt from base so nothing but the relative part of p is
// used.
func within(base, p string) (string, bool) {
	// filepath.Rel never returns on Windows for a UNC share root against
	// the same root spelled with a trailing separator
	// (Rel(`\\h\s`, `\\h\s\`) spins in its element loop), so compare
	// share roots without it.
	base, p = trimShareRoot(base), trimShareRoot(p)
	rel, err := filepath.Rel(base, p)
	if err != nil || !filepath.IsLocal(rel) {
		return "", false
	}
	return filepath.Join(base, rel), true
}

// trimShareRoot turns `\\host\share\` into `\\host\share` (Windows UNC
// roots only; `C:\` and every other path are returned unchanged).
func trimShareRoot(p string) string {
	vol := filepath.VolumeName(p)
	if len(vol) > 2 && len(p) > len(vol) && strings.Trim(p[len(vol):], `\/`) == "" {
		return vol
	}
	return p
}

func outside(p string) error {
	return &Error{Code: "EOUTSIDE", Path: p, Err: errors.New("path is outside the allowed roots")}
}

// Outside is the EOUTSIDE error for p.
func Outside(p string) error { return outside(p) }

// WithinLexical reports whether the absolute, cleaned path p lies inside
// a root as written (or inside a root's resolved form), without touching
// the file system.
func (r *Roots) WithinLexical(p string) bool {
	_, ok := r.Contain(p)
	return ok
}

// Contain returns p rebuilt from the allowed root it lies in, as written:
// the root joined with p's path relative to it (filepath.Rel +
// filepath.IsLocal), so nothing but the relative part of the caller's
// path is ever used. Callers must touch the file system only through the
// returned path. false when p is outside every root; the file system is
// not touched (except to resolve a root that didn't exist yet, on a miss).
func (r *Roots) Contain(p string) (string, bool) {
	if r == nil {
		return "", false
	}
	clean := filepath.Clean(p)
	lexRoots, _ := r.snapshot()
	if c, ok := firstWithin(lexRoots, clean); ok {
		return c, true
	}
	if r.refresh() {
		lexRoots, _ = r.snapshot()
		return firstWithin(lexRoots, clean)
	}
	return "", false
}

func firstWithin(bases []string, p string) (string, bool) {
	for _, base := range bases {
		if c, ok := within(base, p); ok {
			return c, true
		}
	}
	return "", false
}

// IsRoot reports whether p (absolute, cleaned) is one of the roots, as
// written or resolved.
func (r *Roots) IsRoot(p string) bool {
	if r == nil {
		return false
	}
	lexRoots, _ := r.snapshot()
	p = trimShareRoot(p)
	for _, base := range lexRoots {
		base = trimShareRoot(base)
		if base == p || (runtime.GOOS == "windows" && strings.EqualFold(base, p)) {
			return true
		}
	}
	return false
}

// WithinResolved reports whether p, a path with every symlink / junction
// already resolved, lies inside a root's resolved form.
func (r *Roots) WithinResolved(p string) bool {
	if r == nil {
		return false
	}
	_, realRoots := r.snapshot()
	if anyWithin(realRoots, p) {
		return true
	}
	if r.refresh() {
		_, realRoots = r.snapshot()
		return anyWithin(realRoots, p)
	}
	return false
}

// Resolve checks that p lies inside a root, both as written and after
// resolving symlinks (a link inside a root that points elsewhere is
// refused), and returns the resolved path to open.
func (r *Roots) Resolve(p string) (string, error) {
	if p == "" || strings.IndexByte(p, 0) >= 0 {
		return "", &Error{Code: "EINVAL", Path: p, Err: errors.New("path must be a non-empty string without NUL bytes")}
	}
	if !filepath.IsAbs(p) {
		return "", &Error{Code: "EINVAL", Path: p, Err: errors.New("path must be absolute")}
	}
	if r == nil {
		return "", outside(p)
	}
	r.refresh()
	lexRoots, realRoots := r.snapshot()

	// 1. As written: refuse before touching the file system, so paths
	//    outside every root can't even be probed for existence.
	var candidate string
	for _, base := range lexRoots {
		if c, ok := within(base, filepath.Clean(p)); ok {
			candidate = c
			break
		}
	}
	if candidate == "" {
		return "", outside(p)
	}

	// 2. After resolving symlinks / junctions.
	resolved, err := filepath.EvalSymlinks(candidate)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return "", &Error{Code: "ENOENT", Path: p, Err: err}
		}
		return "", classify(p, err)
	}
	for _, base := range realRoots {
		if c, ok := within(base, resolved); ok {
			return c, nil
		}
	}
	return "", outside(p)
}
