package cluster

import (
	"context"
	"errors"
	"testing"
)

func TestHealthAuditIsAtomicAndCannotReviveChangedPeer(t *testing.T) {
	s, close := testClusterStore(t, t.TempDir())
	defer close()
	ctx := context.Background()
	p, err := s.SaveOutbound(ctx, Handshake{PeerID: testPeerID, Name: "source", URL: "http://source.invalid", SharedSecret: testSecret}, testSecret)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.Writer.Exec(`UPDATE peers SET last_seen_at=42,status='online'; CREATE TRIGGER reject_health BEFORE INSERT ON cluster_audit WHEN NEW.kind='test' BEGIN SELECT RAISE(ABORT,'injected'); END`); err != nil {
		t.Fatal(err)
	}
	if err = s.RecordHealth(ctx, p, false, "test", "unreachable"); err == nil {
		t.Fatal("failed audit accepted")
	}
	after, err := s.Peer(ctx, p.PeerID)
	if err != nil || after.Status != "online" || after.LastSeenAt == nil || *after.LastSeenAt != 42 {
		t.Fatal(after, err)
	}
	if _, err = s.Writer.Exec(`DROP TRIGGER reject_health`); err != nil {
		t.Fatal(err)
	}
	if err = s.RecordHealth(ctx, p, false, "test", "unreachable"); err != nil {
		t.Fatal(err)
	}
	after, err = s.Peer(ctx, p.PeerID)
	if err != nil || after.Status != "offline" || after.LastSeenAt == nil || *after.LastSeenAt != 42 {
		t.Fatal(after, err)
	}
	if _, err = s.Update(ctx, p.PeerID, map[string]any{"url": "http://moved.invalid"}); err != nil {
		t.Fatal(err)
	}
	if err = s.RecordHealth(ctx, p, true, "test", ""); !errors.Is(err, ErrPeerChanged) {
		t.Fatal("stale probe accepted", err)
	}
	if _, err = s.Revoke(ctx, p.PeerID); err != nil {
		t.Fatal(err)
	}
	if err = s.RecordHealth(ctx, p, true, "test", ""); !errors.Is(err, ErrPeerChanged) {
		t.Fatal("revoked peer revived", err)
	}
}
