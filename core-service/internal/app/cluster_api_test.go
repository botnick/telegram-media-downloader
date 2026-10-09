package app

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/botnick/telegram-media-downloader/core-service/internal/cluster"
)

func clusterCall(t *testing.T, srv *httptest.Server, method, path, token string, body any) (int, map[string]any) {
	t.Helper()
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	req, err := http.NewRequest(method, srv.URL+path, strings.NewReader(string(raw)))
	if err != nil {
		t.Fatal(err)
	}
	if token != "" {
		req.AddCookie(&http.Cookie{Name: "tg_dl_session", Value: token})
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := srv.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var out map[string]any
	if err = json.NewDecoder(res.Body).Decode(&out); err != nil {
		t.Fatal(res.StatusCode, err)
	}
	return res.StatusCode, out
}
func TestClusterTwoGoServersPairProbeAndRevoke(t *testing.T) {
	t.Setenv("PUBLIC_URL", "")
	a, as := socketTestApp(t)
	b, bs := socketTestApp(t)
	at := socketToken(t, a, "admin", time.Hour)
	bt := socketToken(t, b, "admin", time.Hour)
	status, code := clusterCall(t, bs, "POST", "/api/cluster/identity/pairing-code", bt, map[string]any{})
	if status != 200 {
		t.Fatal(status, code)
	}
	status, paired := clusterCall(t, as, "POST", "/api/cluster/peers", at, map[string]any{"url": bs.URL, "pairingCode": code["code"]})
	if status != 200 {
		t.Fatal(status, paired)
	}
	aid, err := a.cluster.Identity(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	bid, err := b.cluster.Identity(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	ap, err := a.cluster.Peer(context.Background(), bid.PeerID)
	if err != nil {
		t.Fatal(err)
	}
	bp, err := b.cluster.Peer(context.Background(), aid.PeerID)
	if err != nil {
		t.Fatal(err)
	}
	if len(ap.Secret) != 64 || string(ap.Secret) != string(bp.Secret) || bp.URL != as.URL || ap.URL != bs.URL {
		t.Fatal("asymmetric pairing")
	}
	raw, _ := json.Marshal(paired)
	if strings.Contains(string(raw), string(ap.Secret)) {
		t.Fatal("pair response leaked key")
	}
	status, health := clusterCall(t, as, "POST", "/api/cluster/peers/"+bid.PeerID+"/test", at, map[string]any{})
	if status != 200 || health["ok"] != true {
		t.Fatal(status, health)
	}
	// The paired machines serve actual catalog rows and range bytes over the
	// signed bridge, including paths that must remain escaped during signing.
	name := "movie %+.bin"
	rescueFile(t, b, name)
	if err = os.WriteFile(filepath.Join(b.dataDir, "downloads", name), []byte("0123456789"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err = b.db.Writer.Exec(`INSERT INTO downloads(id,group_id,message_id,file_name,file_path,file_size) VALUES(42,'fixture',42,?,?,10)`, name, name); err != nil {
		t.Fatal(err)
	}
	response, err := a.clusterHTTP.Request(context.Background(), ap, "GET", "/api/cluster/downloads/since?sinceId=0&limit=1", nil)
	if err != nil {
		t.Fatal(err)
	}
	var catalog struct {
		Rows   []cluster.CatalogRow
		PeerID string `json:"peerId"`
	}
	if err = cluster.ReadJSON(response, &catalog); err != nil || len(catalog.Rows) != 1 || catalog.Rows[0].ID != 42 || catalog.PeerID != bid.PeerID {
		t.Fatal(catalog, err)
	}
	if _, err = b.db.Writer.Exec(`WITH RECURSIVE ids(n) AS (VALUES(43) UNION ALL SELECT n+1 FROM ids WHERE n<543) INSERT INTO downloads(id,group_id,message_id,file_name,file_path,file_size) SELECT n,'fixture',n,?,?,10 FROM ids`, name, name); err != nil {
		t.Fatal(err)
	}
	status, synced := clusterSyncCall(t, as, at)
	if status != 200 || synced["rows"].(float64) > 502 {
		t.Fatal("native catalog sync", status, synced)
	}
	var catalogCount int
	if err = a.db.Reader.QueryRow(`SELECT count(*) FROM peer_downloads WHERE peer_id=?`, bid.PeerID).Scan(&catalogCount); err != nil || catalogCount != 502 {
		t.Fatal("incomplete paged cache", catalogCount, err)
	}
	for _, path := range []string{"/files/" + url.PathEscape(name) + "?peer=" + bid.PeerID, "/files/_clusterref/" + bid.PeerID + "/42"} {
		req, err := http.NewRequest("GET", as.URL+path, nil)
		if err != nil {
			t.Fatal(err)
		}
		req.AddCookie(&http.Cookie{Name: "tg_dl_session", Value: at})
		req.Header.Set("Range", "bytes=2-5")
		res, err := as.Client().Do(req)
		if err != nil {
			t.Fatal(err)
		}
		bytes, readErr := io.ReadAll(res.Body)
		res.Body.Close()
		if readErr != nil || res.StatusCode != 206 || string(bytes) != "2345" || res.Header.Get("Content-Range") != "bytes 2-5/10" {
			t.Fatal("bridged range", res.StatusCode, string(bytes), readErr)
		}
	}
	// A second pass must discover edits/deletes below the previous maximum ID.
	if _, err = b.db.Writer.Exec(`UPDATE downloads SET file_name='renamed.bin' WHERE id=42; DELETE FROM downloads WHERE id=43`); err != nil {
		t.Fatal(err)
	}
	status, synced = clusterSyncCall(t, as, at)
	if status != 200 || synced["rows"].(float64) > 2 {
		t.Fatal("old-row changes were skipped", status, synced)
	}
	var renamed string
	var deleted int
	if err = a.db.Reader.QueryRow(`SELECT file_name FROM peer_downloads WHERE peer_id=? AND remote_id=42`, bid.PeerID).Scan(&renamed); err != nil || renamed != "renamed.bin" {
		t.Fatal(renamed, err)
	}
	if err = a.db.Reader.QueryRow(`SELECT count(*) FROM peer_downloads WHERE peer_id=? AND remote_id=43`, bid.PeerID).Scan(&deleted); err != nil || deleted != 0 {
		t.Fatal(deleted, err)
	}
	// A code cannot be reused even by the peer that successfully consumed it.
	status, _ = clusterCall(t, as, "POST", "/api/cluster/peers", at, map[string]any{"url": bs.URL, "pairingCode": code["code"]})
	if status == 200 {
		t.Fatal("code reused")
	}
	// Both identity and signing key survive a bootstrap-token rotation.
	status, _ = clusterCall(t, bs, "POST", "/api/cluster/identity/rotate-token", bt, nil)
	if status != 200 {
		t.Fatal(status)
	}
	status, health = clusterCall(t, as, "POST", "/api/cluster/peers/"+bid.PeerID+"/test", at, map[string]any{})
	if status != 200 || health["ok"] != true {
		t.Fatal("rotation broke established pair", status, health)
	}
	status, _ = clusterCall(t, bs, "DELETE", "/api/cluster/peers/"+aid.PeerID, bt, nil)
	if status != 200 {
		t.Fatal(status)
	}
	status, health = clusterCall(t, as, "POST", "/api/cluster/peers/"+bid.PeerID+"/test", at, map[string]any{})
	if status != 200 || health["ok"] != false || health["code"] != "token_invalid" {
		t.Fatal("revocation ignored", status, health)
	}
	status, _ = clusterCall(t, as, "DELETE", "/api/cluster/peers/"+bid.PeerID, at, nil)
	if status != 200 {
		t.Fatal(status)
	}
	var cached int
	if err = a.db.Reader.QueryRow(`SELECT count(*) FROM peer_downloads`).Scan(&cached); err != nil || cached != 0 {
		t.Fatal("revoked catalog retained", cached, err)
	}
	syncState, err := a.cluster.SyncState(context.Background())
	if err != nil || len(syncState) != 0 {
		t.Fatal("re-pair would skip old cursor", syncState, err)
	}
	status, _ = clusterCall(t, as, "GET", "/api/cluster/identity", socketToken(t, a, "guest", time.Hour), nil)
	if status != 403 {
		t.Fatal("guest identity access", status)
	}
	status, _ = clusterCall(t, as, "GET", "/api/cluster/identity/token", "", nil)
	if status != 401 {
		t.Fatal("anonymous token access", status)
	}
}

func TestClusterPairDoesNotFollowRedirectOrAcceptMissingSecretAck(t *testing.T) {
	t.Setenv("PUBLIC_URL", "")
	a, srv := socketTestApp(t)
	token := socketToken(t, a, "admin", time.Hour)
	var received atomic.Int64
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { received.Add(1); w.WriteHeader(200) }))
	defer target.Close()
	redirect := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL, http.StatusTemporaryRedirect)
	}))
	defer redirect.Close()
	status, _ := clusterCall(t, srv, "POST", "/api/cluster/peers", token, map[string]any{"url": redirect.URL, "token": strings.Repeat("ab", 32)})
	if status == 200 || received.Load() != 0 {
		t.Fatal("redirect leaked signed handshake", status, received.Load())
	}
	noAck := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{"peer_id": "00000000-0000-4000-8000-0000000000a1", "name": "no-ack"})
	}))
	defer noAck.Close()
	status, _ = clusterCall(t, srv, "POST", "/api/cluster/peers", token, map[string]any{"url": noAck.URL, "token": strings.Repeat("ab", 32)})
	if status == 200 {
		t.Fatal("unacknowledged pair succeeded")
	}
	peers, err := a.cluster.Peers(context.Background())
	if err != nil || len(peers) != 0 {
		t.Fatal("failed handshake persisted peer", len(peers), err)
	}
}

