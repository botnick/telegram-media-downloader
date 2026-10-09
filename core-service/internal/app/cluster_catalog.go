package app

import (
	"net/http"
	"strings"
	"time"
)

func (a *App) handlePeerCatalog(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	search := strings.TrimSpace(q.Get("q"))
	limit := 500
	if strings.HasSuffix(r.URL.Path, "/search/peer") {
		if search == "" {
			writeJSON(w, 200, map[string]any{"rows": []any{}})
			return
		}
		limit = min(200, max(1, int(number(q.Get("limit"), 50))))
	} else {
		limit = min(2000, max(1, int(number(q.Get("limit"), 500))))
	}
	rows, err := a.cluster.Catalog(r.Context(), int64(number(q.Get("sinceId"), 0)), search, limit)
	if err != nil {
		writeJSONError(w, 500, "Peer catalog read failed")
		return
	}
	i, err := a.cluster.Identity(r.Context())
	if err != nil {
		writeJSONError(w, 500, "Identity read failed")
		return
	}
	out := map[string]any{"rows": rows, "peerId": i.PeerID}
	if strings.HasSuffix(r.URL.Path, "/search/peer") {
		out["q"] = search
	} else {
		out["now"] = time.Now().UnixMilli()
	}
	writeJSON(w, 200, out)
}

func (a *App) handlePeerSnapshot(w http.ResponseWriter, r *http.Request) {
	cfg, err := a.config.Load(r.Context())
	if err != nil {
		writeJSONError(w, 500, "Config read failed")
		return
	}
	i, err := a.cluster.Identity(r.Context())
	if err != nil {
		writeJSONError(w, 500, "Identity read failed")
		return
	}
	key := "groups"
	fields := []string{"id", "name", "enabled", "type", "username", "monitorAccount", "forwardAccount", "ownerPeerId", "backupPeerId", "rescueMode", "rescueRetentionHours", "ttl", "tags", "filters", "autoForward", "trackUsers", "topics", "suspended"}
	if strings.Contains(r.URL.Path, "/accounts/") {
		key = "accounts"
		fields = []string{"id", "label", "phone", "disabled"}
	}
	items, _ := cfg[key].([]any)
	out := make([]map[string]any, 0, len(items))
	for _, raw := range items {
		m, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		item := map[string]any{}
		for _, field := range fields {
			if v, ok := m[field]; ok {
				item[field] = peerMetadata(v)
			}
		}
		if key == "accounts" {
			item["disabled"] = m["disabled"] == true
		}
		out = append(out, item)
	}
	writeJSON(w, 200, map[string]any{key: out, "peerId": i.PeerID, "now": time.Now().UnixMilli()})
}

// Do not forward credentials hidden in custom nested filter/topic metadata.
func peerMetadata(value any) any {
	switch v := value.(type) {
	case map[string]any:
		out := map[string]any{}
		for key, item := range v {
			k := strings.ToLower(key)
			if strings.Contains(k, "secret") || strings.Contains(k, "password") || strings.Contains(k, "token") || strings.Contains(k, "session") || k == "apihash" || k == "api_hash" {
				continue
			}
			out[key] = peerMetadata(item)
		}
		return out
	case []any:
		out := make([]any, len(v))
		for i, item := range v {
			out[i] = peerMetadata(item)
		}
		return out
	default:
		return value
	}
}
