package session

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync"

	gotdSession "github.com/gotd/td/session"
	"golang.org/x/crypto/scrypt"
)

const nativeFormat = "tgdl-gotd-session-v1"
const maxSessionSize = 4 << 20

type nativeEnvelope struct {
	Format     string `json:"format"`
	Salt       []byte `json:"salt"`
	Nonce      []byte `json:"nonce"`
	Ciphertext []byte `json:"ciphertext"`
}

// EncryptedStorage implements gotd session.Storage. Native auth keys are
// encrypted at rest; a bad envelope or wrong secret is an error, never a
// request to silently create a new authorization or reload an old session.
type EncryptedStorage struct {
	path   string
	secret string
	mu     sync.Mutex
}

func NewEncryptedStorage(path, secret string) (*EncryptedStorage, error) {
	if path == "" || secret == "" {
		return nil, errors.New("session path and encryption secret are required")
	}
	return &EncryptedStorage{path: path, secret: secret}, nil
}

func nativeCipher(secret string, salt []byte) (cipher.AEAD, error) {
	key, err := scrypt.Key([]byte(secret), salt, 1<<14, 8, 1, 32)
	if err != nil {
		return nil, err
	}
	defer clear(key)
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}

func (s *EncryptedStorage) LoadSession(ctx context.Context) ([]byte, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	f, err := os.Open(s.path)
	if os.IsNotExist(err) {
		return nil, gotdSession.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	defer f.Close()
	raw, err := io.ReadAll(io.LimitReader(f, maxSessionSize+1))
	if err != nil {
		return nil, err
	}
	if len(raw) > maxSessionSize {
		return nil, errors.New("native Telegram session exceeds size limit")
	}
	var envelope nativeEnvelope
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return nil, errors.New("invalid native Telegram session envelope")
	}
	if envelope.Format != nativeFormat || len(envelope.Salt) != 16 || len(envelope.Nonce) != 12 || len(envelope.Ciphertext) < 16 {
		return nil, errors.New("invalid native Telegram session format")
	}
	aead, err := nativeCipher(s.secret, envelope.Salt)
	if err != nil {
		return nil, err
	}
	plain, err := aead.Open(nil, envelope.Nonce, envelope.Ciphertext, []byte(nativeFormat))
	if err != nil {
		return nil, errors.New("native Telegram session authentication failed")
	}
	if err := ctx.Err(); err != nil {
		clear(plain)
		return nil, err
	}
	return plain, nil
}

func (s *EncryptedStorage) StoreSession(ctx context.Context, plain []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return err
	}
	if len(plain) == 0 || len(plain) > maxSessionSize/2 {
		return errors.New("invalid native Telegram session size")
	}
	envelope := nativeEnvelope{Format: nativeFormat, Salt: make([]byte, 16), Nonce: make([]byte, 12)}
	if _, err := rand.Read(envelope.Salt); err != nil {
		return err
	}
	if _, err := rand.Read(envelope.Nonce); err != nil {
		return err
	}
	aead, err := nativeCipher(s.secret, envelope.Salt)
	if err != nil {
		return err
	}
	envelope.Ciphertext = aead.Seal(nil, envelope.Nonce, plain, []byte(nativeFormat))
	raw, err := json.Marshal(envelope)
	if err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(s.path), 0700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(s.path), ".tgdl-session-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	defer tmp.Close()
	if _, err := tmp.Write(raw); err != nil {
		return err
	}
	if err := tmp.Sync(); err != nil {
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := os.Rename(tmp.Name(), s.path); err != nil {
		return fmt.Errorf("publish encrypted session: %w", err)
	}
	return nil
}

var _ gotdSession.Storage = (*EncryptedStorage)(nil)
