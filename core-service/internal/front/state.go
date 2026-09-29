package front

import (
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
)

// State is what the Node app pushes over the control channel
// (POST /v1/front/state): the parts of its config and middleware the fast
// path must agree with. Until the first push — or when a field says the
// fast path can't reproduce Node — every request is proxied.
type State struct {
	// Version increases with every push; /health reports the last one.
	Version int64 `json:"version"`
	// config.web.enabled !== false && isAuthConfigured(config.web)
	AuthReady bool `json:"authReady"`
	// config.web.forceHttps
	ForceHTTPS bool `json:"forceHttps"`
	// config.web.rateLimit.enabled (the /api limiter counts every request)
	RateLimit bool `json:"rateLimit"`
	// config.web.shareSecret (hex), for the /files bearer tokens.
	ShareSecret string `json:"shareSecret"`
	// The headers Node's middleware chain (HSTS, helmet / CSP, the cache
	// policy) and the route put on a response, per fast-path route
	// ("files", "photos", "thumbs"), in order, with Node's spelling. Node
	// computes them from its own middlewares at every push; nothing here
	// hardcodes a value.
	Headers map[string][][2]string `json:"headers"`

	secret []byte
}

const maxStateBytes = 256 << 10

func decodeState(r io.Reader) (*State, error) {
	var st State
	dec := json.NewDecoder(io.LimitReader(r, maxStateBytes))
	if err := dec.Decode(&st); err != nil {
		return nil, err
	}
	if st.ShareSecret != "" {
		b, err := hex.DecodeString(st.ShareSecret)
		if err != nil || len(b) == 0 {
			return nil, errors.New("shareSecret must be hex")
		}
		st.secret = b
	}
	for _, list := range st.Headers {
		for _, h := range list {
			if h[0] == "" || strings.ContainsAny(h[0]+h[1], "\r\n") {
				return nil, errors.New("invalid header in state")
			}
		}
	}
	return &st, nil
}

// routeHeaders are the headers Node's response to a fast-path route
// starts with. ok is false when Node didn't push them (older Node, or a
// route it doesn't want answered here): the request is proxied.
func (st *State) routeHeaders(route string) (hdrList, bool) {
	list, ok := st.Headers[route]
	if !ok {
		return nil, false
	}
	h := make(hdrList, 0, len(list)+8)
	for _, x := range list {
		h = append(h, hdr{x[0], x[1]})
	}
	return h, true
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
