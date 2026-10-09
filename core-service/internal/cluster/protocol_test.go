package cluster

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/botnick/telegram-media-downloader/core-service/internal/store"
)

const testPeerID = "00000000-0000-4000-8000-0000000000a1"
const testSecret = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

func testClusterStore(t testing.TB, dir string) (Store, func()) {
	t.Helper()
	db, err := store.Open(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	s := Store{Writer: db.Writer, Reader: db.Reader}
	if err = s.Initialize(context.Background()); err != nil {
		t.Fatal(err)
	}
	return s, func() { db.Reader.Close(); db.Writer.Close() }
}
func signed(req SignedRequest, key string) SignedRequest {
	if req.Timestamp == "" {
		req.Timestamp = strconv.FormatInt(time.Now().UnixMilli(), 10)
	}
	stamp, _ := strconv.ParseInt(req.Timestamp, 10, 64)
	req.Signature = Signature(key, req.Method, req.Target, stamp, req.Body)
	return req
}
func handshakeRequest(t *testing.T, s Store, code, id string) (SignedRequest, Handshake) {
	t.Helper()
	h := Handshake{PeerID: id, Name: "remote", URL: "http://remote.invalid", SharedSecret: testSecret, PairingCode: code}
	body, err := json.Marshal(h)
	if err != nil {
		t.Fatal(err)
	}
	key := PairingKey(code)
	if code == "" {
		key, err = s.Token(context.Background())
		if err != nil {
			t.Fatal(err)
		}
	}
	return signed(SignedRequest{PeerID: id, Method: "POST", Target: "/api/cluster/handshake", Body: body}, key), h
}
func TestPeerSignatureCoversExactBytes(t *testing.T) {
	const stamp = 1717200000123
	const target = "/api/cluster/handshake?name=a%20b&x=2"
	body := []byte(`{ "id": 1 }`)
	sig := Signature(testSecret, "POST", target, stamp, body)
	// Independently calculated with Python hashlib/hmac over the frozen bytes.
	if sig != "9d85a6e1a051915f5b6dd54a9bf1c0c72022036fefd1ceff7fbc958157c67c6d" {
		t.Fatal("released wire signature differs", sig)
	}
	if !signatureMatches(testSecret, "POST", target, stamp, body, sig) {
		t.Fatal("signature rejected")
	}
	for _, mutate := range []struct {
		method, target string
		body           []byte
	}{{"GET", target, body}, {"POST", "/api/cluster/handshake?x=2&name=a%20b", body}, {"POST", target, []byte(`{"id":1}`)}} {
		if signatureMatches(testSecret, mutate.method, mutate.target, stamp, mutate.body, sig) {
			t.Fatal("mutation accepted")
		}
	}
	if signatureMatches(testSecret, "POST", target, stamp, body, sig+"00") {
		t.Fatal("overlong signature accepted")
	}
	for _, stamp := range []string{"9223372036854775807", "-9223372036854775808", "NaN", "1"} {
		if _, err := validateSigned(SignedRequest{PeerID: testPeerID, Timestamp: stamp, Signature: sig}, time.Now().UnixMilli()); err == nil {
			t.Fatal("invalid clock accepted", stamp)
		}
	}
}
func TestCodeConsumptionAndPeerSecretCommitTogether(t *testing.T) {
	s, close := testClusterStore(t, t.TempDir())
	defer close()
	ctx := context.Background()
	code, err := s.IssueCode(ctx)
	if err != nil {
		t.Fatal(err)
	}
	req, h := handshakeRequest(t, s, code.Code, testPeerID)
	if _, err = s.Writer.Exec(`CREATE TRIGGER reject_pair BEFORE INSERT ON peers BEGIN SELECT RAISE(ABORT,'injected'); END`); err != nil {
		t.Fatal(err)
	}
	if _, err = s.AcceptHandshake(ctx, req, h, "test"); err == nil {
		t.Fatal("failed peer write acknowledged")
	}
	if _, err = s.Writer.Exec(`DROP TRIGGER reject_pair`); err != nil {
		t.Fatal(err)
	}
	reply, err := s.AcceptHandshake(ctx, req, h, "test")
	if err != nil || reply.SharedSecretAck != testSecret {
		t.Fatal(reply, err)
	}
	p, err := s.Peer(ctx, testPeerID)
	if err != nil || string(p.Secret) != testSecret {
		t.Fatal(p, err)
	}
	if _, err = s.AcceptHandshake(ctx, req, h, "test"); err == nil {
		t.Fatal("code consumed twice")
	}
	raw, err := json.Marshal(p)
	if err != nil || strings.Contains(string(raw), testSecret) {
		t.Fatal("secret escaped public peer", err)
	}
}
func TestConcurrentCodeHasExactlyOneWinner(t *testing.T) {
	s, close := testClusterStore(t, t.TempDir())
	defer close()
	ctx := context.Background()
	code, err := s.IssueCode(ctx)
	if err != nil {
		t.Fatal(err)
	}
	req, h := handshakeRequest(t, s, code.Code, testPeerID)
	var winners atomic.Int64
	var wg sync.WaitGroup
	for range 16 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := s.AcceptHandshake(ctx, req, h, "test"); err == nil {
				winners.Add(1)
			}
		}()
	}
	wg.Wait()
	if winners.Load() != 1 {
		t.Fatal("winners", winners.Load())
	}
}
func TestReplaySurvivesRestartAndRevokedPeerCannotAuthenticate(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "data")
	s, close := testClusterStore(t, dir)
	ctx := context.Background()
	req, h := handshakeRequest(t, s, "", testPeerID)
	if _, err := s.AcceptHandshake(ctx, req, h, "test"); err != nil {
		close()
		t.Fatal(err)
	}
	request := signed(SignedRequest{PeerID: testPeerID, Method: "GET", Target: "/api/cluster/health"}, testSecret)
	if _, err := s.Verify(ctx, request); err != nil {
		close()
		t.Fatal(err)
	}
	close()
	s, close = testClusterStore(t, dir)
	defer close()
	if _, err := s.Verify(ctx, request); !errors.Is(err, AuthError("replay")) {
		t.Fatal("replay after restart", err)
	}
	token, err := s.Token(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.Verify(ctx, signed(request, token)); !errors.Is(err, AuthError("bad_signature")) {
		t.Fatal("bootstrap token used as pair key", err)
	}
	if _, err = s.Revoke(ctx, testPeerID); err != nil {
		t.Fatal(err)
	}
	if _, err = s.Verify(ctx, request); !errors.Is(err, AuthError("no_secret")) {
		t.Fatal("revoked peer accepted", err)
	}
}
func TestHandshakeIdentityAndCodeKeyCannotBeSubstituted(t *testing.T) {
	s, close := testClusterStore(t, t.TempDir())
	defer close()
	ctx := context.Background()
	code, err := s.IssueCode(ctx)
	if err != nil {
		t.Fatal(err)
	}
	req, h := handshakeRequest(t, s, code.Code, testPeerID)
	other := req
	other.PeerID = "00000000-0000-4000-8000-0000000000b2"
	if _, err = s.AcceptHandshake(ctx, other, h, "test"); !errors.Is(err, AuthError("peer_id_mismatch")) {
		t.Fatal(err)
	}
	token, err := s.Token(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.AcceptHandshake(ctx, signed(req, token), h, "test"); !errors.Is(err, AuthError("bad_signature")) {
		t.Fatal("code gate fell back to token", err)
	}
	if _, err = s.AcceptHandshake(ctx, req, h, "test"); err != nil {
		t.Fatal("failed attempts consumed code", err)
	}
}