func TestClusterGateVerifiesBodyAndEscapedRequestTarget(t *testing.T) {
	a, srv := socketTestApp(t)
	const id = "00000000-0000-4000-8000-0000000000a1"
	secret := strings.Repeat("ab", 32)
	_, err := a.cluster.SaveOutbound(context.Background(), cluster.Handshake{PeerID: id, Name: "wire", URL: "http://wire.invalid", SharedSecret: secret}, secret)
	if err != nil {
		t.Fatal(err)
	}
	stamp := time.Now().UnixMilli()
	target := "/api/cluster/health?escaped=a%2Fb&space=a%20b"
	for i, bad := range []bool{false, true} {
		req, err := http.NewRequest("GET", srv.URL+target, strings.NewReader("body"))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("X-Peer-Id", id)
		req.Header.Set("X-Peer-Ts", strconv.FormatInt(stamp+int64(i), 10))
		signedTarget := target
		if bad {
			signedTarget = "/api/cluster/health?escaped=a/b&space=a%20b"
		}
		req.Header.Set("X-Peer-Signature", cluster.Signature(secret, "GET", signedTarget, stamp+int64(i), []byte("body")))
		res, err := srv.Client().Do(req)
		if err != nil {
			t.Fatal(err)
		}
		io.Copy(io.Discard, res.Body)
		res.Body.Close()
		want := 200
		if bad {
			want = 401
		}
		if res.StatusCode != want {
			t.Fatal(res.StatusCode, want)
		}
	}
}

