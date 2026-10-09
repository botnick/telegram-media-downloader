package backup

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/json"
	"errors"

	"golang.org/x/crypto/pbkdf2"
)

// TGDC v1 is the existing credential format. Keep the salt, cost and layout
// byte compatible so a migrated database needs no plaintext export.
func credentialKey(secret []byte) ([]byte, error) {
	if len(secret) != 32 {
		return nil, errors.New("share secret not initialised")
	}
	salt := make([]byte, 16)
	copy(salt, "tgdl-cred-v1")
	return pbkdf2.Key(secret, salt, 200000, 32, sha256.New), nil
}
func sealConfig(config map[string]any, secret []byte) ([]byte, error) {
	key, err := credentialKey(secret)
	if err != nil {
		return nil, err
	}
	defer clear(key)
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	plain, err := json.Marshal(config)
	if err != nil {
		return nil, err
	}
	defer clear(plain)
	blob := make([]byte, 17)
	copy(blob, "TGDC\x01")
	if _, err = rand.Read(blob[5:]); err != nil {
		return nil, err
	}
	return aead.Seal(blob, blob[5:17], plain, nil), nil
}
func openConfig(blob, secret []byte) (map[string]any, error) {
	if len(blob) < 33 || string(blob[:5]) != "TGDC\x01" {
		return nil, errors.New("invalid TGDC credentials")
	}
	key, err := credentialKey(secret)
	if err != nil {
		return nil, err
	}
	defer clear(key)
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	plain, err := aead.Open(nil, blob[5:17], blob[17:], nil)
	if err != nil {
		return nil, errors.New("credentials no longer decryptable, please re-enter")
	}
	defer clear(plain)
	var out map[string]any
	err = json.Unmarshal(plain, &out)
	if out == nil && err == nil {
		err = errors.New("invalid credential object")
	}
	return out, err
}
func payloadKey(passphrase string, salt []byte) ([]byte, error) {
	if passphrase == "" {
		return nil, errors.New("passphrase required")
	}
	if len(salt) < 8 {
		return nil, errors.New("invalid encryption salt")
	}
	return pbkdf2.Key([]byte(passphrase), salt, 200000, 32, sha256.New), nil
}
