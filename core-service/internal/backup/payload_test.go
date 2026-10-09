package backup

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"testing"
)

type fragmentReader struct {
	io.Reader
	size int
}

func (r fragmentReader) Read(b []byte) (int, error) { return r.Reader.Read(b[:min(len(b), r.size)]) }

func TestTGDBMatchesStandardGCMForFragmentedAndBoundaryInputs(t *testing.T) {
	key := bytes.Repeat([]byte{0x7f}, 32)
	header := append([]byte("TGDB\x01"), bytes.Repeat([]byte{0x4f}, 12)...)
	block, _ := aes.NewCipher(key)
	aead, _ := cipher.NewGCM(block)
	for _, size := range []int{0, 1, 15, 16, 17, 31, 32, 33, 65535, 65536, 65537, 1 << 20} {
		for _, fragment := range []int{1, 7, 4093, 65536} {
			t.Run(fmt.Sprintf("%d/%d", size, fragment), func(t *testing.T) {
				plain := make([]byte, size)
				for i := range plain {
					plain[i] = byte(i*37 + 11)
				}
				expected := append(bytes.Clone(header), aead.Seal(nil, header[5:], plain, nil)...)
				var encrypted, restored bytes.Buffer
				if err := encryptPayloadNonce(context.Background(), &encrypted, fragmentReader{bytes.NewReader(plain), fragment}, int64(size), key, header); err != nil {
					t.Fatal(err)
				}
				if !bytes.Equal(encrypted.Bytes(), expected) {
					t.Fatal("streamed ciphertext/tag differs from Go AES-GCM")
				}
				if err := decryptPayload(context.Background(), &restored, fragmentReader{bytes.NewReader(expected), fragment}, int64(len(expected)), key); err != nil {
					t.Fatal(err)
				}
				if !bytes.Equal(restored.Bytes(), plain) {
					t.Fatal("decrypted bytes differ")
				}
			})
		}
	}
}

func TestTGDBAuthenticatesHeaderCiphertextLengthAndTag(t *testing.T) {
	key := bytes.Repeat([]byte{0x31}, 32)
	plain := []byte("private backup bytes")
	var b bytes.Buffer
	if err := encryptPayload(context.Background(), &b, bytes.NewReader(plain), int64(len(plain)), key); err != nil {
		t.Fatal(err)
	}
	valid := b.Bytes()
	for i := range valid {
		corrupt := bytes.Clone(valid)
		corrupt[i] ^= 1
		if err := decryptPayload(context.Background(), io.Discard, bytes.NewReader(corrupt), int64(len(corrupt)), key); err == nil {
			t.Fatalf("accepted mutation at %d", i)
		}
	}
	for i := 0; i < len(valid); i++ {
		if err := decryptPayload(context.Background(), io.Discard, bytes.NewReader(valid[:i]), int64(i), key); err == nil {
			t.Fatalf("accepted truncation at %d", i)
		}
	}
	for _, wrong := range [][]byte{nil, bytes.Repeat([]byte{0x32}, 32)} {
		if err := decryptPayload(context.Background(), io.Discard, bytes.NewReader(valid), int64(len(valid)), wrong); err == nil {
			t.Fatal("accepted wrong key")
		}
	}
	extra := append(bytes.Clone(valid), 0)
	if err := decryptPayload(context.Background(), io.Discard, bytes.NewReader(extra), int64(len(valid)), key); err == nil {
		t.Fatal("accepted trailing bytes")
	}
	var second bytes.Buffer
	if err := encryptPayload(context.Background(), &second, bytes.NewReader(plain), int64(len(plain)), key); err != nil {
		t.Fatal(err)
	}
	if bytes.Equal(valid, second.Bytes()) {
		t.Fatal("nonce repeated")
	}
}

func TestTGDBIndependentPythonVector(t *testing.T) {
	// Python cryptography AESGCM + PBKDF2HMAC(SHA256,200000), no AAD;
	// plaintext bytes(range(256))*257 + b'\x00tail\xff', nonce bytes(range(12)).
	salt := make([]byte, 16)
	for i := range salt {
		salt[i] = byte(i)
	}
	key, err := payloadKey("ทดสอบ backup", salt)
	if err != nil {
		t.Fatal(err)
	}
	if hex.EncodeToString(key) != "7f3b8cd9e4e5bc9ef119c800e9bc11b20e1a87a75ba772f8356f0fe2ddc2b795" {
		t.Fatal("PBKDF2 vector")
	}
	plain := make([]byte, 256*257)
	for i := range plain {
		plain[i] = byte(i)
	}
	plain = append(plain, 0, 't', 'a', 'i', 'l', 255)
	header := make([]byte, 17)
	copy(header, "TGDB\x01")
	for i := range 12 {
		header[i+5] = byte(i)
	}
	var out bytes.Buffer
	if err = encryptPayloadNonce(context.Background(), &out, bytes.NewReader(plain), int64(len(plain)), key, header); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(out.Bytes())
	if hex.EncodeToString(sum[:]) != "ff17e88022fefda43746f62ad94bb1bc2d5779393028dd61de2f47589bd0ccd3" {
		t.Fatalf("Python ciphertext differs: %x", sum)
	}
	if hex.EncodeToString(out.Bytes()[out.Len()-16:]) != "ff0d079abf7bde3ee4d2fa1a62dfdd54" {
		t.Fatal("Python tag differs")
	}
}

