package backup

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"strings"
)

type localProvider struct {
	root *os.Root
	name string
}

func newLocal(cfg map[string]any) (*localProvider, error) {
	name, _ := cfg["rootPath"].(string)
	if name == "" {
		return nil, errors.New("rootPath required")
	}
	if !filepath.IsAbs(name) {
		return nil, errors.New("rootPath must be an absolute path")
	}
	if err := os.MkdirAll(name, 0700); err != nil {
		return nil, err
	}
	root, err := os.OpenRoot(name)
	if err != nil {
		return nil, err
	}
	return &localProvider{root, name}, nil
}
func (p *localProvider) Close() error { return p.root.Close() }
func validObject(name string) error {
	if name == "" || !fs.ValidPath(name) || strings.ContainsAny(name, "\\:\x00") {
		return errors.New("invalid backup object path")
	}
	return nil
}
func (p *localProvider) temporary(dir string) (*os.File, string, error) {
	for range 8 {
		var random [12]byte
		if _, err := rand.Read(random[:]); err != nil {
			return nil, "", err
		}
		name := path.Join(dir, ".tgdl-part-"+hex.EncodeToString(random[:]))
		f, err := p.root.OpenFile(name, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
		if errors.Is(err, fs.ErrExist) {
			continue
		}
		return f, name, err
	}
	return nil, "", errors.New("could not reserve backup temporary file")
}
func (p *localProvider) Test(ctx context.Context) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	f, name, err := p.temporary(".")
	if err != nil {
		return "", err
	}
	defer p.root.Remove(name)
	_, err = f.Write([]byte("tgdl backup write probe"))
	if err == nil {
		err = f.Sync()
	}
	err = errors.Join(err, f.Close())
	if err != nil {
		return "", err
	}
	return "Wrote + removed probe at " + filepath.Join(p.name, ".tgdl-test-probe"), nil
}

type contextReader struct {
	ctx context.Context
	r   io.Reader
}

func (r contextReader) Read(b []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.r.Read(b)
}
func fileDigest(ctx context.Context, r io.Reader) ([]byte, int64, error) {
	h := sha256.New()
	n, err := io.CopyBuffer(h, contextReader{ctx, r}, make([]byte, 64<<10))
	return h.Sum(nil), n, err
}
func (p *localProvider) Upload(ctx context.Context, name string, src io.ReadSeeker, size int64, progress func(int64)) (UploadResult, error) {
	if err := validObject(name); err != nil {
		return UploadResult{}, err
	}
	// Compare content when sizes match, including empty files. The destination
	// handle remains under os.Root even if a parent symlink changes concurrently.
	existing, err := p.root.Open(name)
	if err == nil {
		st, e := existing.Stat()
		if e == nil && st.Mode().IsRegular() && st.Size() == size {
			remote, _, e1 := fileDigest(ctx, existing)
			local, n, e2 := fileDigest(ctx, src)
			_, e3 := src.Seek(0, io.SeekStart)
			_ = existing.Close()
			if e := errors.Join(e1, e2, e3); e != nil {
				return UploadResult{}, e
			}
			if n == size && bytes.Equal(local, remote) {
				return UploadResult{Bytes: size, Skipped: true}, nil
			}
		} else {
			_ = existing.Close()
			if e != nil {
				return UploadResult{}, e
			}
			if !st.Mode().IsRegular() {
				return UploadResult{}, errors.New("backup destination is not a regular file")
			}
		}
	} else if !errors.Is(err, fs.ErrNotExist) {
		return UploadResult{}, err
	}
	if err = p.root.MkdirAll(path.Dir(name), 0700); err != nil {
		return UploadResult{}, err
	}
	out, temp, err := p.temporary(path.Dir(name))
	if err != nil {
		return UploadResult{}, err
	}
	defer p.root.Remove(temp)
	defer out.Close()
	var total int64
	buf := make([]byte, 64<<10)
	reader := pacedReader{ctx, src, uploadPacerFrom(ctx)}
	for {
		if err = ctx.Err(); err != nil {
			return UploadResult{}, err
		}
		n, readErr := reader.Read(buf)
		if n > 0 {
			written, e := out.Write(buf[:n])
			total += int64(written)
			if e != nil {
				return UploadResult{}, e
			}
			if written != n {
				return UploadResult{}, io.ErrShortWrite
			}
			if progress != nil {
				progress(total)
			}
		}
		if errors.Is(readErr, io.EOF) {
			break
		}
		if readErr != nil {
			return UploadResult{}, readErr
		}
		if n == 0 {
			return UploadResult{}, io.ErrNoProgress
		}
	}
	if total != size {
		return UploadResult{}, fmt.Errorf("backup source size changed: read %d, expected %d", total, size)
	}
	if err = ctx.Err(); err != nil {
		return UploadResult{}, err
	}
	if err = out.Sync(); err != nil {
		return UploadResult{}, err
	}
	if err = out.Close(); err != nil {
		return UploadResult{}, err
	}
	if err = p.root.Rename(temp, name); err != nil {
		return UploadResult{}, err
	}
	return UploadResult{Bytes: total}, nil
}
func (p *localProvider) List(ctx context.Context, prefix string) ([]Object, error) {
	prefix = strings.TrimSuffix(prefix, "/")
	if err := validObject(prefix); err != nil {
		return nil, err
	}
	out := []Object{}
	err := fs.WalkDir(p.root.FS(), prefix, func(name string, d fs.DirEntry, err error) error {
		if errors.Is(err, fs.ErrNotExist) && name == prefix {
			return fs.SkipAll
		}
		if err != nil {
			return err
		}
		if err = ctx.Err(); err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}
		if d.Type()&os.ModeSymlink != 0 {
			return nil
		}
		st, err := d.Info()
		if err != nil {
			return err
		}
		if st.Mode().IsRegular() {
			out = append(out, Object{Path: name, Size: st.Size(), Modified: st.ModTime()})
		}
		return nil
	})
	return out, err
}
func (p *localProvider) Delete(ctx context.Context, name string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := validObject(name); err != nil {
		return err
	}
	err := p.root.Remove(name)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	return err
}
