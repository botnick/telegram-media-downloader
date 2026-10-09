package app

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/botnick/telegram-media-downloader/core-service/internal/cluster"
	"github.com/gorilla/websocket"
)

func TestClusterLiveCatalogConvergesAndRevocationCloses(t *testing.T) {
	a, as := socketTestApp(t)
	b, bs := socketTestApp(t)
	ctx := context.Background()
	aid, _ := a.cluster.Identity(ctx)
	bid, _ := b.cluster.Identity(ctx)
	secret := strings.Repeat("cd", 32)
	if _, err := a.cluster.SaveOutbound(ctx, cluster.Handshake{PeerID: bid.PeerID, Name: "b", URL: bs.URL, SharedSecret: secret}, secret); err != nil {
		t.Fatal(err)
	}
	if _, err := b.cluster.SaveOutbound(ctx, cluster.Handshake{PeerID: aid.PeerID, Name: "a", URL: as.URL, SharedSecret: secret}, secret); err != nil {
		t.Fatal(err)
	}
	if _, err := b.db.Writer.Exec(`INSERT INTO downloads(group_id,message_id,file_path,file_name) VALUES('live',1,'live.bin','before')`); err != nil {
		t.Fatal(err)
	}
	waitClusterRow(t, a, bid.PeerID, "before", 1)
	if _, err := b.db.Writer.Exec(`UPDATE downloads SET file_name='after' WHERE group_id='live'`); err != nil {
		t.Fatal(err)
	}
	waitClusterRow(t, a, bid.PeerID, "after", 1)
	if _, err := b.db.Writer.Exec(`DELETE FROM downloads WHERE group_id='live'`); err != nil {
		t.Fatal(err)
	}
	waitClusterRow(t, a, bid.PeerID, "", 0)
	p, err := a.cluster.Peer(ctx, bid.PeerID)
	if err != nil {
		t.Fatal(err)
	}
	url, err := a.clusterHTTP.SocketURL(ctx, p)
	if err != nil {
		t.Fatal(err)
	}
	conn, res, err := websocket.DefaultDialer.Dial(url, nil)
	if res != nil && res.Body != nil {
		res.Body.Close()
	}
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if _, err = b.cluster.Revoke(ctx, aid.PeerID); err != nil {
		t.Fatal(err)
	}
	conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	for {
		if _, _, err = conn.ReadMessage(); err != nil {
			break
		}
	}
	if e, ok := err.(interface{ Timeout() bool }); ok && e.Timeout() {
		t.Fatal("revoked socket stayed open")
	}
}
func waitClusterRow(t *testing.T, a *App, peer, name string, count int) {
	t.Helper()
	deadline := time.Now().Add(8 * time.Second)
	for time.Now().Before(deadline) {
		var n int
		var got string
		err := a.db.Reader.QueryRow(`SELECT count(*),COALESCE(MAX(file_name),'') FROM peer_downloads WHERE peer_id=?`, peer).Scan(&n, &got)
		if err == nil && n == count && (count == 0 || got == name) {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("live peer row did not converge to count=%d name=%q", count, name)
}

func TestClusterSocketRejectsUnsignedBeforeDashboardSetup(t *testing.T) {
	a, err := New(context.Background(), Config{DataDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	s := httptest.NewServer(a.Handler())
	defer s.Close()
	c, r, err := websocket.DefaultDialer.Dial(strings.Replace(s.URL, "http", "ws", 1)+"/ws/cluster", nil)
	if c != nil {
		c.Close()
	}
	if r != nil {
		defer r.Body.Close()
	}
	if err == nil || r == nil || r.StatusCode != 401 {
		t.Fatal("unsigned peer auth bypass", r, err)
	}
}

func TestClusterShutdownInterruptsSilentHandshake(t *testing.T) {
	entered := make(chan struct{}, 1)
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/ws/cluster" {
			w.WriteHeader(404)
			return
		}
		select {
		case entered <- struct{}{}:
		default:
		}
		<-r.Context().Done()
	}))
	defer remote.Close()
	a, _ := socketTestApp(t)
	secret := strings.Repeat("ab", 32)
	_, err := a.cluster.SaveOutbound(context.Background(), cluster.Handshake{PeerID: "00000000-0000-4000-8000-0000000000a1", Name: "silent", URL: remote.URL, SharedSecret: secret}, secret)
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("outbound handshake never started")
	}
	done := make(chan error, 1)
	go func() { done <- a.Close() }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(2 * time.Second):
		t.Error("shutdown did not interrupt silent peer handshake")
		<-done
	}
}

