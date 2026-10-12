package app

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/botnick/telegram-media-downloader/core-service/internal/cluster"
)

func pairClusterApps(t *testing.T, a *App, as *httptest.Server, b *App, bs *httptest.Server) (cluster.Identity, cluster.Identity) {
	t.Helper()
	ctx := context.Background()
	aid, _ := a.cluster.Identity(ctx)
	bid, _ := b.cluster.Identity(ctx)
	secret := strings.Repeat("ef", 32)
	if _, err := a.cluster.SaveOutbound(ctx, cluster.Handshake{PeerID: bid.PeerID, Name: "b", URL: bs.URL, SharedSecret: secret}, secret); err != nil {
		t.Fatal(err)
	}
	if _, err := b.cluster.SaveOutbound(ctx, cluster.Handshake{PeerID: aid.PeerID, Name: "a", URL: as.URL, SharedSecret: secret}, secret); err != nil {
		t.Fatal(err)
	}
	return aid, bid
}

func insertClusterDownload(t *testing.T, a *App, id int64, path, hash string, size int64) {
	t.Helper()
	rescueFile(t, a, path)
	if _, err := a.db.Writer.Exec(`INSERT INTO downloads(id,group_id,message_id,file_name,file_path,file_size,file_hash,file_type) VALUES(?,'dup',?,?,?,?,?,'photo')`, id, id, path, path, size, hash); err != nil {
		t.Fatal(err)
	}
}

