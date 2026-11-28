package backup

import (
	"bytes"
	"context"
	"crypto/rand"
	"database/sql"
	"errors"
	"io"
	"os"
	"time"
	"unicode/utf8"
)

// A full backup file is one self-contained encrypted file:
//
//	"TGDLFULL" | version 0x01 | salt length (1 byte) | salt | TGDB v1 payload
//
// The payload is the state archive (tar.gz with a manifest), encrypted with
// a key derived from the user's passphrase and the salt in the header, so a
// passphrase alone restores it on any machine.
var fullMagic = []byte("TGDLFULL")

const (
	fullVersion       = 1
	fullSaltSize      = 32
	MinFullPassphrase = 8
	FullBackupExt     = ".tgdl-backup"
)

// Errors a restore reports to the dashboard by code.
var (
	ErrWrongPassphrase = errors.New("wrong backup password, or the file is damaged")
	ErrNotFullBackup   = errors.New("this is not a tgdl full backup file")
	ErrNewerBackup     = errors.New("this backup was made by a newer version; update the app first")
)

// FullBackupOptions builds a full backup.
type FullBackupOptions struct {
	DB            *sql.DB
	DataDir       string
	AppVersion    string
	SchemaVersion int
	Passphrase    string
	// Lock serialises with other snapshot writers when set.
	Lock func() func()
}

func checkPassphrase(p string) error {
	if utf8.RuneCountInString(p) < MinFullPassphrase {
		return errors.New("the backup password must have at least 8 characters")
	}
	if len(p) > 1024 {
		return errors.New("the backup password is too long")
	}
	return nil
}

// BuildFullBackup writes an encrypted full backup into dir and returns its
// path. The caller removes the file once it has been delivered.
func BuildFullBackup(ctx context.Context, dir string, opts FullBackupOptions) (string, Manifest, error) {
	var manifest Manifest
	if err := checkPassphrase(opts.Passphrase); err != nil {
		return "", manifest, err
	}
	if err := os.MkdirAll(dir, 0700); err != nil {
		return "", manifest, err
	}
	if opts.Lock != nil {
		defer opts.Lock()()
	}
	plain, err := os.CreateTemp(dir, ".full-archive-")
	if err != nil {
		return "", manifest, err
	}
	defer os.Remove(plain.Name())
	defer plain.Close()
	manifest = Manifest{Format: manifestFormat, Version: 1, AppVersion: opts.AppVersion, SchemaVersion: opts.SchemaVersion, CreatedAt: time.Now().UTC().Truncate(time.Second)}
	if _, err = writeStateArchive(ctx, opts.DB, opts.DataDir, dir, plain, &manifest); err != nil {
		return "", manifest, err
	}
	size, err := plain.Seek(0, io.SeekCurrent)
	if err != nil {
		return "", manifest, err
	}
	if _, err = plain.Seek(0, io.SeekStart); err != nil {
		return "", manifest, err
	}
	salt := make([]byte, fullSaltSize)
	if _, err = rand.Read(salt); err != nil {
		return "", manifest, err
	}
	key, err := payloadKey(opts.Passphrase, salt)
	if err != nil {
		return "", manifest, err
	}
	defer clear(key)
	out, err := os.CreateTemp(dir, ".full-backup-")
	if err != nil {
		return "", manifest, err
	}
	keep := false
	defer func() {
		out.Close()
		if !keep {
			os.Remove(out.Name())
		}
	}()
	header := append(append(append([]byte{}, fullMagic...), fullVersion, byte(len(salt))), salt...)
	if _, err = out.Write(header); err != nil {
		return "", manifest, err
	}
	if err = encryptPayload(ctx, out, plain, size, key); err != nil {
		return "", manifest, err
	}
	if err = out.Sync(); err != nil {
		return "", manifest, err
	}
	keep = true
	return out.Name(), manifest, out.Close()
}

// readFullHeader returns the salt and the payload offset of a full backup.
func readFullHeader(path string) ([]byte, int64, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, 0, err
	}
	defer f.Close()
	head := make([]byte, len(fullMagic)+2)
	if _, err = io.ReadFull(f, head); err != nil || !bytes.Equal(head[:len(fullMagic)], fullMagic) {
		return nil, 0, ErrNotFullBackup
	}
	if head[len(fullMagic)] != fullVersion {
		return nil, 0, ErrNewerBackup
	}
	n := int(head[len(fullMagic)+1])
	if n < 16 {
		return nil, 0, errors.New("invalid full backup header")
	}
	salt := make([]byte, n)
	if _, err = io.ReadFull(f, salt); err != nil {
		return nil, 0, errors.New("invalid full backup header")
	}
	return salt, int64(len(head) + n), nil
}

// RestoreFullBackup decrypts, extracts and verifies a full backup into
// output, which must not exist. A wrong password fails authentication
// before anything is extracted.
func RestoreFullBackup(ctx context.Context, input, output, passphrase string, maxSchema int) (RestoreResult, error) {
	if passphrase == "" {
		return RestoreResult{}, errors.New("enter the backup password")
	}
	salt, offset, err := readFullHeader(input)
	if err != nil {
		return RestoreResult{}, err
	}
	return RestoreSnapshot(ctx, input, output, RestoreOptions{Passphrase: passphrase, Salt: salt, Offset: offset, Manifest: true, MaxSchema: maxSchema})
}

// IsWrongPassphrase reports a payload authentication failure, which is what
// a wrong backup password produces.
func IsWrongPassphrase(err error) bool {
	return errors.Is(err, errPayloadAuth)
}