func TestClusterEmptyResetNotifiesDashboard(t *testing.T) {
	a, _ := socketTestApp(t)
	const id = "00000000-0000-4000-8000-0000000000a1"
	secret := strings.Repeat("ab", 32)
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/cluster/catalog/changes" {
			w.WriteHeader(404)
			return
		}
		writeJSON(w, 200, cluster.ChangePage{PeerID: id, Epoch: secret, Reset: true, Changes: []cluster.Change{}})
	}))
	defer remote.Close()
	_, err := a.cluster.SaveOutbound(context.Background(), cluster.Handshake{PeerID: id, Name: "empty", URL: remote.URL, SharedSecret: secret}, secret)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = a.db.Writer.Exec(`INSERT INTO peer_downloads(peer_id,remote_id,file_path,cached_at) VALUES(?,1,'gone.bin',0)`, id); err != nil {
		t.Fatal(err)
	}
	client := a.hub.Add("admin")
	defer a.hub.Remove(client)
	if _, _, err = a.syncCluster(context.Background()); err != nil {
		t.Fatal(err)
	}
	select {
	case e := <-client.Events():
		if e.Type != "peer_catalog_update" {
			t.Fatal(e.Type)
		}
	case <-time.After(time.Second):
		t.Fatal("empty reset removed rows without notifying dashboard")
	}
}

func TestClusterSuccessfulHandshakeKeepsSocketAlive(t *testing.T) {
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := wsUpgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer c.Close()
		kind, raw, err := c.ReadMessage()
		if err == nil {
			c.WriteMessage(kind, raw)
		}
	}))
	defer remote.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	c, res, err := dialClusterSocket(ctx, strings.Replace(remote.URL, "http", "ws", 1))
	if res != nil {
		res.Body.Close()
	}
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	time.Sleep(20 * time.Millisecond)
	c.SetWriteDeadline(time.Now().Add(time.Second))
	c.SetReadDeadline(time.Now().Add(time.Second))
	if err = c.WriteMessage(websocket.TextMessage, []byte("live")); err != nil {
		t.Fatal("upgrade canceled live socket", err)
	}
	_, raw, err := c.ReadMessage()
	if err != nil || string(raw) != "live" {
		t.Fatal("upgrade did not survive handshake context", string(raw), err)
	}
}

func TestPeerChangesQueryBounds(t *testing.T) {
	a, _ := socketTestApp(t)
	if _, err := a.db.Writer.Exec(`INSERT INTO downloads(group_id,message_id,file_path) VALUES('q',1,'one'),('q',2,'two')`); err != nil {
		t.Fatal(err)
	}
	for _, q := range []string{"after=-1", "after=word", "limit=0", "limit=501", "limit=word", "epoch=not-an-epoch"} {
		w := httptest.NewRecorder()
		a.handlePeerChanges(w, httptest.NewRequest("GET", "/api/cluster/catalog/changes?"+q, nil))
		if w.Code != 400 {
			t.Errorf("%s status=%d", q, w.Code)
		}
	}
	w := httptest.NewRecorder()
	a.handlePeerChanges(w, httptest.NewRequest("GET", "/api/cluster/catalog/changes?limit=1", nil))
	var page cluster.ChangePage
	if err := json.Unmarshal(w.Body.Bytes(), &page); err != nil || w.Code != 200 || len(page.Changes) != 1 || !page.More {
		t.Fatal(w.Code, page, err)
	}
}
