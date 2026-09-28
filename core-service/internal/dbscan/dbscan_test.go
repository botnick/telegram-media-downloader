package dbscan

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"net/http/httptest"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

// ---- fixtures -------------------------------------------------------------

// synthFaces ports the generator of tests/ai/dbscan.test.js: unit vectors
// around k identity centres plus strangers, from a 32-bit LCG. (Math.log /
// Math.cos may differ from Go's in the last ulp, so the data is not
// bit-identical to the JS fixture; these tests compare Go with Go.)
type lcg struct{ s uint32 }

func (l *lcg) rnd() float64 {
	l.s = l.s*1664525 + 1013904223
	return float64(l.s) / 4294967296
}

func (l *lcg) gauss() float64 {
	u := l.rnd()
	if u == 0 {
		u = 1e-9
	}
	a := math.Sqrt(-2 * math.Log(u))
	return a * math.Cos(2*math.Pi*l.rnd())
}

func unit(a []float32) []float32 {
	t := 0.0
	for _, v := range a {
		t += float64(float64(v) * float64(v))
	}
	t = math.Sqrt(t)
	out := make([]float32, len(a))
	for i, v := range a {
		out[i] = float32(float64(v) / t)
	}
	return out
}

type synthOpts struct {
	k         int
	dim       int
	seed      uint32
	noise     float64
	strangers float64
}

func synthFaces(n int, o synthOpts) (data []float32, weights []float64) {
	if o.k == 0 {
		o.k = 8
	}
	if o.dim == 0 {
		o.dim = 64
	}
	if o.noise == 0 {
		o.noise = 0.12
	}
	if o.strangers < 0 {
		o.strangers = 0
	} else if o.strangers == 0 {
		o.strangers = 0.15
	}
	l := &lcg{s: o.seed}
	gaussVec := func() []float32 {
		v := make([]float32, o.dim)
		for i := range v {
			v[i] = float32(l.gauss())
		}
		return v
	}
	centres := make([][]float32, o.k)
	for c := range centres {
		centres[c] = unit(gaussVec())
	}
	data = make([]float32, 0, n*o.dim)
	weights = make([]float64, n)
	for i := 0; i < n; i++ {
		var base []float32
		if l.rnd() < o.strangers {
			base = unit(gaussVec())
		} else {
			base = centres[int(math.Floor(l.rnd()*float64(o.k)))]
		}
		e := make([]float32, o.dim)
		for d, v := range base {
			e[d] = float32(float64(v) + float64(l.gauss()*o.noise))
		}
		data = append(data, unit(e)...)
		if i%5 == 0 {
			weights[i] = math.NaN()
		} else {
			weights[i] = 0.3 + l.rnd()
		}
	}
	return data, weights
}

// ---- reference implementation ----------------------------------------------

// refDist is the original euclidean(): one accumulator, no early exit.
func refDist(a, b []float32) float64 {
	s := 0.0
	for i := range a {
		d := float64(a[i]) - float64(b[i])
		s += float64(d * d)
	}
	return math.Sqrt(s)
}

func refRegion(data []float32, n, dim, idx int, eps float64) []int32 {
	var out []int32
	p := data[idx*dim : (idx+1)*dim]
	for j := 0; j < n; j++ {
		if j == idx {
			continue
		}
		if refDist(p, data[j*dim:(j+1)*dim]) <= eps {
			out = append(out, int32(j))
		}
	}
	return out
}

