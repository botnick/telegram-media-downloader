package auth

import (
	"encoding/hex"
	"testing"

	"golang.org/x/crypto/scrypt"
)

func TestVerifyPasswordScrypt(t *testing.T) {
	salt := []byte("0123456789abcdef")
	hash, err := scrypt.Key([]byte("correct horse"), salt, 1<<14, 8, 1, 64)
	if err != nil {
		t.Fatal(err)
	}
	stored := PasswordHash{Algo: "scrypt", Salt: salt, Hash: hash, N: 1 << 14, R: 8, P: 1, KeyLen: 64}
	if !VerifyPassword("correct horse", stored) {
		t.Fatal("expected password to verify")
	}
	if VerifyPassword("wrong", stored) {
		t.Fatal("wrong password verified")
	}
}

func TestVerifyPasswordMatchesNodeScryptWireFixture(t *testing.T) {
	hash, err := hex.DecodeString("d0bba9c87933008803afd503b2b88001ff3bbcc6c26dc6947c3bc53801e4d03d23e450e6eb8dc0d37d5e4e0a170200ad07df75ece3c08b3454371f62b4e92610")
	if err != nil {
		t.Fatal(err)
	}
	if !VerifyPassword("correct horse", PasswordHash{Algo: "scrypt", Salt: []byte("0123456789abcdef"), Hash: hash, N: 16384, R: 8, P: 1, KeyLen: 64}) {
		t.Fatal("Node scrypt fixture did not verify")
	}
}
