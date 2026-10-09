package cluster

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestSyncFailureIsPersistedAndReturned(t *testing.T) {
	for _, tc := range []struct {
		name, body string
		status     int
	}{
		{"offline", `unavailable`, 503},
		{"invalid_json", `{`, 200},
		{"missing_rows", `{"peerId":"` + testPeerID + `"}`, 200},
		{"wrong_peer", `{"peerId":"another","rows":[]}`, 200},
		{"nonadvancing_page", `{"peerId":"` + testPeerID + `","rows":[{"id":0,"file_path":"a.bin"}]}`, 200},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s, close := testClusterStore(t, t.TempDir())
			defer close()
			remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(tc.status)
				w.Write([]byte(tc.body))
			}))
			defer remote.Close()
			ctx := context.Background()
			p, err := s.SaveOutbound(ctx, Handshake{PeerID: testPeerID, Name: "source", URL: remote.URL, SharedSecret: testSecret}, testSecret)
			if err != nil {
				t.Fatal(err)
			}
			c := NewClient(s)
			defer c.Close()
			if n, err := c.SyncPeer(ctx, p); n != 0 || err == nil {
				t.Fatalf("failed sync reported success: rows=%d error=%v", n, err)
			}
			state, err := s.SyncState(ctx)
			if err != nil || state[p.PeerID].LastError == nil || state[p.PeerID].SinceID != nil {
				t.Fatal("failed page advanced or lost error", state, err)
			}
			p, err = s.Peer(ctx, p.PeerID)
			if err != nil || p.Status != "offline" {
				t.Fatal(p.Status, err)
			}
		})
	}
}

func TestCatalogPageAndCursorRollbackTogether(t *testing.T) {
	s, close := testClusterStore(t, t.TempDir())
	defer close()
	ctx := context.Background()
	p, err := s.SaveOutbound(ctx, Handshake{PeerID: testPeerID, Name: "source", URL: "http://source.invalid", SharedSecret: testSecret}, testSecret)
	if err != nil {
		t.Fatal(err)
	}
	path := "a.bin"
	rows := []CatalogRow{{ID: 1, FilePath: &path}, {ID: 2, FilePath: &path}}
	if _, err = s.Writer.Exec(`CREATE TRIGGER reject_second BEFORE INSERT ON peer_downloads WHEN NEW.remote_id=2 BEGIN SELECT RAISE(ABORT,'injected'); END`); err != nil {
		t.Fatal(err)
	}
	if _, err = s.SaveDelta(ctx, p, 0, rows); err == nil {
		t.Fatal("failed page committed")
	}
	var n int
	if err = s.Reader.QueryRow(`SELECT count(*) FROM peer_downloads`).Scan(&n); err != nil || n != 0 {
		t.Fatal("partial catalog", n, err)
	}
	state, err := s.SyncState(ctx)
	if err != nil || len(state) != 0 {
		t.Fatal("advanced failed cursor", state, err)
	}
	if _, err = s.Writer.Exec(`DROP TRIGGER reject_second`); err != nil {
		t.Fatal(err)
	}
	if next, err := s.SaveDelta(ctx, p, 0, rows); err != nil || next != 2 {
		t.Fatal(next, err)
	}
	if _, err = s.SaveDelta(ctx, p, 0, rows); err == nil {
		t.Fatal("stale page overwrote cursor")
	}
	if _, err = s.Revoke(ctx, p.PeerID); err != nil {
		t.Fatal(err)
	}
	if _, err = s.SaveDelta(ctx, p, 2, []CatalogRow{{ID: 3, FilePath: &path}}); !errors.Is(err, ErrPeerChanged) {
		t.Fatal("revoked peer resurrected", err)
	}
	if err = s.Reader.QueryRow(`SELECT count(*) FROM peer_downloads`).Scan(&n); err != nil || n != 0 {
		t.Fatal(n, err)
	}
}
func TestInvalidCatalogDoesNotAdvanceOrOverwrite(t *testing.T) {
	s, close := testClusterStore(t, t.TempDir())
	defer close()
	ctx := context.Background()
	p, err := s.SaveOutbound(ctx, Handshake{PeerID: testPeerID, Name: "source", URL: "http://source.invalid", SharedSecret: testSecret}, testSecret)
	if err != nil {
		t.Fatal(err)
	}
	path := "a.bin"
	badSize := int64(-1)
	for _, rows := range [][]CatalogRow{{{ID: 0, FilePath: &path}}, {{ID: 2, FilePath: &path}, {ID: 1, FilePath: &path}}, {{ID: 1}}, {{ID: 1, FilePath: &path, FileSize: &badSize}}} {
		if _, err = s.SaveDelta(ctx, p, 0, rows); err == nil {
			t.Fatal("invalid page accepted", rows)
		}
	}
	state, err := s.SyncState(ctx)
	if err != nil || len(state) != 0 {
		t.Fatal(state, err)
	}
	if _, err = s.Update(ctx, p.PeerID, map[string]any{"url": "http://moved.invalid"}); err != nil {
		t.Fatal(err)
	}
	if _, err = s.SaveDelta(ctx, p, 0, []CatalogRow{{ID: 1, FilePath: &path}}); !errors.Is(err, ErrPeerChanged) {
		t.Fatal("old endpoint page accepted", err)
	}
}