// refLabels is refDbscan from tests/ai/dbscan.test.js: a stack that
// pushes a point once per core neighbour and pops from the front.
func refLabels(data []float32, n, dim int, eps, minPts float64) []int32 {
	if minPts < 2 {
		minPts = 2
	}
	labels := make([]int32, n)
	for i := range labels {
		labels[i] = -2
	}
	cluster := int32(-1)
	for i := 0; i < n; i++ {
		if labels[i] != -2 {
			continue
		}
		nb := refRegion(data, n, dim, i, eps)
		if float64(len(nb)+1) < minPts {
			labels[i] = -1
			continue
		}
		cluster++
		labels[i] = cluster
		stack := append([]int32(nil), nb...)
		for len(stack) > 0 {
			j := stack[0]
			stack = stack[1:]
			if labels[j] == -1 {
				labels[j] = cluster
			}
			if labels[j] != -2 {
				continue
			}
			labels[j] = cluster
			sub := refRegion(data, n, dim, int(j), eps)
			if float64(len(sub)+1) >= minPts {
				for _, k := range sub {
					if labels[k] == -2 {
						stack = append(stack, k)
					}
				}
			}
		}
	}
	return labels
}

type refClusterT struct {
	members  []int32
	centroid []float32
}

// refCluster is refClusterFaces: first-appearance groups, stable size sort,
// refCentroid over the members with quality weights (non-finite -> 1.0).
func refCluster(data []float32, n, dim int, weights []float64, eps, minPts float64) ([]refClusterT, int) {
	labels := refLabels(data, n, dim, eps, minPts)
	order := []int32{}
	groups := map[int32][]int32{}
	noiseN := 0
	for idx, l := range labels {
		if l < 0 {
			noiseN++
			continue
		}
		if _, ok := groups[l]; !ok {
			order = append(order, l)
		}
		groups[l] = append(groups[l], int32(idx))
	}
	out := make([]refClusterT, 0, len(order))
	for _, l := range order {
		m := groups[l]
		c := make([]float32, dim)
		totalW := 0.0
		for _, idx := range m {
			w := 1.0
			if weights != nil && !math.IsNaN(weights[idx]) && !math.IsInf(weights[idx], 0) && weights[idx] > 0 {
				w = weights[idx]
			}
			totalW += w
			for i := 0; i < dim; i++ {
				c[i] = float32(float64(c[i]) + float64(float64(data[int(idx)*dim+i])*w))
			}
		}
		if totalW <= 0 {
			totalW = 1
		}
		for i := range c {
			c[i] = float32(float64(c[i]) / totalW)
		}
		out = append(out, refClusterT{members: m, centroid: c})
	}
	// stable insertion sort by size desc
	for i := 1; i < len(out); i++ {
		for j := i; j > 0 && len(out[j].members) > len(out[j-1].members); j-- {
			out[j], out[j-1] = out[j-1], out[j]
		}
	}
	return out, noiseN
}

func equalLabels(t *testing.T, name string, got, want []int32) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("%s: %d labels, want %d", name, len(got), len(want))
	}
	for i := range got {
		if got[i] != want[i] {
			t.Fatalf("%s: label[%d] = %d, want %d", name, i, got[i], want[i])
		}
	}
}

func checkCluster(t *testing.T, name string, res Result, dim int, want []refClusterT, wantNoise int) {
	t.Helper()
	if res.Count != len(want) {
		t.Fatalf("%s: %d clusters, want %d", name, res.Count, len(want))
	}
	if res.NoiseCount != wantNoise {
		t.Fatalf("%s: noise %d, want %d", name, res.NoiseCount, wantNoise)
	}
	if len(res.Starts) != res.Count+1 || len(res.Centroids) != res.Count*dim {
		t.Fatalf("%s: packing sizes starts=%d centroids=%d", name, len(res.Starts), len(res.Centroids))
	}
	for c, w := range want {
		m := res.Members[res.Starts[c]:res.Starts[c+1]]
		if len(m) != len(w.members) {
			t.Fatalf("%s: cluster %d has %d members, want %d", name, c, len(m), len(w.members))
		}
		for i := range m {
			if m[i] != w.members[i] {
				t.Fatalf("%s: cluster %d member %d = %d, want %d", name, c, i, m[i], w.members[i])
			}
		}
		got := res.Centroids[c*dim : (c+1)*dim]
		for i := range got {
			if math.Float32bits(got[i]) != math.Float32bits(w.centroid[i]) {
				t.Fatalf("%s: cluster %d centroid[%d] = %v, want %v (bits differ)", name, c, i, got[i], w.centroid[i])
			}
		}
	}
	if int(res.Starts[res.Count]) != len(res.Members) {
		t.Fatalf("%s: last start %d != %d members", name, res.Starts[res.Count], len(res.Members))
	}
}

