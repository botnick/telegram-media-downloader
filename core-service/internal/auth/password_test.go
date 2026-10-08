package auth

import (
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
