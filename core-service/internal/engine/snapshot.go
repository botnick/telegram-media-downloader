package engine

import (
	"context"
	"database/sql"
	"encoding/json"
	"io"
	"strconv"
	"sync/atomic"
	"time"

	"github.com/botnick/telegram-media-downloader/core-service/internal/telegram"
)

type transferStats struct {
	started  time.Time
	received atomic.Int64
}
type trackedTransport struct {
	telegram.MediaDownloader
	stats     *transferStats
	bandwidth *bandwidthLimiter
	budget    *attemptBudget
}
type trackedWriter struct {
	io.Writer
	stats     *transferStats
	ctx       context.Context
	bandwidth *bandwidthLimiter
	budget    *attemptBudget
}

func (w trackedWriter) Write(p []byte) (int, error) {
	total := 0
	for len(p) > 0 {
		n := len(p)
		if w.bandwidth != nil {
			w.budget.pause()
			var err error
			n, err = w.bandwidth.take(w.ctx, n)
			w.budget.resume()
			if err != nil {
				return total, err
			}
		}
		written, err := w.Writer.Write(p[:n])
		w.stats.received.Add(int64(written))
		total += written
		if err == nil && written != n {
			err = io.ErrShortWrite
		}
		if err != nil {
			return total, err
		}
		p = p[n:]
	}
	return total, nil
}
func (t trackedTransport) DownloadMedia(ctx context.Context, a telegram.Attachment, w io.Writer) error {
	return t.MediaDownloader.DownloadMedia(ctx, a, trackedWriter{Writer: w, stats: t.stats, ctx: ctx, bandwidth: t.bandwidth, budget: t.budget})
}

// Snapshot exposes only dashboard fields. Serialized Telegram messages,
// access hashes and file references must never appear in this response.
func (c *Controller) Snapshot(ctx context.Context) (map[string]any, error) {
	status, err := c.Status(ctx)
	if err != nil {
		return nil, err
	}
	c.mu.Lock()
	run := c.run
	c.mu.Unlock()
	active, queued, recent := []map[string]any{}, []map[string]any{}, []map[string]any{}
	// Active workers <=64; pending and history views are independently bounded.
	rows, err := c.reader.QueryContext(ctx, `SELECT id,group_id,group_name,message_id,media_type,file_name,file_size,account_id,status,paused,created_at,updated_at,error,
 (SELECT file_path FROM downloads WHERE group_id=tgdl_work.group_id AND message_id=tgdl_work.message_id LIMIT 1)
 FROM tgdl_work WHERE status='processing' OR id IN (SELECT id FROM tgdl_work WHERE status='pending' ORDER BY id LIMIT 1000)
 OR id IN (SELECT id FROM tgdl_work WHERE status IN ('completed','failed','skipped') ORDER BY updated_at DESC LIMIT 100)
 ORDER BY CASE WHEN status='pending' THEN id ELSE -updated_at END,id DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id, msg, size, added, updated int64
		var group, name, media, file, account, state string
		var paused bool
		var detail, filePath sql.NullString
		if err = rows.Scan(&id, &group, &name, &msg, &media, &file, &size, &account, &state, &paused, &added, &updated, &detail, &filePath); err != nil {
			return nil, err
		}
		item := map[string]any{"key": group + "_" + strconv.FormatInt(msg, 10), "groupId": group, "groupName": name, "mediaType": media, "messageId": msg, "fileName": file, "fileSize": size, "accountId": account, "accountName": nil, "addedAt": added, "progress": 0, "received": 0, "total": size, "bps": 0, "eta": nil}
		if filePath.Valid {
			item["filePath"] = filePath.String
		}
		switch state {
		case "processing":
			item["status"] = "active"
			if paused {
				item["status"] = "paused"
			}
			if run != nil {
				run.mu.Lock()
				stats := run.progress[id]
				run.mu.Unlock()
				if stats != nil {
					received := stats.received.Load()
					elapsed := time.Since(stats.started).Seconds()
					bps := int64(float64(received) / max(elapsed, 0.001))
					item["received"] = received
					item["bps"] = bps
					if size > 0 {
						item["progress"] = min(100, float64(received)*100/float64(size))
					}
					if bps > 0 {
						item["eta"] = max(size-received, 0) / bps
					}
				}
			}
			active = append(active, item)
		case "pending":
			item["status"] = "queued"
			if paused {
				item["status"] = "paused"
			}
			queued = append(queued, item)
		default:
			item["status"] = "failed"
			if state == "skipped" {
				item["status"] = "cancelled"
			}
			item["finishedAt"] = updated
			if state == "completed" {
				item["status"] = "done"
				item["progress"] = 100
				item["received"] = size
			}
			if detail.Valid {
				item["error"] = detail.String
			}
			recent = append(recent, item)
		}
	}
	if err = rows.Err(); err != nil {
		return nil, err
	}
	globalPaused, err := c.work.QueuePaused(ctx)
	if err != nil {
		return nil, err
	}
	pausedCount, err := c.work.PausedCount(ctx)
	if err != nil {
		return nil, err
	}
	if len(recent) == 0 {
		var historyJSON string
		if err := c.reader.QueryRowContext(ctx, `SELECT value FROM kv WHERE key='queue_history'`).Scan(&historyJSON); err == nil {
			var history []map[string]any
			if json.Unmarshal([]byte(historyJSON), &history) == nil {
				if len(history) > 100 {
					history = history[:100]
				}
				recent = history
			}
		}
	}
	var maxSpeed any
	if speed := c.bandwidth.limit(); speed > 0 {
		maxSpeed = speed
	}
	return map[string]any{"active": active, "queued": queued, "recent": recent, "globalPaused": globalPaused, "pausedCount": pausedCount, "workers": status["workers"], "pending": status["queue"], "engineRunning": status["state"] == "running", "maxSpeed": maxSpeed}, nil
}