// ---- tests ------------------------------------------------------------------

func TestRejectBound(t *testing.T) {
	if b := RejectBound(math.NaN()); !math.IsInf(b, -1) {
		t.Fatalf("NaN eps -> %v, want -Inf", b)
	}
	if b := RejectBound(-1); !math.IsInf(b, -1) {
		t.Fatalf("negative eps -> %v, want -Inf", b)
	}
	if b := RejectBound(math.Inf(1)); !math.IsInf(b, 1) {
		t.Fatalf("+Inf eps -> %v, want +Inf", b)
	}
	if b := RejectBound(0); !(b > 0) || !(math.Sqrt(b) > 0) {
		t.Fatalf("eps 0 -> %v", b)
	}
	if b := RejectBound(math.Copysign(0, -1)); !(b > 0) {
		t.Fatalf("eps -0 -> %v", b)
	}
	l := &lcg{s: 42}
	samples := []float64{1.05, 0.6, 0.5, 1, 2, 1e-3, 1e-160, 1e150, 0.1, 0.7, 1.2}
	for i := 0; i < 2000; i++ {
		samples = append(samples, l.rnd()*3)
	}
	for _, eps := range samples {
		b := RejectBound(eps)
		if !(math.Sqrt(b) > eps) {
			t.Fatalf("eps %v: sqrt(bound %v) not > eps", eps, b)
		}
		if b < eps*eps {
			t.Fatalf("eps %v: bound %v below eps²", eps, b)
		}
		// minimal-ish: within a few ulps of eps² for normal eps
		if eps > 1e-150 && eps < 1e150 && b > eps*eps*(1+1e-14) {
			t.Fatalf("eps %v: bound %v too far above eps² %v", eps, b, eps*eps)
		}
		// the early exit never disagrees with the full test: anything just
		// above the bound is out, eps² itself is decided by sqrt.
		if math.Sqrt(math.Nextafter(b, math.Inf(1))) <= eps {
			t.Fatalf("eps %v: a sum above the bound would still be within", eps)
		}
	}
}

func TestPairKernelsMatchFullDistance(t *testing.T) {
	l := &lcg{s: 7}
	for _, dim := range []int{0, 1, 3, 4, 5, 31, 32, 33, 64, 70, 128, 512} {
		for trial := 0; trial < 60; trial++ {
			q := make([]float32, dim)
			rs := make([][]float32, 4)
			for i := range q {
				q[i] = float32(l.gauss())
			}
			for k := range rs {
				rs[k] = make([]float32, dim)
				for i := range rs[k] {
					rs[k][i] = float32(float64(q[i]) + l.gauss()*0.3)
				}
			}
			for _, epsKind := range []int{0, 1, 2} {
				// eps exactly at a pair's distance, one ulp below, or random
				full := refDist(q, rs[0])
				eps := full
				switch epsKind {
				case 1:
					eps = math.Nextafter(full, 0)
				case 2:
					eps = l.rnd() * 2 * (full + 0.1)
				}
				bound := RejectBound(eps)
				o0, o1, o2, o3 := rows4(q, rs[0], rs[1], rs[2], rs[3], eps, bound)
				p0, p1, p2, p3 := queries4(q, q, q, q, rs[0], eps, bound)
				for k, got := range []bool{o0, o1, o2, o3} {
					want := refDist(q, rs[k]) <= eps
					if got != want || pair(q, rs[k], eps, bound) != want {
						t.Fatalf("dim %d eps %v row %d: rows4 %v pair %v want %v", dim, eps, k, got, pair(q, rs[k], eps, bound), want)
					}
				}
				want0 := refDist(q, rs[0]) <= eps
				for _, got := range []bool{p0, p1, p2, p3} {
					if got != want0 {
						t.Fatalf("dim %d eps %v: queries4 %v want %v", dim, eps, got, want0)
					}
				}
			}
		}
	}
}

