// Package session converts the encrypted gramJS session format used by
// telegram-media-downloader into gotd's on-disk session representation.
package session

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/subtle"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"strconv"

	"github.com/gotd/td/crypto"
	gotdSession "github.com/gotd/td/session"
	"golang.org/x/crypto/scrypt"
)

var legacySalt = []byte("tg-dl-salt-v1")

// GramJSData is the portion of a gramJS StringSession needed by gotd.
type GramJSData struct {
	DC        int
	Addr      string
	Port      int
	AuthKey   []byte
	AuthKeyID []byte
}

type secureBlob struct {
	Version int    `json:"v"`
	Salt    string `json:"salt"`
	IV      string `json:"iv"`
	Data    string `json:"data"`
	Tag     string `json:"tag"`
}

// DecryptSecureSession accepts v2 blobs and the v1/unversioned legacy format.
// The key derivation and 16-byte GCM nonce match src/core/security.js.
func DecryptSecureSession(raw []byte, password string) (string, error) {
	var blob secureBlob
	if err := json.Unmarshal(raw, &blob); err != nil {
		return "", fmt.Errorf("decode secure session: %w", err)
	}
	if blob.IV == "" || blob.Data == "" || blob.Tag == "" {
		return "", errors.New("secure session is missing iv, data, or tag")
	}
	salt := legacySalt
	if blob.Version < 0 || blob.Version > 2 {
		return "", errors.New("unsupported encrypted session version")
	}
	if blob.Version == 2 {
		if blob.Salt == "" {
			return "", errors.New("v2 secure session is missing salt")
		}
		var err error
		salt, err = hex.DecodeString(blob.Salt)
		if err != nil || len(salt) == 0 {
			return "", errors.New("secure session salt is not valid hex")
		}
	}
	iv, err := hex.DecodeString(blob.IV)
	if err != nil || len(iv) != 16 {
		return "", errors.New("secure session iv must be 16 bytes")
	}
	ciphertext, err := hex.DecodeString(blob.Data)
	if err != nil {
		return "", fmt.Errorf("secure session ciphertext: %w", err)
	}
	tag, err := hex.DecodeString(blob.Tag)
	if err != nil || len(tag) != 16 {
		return "", errors.New("secure session tag must be 16 bytes")
	}
	key, err := scrypt.Key([]byte(password), salt, 1<<14, 8, 1, 32)
	if err != nil {
		return "", fmt.Errorf("derive secure session key: %w", err)
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", fmt.Errorf("create secure session cipher: %w", err)
	}
	gcm, err := cipher.NewGCMWithNonceSize(block, len(iv))
	if err != nil {
		return "", fmt.Errorf("create secure session gcm: %w", err)
	}
	plain, err := gcm.Open(nil, iv, append(ciphertext, tag...), nil)
	if err != nil {
		return "", errors.New("secure session authentication failed")
	}
	return string(plain), nil
}

// ParseGramJSStringSession parses gramJS's StringSession wire format. Both
// the normal address-length form and Telethon's IPv4-compatible 352-byte form
// are accepted because old installations may contain either.
func ParseGramJSStringSession(value string) (GramJSData, error) {
	if len(value) < 2 || value[0] != '1' {
		return GramJSData{}, errors.New("unsupported gramJS session version")
	}
	raw, err := base64.StdEncoding.DecodeString(value[1:])
	if err != nil {
		return GramJSData{}, fmt.Errorf("decode gramJS session: %w", err)
	}
	if len(raw) < 1+2+2+256 {
		return GramJSData{}, errors.New("gramJS session is truncated")
	}
	dc := int(raw[0])
	if dc == 0 {
		return GramJSData{}, errors.New("invalid Telegram datacenter")
	}
	offset := 1
	var address string
	addressLen := int(binary.BigEndian.Uint16(raw[1:3]))
	if addressLen > 0 && addressLen <= 128 && 3+addressLen+2+256 == len(raw) {
		offset += 2
		address = string(raw[offset : offset+addressLen])
		offset += addressLen
	} else if len(raw) == 1+4+2+256 || len(raw) == 1+16+2+256 {
		ipLen := len(raw) - 1 - 2 - 256
		address = net.IP(raw[offset : offset+ipLen]).String()
		offset += ipLen
	} else {
		return GramJSData{}, errors.New("gramJS session has an invalid server address")
	}
	if net.ParseIP(address) == nil {
		return GramJSData{}, errors.New("Telegram session address must be an IP address")
	}
	port := int(binary.BigEndian.Uint16(raw[offset : offset+2]))
	offset += 2
	if port <= 0 || port > 65535 || offset+256 != len(raw) {
		return GramJSData{}, errors.New("gramJS session has an invalid port or auth key")
	}
	key := append([]byte(nil), raw[offset:]...)
	var auth crypto.Key
	copy(auth[:], key)
	id := auth.ID()
	return GramJSData{DC: dc, Addr: net.JoinHostPort(address, strconv.Itoa(port)), Port: port, AuthKey: key, AuthKeyID: append([]byte(nil), id[:]...)}, nil
}

// LoadEncrypted reads a .enc session and converts it without modifying the
// source file. secret is the contents of data/secret.key.
func LoadEncrypted(path, secret string) (GramJSData, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return GramJSData{}, fmt.Errorf("read encrypted Telegram session: %w", err)
	}
	plain, err := DecryptSecureSession(raw, secret)
	if err != nil {
		return GramJSData{}, err
	}
	return ParseGramJSStringSession(plain)
}

// WriteGotd persists an imported session in authenticated encrypted storage.
// The legacy source is only read during an explicit one-time import.
func WriteGotd(ctx context.Context, path, secret string, data GramJSData) error {
	if err := validate(data); err != nil {
		return err
	}
	storage, err := NewEncryptedStorage(path, secret)
	if err != nil {
		return err
	}
	loader := &gotdSession.Loader{Storage: storage}
	return loader.Save(ctx, &gotdSession.Data{DC: data.DC, Addr: data.Addr, AuthKey: data.AuthKey, AuthKeyID: data.AuthKeyID})
}

func validate(data GramJSData) error {
	if data.DC <= 0 {
		return errors.New("Telegram session DC must be positive")
	}
	if data.Addr == "" || data.Port <= 0 || data.Port > 65535 {
		return errors.New("Telegram session address is invalid")
	}
	if len(data.AuthKey) != 256 || len(data.AuthKeyID) != 8 {
		return errors.New("Telegram session auth key is invalid")
	}
	return nil
}

// EqualAuthKeyID is a constant-time comparison helper for tests and callers
// that need to verify a converted identity without exposing key material.
func EqualAuthKeyID(a, b []byte) bool {
	return len(a) == len(b) && subtle.ConstantTimeCompare(a, b) == 1
}
