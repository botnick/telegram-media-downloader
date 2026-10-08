package auth

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"

	"golang.org/x/crypto/scrypt"
)

const (
	defaultScryptN      = 1 << 14
	defaultScryptR      = 8
	defaultScryptP      = 1
	defaultScryptKeyLen = 64
	passwordSaltLen     = 16
)

// PasswordHash is the JSON-compatible scrypt representation used by the
// existing web config. Salt and Hash contain raw bytes in Go and are encoded
// as hex at the config boundary.
type PasswordHash struct {
	Algo   string
	Salt   []byte
	Hash   []byte
	N      int
	R      int
	P      int
	KeyLen int
}

func HashPassword(password string) (PasswordHash, error) {
	if password == "" {
		return PasswordHash{}, errors.New("password must be non-empty")
	}
	salt := make([]byte, passwordSaltLen)
	if _, err := rand.Read(salt); err != nil {
		return PasswordHash{}, fmt.Errorf("generate password salt: %w", err)
	}
	hash, err := scrypt.Key([]byte(password), salt, defaultScryptN, defaultScryptR, defaultScryptP, defaultScryptKeyLen)
	if err != nil {
		return PasswordHash{}, fmt.Errorf("derive password hash: %w", err)
	}
	return PasswordHash{Algo: "scrypt", Salt: salt, Hash: hash, N: defaultScryptN, R: defaultScryptR, P: defaultScryptP, KeyLen: defaultScryptKeyLen}, nil
}

func VerifyPassword(password string, stored PasswordHash) bool {
	if stored.Algo != "scrypt" || len(stored.Salt) == 0 || len(stored.Hash) == 0 {
		return false
	}
	n, r, p := stored.N, stored.R, stored.P
	keyLen := stored.KeyLen
	if n <= 1 {
		n = defaultScryptN
	}
	if r <= 0 {
		r = defaultScryptR
	}
	if p <= 0 {
		p = defaultScryptP
	}
	if keyLen <= 0 {
		keyLen = len(stored.Hash)
	}
	candidate, err := scrypt.Key([]byte(password), stored.Salt, n, r, p, keyLen)
	if err != nil || len(candidate) != len(stored.Hash) {
		return false
	}
	return subtle.ConstantTimeCompare(candidate, stored.Hash) == 1
}

// PasswordHashJSON is the exact object shape persisted in kv['config'].
type PasswordHashJSON struct {
	Algo   string `json:"algo"`
	Salt   string `json:"salt"`
	Hash   string `json:"hash"`
	N      int    `json:"N"`
	R      int    `json:"r"`
	P      int    `json:"p"`
	KeyLen int    `json:"keylen"`
}

func (p PasswordHash) JSON() PasswordHashJSON {
	return PasswordHashJSON{Algo: p.Algo, Salt: hex.EncodeToString(p.Salt), Hash: hex.EncodeToString(p.Hash), N: p.N, R: p.R, P: p.P, KeyLen: p.KeyLen}
}

func PasswordHashFromJSON(p PasswordHashJSON) (PasswordHash, error) {
	if !strings.EqualFold(p.Algo, "scrypt") {
		return PasswordHash{}, errors.New("unsupported password hash algorithm")
	}
	salt, err := hex.DecodeString(p.Salt)
	if err != nil {
		return PasswordHash{}, fmt.Errorf("decode password salt: %w", err)
	}
	hash, err := hex.DecodeString(p.Hash)
	if err != nil {
		return PasswordHash{}, fmt.Errorf("decode password hash: %w", err)
	}
	return PasswordHash{Algo: "scrypt", Salt: salt, Hash: hash, N: p.N, R: p.R, P: p.P, KeyLen: p.KeyLen}, nil
}