func TestNaNRowsAreNeverNeighbours(t *testing.T) {
	q := []float32{1, 2, 3}
	r := []float32{1, float32(math.NaN()), 3}
	for _, eps := range []float64{0, 1, 1e9} {
		if pair(q, r, eps, RejectBound(eps)) {
			t.Fatalf("eps %v: NaN row is a neighbour", eps)
		}
	}
	if pair(q, q, math.NaN(), RejectBound(math.NaN())) {
		t.Fatal("NaN eps: a point is within of itself")
	}
}

type labelCase struct {
	name   string
	n      int
	o      synthOpts
	eps    float64
	minPts float64
	nanRow int // -1 = none
}

var labelCases = []labelCase{
	{"mixed identities", 300, synthOpts{seed: 3}, 1.05, 2, -1},
	{"minPts 3 (border points)", 300, synthOpts{seed: 5}, 1.05, 3, -1},
	{"straddling eps", 250, synthOpts{seed: 7, noise: 0.16}, 1.05, 2, -1},
	{"tight eps", 250, synthOpts{seed: 9}, 0.6, 2, -1},
	{"one dominant person", 180, synthOpts{seed: 11, k: 1, strangers: 0.05}, 1.05, 2, -1},
	{"NaN row", 40, synthOpts{seed: 13}, 1.05, 2, 5},
	{"minPts 2.5", 300, synthOpts{seed: 15}, 1.05, 2.5, -1},
	{"minPts below 2", 120, synthOpts{seed: 17}, 1.05, 0, -1},
	{"dim 70 (partial blocks)", 300, synthOpts{seed: 19, dim: 70, noise: 0.14}, 1.05, 2, -1},
	{"parallel path, dim 64", 2500, synthOpts{seed: 21}, 1.05, 2, -1},
	{"parallel path, minPts 4, border", 2200, synthOpts{seed: 23, noise: 0.17}, 1.05, 4, -1},
	{"parallel path, dim 512", 1200, synthOpts{seed: 25, dim: 512, k: 12, noise: 0.04}, 1.05, 2, 17},
}

func caseData(c labelCase) ([]float32, []float64, int) {
	data, weights := synthFaces(c.n, c.o)
	dim := c.o.dim
	if dim == 0 {
		dim = 64
	}
	if c.nanRow >= 0 {
		for i := 0; i < dim; i++ {
			data[c.nanRow*dim+i] = float32(math.NaN())
		}
	}
	return data, weights, dim
}

func TestLabelsMatchReference(t *testing.T) {
	for _, c := range labelCases {
		c := c
		t.Run(c.name, func(t *testing.T) {
			t.Parallel()
			data, _, dim := caseData(c)
			want := refLabels(data, c.n, dim, c.eps, c.minPts)
			for _, w := range []int{1, 2, 8, 16} {
				got, err := Labels(context.Background(), data, c.n, dim, c.eps, c.minPts, w, nil)
				if err != nil {
					t.Fatal(err)
				}
				equalLabels(t, fmt.Sprintf("%s workers=%d", c.name, w), got, want)
			}
		})
	}
}

func TestClusterMatchesReference(t *testing.T) {
	for _, c := range labelCases {
		c := c
		t.Run(c.name, func(t *testing.T) {
			t.Parallel()
			data, weights, dim := caseData(c)
			want, wantNoise := refCluster(data, c.n, dim, weights, c.eps, c.minPts)
			for _, w := range []int{1, 8} {
				res, err := Cluster(context.Background(), data, c.n, dim, weights, c.eps, c.minPts, w, nil)
				if err != nil {
					t.Fatal(err)
				}
				checkCluster(t, fmt.Sprintf("%s workers=%d", c.name, w), res, dim, want, wantNoise)
			}
			// nil weights -> every weight is 1.0
			wantU, _ := refCluster(data, c.n, dim, nil, c.eps, c.minPts)
			res, err := Cluster(context.Background(), data, c.n, dim, nil, c.eps, c.minPts, 4, nil)
			if err != nil {
				t.Fatal(err)
			}
			checkCluster(t, c.name+" unweighted", res, dim, wantU, wantNoise)
		})
	}
}

