package cluster

import (
	"testing"
	"time"
)

func TestSignerRoundTripAndExpiry(t *testing.T) {
	signer := NewSigner([]byte("shared-secret"), 30*time.Second)
	req := Request{Method: "POST", Path: "/v1/cluster/sync", Timestamp: time.Now().Unix(), Nonce: "abc", Body: []byte(`{"id":1}`)}
	sig := signer.Sign(req)
	if !signer.Verify(req, sig) {
		t.Fatal("valid signature did not verify")
	}
	req.Body = []byte(`{"id":2}`)
	if signer.Verify(req, sig) {
		t.Fatal("body mutation verified")
	}
	req.Timestamp -= 120
	if signer.Verify(req, sig) {
		t.Fatal("expired signature verified")
	}
}

func TestPairingCodesAreSingleUse(t *testing.T) {
	store := NewPairingStore(2 * time.Minute)
	code, err := store.Issue("peer-a")
	if err != nil {
		t.Fatal(err)
	}
	peer, ok := store.Consume(code)
	if !ok || peer != "peer-a" {
		t.Fatalf("consume = %q %v", peer, ok)
	}
	if _, ok := store.Consume(code); ok {
		t.Fatal("pairing code was reusable")
	}
}
