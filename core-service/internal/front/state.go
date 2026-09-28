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
	// The headers helmet sets on every response, in order, with Node's
	// spelling, e.g. ["Content-Security-Policy", "default-src 'self';…"].
	Helmet [][2]string `json:"helmet"`

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
	for _, h := range st.Helmet {
		if h[0] == "" || strings.ContainsAny(h[0]+h[1], "\r\n") {
			return nil, errors.New("invalid helmet header")
		}
	}
	return &st, nil
}

// baseHeaders are the headers every Node response starts with: the HSTS
// value of the forceHttps middleware, then helmet's (with
// upgrade-insecure-requests appended to the CSP when forceHttps is on and
// the request is secure).
func (st *State) baseHeaders(secure bool) hdrList {
	h := make(hdrList, 0, len(st.Helmet)+8)
	if st.ForceHTTPS {
		// Only reached for secure requests (others are Node's to redirect).
		h = append(h, hdr{"Strict-Transport-Security", "max-age=31536000; includeSubDomains"})
	} else {
		h = append(h, hdr{"Strict-Transport-Security", "max-age=0"})
	}
	for _, x := range st.Helmet {
		v := x[1]
		if st.ForceHTTPS && secure && strings.EqualFold(x[0], "Content-Security-Policy") &&
			!strings.Contains(v, "upgrade-insecure-requests") {
			v += ";upgrade-insecure-requests"
		}
		h = append(h, hdr{x[0], v})
	}
	return h
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