// A later cluster can own a lower point index through a border point;
// groups must come out in first-appearance order, not label order.
func TestClusterFirstAppearanceOrder(t *testing.T) {
	// 1-D points, eps 1, minPts 3: point 0 is noise when visited (one
	// neighbour), cluster 0 forms at index 1 (points 1,2,3 around 10),
	// cluster 1 at index 4 (points 4,5 at -0.5,-1.2 plus 0 as border).
	data := []float32{0, 10, 10.5, 11, -0.5, -1.2}
	labels, err := Labels(context.Background(), data, 6, 1, 1, 3, 1, nil)
	if err != nil {
		t.Fatal(err)
	}
	equalLabels(t, "labels", labels, refLabels(data, 6, 1, 1, 3))
	if labels[0] != 1 || labels[1] != 0 {
		t.Fatalf("fixture no longer exercises the ordering: %v", labels)
	}
	res, err := Cluster(context.Background(), data, 6, 1, nil, 1, 3, 1, nil)
	if err != nil {
		t.Fatal(err)
	}
	// Both clusters have 3 members; stable sort keeps first appearance:
	// the cluster holding index 0 (label 1) comes first.
	if res.Count != 2 || res.Members[res.Starts[0]] != 0 {
		t.Fatalf("want cluster with point 0 first, got starts=%v members=%v", res.Starts, res.Members)
	}
}

func TestEdgeCases(t *testing.T) {
	ctx := context.Background()
	got, err := Labels(ctx, nil, 0, 0, 1, 2, 4, func(int, int) { t.Fatal("progress on empty input") })
	if err != nil || len(got) != 0 {
		t.Fatalf("empty: %v %v", got, err)
	}
	res, err := Cluster(ctx, nil, 0, 512, nil, 1, 2, 4, nil)
	if err != nil || res.Count != 0 || res.NoiseCount != 0 || len(res.Starts) != 1 || len(res.Members) != 0 {
		t.Fatalf("empty cluster: %+v %v", res, err)
	}
	got, _ = Labels(ctx, []float32{1, 2}, 1, 2, 1, 2, 1, nil)
	equalLabels(t, "single", got, []int32{-1})
	// dim 0: every distance is 0, so everything is one cluster (as in JS)
	got, _ = Labels(ctx, nil, 3, 0, 0.5, 2, 1, nil)
	equalLabels(t, "dim0", got, []int32{0, 0, 0})
	// NaN eps: nothing is within
	got, _ = Labels(ctx, []float32{0, 0, 0}, 3, 1, math.NaN(), 2, 1, nil)
	equalLabels(t, "nan eps", got, []int32{-1, -1, -1})
	// eps 0: only identical points
	got, _ = Labels(ctx, []float32{1, 1, 2}, 3, 1, 0, 2, 1, nil)
	equalLabels(t, "eps0", got, []int32{0, 0, -1})
	// non-finite minPts counts as 2
	got, _ = Labels(ctx, []float32{1, 1, 5}, 3, 1, 0.5, math.NaN(), 1, nil)
	equalLabels(t, "nan minPts", got, []int32{0, 0, -1})
	if _, err := Labels(ctx, []float32{1}, 2, 1, 1, 2, 1, nil); !errors.Is(err, ErrInput) {
		t.Fatalf("short data: %v", err)
	}
}

