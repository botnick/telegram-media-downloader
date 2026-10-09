package cluster

import (
	"context"
	"encoding/json"
	"strconv"
	"testing"
	"time"
)

func TestSocketAuthAndEventSignatures(t *testing.T) {
	s, close := testClusterStore(t, t.TempDir())
	defer close()
	ctx := context.Background()
	p, err := s.SaveOutbound(ctx, Handshake{PeerID: testPeerID, Name: "peer", URL: "http://peer.invalid", SharedSecret: testSecret}, testSecret)
	if err != nil {
		t.Fatal(err)
	}
	stamp := time.Now().UnixMilli()
	q := map[string]string{"peer": p.PeerID, "ts": strconv.FormatInt(stamp, 10), "sig": ConnectSignature(testSecret, stamp)}
	if _, err = s.VerifyConnect(ctx, q["peer"], q["ts"], q["sig"]); err != nil {
		t.Fatal(err)
	}
	if _, err = s.VerifyConnect(ctx, q["peer"], q["ts"], q["sig"]); err == nil {
		t.Fatal("connect replay accepted")
	}
	e := SocketEvent{Type: "download_updated", Timestamp: stamp, Payload: json.RawMessage(`{"id":1,"file_path":"a.bin"}`)}
	e.Signature = EventSignature(testSecret, e)
	if err = s.ApplySocketEvent(ctx, p, e); err != nil {
		t.Fatal(err)
	}
	var path string
	if err = s.Reader.QueryRow(`SELECT file_path FROM peer_downloads WHERE peer_id=? AND remote_id=1`, p.PeerID).Scan(&path); err != nil || path != "a.bin" {
		t.Fatal(path, err)
	}
	if err = s.ApplySocketEvent(ctx, p, e); err == nil {
		t.Fatal("event replay accepted")
	}
	e.Timestamp++
	e.Payload = json.RawMessage(`{"id":1,"file_path":"forged"}`)
	if err = s.ApplySocketEvent(ctx, p, e); err == nil {
		t.Fatal("tampering accepted")
	}
	e.Timestamp = time.Now().Add(-2 * time.Minute).UnixMilli()
	e.Signature = EventSignature(testSecret, e)
	if err = s.ApplySocketEvent(ctx, p, e); err == nil {
		t.Fatal("stale event accepted")
	}
	if _, err = s.Revoke(ctx, p.PeerID); err != nil {
		t.Fatal(err)
	}
	e.Timestamp = time.Now().UnixMilli() + 2
	e.Signature = EventSignature(testSecret, e)
	if err = s.ApplySocketEvent(ctx, p, e); err == nil {
		t.Fatal("revoked socket continued writing")
	}
}

func TestSocketSignatureUsesReleasedJSONValueEncoding(t *testing.T) {
	e := SocketEvent{Type: "catalog_changed", Timestamp: 1717200000123, Payload: json.RawMessage(`{ "10":"tenth", "2":"second", "text":"\u003cไทย\u003e\u2028", "number":1.0,"small":1e-07 }`)}
	// Frozen independently with Python over JS-style key order, strings/numbers.
	if got := EventSignature(testSecret, e); got != "786bb937ac87408017e66b5e687009869a30875ea288614e35c77965a398f146" {
		t.Fatal("JSON value signature", got)
	}
}

func TestSocketJSONValues(t *testing.T) {
	for _, tc := range []struct{ in, want string }{
		{`{"z":1,"01":2,"2":3,"1":4,"z":5}`, `{"1":4,"2":3,"z":5,"01":2}`},
		{`["\ud83d\ude00","\ud800","\uDC00","\u0001","\/","\"","\\"]`, `["😀","\ud800","\udc00","\u0001","/","\"","\\"]`},
		{`[1e-6,1e-7,1e20,1e21,-0,1.0,1e999]`, `[0.000001,1e-7,100000000000000000000,1e+21,0,1,null]`},
		{`1e999`, `null`}, {`null`, `{}`}, {`false`, `{}`}, {`-0.0`, `{}`}, {`""`, `{}`},
	} {
		t.Run(tc.in, func(t *testing.T) {
			got, err := socketJSON([]byte(tc.in))
			if err != nil || string(got) != tc.want {
				t.Fatalf("got %s err %v want %s", got, err, tc.want)
			}
		})
	}
}

func TestSocketReceiptAndVersionedCache(t *testing.T) {
	s, close := testClusterStore(t, t.TempDir())
	defer close()
	ctx := context.Background()
	p, err := s.SaveOutbound(ctx, Handshake{PeerID: testPeerID, Name: "peer", URL: "http://peer.invalid", SharedSecret: testSecret}, testSecret)
	if err != nil {
		t.Fatal(err)
	}
	e := SocketEvent{Type: "download_added", Timestamp: time.Now().UnixMilli(), Payload: json.RawMessage(`{"id":1,"file_path":"one.bin"}`)}
	e.Signature = EventSignature(testSecret, e)
	if _, err = s.Writer.Exec(`CREATE TRIGGER reject_socket BEFORE INSERT ON peer_downloads BEGIN SELECT RAISE(ABORT,'test cache fault'); END`); err != nil {
		t.Fatal(err)
	}
	if err = s.ApplySocketEvent(ctx, p, e); err == nil {
		t.Fatal("faulted cache write accepted")
	}
	if _, err = s.Writer.Exec(`DROP TRIGGER reject_socket`); err != nil {
		t.Fatal(err)
	}
	if err = s.ApplySocketEvent(ctx, p, e); err != nil {
		t.Fatal("failed write consumed replay receipt", err)
	}
	page := ChangePage{PeerID: p.PeerID, Epoch: testSecret, Head: 1, Next: 1, Reset: true, Changes: []Change{{Revision: 1, Type: "download_deleted", Payload: json.RawMessage(`{"remote_id":1}`)}}}
	if err = s.SaveChanges(ctx, p, SyncState{}, page); err != nil {
		t.Fatal(err)
	}
	e.Timestamp++
	e.Signature = EventSignature(testSecret, e)
	if err = s.ApplySocketEvent(ctx, p, e); err != nil {
		t.Fatal(err)
	}
	var n int
	if err = s.Reader.QueryRow(`SELECT count(*) FROM peer_downloads WHERE peer_id=?`, p.PeerID).Scan(&n); err != nil || n != 0 {
		t.Fatal("unversioned event resurrected deleted row", n, err)
	}
	for _, kind := range []string{"group_added", "group_changed", "group_removed", "config_changed", "failover_requested", "failover_completed"} {
		e.Type = kind
		e.Timestamp++
		e.Payload = json.RawMessage(`{}`)
		e.Signature = EventSignature(testSecret, e)
		if err = s.ApplySocketEvent(ctx, p, e); err == nil {
			t.Fatal("unsupported workflow reported success", kind)
		}
	}
}
