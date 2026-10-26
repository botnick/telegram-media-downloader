package telegram

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/gotd/td/tg"
)

// Opt-in, read-only Telegram acceptance check. The manifest and independent
// encrypted test session are supplied by the operator, never stored in Git.
// Downloads use a private directory on the operator's disk, not the system
// temporary directory (which may be a RAM filesystem).
func TestLargeMediaLiveAcceptance(t *testing.T) {
	dir := os.Getenv("TGDL_LIVE_DOWNLOAD_DIR")
	if dir == "" {
		t.Skip("requires an explicit live download manifest and test session")
	}
	if verifyChunks {
		t.Fatal("unset TGDL_VERIFY_CHUNKS to measure the parallel download path")
	}
	var cfg struct {
		AppID   int
		AppHash string
		Files   []struct {
			ID, Channel, AccessHash, Message, Size int64
			SHA256                                 string
		}
	}
	data, err := os.ReadFile(filepath.Join(dir, "config.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err = json.Unmarshal(data, &cfg); err != nil {
		t.Fatal(err)
	}
	if len(cfg.Files) == 0 {
		t.Fatal("manifest has no files")
	}
	secret, err := os.ReadFile(filepath.Join(dir, "secret.key"))
	if err != nil {
		t.Fatal(err)
	}
	threads := 4
	if value := os.Getenv("TGDL_LIVE_DOWNLOAD_THREADS"); value != "" {
		threads, err = strconv.Atoi(value)
		if err != nil || threads < 1 || threads > 16 {
			t.Fatal("TGDL_LIVE_DOWNLOAD_THREADS must be between 1 and 16")
		}
	}
	client, err := NewGotdClient(GotdConfig{
		AppID: cfg.AppID, AppHash: cfg.AppHash,
		SessionPath: filepath.Join(dir, "session.enc"), SessionSecret: strings.TrimSpace(string(secret)),
	})
	if err != nil {
		t.Fatal(err)
	}
	client.threads = newThreadTuner(threads)
	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Minute)
	defer cancel()
	err = client.Run(ctx, func(ctx context.Context) error {
		for index, file := range cfg.Files {
			if !t.Run(fmt.Sprintf("file-%d", index), func(t *testing.T) {
				wantHash, e := hex.DecodeString(file.SHA256)
				if e != nil || len(wantHash) != sha256.Size || file.Size < 256<<20 {
					t.Fatal("manifest needs a SHA-256 digest and a file of at least 256 MiB")
				}
				fileCtx, fileCancel := context.WithTimeout(ctx, 15*time.Minute)
				defer fileCancel()
				page, e := client.API().ChannelsGetMessages(fileCtx, &tg.ChannelsGetMessagesRequest{
					Channel: &tg.InputChannel{ChannelID: file.Channel, AccessHash: file.AccessHash},
					ID:      []tg.InputMessageClass{&tg.InputMessageID{ID: int(file.Message)}},
				})
				if e != nil {
					t.Fatal(e)
				}
				var messages []tg.MessageClass
				switch p := page.(type) {
				case *tg.MessagesChannelMessages:
					messages = p.Messages
				case *tg.MessagesMessages:
					messages = p.Messages
				default:
					t.Fatalf("unexpected message response %T", page)
				}
				if len(messages) != 1 {
					t.Fatal("source message unavailable")
				}
				message, ok := messages[0].(*tg.Message)
				if !ok {
					t.Fatal("source message removed")
				}
				attachment, e := MessageAttachment(message)
				if e != nil {
					t.Fatal(e)
				}
				scratch, e := os.MkdirTemp(dir, "large-download-")
				if e != nil {
					t.Fatal(e)
				}
				defer os.RemoveAll(scratch)
				output, e := os.OpenFile(filepath.Join(scratch, "download.part"), os.O_CREATE|os.O_EXCL|os.O_RDWR, 0600)
				if e != nil {
					t.Fatal(e)
				}
				defer output.Close()
				usedThreads := client.threads.threads()
				floods := client.guard.floods.Load()
				started := time.Now()
				if e = client.DownloadMedia(fileCtx, attachment, &liveDownloadProgress{Writer: output, t: t, last: started}); e != nil {
					t.Fatal(e)
				}
				if e = output.Sync(); e != nil {
					t.Fatal(e)
				}
				elapsed := time.Since(started).Seconds()
				if _, e = output.Seek(0, io.SeekStart); e != nil {
					t.Fatal(e)
				}
				hash := sha256.New()
				size, e := io.Copy(hash, output)
				if e != nil {
					t.Fatal(e)
				}
				digest := hex.EncodeToString(hash.Sum(nil))
				if size != file.Size || digest != strings.ToLower(file.SHA256) {
					t.Fatal("download size or SHA-256 differs from the source file")
				}
				t.Logf("PASS bytes=%d threads=%d seconds=%.3f MiB/s=%.3f flood_waits=%d next_threads=%d SHA-256 matched after disk readback", size, usedThreads, elapsed, float64(size)/1048576/elapsed, client.guard.floods.Load()-floods, client.threads.threads())
			}) {
				return fmt.Errorf("stopped after failed live file check")
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

// Progress contains byte counts only, never message text, names or credentials.
type liveDownloadProgress struct {
	io.Writer
	t     *testing.T
	bytes int64
	last  time.Time
}

func (w *liveDownloadProgress) Write(p []byte) (int, error) {
	n, err := w.Writer.Write(p)
	w.bytes += int64(n)
	if time.Since(w.last) >= 30*time.Second {
		w.t.Logf("downloaded %d bytes", w.bytes)
		w.last = time.Now()
	}
	return n, err
}
