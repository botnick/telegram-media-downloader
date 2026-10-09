package backup

import (
	"context"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"

	"github.com/botnick/telegram-media-downloader/core-service/internal/filepublish"
)

// RecoveryInfo carries the non-secret parameters required alongside a saved
// passphrase. TGDB v1 does not embed the per-destination PBKDF2 salt in the file.
type RecoveryInfo struct {
	Format        string `json:"format"`
	Version       int    `json:"version"`
	KDF           string `json:"kdf"`
	Iterations    int    `json:"iterations"`
	SaltHex       string `json:"saltHex"`
	DestinationID int64  `json:"destinationId"`
}

func (m *Manager) RecoveryInfo(ctx context.Context, id int64) (RecoveryInfo, error) {
	d, err := m.load(ctx, id)
	if err != nil {
		return RecoveryInfo{}, err
	}
	if len(d.Salt) < 8 {
		return RecoveryInfo{}, errors.New("destination has no backup encryption salt")
	}
	return RecoveryInfo{"TGDB", 1, "PBKDF2-HMAC-SHA256", 200000, hex.EncodeToString(d.Salt), id}, nil
}

// DecryptFile authenticates an entire TGDB v1 payload before publishing any
// output. The target must not exist. Authentication failures discard the private
// temporary plaintext without exposing it to a parser or to the final filename.
func DecryptFile(ctx context.Context, input, output, passphrase string, salt []byte) error {
	key, err := payloadKey(passphrase, salt)
	if err != nil {
		return err
	}
	defer clear(key)
	return decryptFileKey(ctx, input, output, key)
}

func decryptFileKey(ctx context.Context, input, output string, key []byte) error {
	src, err := os.Open(input)
	if err != nil {
		return err
	}
	defer src.Close()
	info, err := src.Stat()
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return errors.New("backup input is not a regular file")
	}
	output = filepath.Clean(output)
	parent := filepath.Dir(output)
	name := filepath.Base(output)
	if name == "." || name == ".." || name == string(filepath.Separator) {
		return errors.New("invalid output filename")
	}
	root, err := os.OpenRoot(parent)
	if err != nil {
		return err
	}
	defer root.Close()
	if _, err = root.Lstat(name); err == nil {
		return os.ErrExist
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	temp, err := randomSFTPName(".tgdb-restore-")
	if err != nil {
		return err
	}
	out, err := root.OpenFile(temp, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	defer root.Remove(temp)
	defer out.Close()
	if err = decryptPayload(ctx, out, src, info.Size(), key); err != nil {
		return err
	}
	if err = out.Sync(); err != nil {
		return err
	}
	if err = out.Close(); err != nil {
		return err
	}
	if err = ctx.Err(); err != nil {
		return err
	}
	// Refuse even a target created after Lstat; both names use the open root.
	dir, err := root.Open(".")
	if err != nil {
		return err
	}
	defer dir.Close()
	return filepublish.ExclusiveAt(dir, temp, name)
}
