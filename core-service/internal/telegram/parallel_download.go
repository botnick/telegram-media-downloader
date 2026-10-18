package telegram

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"strconv"
	"sync"

	"github.com/gotd/td/tg"
	"github.com/gotd/td/tgerr"
)

// One file used to be fetched one part at a time: ask for 1 MiB, wait for it,
// ask for the next. Its speed was then set by the round trip to the
// datacenter, not by bandwidth (about 1.3 MB/s far from the DC, issue #111).
// fetchParallel keeps several part requests of the same file in flight and
// still writes the parts to the output in order, so the hashing, bandwidth
// limit and .part publishing downstream see the same byte stream as before.

// maxDownloadThreads is the most part requests one file keeps in flight
// (TGDL_DOWNLOAD_THREADS, 1 restores the one-part-at-a-time download).
var maxDownloadThreads = downloadThreadsFromEnv(os.Getenv("TGDL_DOWNLOAD_THREADS"))

const defaultDownloadThreads = 4

func downloadThreadsFromEnv(value string) int {
	n, err := strconv.Atoi(value)
	if err != nil || n < 1 {
		return defaultDownloadThreads
	}
	return min(n, 16)
}

// Clean files in a row before a throttled account gets one thread back.
const threadRecoveryFiles = 8

// threadTuner adapts an account's threads per file to Telegram: a FLOOD_WAIT
// during a file halves them, and a run of files without one adds one back.
type threadTuner struct {
	mu      sync.Mutex
	max     int
	current int
	clean   int
}

func newThreadTuner(max int) *threadTuner {
	return &threadTuner{max: max, current: max}
}

func (t *threadTuner) threads() int {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.current
}

func (t *threadTuner) record(flooded bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if flooded {
		t.current = max(1, t.current/2)
		t.clean = 0
		return
	}
	if t.current >= t.max {
		return
	}
	if t.clean++; t.clean >= threadRecoveryFiles {
		t.current++
		t.clean = 0
	}
}

type partFetcher interface {
	UploadGetFile(context.Context, *tg.UploadGetFileRequest) (tg.UploadFileClass, error)
}

// fetchParallel writes the file at loc to w, keeping up to threads part
// requests in flight. size is the size Telegram reported; parts past a short
// one are dropped and a file longer than reported is read on to its end, so a
// wrong size cannot truncate or pad the output. At most threads parts are
// held in memory.
func fetchParallel(ctx context.Context, api partFetcher, loc tg.InputFileLocationClass, size int64, threads int, w io.Writer) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	type result struct {
		index int
		data  []byte
		err   error
	}
	parts := int((size + downloadPartSize - 1) / downloadPartSize)
	results := make(chan result, threads)
	next, inflight := 0, 0
	launch := func() {
		index := next
		next++
		inflight++
		go func() {
			data, err := fetchPart(ctx, api, loc, int64(index)*downloadPartSize)
			results <- result{index, data, err}
		}()
	}
	pending := map[int][]byte{}
	written, last := 0, downloadPartSize
	var failure error
	for {
		for failure == nil && next < parts && next-written < threads {
			launch()
		}
		if inflight == 0 {
			break
		}
		r := <-results
		inflight--
		if failure != nil || r.index >= parts {
			continue
		}
		if r.err != nil {
			failure = r.err
			cancel()
			continue
		}
		pending[r.index] = r.data
		for written < parts {
			data, ok := pending[written]
			if !ok {
				break
			}
			delete(pending, written)
			if _, err := w.Write(data); err != nil {
				failure = err
				cancel()
				break
			}
			written++
			if last = len(data); last < downloadPartSize {
				parts = written
			}
		}
	}
	if failure != nil {
		return failure
	}
	// Telegram reported less than it holds: read on until a short part.
	for offset := int64(written) * downloadPartSize; last == downloadPartSize; offset += downloadPartSize {
		data, err := fetchPart(ctx, api, loc, offset)
		if err != nil {
			return err
		}
		if _, err := w.Write(data); err != nil {
			return err
		}
		last = len(data)
	}
	return nil
}

// Timeouts one part may retry, as the library's own reader does.
const partTimeoutRetries = 20

func fetchPart(ctx context.Context, api partFetcher, loc tg.InputFileLocationClass, offset int64) ([]byte, error) {
	for try := 0; ; try++ {
		res, err := api.UploadGetFile(ctx, &tg.UploadGetFileRequest{Location: loc, Offset: offset, Limit: downloadPartSize})
		if err == nil {
			file, ok := res.(*tg.UploadFile)
			if !ok {
				return nil, fmt.Errorf("unexpected Telegram file response %T", res)
			}
			return file.Bytes, nil
		}
		if try >= partTimeoutRetries || !partTimeout(ctx, err) {
			return nil, err
		}
	}
}

func partTimeout(ctx context.Context, err error) bool {
	if ctx.Err() != nil {
		return false
	}
	if tgerr.Is(err, tg.ErrTimeout) || errors.Is(err, context.DeadlineExceeded) {
		return true
	}
	var netErr net.Error
	return errors.As(err, &netErr) && netErr.Timeout()
}
