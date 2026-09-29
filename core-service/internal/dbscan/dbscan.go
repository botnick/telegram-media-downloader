// Package dbscan is the face-clustering DBSCAN of the Node app
// (src/core/ai/dbscan.js), ported so that it produces the same labels,
// the same cluster order and byte-identical centroids.
//
// What has to match the JavaScript exactly:
//
//   - visit order: outer loop by point index, FIFO expansion queue, each
//     point enqueued at most once per cluster (QUEUED marker), noise
//     points only turned into border points when popped;
//   - distance: Σ (a[i] − b[i])² accumulated in ONE float64 per pair, in
//     dimension order, then math.Sqrt(sum) <= eps. Every product goes
//     through an explicit float64() conversion: the Go spec lets the
//     compiler fuse x*y + z into an FMA (arm64, ppc64, s390x do), and a
//     fused multiply-add rounds differently from V8's separate ops;
//   - the early exit every 32 dimensions against RejectBound(eps), which
//     never changes a decision (partial sums of squares only grow);
//   - clusters in first-appearance order by point index, stable-sorted by
//     size descending; centroids accumulated like the JS Float32Array
//     (float64 arithmetic, rounded to float32 after every step).
//
// The O(n²) neighbour search runs on several goroutines. Every point is
// region-queried exactly once and a query's answer never depends on the
// labels, so queries are computed ahead of time in parallel and consumed
// in the same order as the sequential algorithm: the labels do not depend
// on the number of workers.
package dbscan

import (
	"context"
	"errors"
	"fmt"
	"math"
	"sort"
	"sync"
	"sync/atomic"
	"time"
)

const (
	unvisited int32 = -2
	noise     int32 = -1
	queued    int32 = -3
)

// checkEvery matches CHECK_EVERY in dbscan.js: the running sum is compared
// with the reject bound after every 32 dimensions (and after the last,
// possibly shorter, block).
const checkEvery = 32

// numberEpsilon is JavaScript's Number.EPSILON (2^-52).
const numberEpsilon = 0x1p-52

// parallelMinPoints: below this many points the sequential path is used.
const parallelMinPoints = 512

// minChunkRows is the smallest row range one goroutine scans for a query.
const minChunkRows = 256

// RejectBound returns the smallest-ish B such that sum > B guarantees
// math.Sqrt(sum) > eps (a port of _rejectBound in dbscan.js).
func RejectBound(eps float64) float64 {
	if !(eps >= 0) {
		return math.Inf(-1) // NaN / negative eps: nothing is ever within
	}
	if math.IsInf(eps, 1) {
		return math.Inf(1)
	}
	b := eps * eps
	if b == 0 {
		b = math.SmallestNonzeroFloat64
	}
	for !(math.Sqrt(b) > eps) {
		step := float64(b * numberEpsilon)
		if step < math.SmallestNonzeroFloat64 {
			step = math.SmallestNonzeroFloat64
		}
		b += step
	}
	return b
}

// pair decides whether r is within eps of q.
func pair(q, r []float32, eps, bound float64) bool {
	n := len(q)
	r = r[:n]
	var s float64
	for i := 0; i < n; i += checkEvery {
		stop := i + checkEvery
		if stop > n {
			stop = n
		}
		qb := q[i:stop]
		rb := r[i:stop]
		rb = rb[:len(qb)]
		for k, qv := range qb {
			d := float64(qv) - float64(rb[k])
			s += float64(d * d)
		}
		if s > bound {
			return false
		}
	}
	return math.Sqrt(s) <= eps
}

