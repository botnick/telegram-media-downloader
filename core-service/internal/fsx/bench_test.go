package fsx

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/botnick/telegram-media-downloader/core-service/internal/hash"
)

func benchPaths(b *testing.B) (*hash.Roots, []string) {
	tree := os.Getenv("FSX_BENCH_TREE")
	if tree == "" {
		b.Skip("FSX_BENCH_TREE not set")
	}
	r, _ := hash.NewRoots([]string{tree, filepath.Join(tree, "..", "nope"), filepath.Join(tree, "..", "hash")})
	var paths []string
	for i := 0; i < 64; i++ {
		paths = append(paths, filepath.Join(tree, "group-"+itoa3(i % 50)[1:], []string{"images", "videos", "documents"}[i%3], "2024-01-01T00_00_00_"+itoa3(i)+".bin"))
	}
	return r, paths
}

func BenchmarkStatBatch64(b *testing.B) {
	r, paths := benchPaths(b)
	dc := NewDirCache(DirCacheTTL)
	for i := 0; i < b.N; i++ {
		_, _ = StatBatch(context.Background(), r, paths, 16, dc)
	}
}

func BenchmarkStatPathOnly(b *testing.B) {
	_, paths := benchPaths(b)
	for i := 0; i < b.N; i++ {
		StatPath(paths[i%64])
	}
}

func BenchmarkCheckPath(b *testing.B) {
	r, paths := benchPaths(b)
	for i := 0; i < b.N; i++ {
		checkPath(r, paths[i%64])
	}
}
