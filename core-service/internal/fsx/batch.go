package fsx

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/botnick/telegram-media-downloader/core-service/internal/hash"
)

// Result is one entry of a stat-batch answer: the stat, or Code.
type Result struct {
	OK      bool    `json:"ok,omitempty"`
	Size    int64   `json:"size"`
	MtimeMs float64 `json:"mtimeMs"`
	IsFile  bool    `json:"isFile"`
	IsDir   bool    `json:"isDir"`
	Code    string  `json:"code,omitempty"`
}

// MarshalJSON writes {ok,size,mtimeMs,isFile,isDir} or {code}.
func (r Result) MarshalJSON() ([]byte, error) {
	if r.Code != "" {
		return json.Marshal(struct {
			Code string `json:"code"`
		}{r.Code})
	}
	return json.Marshal(struct {
		OK      bool    `json:"ok"`
		Size    int64   `json:"size"`
		MtimeMs float64 `json:"mtimeMs"`
		IsFile  bool    `json:"isFile"`
		IsDir   bool    `json:"isDir"`
	}{true, r.Size, r.MtimeMs, r.IsFile, r.IsDir})
}

func okResult(st Stat) Result {
	return Result{OK: true, Size: st.Size, MtimeMs: st.MtimeMs, IsFile: st.IsFile, IsDir: st.IsDir}
}

func codeResult(code string) Result { return Result{Code: code} }

// CodeOutside is the answer for a path outside the allowed roots.
const CodeOutside = "EOUTSIDE"

// containment answers "is this directory, with links resolved, inside an
// allowed root?". A directory is inside when its parent is and it is a
// plain directory (lstat, no link); only a link on the way costs a full
// filepath.EvalSymlinks. Verdicts are cached per directory in a DirCache
// (a page of library rows shares a handful of folders, and consecutive
// pages share them too).
type containment struct {
	roots *hash.Roots
	cache *DirCache
}

type verdict uint8

const (
	verdictUnknown verdict = iota // could not be resolved (missing, loop, …)
	verdictInside
	verdictOutside
)

// DirCache remembers directory verdicts for a short time across requests.
// The window it adds to the check-then-stat race is of the same kind as
// the one documented for hashing (someone with write access to the
// downloads folder swapping a directory for a link), and a stat only
// returns metadata.
type DirCache struct {
	mu  sync.Mutex
	ttl time.Duration
	m   map[string]dirEntry
}

type dirEntry struct {
	v       verdict
	expires time.Time
}

// DirCacheTTL is how long a directory verdict is reused.
const DirCacheTTL = 2 * time.Second

const dirCacheMax = 50_000

// NewDirCache makes a cache; ttl <= 0 caches for one request only.
func NewDirCache(ttl time.Duration) *DirCache {
	return &DirCache{ttl: ttl, m: map[string]dirEntry{}}
}

func (dc *DirCache) get(key string, now time.Time) (verdict, bool) {
	dc.mu.Lock()
	defer dc.mu.Unlock()
	e, ok := dc.m[key]
	if !ok || (dc.ttl > 0 && now.After(e.expires)) {
		return 0, false
	}
	return e.v, true
}

func (dc *DirCache) put(key string, v verdict, now time.Time) {
	dc.mu.Lock()
	defer dc.mu.Unlock()
	if len(dc.m) >= dirCacheMax {
		dc.m = map[string]dirEntry{}
	}
	dc.m[key] = dirEntry{v: v, expires: now.Add(dc.ttl)}
}

func newContainment(roots *hash.Roots, cache *DirCache) *containment {
	if cache == nil {
		cache = NewDirCache(0)
	}
	return &containment{roots: roots, cache: cache}
}

func (c *containment) dir(d string) verdict {
	key := d
	if isWindows {
		key = strings.ToLower(d)
	}
	now := time.Now()
	if v, ok := c.cache.get(key, now); ok {
		return v
	}
	v := c.resolveDir(d)
	c.cache.put(key, v, now)
	return v
}

func (c *containment) resolveDir(d string) verdict {
	if c.roots.IsRoot(d) {
		return verdictInside
	}
	parent := filepath.Dir(d)
	if parent == d || !c.roots.WithinLexical(parent) {
		return verdictOutside
	}
	if pv := c.dir(parent); pv != verdictInside {
		return pv
	}
	fi, err := os.Lstat(d)
	if err != nil {
		return verdictUnknown
	}
	if fi.Mode().IsDir() {
		return verdictInside // a plain directory inside an inside directory
	}
	// A symlink / junction / other reparse point: where does it lead?
	real, err := filepath.EvalSymlinks(d)
	if err != nil {
		return verdictUnknown
	}
	if c.roots.WithinResolved(real) {
		return verdictInside
	}
	return verdictOutside
}

// resolvedInside checks p itself (a link, or a path whose parent could
// not be resolved) after resolving every link.
func (c *containment) resolvedInside(p string) bool {
	real, err := filepath.EvalSymlinks(p)
	return err == nil && c.roots.WithinResolved(real)
}

// checkPath validates and lexically contains a path from the app. It
// returns the path rebuilt from its allowed root (hash.Roots.Contain) —
// the only form of it the file system ever sees. ok=false comes with the
// answer to send instead of a stat.
func checkPath(roots *hash.Roots, p string) (string, Result, bool) {
	if strings.IndexByte(p, 0) >= 0 {
		// fs.stat throws before touching the disk.
		return "", codeResult("ERR_INVALID_ARG_VALUE"), false
	}
	if p == "" || !filepath.IsAbs(p) {
		return "", codeResult("EINVAL"), false
	}
	contained, ok := roots.Contain(p)
	if !ok {
		return "", codeResult(CodeOutside), false
	}
	return contained, Result{}, true
}

// statOne answers one path: containment as written, then the resolved
// parent, then the stat itself, then — only for a link, or when the
// parent could not be resolved — the resolved target.
func statOne(c *containment, p string) Result {
	clean, res, ok := checkPath(c.roots, p)
	if !ok {
		return res
	}
	parentKnown := false
	if parent := filepath.Dir(clean); parent != clean && c.roots.WithinLexical(parent) {
		switch c.dir(parent) {
		case verdictOutside:
			return codeResult(CodeOutside)
		case verdictInside:
			parentKnown = true
		}
	}
	st, code, link := StatPath(clean)
	if code != "" {
		return codeResult(code)
	}
	if (link || !parentKnown) && !c.resolvedInside(clean) {
		return codeResult(CodeOutside)
	}
	return okResult(st)
}

// StatBatch stats every path (fs.stat semantics, see StatPath) with at
// most `parallel` stats in flight. Results are in input order. cache may
// be nil (verdicts then live for this call only).
func StatBatch(ctx context.Context, roots *hash.Roots, paths []string, parallel int, cache *DirCache) ([]Result, error) {
	out := make([]Result, len(paths))
	if len(paths) == 0 {
		return out, nil
	}
	if parallel < 1 {
		parallel = 1
	}
	if parallel > len(paths) {
		parallel = len(paths)
	}
	c := newContainment(roots, cache)
	var wg sync.WaitGroup
	next := make(chan int)
	for w := 0; w < parallel; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := range next {
				out[i] = statOne(c, paths[i])
			}
		}()
	}
	var err error
feed:
	for i := range paths {
		select {
		case next <- i:
		case <-ctx.Done():
			err = ctx.Err()
			break feed
		}
	}
	close(next)
	wg.Wait()
	return out, err
}