// rows4 decides four rows against one query at once. Each pair keeps its
// own accumulator in dimension order, so every answer equals pair(q, r_k);
// the four independent chains only hide the add latency.
func rows4(q, r0, r1, r2, r3 []float32, eps, bound float64) (bool, bool, bool, bool) {
	n := len(q)
	r0, r1, r2, r3 = r0[:n], r1[:n], r2[:n], r3[:n]
	var s0, s1, s2, s3 float64
	var x0, x1, x2, x3 bool // rejected
	for i := 0; i < n; i += checkEvery {
		stop := i + checkEvery
		if stop > n {
			stop = n
		}
		qb := q[i:stop]
		b0 := r0[i:stop]
		b1 := r1[i:stop]
		b2 := r2[i:stop]
		b3 := r3[i:stop]
		b0, b1, b2, b3 = b0[:len(qb)], b1[:len(qb)], b2[:len(qb)], b3[:len(qb)]
		for k, qv := range qb {
			a := float64(qv)
			d0 := a - float64(b0[k])
			s0 += float64(d0 * d0)
			d1 := a - float64(b1[k])
			s1 += float64(d1 * d1)
			d2 := a - float64(b2[k])
			s2 += float64(d2 * d2)
			d3 := a - float64(b3[k])
			s3 += float64(d3 * d3)
		}
		if s0 > bound {
			x0 = true
		}
		if s1 > bound {
			x1 = true
		}
		if s2 > bound {
			x2 = true
		}
		if s3 > bound {
			x3 = true
		}
		if x0 && x1 && x2 && x3 {
			return false, false, false, false
		}
	}
	return !x0 && math.Sqrt(s0) <= eps,
		!x1 && math.Sqrt(s1) <= eps,
		!x2 && math.Sqrt(s2) <= eps,
		!x3 && math.Sqrt(s3) <= eps
}

// queries4 decides one row against four queries at once (the row is read
// once for all four). Same per-pair arithmetic as pair(q_k, r).
func queries4(q0, q1, q2, q3, r []float32, eps, bound float64) (bool, bool, bool, bool) {
	n := len(r)
	q0, q1, q2, q3 = q0[:n], q1[:n], q2[:n], q3[:n]
	var s0, s1, s2, s3 float64
	var x0, x1, x2, x3 bool
	for i := 0; i < n; i += checkEvery {
		stop := i + checkEvery
		if stop > n {
			stop = n
		}
		rb := r[i:stop]
		a0 := q0[i:stop]
		a1 := q1[i:stop]
		a2 := q2[i:stop]
		a3 := q3[i:stop]
		a0, a1, a2, a3 = a0[:len(rb)], a1[:len(rb)], a2[:len(rb)], a3[:len(rb)]
		for k, rv := range rb {
			b := float64(rv)
			d0 := float64(a0[k]) - b
			s0 += float64(d0 * d0)
			d1 := float64(a1[k]) - b
			s1 += float64(d1 * d1)
			d2 := float64(a2[k]) - b
			s2 += float64(d2 * d2)
			d3 := float64(a3[k]) - b
			s3 += float64(d3 * d3)
		}
		if s0 > bound {
			x0 = true
		}
		if s1 > bound {
			x1 = true
		}
		if s2 > bound {
			x2 = true
		}
		if s3 > bound {
			x3 = true
		}
		if x0 && x1 && x2 && x3 {
			return false, false, false, false
		}
	}
	return !x0 && math.Sqrt(s0) <= eps,
		!x1 && math.Sqrt(s1) <= eps,
		!x2 && math.Sqrt(s2) <= eps,
		!x3 && math.Sqrt(s3) <= eps
}

// engine answers region queries: the indices within eps of a point, in
// ascending order, excluding the point itself.
type engine struct {
	data       []float32
	n, dim     int
	eps, bound float64
	workers    int
}

func (e *engine) row(j int) []float32 { return e.data[j*e.dim : (j+1)*e.dim] }

// scanOne appends the neighbours of idx among rows [j0, j1) to out.
func (e *engine) scanOne(idx int32, j0, j1 int, out []int32) []int32 {
	q := e.row(int(idx))
	self := int(idx)
	j := j0
	for ; j+4 <= j1; j += 4 {
		ok0, ok1, ok2, ok3 := rows4(q, e.row(j), e.row(j+1), e.row(j+2), e.row(j+3), e.eps, e.bound)
		if ok0 && j != self {
			out = append(out, int32(j))
		}
		if ok1 && j+1 != self {
			out = append(out, int32(j+1))
		}
		if ok2 && j+2 != self {
			out = append(out, int32(j+2))
		}
		if ok3 && j+3 != self {
			out = append(out, int32(j+3))
		}
	}
	for ; j < j1; j++ {
		if j != self && pair(q, e.row(j), e.eps, e.bound) {
			out = append(out, int32(j))
		}
	}
	return out
}

