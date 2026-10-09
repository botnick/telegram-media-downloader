package app

import (
	"context"

	"github.com/botnick/telegram-media-downloader/core-service/internal/telegram"
	"github.com/botnick/telegram-media-downloader/core-service/internal/ws"
)

func (a *App) broadcastStatsUpdate(ctx context.Context) {
	if a == nil || a.db == nil || a.hub == nil {
		return
	}
	stats, ok := a.statsPayload(ctx)
	if !ok {
		return
	}
	a.hub.Broadcast(ws.Event{Type: "stats_update", Flat: true, Payload: map[string]any{"stats": stats}})
}

func (a *App) statsPayload(ctx context.Context) (map[string]any, bool) {
	if a == nil || a.db == nil {
		return nil, false
	}
	var totalFiles, totalSize int64
	if err := a.db.Reader.QueryRowContext(ctx, `SELECT COUNT(*), COALESCE(SUM(file_size),0) FROM downloads`).Scan(&totalFiles, &totalSize); err != nil {
		return nil, false
	}
	raw, _ := a.config.Load(ctx)
	config := effectiveConfig(raw)
	groups, _ := config["groups"].([]any)
	enabled := 0
	for _, item := range groups {
		if group, ok := item.(map[string]any); ok && group["enabled"] == true {
			enabled++
		}
	}
	accounts := 0
	if sessions, err := telegram.SavedSessions(a.dataDir); err == nil {
		accounts = len(sessions)
	}
	peerStats := make([]map[string]any, 0)
	rows, err := a.db.Reader.QueryContext(ctx, `
		SELECT p.peer_id, p.name, p.status, COUNT(d.remote_id), COALESCE(SUM(d.file_size),0)
		FROM peers p LEFT JOIN peer_downloads d ON d.peer_id = p.peer_id
		GROUP BY p.peer_id, p.name, p.status HAVING COUNT(d.remote_id) > 0 ORDER BY p.peer_id`)
	if err == nil {
		defer rows.Close()
		for rows.Next() {
			var id, name, status string
			var count, size int64
			if rows.Scan(&id, &name, &status, &count, &size) == nil {
				peerStats = append(peerStats, map[string]any{"online": status == "online", "peerId": id, "peerName": name, "totalFiles": count, "totalSize": size, "totalSizeFormatted": formatBytes(size)})
			}
		}
	}
	maxDisk := "0"
	if disk, ok := config["diskManagement"].(map[string]any); ok {
		if value, ok := disk["maxTotalSize"].(string); ok && value != "" {
			maxDisk = value
		}
	}
	apiConfigured := false
	if telegramCfg, ok := config["telegram"].(map[string]any); ok {
		// Node releases saved apiId as a JSON number.
		apiConfigured = number(telegramCfg["apiId"], 0) > 0 && stringOr(telegramCfg["apiHash"], "") != ""
	}
	return map[string]any{
		"accounts": accounts, "apiConfigured": apiConfigured, "diskUsage": totalSize,
		"diskUsageFormatted": formatBytes(totalSize), "enabledGroups": enabled, "maxDiskSize": maxDisk,
		"peerStats": peerStats, "telegramConnected": false, "totalFiles": totalFiles,
		"totalGroups": len(groups), "totalSize": totalSize,
	}, true
}