func TestProgress(t *testing.T) {
	data, _ := synthFaces(700, synthOpts{seed: 31})
	var calls [][2]int
	_, err := Labels(context.Background(), data, 700, 64, 1.05, 2, 4, func(d, n int) {
		calls = append(calls, [2]int{d, n})
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(calls) == 0 || calls[len(calls)-1] != [2]int{700, 700} {
		t.Fatalf("progress calls %v, want a final (700, 700)", calls)
	}
}

func TestCancel(t *testing.T) {
	data, _ := synthFaces(6000, synthOpts{seed: 37, dim: 512, noise: 0.2})
	for _, w := range []int{1, 8} {
		ctx, cancel := context.WithCancel(context.Background())
		time.AfterFunc(30*time.Millisecond, cancel)
		t0 := time.Now()
		_, err := Labels(ctx, data, 6000, 512, 1.05, 2, w, nil)
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("workers=%d: err %v, want context.Canceled", w, err)
		}
		if el := time.Since(t0); el > 3*time.Second {
			t.Fatalf("workers=%d: took %v to stop", w, el)
		}
	}
}

// ---- handler ------------------------------------------------------------------

func encodeBody(data []float32, weights []float64) []byte {
	var b bytes.Buffer
	for _, v := range data {
		_ = binary.Write(&b, binary.LittleEndian, math.Float32bits(v))
	}
	for _, v := range weights {
		_ = binary.Write(&b, binary.LittleEndian, math.Float64bits(v))
	}
	return b.Bytes()
}

type streamed struct {
	progress [][2]int
	result   *resultLine
	errLine  *errorLine
}

func parseStream(t *testing.T, body []byte) streamed {
	t.Helper()
	var s streamed
	sc := bufio.NewScanner(bytes.NewReader(body))
	sc.Buffer(make([]byte, 1<<20), 64<<20)
	for sc.Scan() {
		var m map[string]json.RawMessage
		if err := json.Unmarshal(sc.Bytes(), &m); err != nil {
			t.Fatalf("bad line %q: %v", sc.Text(), err)
		}
		var kind string
		_ = json.Unmarshal(m["t"], &kind)
		switch kind {
		case "progress":
			var p progressLine
			_ = json.Unmarshal(sc.Bytes(), &p)
			s.progress = append(s.progress, [2]int{p.Done, p.N})
		case "result":
			var r resultLine
			_ = json.Unmarshal(sc.Bytes(), &r)
			s.result = &r
		case "error":
			var e errorLine
			_ = json.Unmarshal(sc.Bytes(), &e)
			s.errLine = &e
		default:
			t.Fatalf("unknown line %q", sc.Text())
		}
	}
	return s
}

func decodeResult(t *testing.T, r *resultLine) Result {
	t.Helper()
	dec := func(s string) []byte {
		b, err := base64.StdEncoding.DecodeString(s)
		if err != nil {
			t.Fatal(err)
		}
		return b
	}
	i32 := func(b []byte) []int32 {
		out := make([]int32, len(b)/4)
		for i := range out {
			out[i] = int32(binary.LittleEndian.Uint32(b[4*i:]))
		}
		return out
	}
	cb := dec(r.Centroids)
	cs := make([]float32, len(cb)/4)
	for i := range cs {
		cs[i] = math.Float32frombits(binary.LittleEndian.Uint32(cb[4*i:]))
	}
	return Result{Count: r.Count, NoiseCount: r.NoiseCount, Starts: i32(dec(r.Starts)), Members: i32(dec(r.Members)), Centroids: cs}
}

func sameResult(t *testing.T, got, want Result) {
	t.Helper()
	if got.Count != want.Count || got.NoiseCount != want.NoiseCount ||
		len(got.Starts) != len(want.Starts) || len(got.Members) != len(want.Members) || len(got.Centroids) != len(want.Centroids) {
		t.Fatalf("shape differs: got count=%d noise=%d, want count=%d noise=%d", got.Count, got.NoiseCount, want.Count, want.NoiseCount)
	}
	for i := range got.Starts {
		if got.Starts[i] != want.Starts[i] {
			t.Fatalf("starts[%d]", i)
		}
	}
	for i := range got.Members {
		if got.Members[i] != want.Members[i] {
			t.Fatalf("members[%d]", i)
		}
	}
	for i := range got.Centroids {
		if math.Float32bits(got.Centroids[i]) != math.Float32bits(want.Centroids[i]) {
			t.Fatalf("centroids[%d]", i)
		}
	}
}

func post(h http.Handler, query string, body []byte) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, "/v1/dbscan?"+query, bytes.NewReader(body))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestHandlerRejectsBadRequests(t *testing.T) {
	h := &Handler{Workers: 2}
	body3x2 := encodeBody([]float32{1, 2, 3, 4, 5, 6}, nil)
	cases := []struct {
		name, q string
		body    []byte
	}{
		{"missing n", "dim=2&eps=1&minPts=2", body3x2},
		{"negative n", "n=-1&dim=2&eps=1&minPts=2", body3x2},
		{"bad dim", "n=3&dim=x&eps=1&minPts=2", body3x2},
		{"too many values", "n=65536&dim=8192&eps=1&minPts=2", nil},
		{"too many points", fmt.Sprintf("n=%d&dim=0&eps=1&minPts=2", maxPoints+1), nil},
		{"bad eps", "n=3&dim=2&eps=abc&minPts=2", body3x2},
		{"infinite minPts", "n=3&dim=2&eps=1&minPts=Inf", body3x2},
		{"NaN minPts", "n=3&dim=2&eps=1&minPts=NaN", body3x2},
		{"bad weights flag", "n=3&dim=2&eps=1&minPts=2&weights=2", body3x2},
		{"short body", "n=3&dim=2&eps=1&minPts=2", body3x2[:23]},
		{"long body", "n=3&dim=2&eps=1&minPts=2", append(append([]byte{}, body3x2...), 0)},
		{"missing weights", "n=3&dim=2&eps=1&minPts=2&weights=1", body3x2},
	}
	for _, c := range cases {
		rec := post(h, c.q, c.body)
		if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), `"EINVAL"`) {
			t.Fatalf("%s: status %d body %s", c.name, rec.Code, rec.Body.String())
		}
	}
}