// scanGroup fills outs[k] with the neighbours of qs[k] among rows [j0, j1).
// Four queries share one pass over the rows; fewer go one by one.
func (e *engine) scanGroup(qs []int32, j0, j1 int, outs [][]int32) {
	if len(qs) != 4 {
		for k, idx := range qs {
			outs[k] = e.scanOne(idx, j0, j1, outs[k])
		}
		return
	}
	i0, i1, i2, i3 := int(qs[0]), int(qs[1]), int(qs[2]), int(qs[3])
	q0, q1, q2, q3 := e.row(i0), e.row(i1), e.row(i2), e.row(i3)
	for j := j0; j < j1; j++ {
		ok0, ok1, ok2, ok3 := queries4(q0, q1, q2, q3, e.row(j), e.eps, e.bound)
		if ok0 && j != i0 {
			outs[0] = append(outs[0], int32(j))
		}
		if ok1 && j != i1 {
			outs[1] = append(outs[1], int32(j))
		}
		if ok2 && j != i2 {
			outs[2] = append(outs[2], int32(j))
		}
		if ok3 && j != i3 {
			outs[3] = append(outs[3], int32(j))
		}
	}
}

// compute answers every query in batch. With several workers the batch is
// split into groups of four queries and each group's row range into
// chunks; chunk results are concatenated in row order, so every answer is
// exactly the ascending list the sequential scan would produce.
func (e *engine) compute(batch []int32) [][]int32 {
	res := make([][]int32, len(batch))
	if e.workers <= 1 {
		for i, idx := range batch {
			res[i] = e.scanOne(idx, 0, e.n, nil)
		}
		return res
	}
	groups := (len(batch) + 3) / 4
	chunks := (2*e.workers + groups - 1) / groups
	if maxChunks := e.n / minChunkRows; chunks > maxChunks {
		chunks = maxChunks
	}
	if chunks < 1 {
		chunks = 1
	}
	tasks := groups * chunks
	parts := make([][][]int32, tasks)
	var next atomic.Int64
	var wg sync.WaitGroup
	nw := e.workers
	if nw > tasks {
		nw = tasks
	}
	for w := 0; w < nw; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				t := int(next.Add(1) - 1)
				if t >= tasks {
					return
				}
				g, c := t/chunks, t%chunks
				end := g*4 + 4
				if end > len(batch) {
					end = len(batch)
				}
				qs := batch[g*4 : end]
				j0 := c * e.n / chunks
				j1 := (c + 1) * e.n / chunks
				outs := make([][]int32, len(qs))
				e.scanGroup(qs, j0, j1, outs)
				parts[t] = outs
			}
		}()
	}
	wg.Wait()
	for g := 0; g < groups; g++ {
		base := g * 4
		for k := 0; base+k < len(batch) && k < 4; k++ {
			total := 0
			for c := 0; c < chunks; c++ {
				total += len(parts[g*chunks+c][k])
			}
			out := make([]int32, 0, total)
			for c := 0; c < chunks; c++ {
				out = append(out, parts[g*chunks+c][k]...)
			}
			res[base+k] = out
		}
	}
	return res
}

// ErrInput reports inconsistent n / dim / data sizes.
var ErrInput = errors.New("dbscan: invalid input")

