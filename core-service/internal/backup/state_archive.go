package backup

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"strings"
	"time"
)

// ManifestFile describes one archived state file.
type ManifestFile struct {
	Name   string `json:"name"`
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256"`
}

// Manifest is the last entry of a full backup archive. Restore checks every
// file against it and refuses a backup from a newer database schema.
type Manifest struct {
	Format        string         `json:"format"`
	Version       int            `json:"version"`
	AppVersion    string         `json:"appVersion"`
	SchemaVersion int            `json:"schemaVersion"`
	CreatedAt     time.Time      `json:"createdAt"`
	Files         []ManifestFile `json:"files"`
}

const (
	manifestName   = "manifest.json"
	manifestFormat = "tgdl-full-backup"
	maxManifest    = 1 << 20
)

// writeStateArchive writes the application state (a consistent SQLite copy,
// config.json, secret.key and sessions/) as tar.gz to out. Media is never
// included. stagingParent receives the temporary database copy. With
// manifest set, a manifest.json listing every file is appended last.
func writeStateArchive(ctx context.Context, db *sql.DB, dataDir, stagingParent string, out io.Writer, manifest *Manifest) ([]ManifestFile, error) {
	staging, err := os.MkdirTemp(stagingParent, ".snapshot-stage-")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(staging)
	snap, err := Snapshot(ctx, db, staging, "database")
	if err != nil {
		return nil, err
	}
	zw := gzip.NewWriter(out)
	tw := tar.NewWriter(zw)
	var files []ManifestFile
	appendFile := func(name string, file *os.File) error {
		defer file.Close()
		info, e := file.Stat()
		if e != nil {
			return e
		}
		if !info.Mode().IsRegular() {
			return fmt.Errorf("snapshot entry %q is not a regular file", name)
		}
		header := &tar.Header{Name: name, Mode: 0600, Size: info.Size(), ModTime: info.ModTime(), Typeflag: tar.TypeReg}
		if e = tw.WriteHeader(header); e != nil {
			return e
		}
		sum := sha256.New()
		n, e := io.Copy(io.MultiWriter(tw, sum), contextReader{ctx, file})
		if e != nil {
			return e
		}
		if n != info.Size() {
			return errors.New("snapshot source size changed")
		}
		files = append(files, ManifestFile{Name: name, Size: n, SHA256: hex.EncodeToString(sum.Sum(nil))})
		return nil
	}
	f, err := os.Open(snap.Path)
	if err != nil {
		return nil, err
	}
	if err = appendFile("db.sqlite", f); err != nil {
		return nil, err
	}
	root, err := os.OpenRoot(dataDir)
	if err != nil {
		return nil, err
	}
	defer root.Close()
	// The native session key is essential to restore encrypted account sessions.
	for _, name := range []string{"config.json", "secret.key"} {
		info, e := root.Lstat(name)
		if errors.Is(e, fs.ErrNotExist) {
			continue
		}
		if e != nil {
			return nil, e
		}
		if !info.Mode().IsRegular() {
			return nil, fmt.Errorf("snapshot entry %s is not regular", name)
		}
		f, e := root.Open(name)
		if e != nil {
			return nil, e
		}
		if e = appendFile(name, f); e != nil {
			return nil, e
		}
	}
	err = fs.WalkDir(root.FS(), "sessions", func(name string, entry fs.DirEntry, e error) error {
		if errors.Is(e, fs.ErrNotExist) && name == "sessions" {
			return fs.SkipAll
		}
		if e != nil {
			return e
		}
		if e = ctx.Err(); e != nil {
			return e
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return fmt.Errorf("snapshot refuses session symlink %s", name)
		}
		if entry.IsDir() {
			return nil
		}
		f, e := root.Open(name)
		if e != nil {
			return e
		}
		return appendFile(strings.ReplaceAll(name, "\\", "/"), f)
	})
	if err != nil {
		return nil, err
	}
	if manifest != nil {
		manifest.Files = files
		raw, e := json.MarshalIndent(manifest, "", "  ")
		if e != nil {
			return nil, e
		}
		if e = tw.WriteHeader(&tar.Header{Name: manifestName, Mode: 0600, Size: int64(len(raw)), ModTime: manifest.CreatedAt, Typeflag: tar.TypeReg}); e != nil {
			return nil, e
		}
		if _, e = tw.Write(raw); e != nil {
			return nil, e
		}
	}
	if err = tw.Close(); err != nil {
		return nil, err
	}
	if err = zw.Close(); err != nil {
		return nil, err
	}
	return files, ctx.Err()
}

// checkManifest verifies the extracted files against the manifest: the
// set of files, their sizes and SHA-256 digests, and the schema version.
func checkManifest(root *os.Root, maxSchema int) (Manifest, error) {
	var m Manifest
	f, err := root.Open(manifestName)
	if errors.Is(err, fs.ErrNotExist) {
		return m, ErrNotFullBackup
	}
	if err != nil {
		return m, err
	}
	raw, err := io.ReadAll(io.LimitReader(f, maxManifest+1))
	f.Close()
	if err != nil {
		return m, err
	}
	if len(raw) > maxManifest {
		return m, errors.New("backup manifest is too large")
	}
	if err = json.Unmarshal(raw, &m); err != nil {
		return m, fmt.Errorf("backup manifest is unreadable: %w", err)
	}
	if m.Format != manifestFormat || m.Version != 1 {
		return m, errors.New("unsupported backup manifest format")
	}
	if m.SchemaVersion < 1 {
		return m, errors.New("backup manifest has no schema version")
	}
	if m.SchemaVersion > maxSchema {
		return m, fmt.Errorf("%w (version %s, database schema %d)", ErrNewerBackup, m.AppVersion, m.SchemaVersion)
	}
	listed := map[string]bool{manifestName: true}
	for _, file := range m.Files {
		if err = validObject(file.Name); err != nil || listed[file.Name] {
			return m, fmt.Errorf("backup manifest lists an invalid file %q", file.Name)
		}
		listed[file.Name] = true
		got, e := root.Open(file.Name)
		if e != nil {
			return m, fmt.Errorf("backup is missing %s", file.Name)
		}
		sum := sha256.New()
		n, e := io.Copy(sum, got)
		got.Close()
		if e != nil {
			return m, e
		}
		if n != file.Size || hex.EncodeToString(sum.Sum(nil)) != file.SHA256 {
			return m, fmt.Errorf("backup file %s does not match its checksum", file.Name)
		}
	}
	err = fs.WalkDir(root.FS(), ".", func(name string, entry fs.DirEntry, e error) error {
		if e != nil || entry.IsDir() {
			return e
		}
		if !listed[name] {
			return fmt.Errorf("backup contains %s, which its manifest does not list", name)
		}
		return nil
	})
	return m, err
}
