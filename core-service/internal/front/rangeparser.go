package front

import (
	"math"
	"sort"
	"strings"
)

// byteRange is an inclusive byte range, like range-parser's {start, end}.
type byteRange struct {
	start, end float64
	index      int
}

const (
	rangeUnsatisfiable = -1
	rangeMalformed     = -2
)

// parseRange mirrors range-parser 1.2.1 called by send as
// parseRange(size, header, {combine: true}). It returns the ranges, or a
// status of rangeUnsatisfiable (-1) / rangeMalformed (-2). Numbers are
// doubles, exactly as in JavaScript.
func parseRange(size float64, str string) ([]byteRange, int) {
	idx := strings.IndexByte(str, '=')
	if idx == -1 {
		return nil, rangeMalformed
	}
	var ranges []byteRange
	for i, part := range strings.Split(str[idx+1:], ",") {
		bounds := strings.Split(part, "-")
		start, sok := jsParseInt(bounds[0])
		end, eok := math.NaN(), false
		if len(bounds) > 1 {
			end, eok = jsParseInt(bounds[1])
		}
		if !sok {
			// -nnn
			start = size - end
			end = size - 1
		} else if !eok {
			// nnn-
			end = size - 1
		}
		if end > size-1 {
			end = size - 1
		}
		if math.IsNaN(start) || math.IsNaN(end) || start > end || start < 0 {
			continue
		}
		ranges = append(ranges, byteRange{start: start, end: end, index: i})
	}
	if len(ranges) < 1 {
		return nil, rangeUnsatisfiable
	}
	return combineRanges(ranges), 0
}

// combineRanges mirrors range-parser's combineRanges: overlapping and
// adjacent ranges are merged, the result keeps request order.
func combineRanges(ranges []byteRange) []byteRange {
	ordered := append([]byteRange(nil), ranges...)
	sort.SliceStable(ordered, func(a, b int) bool { return ordered[a].start < ordered[b].start })
	j := 0
	for i := 1; i < len(ordered); i++ {
		r := ordered[i]
		cur := &ordered[j]
		if r.start > cur.end+1 {
			j++
			ordered[j] = r
		} else if r.end > cur.end {
			cur.end = r.end
			if r.index < cur.index {
				cur.index = r.index
			}
		}
	}
	ordered = ordered[:j+1]
	sort.SliceStable(ordered, func(a, b int) bool { return ordered[a].index < ordered[b].index })
	return ordered
}
