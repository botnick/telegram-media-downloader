package nsfw

import (
	"bytes"
	"image"
	"image/draw"
	_ "image/gif" // decoders for PrepareUpload
	"image/jpeg"
	_ "image/png"
	"sort"
)

const (
	downscaleOverBytes = 3 << 19 // 1.5 MiB
	downscaleMaxEdge   = 1024
)

// PrepareUpload shrinks large images before they cross the network: the
// model looks at 224–384 px anyway, and it keeps requests well below proxy
// body limits. Formats the standard library cannot decode are returned
// unchanged and left to the sidecar.
func PrepareUpload(data []byte) []byte {
	if len(data) <= downscaleOverBytes {
		return data
	}
	cfg, _, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil || cfg.Width <= 0 || cfg.Height <= 0 || cfg.Width > 1<<14 || cfg.Height > 1<<14 {
		return data
	}
	src, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return data
	}
	var buf bytes.Buffer
	if jpeg.Encode(&buf, fitInside(src, downscaleMaxEdge), &jpeg.Options{Quality: 90}) != nil || buf.Len() >= len(data) {
		return data
	}
	return buf.Bytes()
}

// fitInside scales src down (never up) so its longer edge is at most edge,
// using nearest-neighbour sampling.
func fitInside(src image.Image, edge int) image.Image {
	b := src.Bounds()
	w, h := b.Dx(), b.Dy()
	if w <= edge && h <= edge {
		return src
	}
	nw, nh := edge, max(1, h*edge/w)
	if h > w {
		nw, nh = max(1, w*edge/h), edge
	}
	dst := image.NewRGBA(image.Rect(0, 0, nw, nh))
	for y := 0; y < nh; y++ {
		sy := b.Min.Y + y*h/nh
		for x := 0; x < nw; x++ {
			dst.Set(x, y, src.At(b.Min.X+x*w/nw, sy))
		}
	}
	return dst
}

// Sprite describes a seekbar sprite sheet.
type Sprite struct {
	Cols, Rows   int
	TileW, TileH int // TileH 0 = derive from the sheet height
	Frames       int
}

// SampleTiles picks up to limit evenly spaced tile indices.
func SampleTiles(frames, limit int) []int {
	if frames <= 0 || limit <= 0 {
		return nil
	}
	n := min(limit, frames)
	out := make([]int, n)
	for k := range out {
		out[k] = k * frames / n
	}
	return out
}

// SpriteTiles cuts the given tiles out of a decoded sprite sheet and encodes
// each as JPEG. Tiles outside the sheet are skipped.
func SpriteTiles(sheet image.Image, s Sprite, indices []int) [][]byte {
	b := sheet.Bounds()
	if s.Cols <= 0 || s.Rows <= 0 || s.TileW <= 0 {
		return nil
	}
	tileH := s.TileH
	if tileH <= 0 {
		tileH = b.Dy() / s.Rows
	}
	if tileH <= 0 {
		return nil
	}
	var out [][]byte
	for _, i := range indices {
		x0 := b.Min.X + (i%s.Cols)*s.TileW
		y0 := b.Min.Y + (i/s.Cols)*tileH
		r := image.Rect(x0, y0, x0+s.TileW, y0+tileH).Intersect(b)
		if r.Dx() < s.TileW/2 || r.Dy() < tileH/2 {
			continue
		}
		tile := image.NewRGBA(image.Rect(0, 0, r.Dx(), r.Dy()))
		draw.Draw(tile, tile.Bounds(), sheet, r.Min, draw.Src)
		var buf bytes.Buffer
		if jpeg.Encode(&buf, tile, &jpeg.Options{Quality: 85}) == nil {
			out = append(out, buf.Bytes())
		}
	}
	return out
}

// TopKMean is the 2.x video aggregation: the mean of the three highest tile
// scores, so a single odd frame cannot decide the whole video.
func TopKMean(scores []float64) float64 {
	if len(scores) == 0 {
		return 0
	}
	s := append([]float64(nil), scores...)
	sort.Sort(sort.Reverse(sort.Float64Slice(s)))
	k := min(3, len(s))
	sum := 0.0
	for _, v := range s[:k] {
		sum += v
	}
	return sum / float64(k)
}
