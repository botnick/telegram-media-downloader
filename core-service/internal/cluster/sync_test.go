package cluster

import (
	"context"
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
		{"missing_changes", `{"peerId":"` + testPeerID + `"}`, 200},
		{"wrong_peer", `{"peerId":"another","changes":[]}`, 200},
		{"nonadvancing_page", `{"peerId":"` + testPeerID + `","epoch":"` + testSecret + `","reset":true,"head":1,"next":1,"changes":[{"revision":0,"type":"download_added","payload":{"id":1,"file_path":"a.bin"}}]}`, 200},
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
			if n, err := c.SyncPeer(ctx, p); n.Rows != 0 || err == nil {
				t.Fatalf("failed sync reported success: result=%+v error=%v", n, err)
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
