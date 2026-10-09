// Package rescue persists retention and source-deletion state before a download
// can publish its catalog row, including queued URL and history requests.
package rescue

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"math"
	"strconv"
	"strings"
	"time"

	"github.com/gotd/td/tg"
)

type Writer interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
	ExecContext(context.Context, string, ...any) (sql.Result, error)
}

func numeric(value any, fallback float64) float64 {
	var n float64
	switch value := value.(type) {
	case float64:
		n = value
	case string:
		var err error
		n, err = strconv.ParseFloat(value, 64)
		if err != nil {
			return fallback
		}
	default:
		return fallback
	}
	if math.IsNaN(n) || math.IsInf(n, 0) {
		return fallback
	}
	return n
}

func Retention(group, cfg map[string]any) time.Duration {
	settings, _ := cfg["rescue"].(map[string]any)
	on := settings["enabled"] == true
	if group["rescueMode"] == "on" {
		on = true
	}
	if group["rescueMode"] == "off" {
		on = false
	}
	if !on {
		return 0
	}
	hours := numeric(group["rescueRetentionHours"], 0)
	if hours <= 0 {
		hours = numeric(settings["retentionHours"], 48)
	}
	if hours <= 0 {
		hours = 48
	}
	return time.Duration(max(1, min(720, hours)) * float64(time.Hour))
}

// Observe accepts either the shared writer or a caller-owned transaction.
// Repeated observations keep the original deadline/source, and enabling rescue
// cannot convert an already-permanent file into a disposable one.
func Observe(ctx context.Context, db Writer, account, groupID string, message *tg.Message, origin string) error {
	if origin == "stories" {
		return nil
	}
	var raw string
	err := db.QueryRowContext(ctx, `SELECT value FROM kv WHERE key='config'`).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	var cfg map[string]any
	if err = json.Unmarshal([]byte(raw), &cfg); err != nil {
		return err
	}
	var group map[string]any
	groups, _ := cfg["groups"].([]any)
	for _, item := range groups {
		g, _ := item.(map[string]any)
		id, _ := g["id"].(string)
		if n, ok := g["id"].(float64); ok {
			id = strconv.FormatInt(int64(n), 10)
		}
		if strings.TrimSpace(id) == groupID {
			group = g
			break
		}
	}
	retention := Retention(group, cfg)
	if retention == 0 {
		return nil
	}
	channel := int64(0)
	if p, ok := message.PeerID.(*tg.PeerChannel); ok {
		channel = p.ChannelID
	}
	if channel == 0 && account == "" {
		return errors.New("rescue needs the source account for non-channel messages")
	}
	_, err = db.ExecContext(ctx, `INSERT INTO tgdl_rescue_messages(group_id,message_id,account_id,channel_id,pending_until)
 SELECT ?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM downloads WHERE group_id=? AND message_id=? AND pending_until IS NULL)
 ON CONFLICT(group_id,message_id) DO NOTHING`, groupID, message.ID, account, channel, time.Now().Add(retention).UnixMilli(), groupID, message.ID)
	return err
}