func TestClusterSnapshotDoesNotExportCredentials(t *testing.T) {
	a, srv := socketTestApp(t)
	ctx := context.Background()
	cfg, err := a.config.Load(ctx)
	if err != nil {
		t.Fatal(err)
	}
	cfg["groups"] = []any{map[string]any{"id": "123", "name": "metadata", "session": "top-secret", "filters": map[string]any{"allowed": true, "authToken": "nested-secret", "topics": []any{map[string]any{"api_hash": "nested-hash", "name": "retained"}}}}}
	cfg["accounts"] = []any{map[string]any{"id": "acct", "label": "public label", "session": "session-secret", "apiHash": "api-secret", "password": "password-secret"}}
	if err = a.config.Save(ctx, cfg); err != nil {
		t.Fatal(err)
	}
	const id = "00000000-0000-4000-8000-0000000000a1"
	secret := strings.Repeat("ab", 32)
	if _, err = a.cluster.SaveOutbound(ctx, cluster.Handshake{PeerID: id, Name: "wire", URL: "http://wire.invalid", SharedSecret: secret}, secret); err != nil {
		t.Fatal(err)
	}
	for i, target := range []string{"/api/cluster/groups/snapshot", "/api/cluster/accounts/snapshot"} {
		req, err := http.NewRequest("GET", srv.URL+target, nil)
		if err != nil {
			t.Fatal(err)
		}
		stamp := time.Now().UnixMilli() + int64(i)
		req.Header.Set("X-Peer-Id", id)
		req.Header.Set("X-Peer-Ts", strconv.FormatInt(stamp, 10))
		req.Header.Set("X-Peer-Signature", cluster.Signature(secret, "GET", target, stamp, nil))
		res, err := srv.Client().Do(req)
		if err != nil {
			t.Fatal(err)
		}
		body, err := io.ReadAll(res.Body)
		res.Body.Close()
		if err != nil || res.StatusCode != 200 {
			t.Fatal(res.StatusCode, err)
		}
		for _, forbidden := range []string{"secret", "api_hash", "authToken", "session"} {
			if strings.Contains(string(body), forbidden) {
				t.Fatal("credentials escaped snapshot", string(body))
			}
		}
		if i == 0 && !strings.Contains(string(body), "retained") {
			t.Fatal("safe nested metadata removed", string(body))
		}
		if i == 1 && !strings.Contains(string(body), "public label") {
			t.Fatal("safe account label removed", string(body))
		}
	}
}