func waitSweep(t *testing.T, srv *httptest.Server, token string) map[string]any {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		status, out := clusterCall(t, srv, "GET", "/api/cluster/sweep/status", token, nil)
		if status != 200 {
			t.Fatal(status, out)
		}
		if out["running"] == false && out["stage"] == "done" {
			return out
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("sweep did not finish")
	return nil
}

func TestClusterSweepFindsAndResolvesCrossPeerDuplicates(t *testing.T) {
	a, as := socketTestApp(t)
	b, bs := socketTestApp(t)
	at := socketToken(t, a, "admin", time.Hour)
	_, bid := pairClusterApps(t, a, as, b, bs)
	ctx := context.Background()

	// An unreachable third peer exercises the queued delete fallback.
	deadSrv := httptest.NewServer(http.NotFoundHandler())
	deadURL := deadSrv.URL
	deadSrv.Close()
	deadID := "0123456789abcdef0123456789abcdef"
	if _, err := a.cluster.SaveOutbound(ctx, cluster.Handshake{PeerID: deadID, Name: "dead", URL: deadURL, SharedSecret: strings.Repeat("ab", 32)}, strings.Repeat("ab", 32)); err != nil {
		t.Fatal(err)
	}
	if _, err := a.db.Writer.Exec(`INSERT INTO peer_downloads(peer_id,remote_id,file_path,file_name,file_size,file_hash,cached_at) VALUES(?,9,'far.bin','far',2048,'h1',1)`, deadID); err != nil {
		t.Fatal(err)
	}
	insertClusterDownload(t, a, 1, "keep.bin", "h1", 2048)
	insertClusterDownload(t, a, 2, "local-dup.bin", "h1", 2048)
	insertClusterDownload(t, a, 3, "tiny-a.bin", "h2", 10)
	insertClusterDownload(t, a, 4, "tiny-b.bin", "h2", 10)
	insertClusterDownload(t, b, 7, "remote-dup.bin", "h1", 2048)
	waitClusterRow(t, a, bid.PeerID, "remote-dup.bin", 1)

	// The federated thumbnail proxy forwards a peer's cached thumbnail and
	// substitutes a placeholder for unknown peers.
	key := sha256.Sum256([]byte("7:320"))
	webp := []byte("RIFF\x04\x00\x00\x00WEBPVP8 ")
	if err := os.MkdirAll(filepath.Join(b.dataDir, "thumbs"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(b.dataDir, "thumbs", hex.EncodeToString(key[:])[:32]+".webp"), webp, 0o600); err != nil {
		t.Fatal(err)
	}
	for path, want := range map[string]string{"/api/cluster/thumbs/" + bid.PeerID + "/7?w=320": "image/webp", "/api/cluster/thumbs/" + deadID + "x/7": "image/png"} {
		req, _ := http.NewRequest("GET", as.URL+path, nil)
		req.AddCookie(&http.Cookie{Name: "tg_dl_session", Value: at})
		res, err := as.Client().Do(req)
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(res.Body)
		res.Body.Close()
		if res.StatusCode != 200 || res.Header.Get("Content-Type") != want || want == "image/webp" && string(body) != string(webp) {
			t.Fatal(path, res.StatusCode, res.Header.Get("Content-Type"), body)
		}
	}

	if status, out := clusterCall(t, as, "GET", "/api/cluster/conflicts", at, nil); status != 200 || len(out["stats"].(map[string]any)) != 0 {
		t.Fatal("stats before first sweep", status, out)
	}
	conn := socketDial(t, a, as, at)
	if status, out := clusterCall(t, as, "POST", "/api/cluster/sweep/run", at, nil); status != 200 || out["started"] != true {
		t.Fatal(status, out)
	}
	var events []string
	conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	for done := 0; done < 2; {
		var m map[string]any
		if err := conn.ReadJSON(&m); err != nil {
			t.Fatal(events, err)
		}
		switch m["type"] {
		case "cluster_sweep_progress", "cluster_sweep_done":
			events = append(events, m["type"].(string))
			if m["type"] == "cluster_sweep_done" {
				done++
				if m["wastedBytes"] != float64(3*2048) {
					t.Fatal(m)
				}
			}
		}
	}
	if strings.Join(events, ",") != "cluster_sweep_progress,cluster_sweep_progress,cluster_sweep_done,cluster_sweep_done" {
		t.Fatal(events)
	}
	if done := waitSweep(t, as, at); done["result"].(map[string]any)["conflicts"] != float64(1) {
		t.Fatal(done)
	}
	status, out := clusterCall(t, as, "GET", "/api/cluster/conflicts", at, nil)
	if status != 200 {
		t.Fatal(status, out)
	}
	conflicts := out["conflicts"].([]any)
	stats := out["stats"].(map[string]any)
	if len(conflicts) != 1 || stats["wastedBytes"] != float64(3*2048) || stats["duplicateRows"] != float64(3) || stats["lastRunAt"] == nil {
		t.Fatal(out)
	}
	c := conflicts[0].(map[string]any)
	owners := c["owners"].([]any)
	if c["id"] != "h1|2048" || c["count"] != float64(4) || len(owners) != 4 || owners[0].(map[string]any)["peerId"] != "self" {
		t.Fatal(c)
	}
	resolve := "/api/cluster/conflicts/" + url.PathEscape("h1|2048") + "/resolve"
	if status, out = clusterCall(t, as, "POST", resolve, at, map[string]any{"keep": map[string]any{"peerId": "self", "remoteId": 99}}); status != 400 {
		t.Fatal("foreign keeper accepted", status, out)
	}
	if status, out = clusterCall(t, as, "POST", resolve, at, map[string]any{"keep": map[string]any{"peerId": "self", "remoteId": 1}}); status != 200 || out["unlinked"] != float64(1) || out["remoteDeleted"] != float64(1) || out["queued"] != float64(1) {
		t.Fatal(status, out)
	}
	var n int
	if err := a.db.Reader.QueryRow(`SELECT COUNT(*) FROM downloads WHERE file_hash='h1'`).Scan(&n); err != nil || n != 1 {
		t.Fatal("local loser not deleted", n, err)
	}
	if _, err := os.Stat(filepath.Join(a.downloadsDir, "local-dup.bin")); !os.IsNotExist(err) {
		t.Fatal("local loser file kept", err)
	}
	if _, err := os.Stat(filepath.Join(a.downloadsDir, "keep.bin")); err != nil {
		t.Fatal("keeper removed", err)
	}
	if err := b.db.Reader.QueryRow(`SELECT COUNT(*) FROM downloads`).Scan(&n); err != nil || n != 0 {
		t.Fatal("remote loser not deleted", n, err)
	}
	if _, err := os.Stat(filepath.Join(b.downloadsDir, "remote-dup.bin")); !os.IsNotExist(err) {
		t.Fatal("remote loser file kept", err)
	}
	if err := b.db.Reader.QueryRow(`SELECT COUNT(*) FROM cluster_audit WHERE kind='cross_delete' AND ok=1`).Scan(&n); err != nil || n != 1 {
		t.Fatal("cross delete not audited", n, err)
	}
	var reason string
	if err := a.db.Reader.QueryRow(`SELECT reason FROM peer_delete_jobs WHERE peer_id=? AND remote_id=9 AND status='pending'`, deadID).Scan(&reason); err != nil || reason != "cluster_dedup keeper=self:1" {
		t.Fatal("unreachable peer delete not queued", reason, err)
	}
	if status, out = clusterCall(t, as, "GET", "/api/cluster/conflicts", at, nil); status != 200 || len(out["conflicts"].([]any)) != 0 {
		t.Fatal("resolved conflict listed", out)
	}
	if status, out = clusterCall(t, as, "POST", resolve, at, map[string]any{"keep": map[string]any{"peerId": "self", "remoteId": 1}}); status != 404 {
		t.Fatal("resolved twice", status, out)
	}
	// The peer's deletion reaches the catalog cache through the change feed.
	waitClusterRow(t, a, bid.PeerID, "", 0)
}

func TestClusterSweepIsSingleFlightAndPeerDeleteRequiresSignature(t *testing.T) {
	a, as := socketTestApp(t)
	at := socketToken(t, a, "admin", time.Hour)
	a.clusterSweep.mu.Lock()
	a.clusterSweep.status = maintenanceIdleStatus(clusterSweepKind)
	a.clusterSweep.status["running"] = true
	a.clusterSweep.mu.Unlock()
	if status, out := clusterCall(t, as, "POST", "/api/cluster/sweep/run", at, map[string]any{"minSize": 1}); status != 409 || out["code"] != "ALREADY_RUNNING" {
		t.Fatal(status, out)
	}
	insertClusterDownload(t, a, 1, "victim.bin", "h", 2048)
	if status, out := clusterCall(t, as, "POST", "/api/cluster/files/delete", at, map[string]any{"remote_id": 1}); status != 401 {
		t.Fatal("unsigned peer delete accepted", status, out)
	}
	var n int
	if err := a.db.Reader.QueryRow(`SELECT COUNT(*) FROM downloads`).Scan(&n); err != nil || n != 1 {
		t.Fatal(n, err)
	}
}
