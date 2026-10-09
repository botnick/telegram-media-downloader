package backup

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/subtle"
	"encoding/binary"
	"errors"
	"io"

	"github.com/ericlagergren/polyval"
)

const (
	payloadHeaderSize = 17
	payloadTagSize    = 16
	// NIST SP 800-38D 5.2.1.1: one GCM invocation is at most 2^39-256 bits.
	maxPayloadSize    int64 = (1<<32 - 2) * aes.BlockSize
	payloadBufferSize       = 64 << 10
)

// gcmPayload implements only the released TGDB v1 profile: AES-256, a 96-bit
// nonce, no AAD and a 128-bit tag. The block cipher/CTR are Go's primitives;
// polynomial multiplication is provided by polyval, using RFC 8452 Appendix A
// to convert GHASH. There is no new cipher or file-format construction here.
type gcmPayload struct {
	stream cipher.Stream
	mac    *polyval.Polyval
	mask   [16]byte
	buf    []byte
}

func newGCMPayload(key, nonce []byte) (*gcmPayload, error) {
	if len(key) != 32 || len(nonce) != 12 {
		return nil, errors.New("TGDB requires a 32-byte key and a 12-byte nonce")
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	var h, counter [16]byte
	block.Encrypt(h[:], h[:])
	// mulX_POLYVAL(ByteReverse(H)); reduction is branchless with respect to H.
	lo := binary.BigEndian.Uint64(h[8:])
	hi := binary.BigEndian.Uint64(h[:8])
	carry := hi >> 63
	hi = hi<<1 | lo>>63
	lo <<= 1
	lo ^= carry
	hi ^= (uint64(0) - carry) & 0xc200000000000000
	binary.LittleEndian.PutUint64(h[:8], lo)
	binary.LittleEndian.PutUint64(h[8:], hi)
	mac, err := polyval.New(h[:])
	clear(h[:])
	if err != nil {
		return nil, errors.New("TGDB authentication key is invalid")
	}
	p := &gcmPayload{mac: mac, buf: make([]byte, payloadBufferSize)}
	copy(counter[:12], nonce)
	counter[15] = 1
	block.Encrypt(p.mask[:], counter[:])
	counter[15] = 2
	// Below maxPayloadSize this counter never wraps its low 32 bits, so the
	// standard 128-bit CTR increment matches GCM's inc32 for every used block.
	p.stream = cipher.NewCTR(block, counter[:])
	return p, nil
}

func reversePayloadBlocks(b []byte) {
	for len(b) >= 16 {
		lo, hi := binary.BigEndian.Uint64(b[:8]), binary.BigEndian.Uint64(b[8:16])
		binary.LittleEndian.PutUint64(b[:8], hi)
		binary.LittleEndian.PutUint64(b[8:16], lo)
		b = b[16:]
	}
}

// auth consumes full blocks, except for the final padded block. The caller
// supplies a reusable buffer whose capacity includes that padding.
func (p *gcmPayload) auth(b []byte) {
	n := len(b)
	if n%16 != 0 {
		b = b[:n+16-n%16]
		clear(b[n:])
	}
	reversePayloadBlocks(b)
	p.mac.Update(b)
	reversePayloadBlocks(b)
}

func (p *gcmPayload) tag(size int64) [16]byte {
	var lengths, tag [16]byte
	binary.BigEndian.PutUint64(lengths[8:], uint64(size)*8)
	p.auth(lengths[:])
	p.mac.Sum(tag[:0])
	reversePayloadBlocks(tag[:])
	for i := range tag {
		tag[i] ^= p.mask[i]
	}
	return tag
}

func payloadWrite(w io.Writer, b []byte) error {
	n, err := w.Write(b)
	if err == nil && n != len(b) {
		err = io.ErrShortWrite
	}
	return err
}

func payloadSize(size int64) error {
	if size < 0 || size > maxPayloadSize {
		return errors.New("TGDB v1 plaintext size exceeds the AES-GCM limit (64 GiB minus 32 bytes)")
	}
	return nil
}

// encryptPayload emits TGDB v1 into a private staging file. The caller must
// discard partial output on error and publish only after successful completion.
func encryptPayload(ctx context.Context, dst io.Writer, src io.Reader, size int64, key []byte) error {
	if err := payloadSize(size); err != nil {
		return err
	}
	var header [payloadHeaderSize]byte
	copy(header[:], "TGDB\x01")
	if _, err := rand.Read(header[5:]); err != nil {
		return err
	}
	return encryptPayloadNonce(ctx, dst, src, size, key, header[:])
}

func encryptPayloadNonce(ctx context.Context, dst io.Writer, src io.Reader, size int64, key, header []byte) error {
	reader := &contextReader{ctx, src}
	if err := payloadSize(size); err != nil {
		return err
	}
	if len(header) != payloadHeaderSize || string(header[:5]) != "TGDB\x01" {
		return errors.New("invalid TGDB header")
	}
	p, err := newGCMPayload(key, header[5:])
	if err != nil {
		return err
	}
	defer clear(p.buf)
	if err = ctx.Err(); err != nil {
		return err
	}
	if err = payloadWrite(dst, header); err != nil {
		return err
	}
	for remaining := size; remaining > 0; {
		if err = ctx.Err(); err != nil {
			return err
		}
		b := p.buf[:min(remaining, int64(len(p.buf)))]
		if _, err = io.ReadFull(reader, b); err != nil {
			return err
		}
		p.stream.XORKeyStream(b, b)
		p.auth(b)
		if err = payloadWrite(dst, b); err != nil {
			return err
		}
		remaining -= int64(len(b))
	}
	var extra [1]byte
	if n, e := io.ReadFull(reader, extra[:]); n != 0 || e != io.EOF {
		if e != nil && e != io.EOF {
			return e
		}
		return errors.New("backup source size changed during encryption")
	}
	if err = ctx.Err(); err != nil {
		return err
	}
	tag := p.tag(size)
	return payloadWrite(dst, tag[:])
}

// decryptPayload writes UNAUTHENTICATED plaintext until the final tag succeeds.
// It is deliberately private: callers may ONLY pass a private temporary file,
// never a parser, network response, stdout, or final destination. Do not expose
// that file before this function returns nil; discard it on every error.
func decryptPayload(ctx context.Context, dst io.Writer, src io.Reader, size int64, key []byte) error {
	reader := &contextReader{ctx, src}
	if size < payloadHeaderSize+payloadTagSize {
		return errors.New("TGDB payload is truncated")
	}
	plainSize := size - payloadHeaderSize - payloadTagSize
	if err := payloadSize(plainSize); err != nil {
		return err
	}
	var header [payloadHeaderSize]byte
	if _, err := io.ReadFull(reader, header[:]); err != nil {
		return err
	}
	if string(header[:4]) != "TGDB" {
		return errors.New("not a TGDB payload")
	}
	if header[4] != 1 {
		return errors.New("unsupported TGDB payload version")
	}
	p, err := newGCMPayload(key, header[5:])
	if err != nil {
		return err
	}
	defer clear(p.buf)
	for remaining := plainSize; remaining > 0; {
		b := p.buf[:min(remaining, int64(len(p.buf)))]
		if _, err = io.ReadFull(reader, b); err != nil {
			return err
		}
		p.auth(b)
		p.stream.XORKeyStream(b, b)
		if err = payloadWrite(dst, b); err != nil {
			return err
		}
		remaining -= int64(len(b))
	}
	var expected [16]byte
	if _, err = io.ReadFull(reader, expected[:]); err != nil {
		return err
	}
	actual := p.tag(plainSize)
	if subtle.ConstantTimeCompare(actual[:], expected[:]) != 1 {
		return errors.New("incorrect backup key or corrupt TGDB payload")
	}
	var extra [1]byte
	if n, e := io.ReadFull(reader, extra[:]); n != 0 || e != io.EOF {
		if e != nil && e != io.EOF {
			return e
		}
		return errors.New("unexpected data after TGDB payload")
	}
	return ctx.Err()
}
