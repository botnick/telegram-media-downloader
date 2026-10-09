package app

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/botnick/telegram-media-downloader/core-service/internal/cluster"
	"github.com/botnick/telegram-media-downloader/core-service/internal/version"
)

func registerClusterRoutes(mux *http.ServeMux, a *App) {
	admin := func(pattern string, h http.HandlerFunc) { mux.Handle(pattern, a.requireAdmin(h)) }
	admin("GET /api/cluster/identity", a.handleClusterIdentity)
	admin("PUT /api/cluster/identity", a.handleClusterRename)
	admin("GET /api/cluster/identity/token", a.handleClusterToken)
	admin("POST /api/cluster/identity/set-token", a.handleClusterToken)
	admin("POST /api/cluster/identity/rotate-token", a.handleClusterToken)
	admin("POST /api/cluster/identity/pairing-code", a.handleClusterCode)
	admin("POST /api/cluster/pairing-code", a.handleClusterCode)
	admin("GET /api/cluster/peers", a.handleClusterPeers)
	admin("POST /api/cluster/peers", a.handleClusterPair)
	admin("PUT /api/cluster/peers/{peerID}", a.handleClusterEdit)
	admin("DELETE /api/cluster/peers/{peerID}", a.handleClusterRevoke)
	admin("POST /api/cluster/peers/{peerID}/test", a.handleClusterTest)
	admin("GET /api/cluster/audit", a.handleClusterAudit)
	admin("GET /api/cluster/sync/state", a.handleClusterSyncState)
	admin("POST /api/cluster/sync/run", a.handleClusterSync)
	mux.HandleFunc("POST /api/cluster/handshake", a.handleClusterHandshake)
	mux.HandleFunc("GET /api/cluster/health", a.handleClusterHealth)
	mux.HandleFunc("GET /api/cluster/downloads/since", a.handlePeerCatalog)
	mux.HandleFunc("GET /api/cluster/catalog/changes", a.handlePeerChanges)
	mux.HandleFunc("GET /api/cluster/search/peer", a.handlePeerCatalog)
	mux.HandleFunc("GET /api/cluster/groups/snapshot", a.handlePeerSnapshot)
	mux.HandleFunc("GET /api/cluster/accounts/snapshot", a.handlePeerSnapshot)
	mux.HandleFunc("GET /api/cluster/files/{path...}", a.handlePeerFile)
}

func isClusterPeerPath(path string) bool {
	switch path {
	case "/api/cluster/handshake", "/api/cluster/health", "/api/cluster/downloads/since", "/api/cluster/catalog/changes", "/api/cluster/groups/snapshot", "/api/cluster/accounts/snapshot", "/api/cluster/sign-url", "/api/cluster/relay/proxy", "/api/cluster/files/delete", "/api/cluster/search/peer":
		return true
	}
	return strings.HasPrefix(path, "/api/cluster/files/") || strings.HasPrefix(path, "/api/cluster/peer-thumbs/")
}

type clusterPeerKey struct{}

func (a *App) beginClusterRequest(r *http.Request) (*http.Request, func(), bool) {
	a.clusterMu.Lock()
	defer a.clusterMu.Unlock()
	if a.clusterClosed || a.ctx.Err() != nil {
		return r, nil, false
	}
	a.clusterWG.Add(1)
	ctx, cancel := context.WithCancel(r.Context())
	if r.URL.Path != "/ws/cluster" && !((r.Method == "GET" || r.Method == "HEAD") && (strings.HasPrefix(r.URL.Path, "/api/cluster/files/") || strings.HasPrefix(r.URL.Path, "/files/"))) {
		cancel()
		limit := 10 * time.Second
		if r.URL.Path == "/api/cluster/sync/run" {
			limit = time.Minute
		}
		ctx, cancel = context.WithTimeout(r.Context(), limit)
	}
	stop := context.AfterFunc(a.ctx, cancel)
	return r.WithContext(ctx), func() { stop(); cancel(); a.clusterWG.Done() }, true
}

