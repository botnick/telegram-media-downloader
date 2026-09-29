package front

import (
	"encoding/hex"
	"encoding/json"
	"net/http"
	"os"
	"testing"
)

// testdata/conformance.json holds inputs and the answers the Node
// libraries give (scripts/gen-front-conformance.js; tests/front-mime.test.js
// checks it is current). Where a port says it is certain, it must agree.

type conformance struct {
	Ranges []struct {
		Size   float64         `json:"size"`
		Header string          `json:"header"`
		Result json.RawMessage `json:"result"`
	} `json:"ranges"`
	Trust []struct {
		Setting   string            `json:"setting"`
		Addr      string            `json:"addr"`
		Trusted   bool              `json:"trusted"`
		Protocols map[string]string `json:"protocols"`
	} `json:"trust"`
	Fresh []struct {
		Req   map[string]string `json:"req"`
		Res   map[string]string `json:"res"`
		Fresh bool              `json:"fresh"`
	} `json:"fresh"`
	Mime []struct {
		Path string `json:"path"`
		Type string `json:"type"`
	} `json:"mime"`
	Names []struct {
		Name    string `json:"name"`
		ASCII   string `json:"ascii"`
		Encoded string `json:"encoded"`
	} `json:"names"`
	Queries []struct {
		Query  string  `json:"query"`
		Token  *string `json:"token"`
		Inline *string `json:"inline"`
	} `json:"queries"`
	Cookies []struct {
		Header string  `json:"header"`
		Value  *string `json:"value"`
		Error  bool    `json:"error"`
	} `json:"cookies"`
	FileTokens struct {
		Secret string `json:"secret"`
		Cases  []struct {
			Token string  `json:"token"`
			Role  *string `json:"role"`
		} `json:"cases"`
	} `json:"fileTokens"`
}

func loadConformance(t *testing.T) conformance {
	t.Helper()
	b, err := os.ReadFile("testdata/conformance.json")
	if err != nil {
		t.Fatal(err)
	}
	var c conformance
	if err := json.Unmarshal(b, &c); err != nil {
		t.Fatal(err)
	}
	return c
}

func TestConformanceRangeParser(t *testing.T) {
	for _, tc := range loadConformance(t).Ranges {
		got, st := parseRange(tc.Size, tc.Header)
		var want any
		_ = json.Unmarshal(tc.Result, &want)
		switch w := want.(type) {
		case float64:
			if st != int(w) {
				t.Errorf("size %v %q: status %d, want %v", tc.Size, tc.Header, st, w)
			}
		case []any:
			if st != 0 || len(got) != len(w) {
				t.Errorf("size %v %q: got %v (status %d), want %v", tc.Size, tc.Header, got, st, w)
				continue
			}
			for i, r := range w {
				pair := r.([]any)
				if got[i].start != pair[0].(float64) || got[i].end != pair[1].(float64) {
					t.Errorf("size %v %q: range %d = %v-%v, want %v", tc.Size, tc.Header, i, got[i].start, got[i].end, pair)
				}
			}
		}
	}
}

func TestConformanceTrustProxy(t *testing.T) {
	for _, tc := range loadConformance(t).Trust {
		tp := parseTrustProxy(tc.Setting)
		if !tp.exact {
			t.Errorf("setting %q: not reproduced", tc.Setting)
			continue
		}
		if got := tp.trusts(tc.Addr, 0); got != tc.Trusted {
			t.Errorf("setting %q addr %s: trusted %v, want %v", tc.Setting, tc.Addr, got, tc.Trusted)
		}
		for xfp, want := range tc.Protocols {
			got, ok := tp.protocol(tc.Addr, xfp, true)
			if !ok || got != want {
				t.Errorf("setting %q addr %s xfp %q: protocol %q (ok %v), want %q", tc.Setting, tc.Addr, xfp, got, ok, want)
			}
		}
	}
}

func TestConformanceFresh(t *testing.T) {
	for _, tc := range loadConformance(t).Fresh {
		r, _ := http.NewRequest(http.MethodGet, "/", nil)
		for k, v := range tc.Req {
			r.Header.Set(k, v)
		}
		h := hdrList{{"ETag", tc.Res["etag"]}, {"Last-Modified", tc.Res["last-modified"]}}
		inm, _ := nodeHeader(r.Header, "If-None-Match")
		ims, _ := nodeHeader(r.Header, "If-Modified-Since")
		got, ok := isFresh(r, h, inm, ims)
		if ok && got != tc.Fresh {
			t.Errorf("%v: fresh %v, want %v", tc.Req, got, tc.Fresh)
		}
		if !ok {
			t.Errorf("%v: not reproduced", tc.Req)
		}
	}
}

func TestConformanceMime(t *testing.T) {
	for _, tc := range loadConformance(t).Mime {
		if got := sendContentType(tc.Path); got != tc.Type {
			t.Errorf("%s: %q, want %q", tc.Path, got, tc.Type)
		}
	}
}

func TestConformanceContentDispositionNames(t *testing.T) {
	for _, tc := range loadConformance(t).Names {
		if got := asciiFilename(tc.Name); got != tc.ASCII {
			t.Errorf("ascii(%q) = %q, want %q", tc.Name, got, tc.ASCII)
		}
		if got := encodeURIComponent(tc.Name); got != tc.Encoded {
			t.Errorf("encodeURIComponent(%q) = %q, want %q", tc.Name, got, tc.Encoded)
		}
	}
}

func TestConformanceQuery(t *testing.T) {
	for _, tc := range loadConformance(t).Queries {
		q, ok := parseNodeQuery(tc.Query)
		if !ok {
			continue // the request goes to Node
		}
		for name, want := range map[string]*string{"token": tc.Token, "inline": tc.Inline} {
			got, isStr := q.str(name)
			if (want != nil) != isStr || (want != nil && got != *want) {
				t.Errorf("%q: %s = %q (string %v), qs says %v", tc.Query, name, got, isStr, want)
			}
		}
	}
}

func TestConformanceCookies(t *testing.T) {
	for _, tc := range loadConformance(t).Cookies {
		h := http.Header{}
		if tc.Header != "" {
			h["Cookie"] = []string{tc.Header}
		}
		v, present, ok := sessionCookieValue(h)
		if !ok {
			continue // Node decides
		}
		if tc.Error {
			t.Errorf("%q: Node's middleware throws, the port claimed %q", tc.Header, v)
			continue
		}
		if present != (tc.Value != nil) || (present && v != *tc.Value) {
			t.Errorf("%q: %q (present %v), want %v", tc.Header, v, present, tc.Value)
		}
	}
}

func TestConformanceFileTokens(t *testing.T) {
	c := loadConformance(t).FileTokens
	secret, _ := hex.DecodeString(c.Secret)
	for i, tc := range c.Cases {
		role, ok := fileTokenRole(secret, tc.Token)
		if ok && (tc.Role == nil || *tc.Role != role) {
			t.Errorf("%q: allowed as %q, Node says %v", tc.Token, role, tc.Role)
		}
		// The tokens the app mints (the first three cases) are handled here.
		if i < 3 && !ok {
			t.Errorf("%q: canonical token not recognised", tc.Token)
		}
	}
}
