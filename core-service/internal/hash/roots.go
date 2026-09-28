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
	return r, warnings
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

// snapshot returns lexical and resolved forms, resolving roots that did
// not exist when tgdl-core started (a downloads dir created later).
func (r *Roots) snapshot() (lexical, real []string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, it := range r.items {
		if it.real == "" {
			if rr, err := filepath.EvalSymlinks(it.lexical); err == nil {
				it.real = rr
			}
		}
		lexical = append(lexical, it.lexical)
		if it.real != "" {
			lexical = append(lexical, it.real)
			real = append(real, it.real)
		}
	}
	return lexical, real
}

// within returns base joined with p's path relative to base when p is
// inside base (or is base), and false otherwise. filepath.Rel + IsLocal
// rejects "..", absolute results and, on Windows, other volumes; the
// result is rebuilt from base so nothing but the relative part of p is
// used.
func within(base, p string) (string, bool) {
	rel, err := filepath.Rel(base, p)
	if err != nil || !filepath.IsLocal(rel) {
		return "", false
	}
	return filepath.Join(base, rel), true
}

func outside(p string) error {
	return &Error{Code: "EOUTSIDE", Path: p, Err: errors.New("path is outside the allowed roots")}
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