// Labels runs DBSCAN over n points of dim float32s packed row-major in
// data and returns a label per point: a cluster id >= 0, or -1 for noise.
// It is dbscanFlat() from dbscan.js. workers <= 1 (or fewer than 512
// points) runs the plain sequential scan; the labels are the same either
// way. progress, when set, is called about once a second with the number
// of region queries done, and once more with (n, n) at the end.
func Labels(ctx context.Context, data []float32, n, dim int, eps, minPts float64, workers int, progress func(done, n int)) ([]int32, error) {
	if n < 0 || dim < 0 {
		return nil, fmt.Errorf("%w: n=%d dim=%d", ErrInput, n, dim)
	}
	// The request limits (handler.go), checked here too so every
	// allocation below is sized from a bounded n.
	if n > MaxPoints {
		return nil, fmt.Errorf("%w: n=%d is over %d", ErrInput, n, MaxPoints)
	}
	if dim > MaxDim {
		return nil, fmt.Errorf("%w: dim=%d is over %d", ErrInput, dim, MaxDim)
	}
	if int64(len(data)) < int64(n)*int64(dim) {
		return nil, fmt.Errorf("%w: %d values for n=%d dim=%d", ErrInput, len(data), n, dim)
	}
	// minPts = Math.max(2, Number.isFinite(minPts) ? minPts : 2)
	if math.IsNaN(minPts) || math.IsInf(minPts, 0) || minPts < 2 {
		minPts = 2
	}
	labels := make([]int32, n)
	for i := range labels {
		labels[i] = unvisited
	}
	if n == 0 {
		return labels, nil
	}
	if workers < 1 || n < parallelMinPoints {
		workers = 1
	}
	e := &engine{data: data[:n*dim], n: n, dim: dim, eps: eps, bound: RejectBound(eps), workers: workers}
	batchMax := 1
	if workers > 1 {
		batchMax = 4 * workers
	}

	// Answers computed ahead of use. Each point is queried exactly once,
	// so every cached answer is consumed; at most two prefetch batches
	// are outstanding at a time.
	cache := make(map[int32][]int32)
	take := func(k int32) ([]int32, bool) {
		v, ok := cache[k]
		if ok {
			delete(cache, k)
		}
		return v, ok
	}
	fill := func(batch []int32) []int32 {
		res := e.compute(batch)
		for i := 1; i < len(batch); i++ {
			cache[batch[i]] = res[i]
		}
		return res[0]
	}

	queue := make([]int32, n)
	var head, tail int
	scanPos := 0 // outer-loop prefetch frontier
	qscan := 0   // expansion prefetch frontier (queue position)

	// Seed query for the outer loop at k, prefetching the next unvisited
	// points (the outer loop will query them unless an expansion does).
	fetchOuter := func(k int) ([]int32, error) {
		if v, ok := take(int32(k)); ok {
			return v, nil
		}
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		batch := []int32{int32(k)}
		p := k + 1
		if scanPos > p {
			p = scanPos
		}
		for ; p < n && len(batch) < batchMax; p++ {
			if labels[p] == unvisited {
				if _, ok := cache[int32(p)]; !ok {
					batch = append(batch, int32(p))
				}
			}
		}
		scanPos = p
		return fill(batch), nil
	}
	// Expansion query for j popped at queue position pos, prefetching the
	// QUEUED points behind it (each will be queried when popped).
	fetchQueued := func(j int32, pos int) ([]int32, error) {
		if v, ok := take(j); ok {
			return v, nil
		}
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		batch := []int32{j}
		p := pos + 1
		if qscan > p {
			p = qscan
		}
		for ; p < tail && len(batch) < batchMax; p++ {
			k := queue[p]
			if labels[k] == queued {
				if _, ok := cache[k]; !ok {
					batch = append(batch, k)
				}
			}
		}
		qscan = p
		return fill(batch), nil
	}

	queries := 0
	lastReport := time.Now()
	tick := func() error {
		queries++
		if queries&63 == 0 {
			if err := ctx.Err(); err != nil {
				return err
			}
			if progress != nil {
				if now := time.Now(); now.Sub(lastReport) >= time.Second {
					lastReport = now
					progress(queries, n)
				}
			}
		}
		return nil
	}

	cluster := int32(-1)
	for i := 0; i < n; i++ {
		if labels[i] != unvisited {
			continue
		}
		seed, err := fetchOuter(i)
		if err != nil {
			return nil, err
		}
		if err := tick(); err != nil {
			return nil, err
		}
		if float64(len(seed)+1) < minPts {
			labels[i] = noise
			continue
		}
		cluster++
		labels[i] = cluster
		// Every neighbour of the seed is enqueued (noise ones become
		// border points on pop); unvisited ones are marked so later
		// expansions don't enqueue them a second time.
		head, tail, qscan = 0, 0, 0
		for _, k := range seed {
			queue[tail] = k
			tail++
			if labels[k] == unvisited {
				labels[k] = queued
			}
		}
		for head < tail {
			j := queue[head]
			head++
			if labels[j] == noise {
				labels[j] = cluster // border point
			}
			if labels[j] != queued {
				continue
			}
			labels[j] = cluster
			sub, err := fetchQueued(j, head-1)
			if err != nil {
				return nil, err
			}
			if err := tick(); err != nil {
				return nil, err
			}
			if float64(len(sub)+1) >= minPts {
				for _, k := range sub {
					if labels[k] == unvisited {
						labels[k] = queued
						queue[tail] = k
						tail++
					}
				}
			}
		}
	}
	if progress != nil {
		progress(n, n)
	}
	return labels, nil
}

