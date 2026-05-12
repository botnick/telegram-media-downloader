// seekbar-cli — batch backfill / one-shot sprite tool. Reuses the same
// worker + config the HTTP service uses; the only difference is the
// input source (CLI args or a JSON list on stdin) and that the process
// exits when the queue drains.
//
// Examples:
//
//	# Single video
//	seekbar-cli --video-id abc123 --path /data/clips/abc.mp4
//
//	# Backfill every .mp4 under a directory tree
//	seekbar-cli --dir /data/clips
//
//	# Batch from stdin (one JSON object per line)
//	echo '{"video_id":"1","path":"/clips/a.mp4"}' | seekbar-cli --stdin
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/botnick/telegram-media-downloader/seekbar-service/internal/config"
	"github.com/botnick/telegram-media-downloader/seekbar-service/internal/logx"
	"github.com/botnick/telegram-media-downloader/seekbar-service/internal/worker"
)

func main() {
	var (
		configPath = flag.String("config", "", "path to config.yaml")
		videoID    = flag.String("video-id", "", "single video id (used with --path)")
		srcPath    = flag.String("path", "", "single source video path")
		dirPath    = flag.String("dir", "", "directory to walk for .mp4/.mov/.mkv/.webm/.avi")
		stdinJSON  = flag.Bool("stdin", false, "read one JSON request per line from stdin")
		listJobs   = flag.Bool("status", false, "print pool stats every second")
	)
	flag.Parse()

	cfg, err := config.Load(*configPath)
	if err != nil {
		fmt.Fprintln(os.Stderr, "config:", err)
		os.Exit(2)
	}
	log := logx.New(cfg.Log.Level, cfg.Log.Format)
	_ = os.MkdirAll(cfg.Storage.OutputDir, 0o755)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	pool := worker.NewPool(cfg, log)
	submitted := 0

	switch {
	case *videoID != "" && *srcPath != "":
		pool.Submit(&worker.Job{
			ID:      uuid.NewString(),
			VideoID: *videoID,
			SrcPath: *srcPath,
		})
		submitted = 1
	case *dirPath != "":
		submitted = walkDir(*dirPath, pool)
	case *stdinJSON:
		submitted = readStdin(pool)
	default:
		fmt.Fprintln(os.Stderr, "seekbar-cli: nothing to do — pass --video-id/--path, --dir, or --stdin")
		flag.Usage()
		os.Exit(2)
	}

	if submitted == 0 {
		fmt.Fprintln(os.Stderr, "seekbar-cli: 0 jobs queued")
		return
	}
	fmt.Fprintf(os.Stderr, "queued %d job(s)\n", submitted)

	pool.SetProgressCallback(func(done, total, ok, errored, queued int) {
		fmt.Fprintf(os.Stderr, "  progress: %d/%d (ok=%d err=%d queued=%d)\n", done, total, ok, errored, queued)
	})
	pool.Start(ctx, "")

	statusTicker := time.NewTicker(time.Second)
	defer statusTicker.Stop()
	for {
		total, done, _, _, queued := pool.LegacyStats()
		if total > 0 && done >= total && queued == 0 {
			break
		}
		if *listJobs {
			fmt.Fprintf(os.Stderr, "  total=%d done=%d queued=%d\n", total, done, queued)
		}
		<-statusTicker.C
	}
	pool.Stop()
	total, done, ok, errored, _ := pool.LegacyStats()
	fmt.Fprintf(os.Stderr, "done: %d/%d (ok=%d err=%d)\n", done, total, ok, errored)
}

func walkDir(root string, pool *worker.Pool) int {
	exts := map[string]bool{
		".mp4": true, ".mov": true, ".mkv": true, ".webm": true,
		".avi": true, ".m4v": true, ".ts": true, ".mpg": true, ".mpeg": true,
	}
	count := 0
	_ = filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() {
			return nil
		}
		if !exts[strings.ToLower(filepath.Ext(path))] {
			return nil
		}
		id := strings.TrimSuffix(filepath.Base(path), filepath.Ext(path))
		pool.Submit(&worker.Job{
			ID:      uuid.NewString(),
			VideoID: id,
			SrcPath: path,
		})
		count++
		return nil
	})
	return count
}

func readStdin(pool *worker.Pool) int {
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	type entry struct {
		VideoID string `json:"video_id"`
		Path    string `json:"path"`
	}
	count := 0
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		var e entry
		if err := json.Unmarshal([]byte(line), &e); err != nil {
			continue
		}
		if e.VideoID == "" || e.Path == "" {
			continue
		}
		pool.Submit(&worker.Job{
			ID:      uuid.NewString(),
			VideoID: e.VideoID,
			SrcPath: e.Path,
		})
		count++
	}
	return count
}