func TestHandlerStreamsResult(t *testing.T) {
	data, weights := synthFaces(900, synthOpts{seed: 41})
	want, err := Cluster(context.Background(), data, 900, 64, weights, 1.05, 2, 1, nil)
	if err != nil {
		t.Fatal(err)
	}
	h := &Handler{Workers: 6}
	rec := post(h, "n=900&dim=64&eps=1.05&minPts=2&weights=1", encodeBody(data, weights))
	if rec.Code != 200 || rec.Header().Get("Content-Type") != "application/x-ndjson" {
		t.Fatalf("status %d type %q body %.200s", rec.Code, rec.Header().Get("Content-Type"), rec.Body.String())
	}
	s := parseStream(t, rec.Body.Bytes())
	if s.result == nil || s.errLine != nil {
		t.Fatalf("no result line: %+v", s)
	}
	if len(s.progress) == 0 || s.progress[len(s.progress)-1] != [2]int{900, 900} {
		t.Fatalf("progress %v, want a final (900, 900)", s.progress)
	}
	sameResult(t, decodeResult(t, s.result), want)

	// Without weights: same as nil weights.
	wantU, _ := Cluster(context.Background(), data, 900, 64, nil, 1.05, 2, 1, nil)
	rec = post(h, "n=900&dim=64&eps=1.05&minPts=2", encodeBody(data, nil))
	s = parseStream(t, rec.Body.Bytes())
	if s.result == nil {
		t.Fatalf("no result: %s", rec.Body.String())
	}
	sameResult(t, decodeResult(t, s.result), wantU)

	// Empty input.
	rec = post(h, "n=0&dim=512&eps=1.05&minPts=2&weights=1", nil)
	s = parseStream(t, rec.Body.Bytes())
	if s.result == nil || s.result.Count != 0 || s.result.NoiseCount != 0 {
		t.Fatalf("empty: %s", rec.Body.String())
	}
}