func signedPeerRequest(r *http.Request, body []byte) cluster.SignedRequest {
	return cluster.SignedRequest{PeerID: r.Header.Get("X-Peer-Id"), Timestamp: r.Header.Get("X-Peer-Ts"), Signature: r.Header.Get("X-Peer-Signature"), Method: r.Method, Target: r.URL.RequestURI(), Body: body}
}
func (a *App) clusterGate(w http.ResponseWriter, r *http.Request, next http.Handler) {
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 1<<20))
	if err != nil {
		writeJSONError(w, 413, "Peer request body too large")
		return
	}
	if r.URL.Path == "/api/cluster/handshake" && r.Method == http.MethodPost {
		// Handshake verification and single-use code consumption share its TX.
		r.Body = io.NopCloser(bytes.NewReader(raw))
		next.ServeHTTP(w, r)
		return
	}
	p, err := a.cluster.Verify(r.Context(), signedPeerRequest(r, raw))
	if err != nil {
		a.clusterAuthError(w, r, err)
		return
	}
	r.Body = io.NopCloser(bytes.NewReader(raw))
	next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), clusterPeerKey{}, p)))
}
func (a *App) clusterAuthError(w http.ResponseWriter, r *http.Request, err error) {
	var authErr cluster.AuthError
	if !errors.As(err, &authErr) {
		writeJSONError(w, 500, "Cluster authentication storage failed")
		return
	}
	_ = a.cluster.Audit(r.Context(), r.Header.Get("X-Peer-Id"), "request", r.Method+" "+r.URL.RequestURI()+": "+string(authErr), false)
	writeJSON(w, 401, map[string]any{"error": "cluster auth failed", "code": string(authErr)})
}
func (a *App) handleClusterIdentity(w http.ResponseWriter, r *http.Request) {
	i, err := a.cluster.Identity(r.Context())
	if err != nil {
		writeJSONError(w, 500, "Cluster identity read failed")
		return
	}
	writeJSON(w, 200, i)
}
func (a *App) handleClusterRename(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Name string `json:"name"`
	}
	if decodeBody(w, r, &in) != nil {
		return
	}
	if in.Name == "" {
		writeJSONError(w, 400, "name required")
		return
	}
	if err := a.cluster.Rename(r.Context(), in.Name); err != nil {
		writeJSONError(w, 400, err.Error())
		return
	}
	a.handleClusterIdentity(w, r)
}
func (a *App) handleClusterToken(w http.ResponseWriter, r *http.Request) {
	var token string
	var err error
	if r.Method == "GET" {
		token, err = a.cluster.Token(r.Context())
	} else {
		kind := "set_token"
		if strings.HasSuffix(r.URL.Path, "rotate-token") {
			kind = "rotate_token"
			token, err = cluster.NewSecret()
			if err != nil {
				writeJSONError(w, 500, "Token generation failed")
				return
			}
		} else {
			var in struct {
				Token string `json:"token"`
			}
			if decodeBody(w, r, &in) != nil {
				return
			}
			token = in.Token
			if token == "" {
				writeJSONError(w, 400, "token required")
				return
			}
		}
		token, err = a.cluster.SetToken(r.Context(), token, kind)
	}
	if err != nil {
		writeJSONError(w, 400, err.Error())
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, 200, map[string]any{"token": token})
}
func (a *App) handleClusterCode(w http.ResponseWriter, r *http.Request) {
	code, err := a.cluster.IssueCode(r.Context())
	if err != nil {
		writeJSONError(w, 500, err.Error())
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, 200, code)
}
func (a *App) handleClusterPeers(w http.ResponseWriter, r *http.Request) {
	peers, err := a.cluster.Peers(r.Context())
	if err != nil {
		writeJSONError(w, 500, "Peer registry read failed")
		return
	}
	writeJSON(w, 200, map[string]any{"peers": peers})
}
func (a *App) clusterRequestContext(r *http.Request) (context.Context, context.CancelFunc) {
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	stop := context.AfterFunc(a.ctx, cancel)
	return ctx, func() { stop(); cancel() }
}
func (a *App) handleClusterPair(w http.ResponseWriter, r *http.Request) {
	var in struct {
		URL         string `json:"url"`
		Token       string `json:"token"`
		PairingCode string `json:"pairingCode"`
	}
	if decodeBody(w, r, &in) != nil {
		return
	}
	if in.URL == "" || (in.Token == "" && in.PairingCode == "") {
		writeJSONError(w, 400, "url + (token or pairingCode) are required")
		return
	}
	self := os.Getenv("PUBLIC_URL")
	if self == "" {
		scheme := "http"
		if networkForRequest(r).secure {
			scheme = "https"
		}
		self = scheme + "://" + r.Host
	}
	ctx, cancel := a.clusterRequestContext(r)
	defer cancel()
	p, err := a.clusterHTTP.Pair(ctx, in.URL, in.Token, in.PairingCode, self, version.AppVersion)
	if err != nil {
		var pair *cluster.PairError
		if errors.As(err, &pair) {
			writeJSON(w, 400, map[string]any{"error": pair.Message, "code": pair.Code})
		} else {
			writeJSONError(w, 500, "Pairing failed")
		}
		return
	}
	writeJSON(w, 200, map[string]any{"peer": p})
}
func (a *App) handleClusterEdit(w http.ResponseWriter, r *http.Request) {
	var in map[string]any
	if decodeBody(w, r, &in) != nil {
		return
	}
	p, err := a.cluster.Update(r.Context(), r.PathValue("peerID"), in)
	if errors.Is(err, sql.ErrNoRows) {
		writeJSONError(w, 404, "peer not found")
		return
	}
	if err != nil {
		writeJSONError(w, 400, err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"peer": p})
}
func (a *App) handleClusterRevoke(w http.ResponseWriter, r *http.Request) {
	ok, err := a.cluster.Revoke(r.Context(), r.PathValue("peerID"))
	if err != nil {
		writeJSONError(w, 400, err.Error())
		return
	}
	if !ok {
		writeJSONError(w, 404, "peer not found")
		return
	}
	writeJSON(w, 200, map[string]any{"success": true})
}
func (a *App) handleClusterHandshake(w http.ResponseWriter, r *http.Request) {
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 1<<20))
	if err != nil {
		writeJSONError(w, 413, "Peer request body too large")
		return
	}
	var h cluster.Handshake
	if err = json.Unmarshal(raw, &h); err != nil {
		writeJSONError(w, 400, "Invalid JSON body")
		return
	}
	reply, err := a.cluster.AcceptHandshake(r.Context(), signedPeerRequest(r, raw), h, version.AppVersion)
	if err != nil {
		var authErr cluster.AuthError
		if errors.As(err, &authErr) {
			a.clusterAuthError(w, r, err)
		} else {
			writeJSON(w, 400, map[string]any{"error": err.Error(), "code": "bad_request"})
		}
		return
	}
	writeJSON(w, 200, reply)
}
func (a *App) handleClusterHealth(w http.ResponseWriter, r *http.Request) {
	p, ok := r.Context().Value(clusterPeerKey{}).(cluster.Peer)
	if !ok {
		writeJSONError(w, 401, "cluster auth failed")
		return
	}
	if err := a.cluster.RecordHealth(r.Context(), p, true, "", ""); err != nil {
		if errors.Is(err, cluster.ErrPeerChanged) {
			a.clusterAuthError(w, r, cluster.AuthError("peer_changed"))
			return
		}
		writeJSONError(w, 500, "Peer status write failed")
		return
	}
	i, err := a.cluster.Identity(r.Context())
	if err != nil {
		writeJSONError(w, 500, "Identity read failed")
		return
	}
	writeJSON(w, 200, map[string]any{"peer_id": i.PeerID, "name": i.Name, "version": version.AppVersion, "ts": time.Now().UnixMilli(), "ok": true})
}
func (a *App) handleClusterTest(w http.ResponseWriter, r *http.Request) {
	p, err := a.cluster.Peer(r.Context(), r.PathValue("peerID"))
	if errors.Is(err, sql.ErrNoRows) {
		writeJSONError(w, 404, "peer not found")
		return
	}
	if err != nil {
		writeJSONError(w, 500, "Peer read failed")
		return
	}
	ctx, cancel := a.clusterRequestContext(r)
	defer cancel()
	res, err := a.clusterHTTP.Request(ctx, p, "GET", "/api/cluster/health", nil)
	out := map[string]any{"ok": false, "code": "unreachable"}
	state := "offline"
	if err != nil {
		var ae cluster.AuthError
		if errors.As(err, &ae) {
			out["code"] = string(ae)
		}
	} else if res.StatusCode != 200 {
		res.Body.Close()
		out["code"] = "remote_error"
		out["status"] = res.StatusCode
		if res.StatusCode == 401 {
			out["code"] = "token_invalid"
		}
	} else {
		var payload map[string]any
		if err = cluster.ReadJSON(res, &payload); err == nil && payload["peer_id"] == p.PeerID && payload["ok"] == true {
			out = map[string]any{"ok": true, "payload": payload}
			state = "online"
		} else {
			out["code"] = "bad_response"
		}
	}
	detail, _ := out["code"].(string)
	if err = a.cluster.RecordHealth(r.Context(), p, state == "online", "test", detail); err != nil {
		if errors.Is(err, cluster.ErrPeerChanged) {
			writeJSONError(w, 409, "Peer changed during probe")
			return
		}
		writeJSONError(w, 500, "Peer status write failed")
		return
	}
	writeJSON(w, 200, out)
}
func (a *App) handleClusterAudit(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	where := []string{}
	args := []any{}
	for _, field := range []struct{ param, column string }{{"peerId", "peer_id"}, {"kind", "kind"}} {
		if v := q.Get(field.param); v != "" {
			where = append(where, field.column+"=?")
			args = append(args, v)
		}
	}
	clause := ""
	if len(where) > 0 {
		clause = " WHERE " + strings.Join(where, " AND ")
	}
	args = append(args, min(2000, max(1, int(number(q.Get("limit"), 200)))))
	rows, err := a.db.Reader.QueryContext(r.Context(), `SELECT id,ts,peer_id,kind,detail,ok FROM cluster_audit`+clause+` ORDER BY ts DESC,id DESC LIMIT ?`, args...)
	if err != nil {
		writeJSONError(w, 500, "Audit read failed")
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var id, ts, ok int64
		var peer, detail *string
		var kind string
		if err = rows.Scan(&id, &ts, &peer, &kind, &detail, &ok); err != nil {
			break
		}
		out = append(out, map[string]any{"id": id, "ts": ts, "peer_id": peer, "kind": kind, "detail": detail, "ok": ok})
	}
	if err != nil || rows.Err() != nil {
		writeJSONError(w, 500, "Audit read failed")
		return
	}
	writeJSON(w, 200, map[string]any{"entries": out})
}
