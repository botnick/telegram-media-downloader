package fsx

import (
	"context"
	"path/filepath"
	"sync"

	"github.com/botnick/telegram-media-downloader/core-service/internal/hash"
)

// Which entries a walk stats (fs.stat, following links).
const (
	StatNone   = "none"   // nothing: names and kinds only
	StatFiles  = "files"  // entries whose Dirent kind is "file"
	StatNonDir = "nondir" // every entry that is not a directory
)

// WalkOptions describes one walk.
type WalkOptions struct {
	// MaxDepth: entries of the root are depth 1; directories at MaxDepth
	// are reported but not read. 0 = no limit.
	MaxDepth int
	Stat     string
	// Parallel bounds the stats in flight inside one directory.
	Parallel int
}

// Event is one line of a walk, in the order Node's recursive
// `for (const e of await readdir(dir, {withFileTypes:true}))` visits them:
// depth first, pre-order, each directory in readdir order.
//
//	T == "d"  a directory entry (Kind dir); its contents follow unless at MaxDepth
//	T == "f"  any other entry; Stat / Code when it was stat'ed
//	T == "e"  a directory that could not be listed (P "" = the root); Code
type Event struct {
	T    string
	P    string // path relative to the root, "/"-separated
	Kind string
	// Stat result for "f" events that were stat'ed.
	Stated bool
	Stat   Stat
	Code   string
}

// Summary closes a walk.
type Summary struct {
	Dirs    int64 `json:"dirs"`
	Files   int64 `json:"files"`
	Errors  int64 `json:"errors"`
	Stated  int64 `json:"stated"`
	Bytes   int64 `json:"bytes"`
	Outside []string
}

type walker struct {
	ctx  context.Context
	c    *containment
	opts WalkOptions
	emit func(Event) error
	sum  Summary
}

// Walk lists root recursively. The root must be inside an allowed root,
// as written and resolved (EOUTSIDE otherwise, as a *hash.Error); every
// directory below it is reached without following links, so it is inside
// too. Linked entries that get stat'ed are checked on their own: a target
// outside the roots is reported with Code EOUTSIDE and not stat'ed.
func Walk(ctx context.Context, roots *hash.Roots, root string, opts WalkOptions, emit func(Event) error) (Summary, error) {
	clean, res, ok := checkPath(roots, root)
	if !ok {
		return Summary{}, &hash.Error{Code: res.Code, Path: root}
	}
	c := newContainment(roots, nil)
	if real, err := filepath.EvalSymlinks(clean); err == nil && !roots.WithinResolved(real) {
		return Summary{}, hash.Outside(root)
	} else if err != nil {
		// Not resolvable: listing it fails the same way (reported as an
		// "e" event below) — unless it somehow succeeds, which we refuse.
		if _, code := ReadDir(clean); code == "" {
			return Summary{}, hash.Outside(root)
		}
	}
	if opts.Parallel < 1 {
		opts.Parallel = 8
	}
	switch opts.Stat {
	case StatFiles, StatNonDir:
	default:
		opts.Stat = StatNone
	}
	w := &walker{ctx: ctx, c: c, opts: opts, emit: emit}
	err := w.dir(clean, "", 0)
	return w.sum, err
}

func (w *walker) wantsStat(kind string) bool {
	switch w.opts.Stat {
	case StatFiles:
		return kind == KindFile
	case StatNonDir:
		return kind != KindDir
	}
	return false
}

type statted struct {
	st     Stat
	code   string
	stated bool
}

func (w *walker) dir(abs, rel string, depth int) error {
	if err := w.ctx.Err(); err != nil {
		return err
	}
	ents, code := ReadDir(abs)
	if code != "" {
		w.sum.Errors++
		return w.emit(Event{T: "e", P: rel, Code: code})
	}
	// Stat this directory's entries in parallel; emit in order.
	var todo []int
	for i, e := range ents {
		if e.Kind != KindDir && w.wantsStat(e.Kind) {
			todo = append(todo, i)
		}
	}
	var stats []statted
	if len(todo) > 0 {
		stats = make([]statted, len(ents))
		w.statAll(abs, ents, todo, stats)
	}
	for i, e := range ents {
		p := e.Name
		if rel != "" {
			p = rel + "/" + e.Name
		}
		if e.Kind == KindDir {
			w.sum.Dirs++
			if err := w.emit(Event{T: "d", P: p, Kind: KindDir}); err != nil {
				return err
			}
			if w.opts.MaxDepth == 0 || depth+1 < w.opts.MaxDepth {
				if err := w.dir(filepath.Join(abs, e.Name), p, depth+1); err != nil {
					return err
				}
			}
			continue
		}
		w.sum.Files++
		ev := Event{T: "f", P: p, Kind: e.Kind}
		if i < len(stats) && stats[i].stated {
			s := &stats[i]
			ev.Stated = true
			w.sum.Stated++
			if s.code != "" {
				ev.Code = s.code
				if s.code == CodeOutside {
					w.sum.Outside = append(w.sum.Outside, p)
				}
			} else {
				ev.Stat = s.st
				if s.st.IsFile {
					w.sum.Bytes += s.st.Size
				}
			}
		}
		if err := w.emit(ev); err != nil {
			return err
		}
	}
	return nil
}

func (w *walker) statAll(abs string, ents []Dirent, todo []int, out []statted) {
	par := w.opts.Parallel
	if par > len(todo) {
		par = len(todo)
	}
	one := func(i int) {
		p := filepath.Join(abs, ents[i].Name)
		st, code, link := StatPath(p)
		if code == "" && (link || ents[i].Kind == KindLink) && !w.c.resolvedInside(p) {
			code = CodeOutside
		}
		out[i] = statted{st: st, code: code, stated: true}
	}
	if par <= 1 {
		for _, i := range todo {
			one(i)
		}
		return
	}
	var wg sync.WaitGroup
	next := make(chan int)
	for k := 0; k < par; k++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := range next {
				one(i)
			}
		}()
	}
	for _, i := range todo {
		next <- i
	}
	close(next)
	wg.Wait()
}