func TestTGDBReadsReleasedStreamFixture(t *testing.T) {
	// Generated once using src/core/backup/encryption.js encryptStream, in two
	// input fragments. The fixture remains usable after the old runtime is removed.
	blob, err := hex.DecodeString("544744420178224e3bf460483eb8d4badd8ebf985f6ab342cfba8508e377482571341ba32c2f62d4523cd82c9f785df864a2c8996c78bd65ee28dfa0a4e035e9787843406b1ecdf1fc67b5")
	if err != nil {
		t.Fatal(err)
	}
	key, err := payloadKey("legacy fixture pass", bytes.Repeat([]byte{0x42}, 16))
	if err != nil {
		t.Fatal(err)
	}
	var restored bytes.Buffer
	if err = decryptPayload(context.Background(), &restored, bytes.NewReader(blob), int64(len(blob)), key); err != nil {
		t.Fatal(err)
	}
	if restored.String() != "legacy streaming backup: ทดสอบ\x00\n" {
		t.Fatal("released stream bytes changed")
	}
}

type failingPayloadWriter struct{}

func (failingPayloadWriter) Write(b []byte) (int, error) { return len(b) - 1, nil }

func TestTGDBRejectsSizeChangesCancellationAndWriteFailure(t *testing.T) {
	key := bytes.Repeat([]byte{5}, 32)
	for _, size := range []int64{-1, maxPayloadSize + 1, 2, 4} {
		if err := encryptPayload(context.Background(), io.Discard, bytes.NewReader([]byte("abc")), size, key); err == nil {
			t.Fatalf("accepted source size %d", size)
		}
	}
	if err := encryptPayload(context.Background(), failingPayloadWriter{}, bytes.NewReader(nil), 0, key); !errors.Is(err, io.ErrShortWrite) {
		t.Fatalf("short write: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	var b bytes.Buffer
	if err := encryptPayload(ctx, &b, bytes.NewReader([]byte("abc")), 3, key); !errors.Is(err, context.Canceled) || b.Len() != 0 {
		t.Fatal("ignored cancellation", err)
	}
}

func FuzzTGDBMatchesStandardGCM(f *testing.F) {
	f.Add([]byte("sample"), byte(7))
	f.Add([]byte{}, byte(1))
	f.Fuzz(func(t *testing.T, plain []byte, fragment byte) {
		if len(plain) > 1<<20 {
			t.Skip()
		}
		key := sha256.Sum256(plain)
		nonce := sha256.Sum256(key[:])
		header := append([]byte("TGDB\x01"), nonce[:12]...)
		block, _ := aes.NewCipher(key[:])
		aead, _ := cipher.NewGCM(block)
		expected := append(bytes.Clone(header), aead.Seal(nil, header[5:], plain, nil)...)
		var out bytes.Buffer
		if err := encryptPayloadNonce(context.Background(), &out, fragmentReader{bytes.NewReader(plain), int(fragment) + 1}, int64(len(plain)), key[:], header); err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(out.Bytes(), expected) {
			t.Fatal("GCM mismatch")
		}
		var restored bytes.Buffer
		if err := decryptPayload(context.Background(), &restored, fragmentReader{bytes.NewReader(expected), int(fragment) + 1}, int64(len(expected)), key[:]); err != nil || !bytes.Equal(restored.Bytes(), plain) {
			t.Fatal("GCM decryption mismatch", err)
		}
	})
}

func BenchmarkTGDBEncryption(b *testing.B) {
	key, _ := hex.DecodeString("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f")
	for _, size := range []int{1 << 20, 64 << 20} {
		b.Run(fmt.Sprintf("%dMiB", size>>20), func(b *testing.B) {
			data := bytes.Repeat([]byte{0xa5}, size)
			b.SetBytes(int64(size))
			b.ReportAllocs()
			b.ResetTimer()
			for range b.N {
				if err := encryptPayload(context.Background(), io.Discard, bytes.NewReader(data), int64(size), key); err != nil {
					b.Fatal(err)
				}
			}
		})
	}
}
