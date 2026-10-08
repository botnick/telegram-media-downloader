// Package cluster contains the local security primitives for peer pairing and
// signed catalog calls. Network transport is deliberately outside this
// package so every caller verifies the same canonical bytes.
package cluster

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"strconv"
	"strings"
	"sync"
	"time"
)

type Request struct {
	Method    string
	Path      string
	Timestamp int64
	Nonce     string
	Body      []byte
}

type Signer struct {
	secret []byte
	window time.Duration
}

func NewSigner(secret []byte, window time.Duration) *Signer {
	if window <= 0 {
		window = 5 * time.Minute
	}
	copySecret := append([]byte(nil), secret...)
	return &Signer{secret: copySecret, window: window}
}

func (s *Signer) Sign(req Request) string {
	mac := hmac.New(sha256.New, s.secret)
	_, _ = mac.Write(canonical(req))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func (s *Signer) Verify(req Request, encoded string) bool {
	if len(s.secret) == 0 || strings.TrimSpace(encoded) == "" {
		return false
	}
	now := time.Now().Unix()
	if req.Timestamp <= 0 || time.Duration(absInt64(now-req.Timestamp))*time.Second > s.window {
		return false
	}
	provided, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil || len(provided) != sha256.Size {
		return false
	}
	expectedMac := hmac.New(sha256.New, s.secret)
	_, _ = expectedMac.Write(canonical(req))
	expected := expectedMac.Sum(nil)
	return subtle.ConstantTimeCompare(provided, expected) == 1
}

func canonical(req Request) []byte {
	hash := sha256.Sum256(req.Body)
	return []byte(strings.Join([]string{strings.ToUpper(strings.TrimSpace(req.Method)), req.Path, strconv.FormatInt(req.Timestamp, 10), req.Nonce, hex.EncodeToString(hash[:])}, "\n"))
}

func absInt64(value int64) int64 {
	if value < 0 {
		return -value
	}
	return value
}

type pairingCode struct {
	peer    string
	expires time.Time
}

type PairingStore struct {
	mu    sync.Mutex
	ttl   time.Duration
	codes map[string]pairingCode
}

func NewPairingStore(ttl time.Duration) *PairingStore {
	if ttl <= 0 {
		ttl = 10 * time.Minute
	}
	return &PairingStore{ttl: ttl, codes: make(map[string]pairingCode)}
}

func (p *PairingStore) Issue(peer string) (string, error) {
	if strings.TrimSpace(peer) == "" {
		return "", fmt.Errorf("peer is required")
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	p.pruneLocked(time.Now())
	for i := 0; i < 32; i++ {
		var raw [4]byte
		if _, err := rand.Read(raw[:]); err != nil {
			return "", err
		}
		random := (uint32(raw[0])<<24 | uint32(raw[1])<<16 | uint32(raw[2])<<8 | uint32(raw[3])) % 1000000
		code := fmt.Sprintf("%06d", random)
		if _, exists := p.codes[code]; exists {
			continue
		}
		p.codes[code] = pairingCode{peer: peer, expires: time.Now().Add(p.ttl)}
		return code, nil
	}
	return "", fmt.Errorf("could not allocate pairing code")
}

func (p *PairingStore) Consume(code string) (string, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	item, ok := p.codes[strings.TrimSpace(code)]
	if !ok || time.Now().After(item.expires) {
		delete(p.codes, strings.TrimSpace(code))
		return "", false
	}
	delete(p.codes, strings.TrimSpace(code))
	return item.peer, true
}

func (p *PairingStore) pruneLocked(now time.Time) {
	for code, item := range p.codes {
		if now.After(item.expires) {
			delete(p.codes, code)
		}
	}
}