// Result is the clustering in the packed form cluster-worker.js posts:
// cluster c owns Members[Starts[c]:Starts[c+1]] and centroid
// Centroids[c*dim:(c+1)*dim]. Clusters are ordered by size, largest first.
type Result struct {
	Count      int
	NoiseCount int
	Starts     []int32 // Count+1 offsets into Members
	Members    []int32
	Centroids  []float32 // Count*dim
}

// Cluster runs Labels and summarises the clusters exactly like
// clusterFlat() in dbscan.js plus the packing in cluster-worker.js.
// weights (per point, may be nil) weight the centroids; NaN, ±Inf and
// values <= 0 count as 1.0.
func Cluster(ctx context.Context, data []float32, n, dim int, weights []float64, eps, minPts float64, workers int, progress func(done, n int)) (Result, error) {
	labels, err := Labels(ctx, data, n, dim, eps, minPts, workers, progress)
	if err != nil {
		return Result{}, err
	}
	// Groups in first-appearance order by point index (a later cluster
	// can own a lower index through a border point, so this is not
	// label order).
	var groups [][]int32
	groupOf := map[int32]int{}
	noiseCount := 0
	for idx := 0; idx < n; idx++ {
		l := labels[idx]
		if l < 0 {
			noiseCount++
			continue
		}
		g, ok := groupOf[l]
		if !ok {
			g = len(groups)
			groupOf[l] = g
			groups = append(groups, nil)
		}
		groups[g] = append(groups[g], int32(idx))
	}
	// Array.prototype.sort is stable: ties keep first-appearance order.
	sort.SliceStable(groups, func(a, b int) bool { return len(groups[a]) > len(groups[b]) })

	res := Result{
		Count:      len(groups),
		NoiseCount: noiseCount,
		Starts:     make([]int32, len(groups)+1),
		Centroids:  make([]float32, len(groups)*dim),
	}
	total := 0
	for c, g := range groups {
		res.Starts[c] = int32(total)
		total += len(g)
	}
	res.Starts[len(groups)] = int32(total)
	res.Members = make([]int32, 0, total)
	for c, g := range groups {
		res.Members = append(res.Members, g...)
		centroidInto(res.Centroids[c*dim:(c+1)*dim], data, dim, g, weights)
	}
	return res, nil
}

// centroidInto writes the weighted mean of the member rows into out, with
// the arithmetic of _centroidOf in dbscan.js: out is a Float32Array, so
// every `out[i] += data[off + i] * w` is a float64 multiply, a float64
// add and a rounding to float32.
func centroidInto(out []float32, data []float32, dim int, members []int32, weights []float64) {
	for i := range out {
		out[i] = 0
	}
	totalW := 0.0
	for _, idx := range members {
		raw := 1.0
		if weights != nil {
			if int(idx) < len(weights) {
				raw = weights[idx]
			} else {
				raw = math.NaN() // weights[idx] === undefined
			}
		}
		w := raw
		if math.IsNaN(raw) || math.IsInf(raw, 0) || !(raw > 0) {
			w = 1.0
		}
		totalW += w
		row := data[int(idx)*dim : int(idx)*dim+dim]
		for i, v := range row {
			out[i] = float32(float64(out[i]) + float64(float64(v)*w))
		}
	}
	if totalW <= 0 {
		totalW = 1
	}
	for i := range out {
		out[i] = float32(float64(out[i]) / totalW)
	}
}