func TestClusterProxyAbortsTruncatedChunkedBody(t *testing.T) {
	a, api := socketTestApp(t)
	token := socketToken(t, a, "admin", time.Hour)
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(200)
		w.(http.Flusher).Flush()
		w.Write([]byte(strings.Repeat("x", 64<<10)))
		w.(http.Flusher).Flush()
		conn, _, err := w.(http.Hijacker).Hijack()
		if err == nil {
			conn.Close()
		}
	}))
	defer remote.Close()
	const id = "00000000-0000-4000-8000-0000000000a1"
	secret := strings.Repeat("ab", 32)
	if _, err := a.cluster.SaveOutbound(context.Background(), cluster.Handshake{PeerID: id, Name: "truncated", URL: remote.URL, SharedSecret: secret}, secret); err != nil {
		t.Fatal(err)
	}
	req, err := http.NewRequest("GET", api.URL+"/files/test.bin?peer="+id, nil)
	if err != nil {
		t.Fatal(err)
	}
	req.AddCookie(&http.Cookie{Name: "tg_dl_session", Value: token})
	res, err := api.Client().Do(req)
	if err != nil {
		t.Fatal("expected partial response before failure", err)
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		t.Fatal(res.StatusCode)
	}
	if _, err = io.ReadAll(res.Body); err == nil {
		t.Fatal("truncated peer body reported complete")
	}
}

func TestClusterDirectModeDoesNotSilentlyProxy(t *testing.T) {
	a, api := socketTestApp(t)
	token := socketToken(t, a, "admin", time.Hour)
	var requests atomic.Int64
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		w.WriteHeader(200)
	}))
	defer remote.Close()
	const id = "00000000-0000-4000-8000-0000000000a1"
	secret := strings.Repeat("ab", 32)
	ctx := context.Background()
	if _, err := a.cluster.SaveOutbound(ctx, cluster.Handshake{PeerID: id, Name: "direct", URL: remote.URL, SharedSecret: secret}, secret); err != nil {
		t.Fatal(err)
	}
	if _, err := a.cluster.Update(ctx, id, map[string]any{"streamMode": "direct"}); err != nil {
		t.Fatal(err)
	}
	status, body := clusterCall(t, api, "GET", "/files/test.bin?peer="+id, token, nil)
	if status != 501 || body["error"] != "unsupported_stream_mode" || requests.Load() != 0 {
		t.Fatal(status, body, requests.Load())
	}
}

func TestClusterShutdownCancelsAndJoinsBlockedPairing(t *testing.T) {
	t.Setenv("PUBLIC_URL", "")
	a, api := socketTestApp(t)
	token := socketToken(t, a, "admin", time.Hour)
	entered := make(chan struct{})
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.Copy(io.Discard, r.Body)
		close(entered)
		<-r.Context().Done()
	}))
	defer remote.Close()
	raw, _ := json.Marshal(map[string]any{"url": remote.URL, "token": strings.Repeat("ab", 32)})
	req, err := http.NewRequest("POST", api.URL+"/api/cluster/peers", strings.NewReader(string(raw)))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(&http.Cookie{Name: "tg_dl_session", Value: token})
	requestDone := make(chan struct{})
	go func() {
		defer close(requestDone)
		res, err := api.Client().Do(req)
		if err == nil {
			io.Copy(io.Discard, res.Body)
			res.Body.Close()
		}
	}()
	select {
	case <-entered:
	case <-time.After(3 * time.Second):
		t.Fatal("pairing did not reach remote")
	}
	closed := make(chan error, 1)
	go func() { closed <- a.Close() }()
	select {
	case err := <-closed:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("blocked pairing prevented shutdown")
	}
	select {
	case <-requestDone:
	case <-time.After(time.Second):
		t.Fatal("HTTP request not joined")
	}
}

// Automatic and manual synchronization share the single-flight gate. The
// manual pass may have zero work after a preceding live notification.
func clusterSyncCall(t *testing.T, s *httptest.Server, token string) (int, map[string]any) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		status, result := clusterCall(t, s, "POST", "/api/cluster/sync/run", token, nil)
		if status != 409 || time.Now().After(deadline) {
			return status, result
		}
		time.Sleep(20 * time.Millisecond)
	}
}
