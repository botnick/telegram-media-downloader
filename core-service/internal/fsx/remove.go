package fsx

import (
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/botnick/telegram-media-downloader/core-service/internal/hash"
)

const maxRemoveTreeBody = 16 << 20

// RemoveTreeHandler removes files below one allowed directory unless their
// absolute path is present in Keep. Directory removal is best-effort, so a
// directory containing a kept file is left in place. Symlinks are treated as
// files and are never followed.
type RemoveTreeHandler struct {
	Roots *hash.Roots
}

type removeTreeRequest struct {
	Root string   `json:"root"`
	Keep []string `json:"keep"`
}

func (h *RemoveTreeHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	var req removeTreeRequest
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxRemoveTreeBody))
	if err := dec.Decode(&req); err != nil || strings.TrimSpace(req.Root) == "" {
		hash.WriteError(w, http.StatusBadRequest, "EINVAL", `body must be JSON {"root": "/abs/dir", "keep": ["/abs/file"]}`)
		return
	}
	root, err := h.Roots.Resolve(req.Root)
	if err != nil {
		h.writeResolveError(w, err)
		return
	}
	st, err := os.Stat(root)
	if err != nil {
		code := "EIO"
		if errors.Is(err, os.ErrNotExist) {
			code = "ENOENT"
		}
		hash.WriteError(w, http.StatusUnprocessableEntity, code, err.Error())
		return
	}
	if !st.IsDir() {
		hash.WriteError(w, http.StatusUnprocessableEntity, "ENOTDIR", "remove root is not a directory")
		return
	}
	keep, err := keepPaths(root, req.Keep)
	if err != nil {
		hash.WriteError(w, http.StatusBadRequest, "EINVAL", err.Error())
		return
	}
	kept, err := removeTree(root, keep)
	if err != nil {
		hash.WriteError(w, http.StatusUnprocessableEntity, "EIO", err.Error())
		return
	}
	hash.WriteJSON(w, http.StatusOK, map[string]any{"kept": kept})
}

func keepPaths(root string, paths []string) (map[string]struct{}, error) {
	keep := make(map[string]struct{}, len(paths))
	for _, p := range paths {
		if strings.TrimSpace(p) == "" || !filepath.IsAbs(p) {
			return nil, errors.New("keep paths must be absolute")
		}
		clean := filepath.Clean(p)
		rel, err := filepath.Rel(root, clean)
		if err != nil || !filepath.IsLocal(rel) || rel == "." {
			return nil, errors.New("keep path is outside the remove root")
		}
		keep[filepath.Join(root, rel)] = struct{}{}
	}
	return keep, nil
}

func removeTree(root string, keep map[string]struct{}) (int, error) {
	kept := 0
	var dirs []string
	err := filepath.WalkDir(root, func(abs string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if abs == root {
			return nil
		}
		if entry.IsDir() {
			dirs = append(dirs, abs)
			return nil
		}
		if _, ok := keep[abs]; ok {
			kept++
			return nil
		}
		if err := os.Remove(abs); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		return nil
	})
	if err != nil {
		return kept, err
	}
	for i := len(dirs) - 1; i >= 0; i-- {
		_ = os.Remove(dirs[i])
	}
	return kept, nil
}

func (h *RemoveTreeHandler) writeResolveError(w http.ResponseWriter, err error) {
	code := "EIO"
	var he *hash.Error
	if errors.As(err, &he) {
		code = he.Code
	}
	status := http.StatusUnprocessableEntity
	if code == "EOUTSIDE" {
		status = http.StatusForbidden
	} else if code == "EINVAL" {
		status = http.StatusBadRequest
	}
	hash.WriteError(w, status, code, err.Error())
}