func TestHandlerQueueFull(t *testing.T) {
	h := &Handler{Workers: 1}
	h.init()
	h.slot <- struct{}{} // a clustering is running
	h.waiting.Store(maxWaiting)
	rec := post(h, "n=1&dim=1&eps=1&minPts=2", encodeBody([]float32{1}, nil))
	if rec.Code != http.StatusServiceUnavailable || !strings.Contains(rec.Body.String(), "EQUEUEFULL") {
		t.Fatalf("status %d body %s", rec.Code, rec.Body.String())
	}
	<-h.slot
}

// Requests queue behind the running clustering and are served in turn.
func TestHandlerSerialises(t *testing.T) {
	data, _ := synthFaces(600, synthOpts{seed: 43})
	body := encodeBody(data, nil)
	h := &Handler{Workers: 2}
	var wg sync.WaitGroup
	codes := make([]int, 3)
	for i := range codes {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			rec := post(h, "n=600&dim=64&eps=1.05&minPts=2", body)
			if s := parseStream(t, rec.Body.Bytes()); s.result == nil {
				codes[i] = -1
				return
			}
			codes[i] = rec.Code
		}(i)
	}
	wg.Wait()
	for i, c := range codes {
		if c != 200 {
			t.Fatalf("request %d: %d", i, c)
		}
	}
}

// The server's ReadTimeout (30 s in tgdl-core) must not cancel a
// clustering that runs longer than it.
func TestHandlerOutlivesReadTimeout(t *testing.T) {
	data, _ := synthFaces(300, synthOpts{seed: 47})
	h := &Handler{Workers: 2, beforeCompute: func() { time.Sleep(700 * time.Millisecond) }}
	srv := httptest.NewUnstartedServer(h)
	srv.Config.ReadTimeout = 200 * time.Millisecond
	srv.Start()
	defer srv.Close()
	resp, err := http.Post(srv.URL+"/v1/dbscan?n=300&dim=64&eps=1.05&minPts=2", "application/octet-stream", bytes.NewReader(encodeBody(data, nil)))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var buf bytes.Buffer
	_, _ = buf.ReadFrom(resp.Body)
	s := parseStream(t, buf.Bytes())
	if s.result == nil {
		t.Fatalf("no result after the read deadline: %q", buf.String())
	}
}

// Closing the connection mid-clustering stops the work.
func TestHandlerStopsWhenClientLeaves(t *testing.T) {
	data, _ := synthFaces(6000, synthOpts{seed: 53, dim: 512, noise: 0.2})
	done := make(chan struct{})
	h := &Handler{Workers: 4}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h.ServeHTTP(w, r)
		close(done)
	}))
	defer srv.Close()
	ctx, cancel := context.WithCancel(context.Background())
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, srv.URL+"/v1/dbscan?n=6000&dim=512&eps=1.05&minPts=2", bytes.NewReader(encodeBody(data, nil)))
	go func() {
		resp, err := http.DefaultClient.Do(req)
		if err == nil {
			_, _ = resp.Body.Read(make([]byte, 1)) // wait for the header
			cancel()
			resp.Body.Close()
		}
	}()
	time.AfterFunc(2*time.Second, cancel)
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("handler still running 10 s after the client left")
	}
}

// ---- benchmark ----------------------------------------------------------------

var (
	benchOnce sync.Once
	benchData []float32
)

func BenchmarkLabels5k512(b *testing.B) {
	benchOnce.Do(func() {
		benchData, _ = synthFaces(5000, synthOpts{seed: 12345, dim: 512, k: 40, noise: 0.05})
	})
	many := runtime.NumCPU() - 1
	if many < 1 {
		many = 1
	}
	for _, w := range []int{1, many} {
		b.Run(fmt.Sprintf("workers=%d", w), func(b *testing.B) {
			for i := 0; i < b.N; i++ {
				if _, err := Labels(context.Background(), benchData, 5000, 512, 1.05, 2, w, nil); err != nil {
					b.Fatal(err)
				}
			}
		})
	}
}
