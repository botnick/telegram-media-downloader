package app

import (
	"context"
	"database/sql"
	"encoding/json"
	"time"

	"github.com/botnick/telegram-media-downloader/core-service/internal/engine"
	"github.com/botnick/telegram-media-downloader/core-service/internal/telegram"
	"github.com/gotd/td/bin"
	"github.com/gotd/td/tg"
)

func directScanSettings(cfg map[string]any, groupID string) (map[string]any, string, bool) {
	settings, accountID, mode := scanRouteSettings(cfg, groupID)
	return settings, accountID, mode == "direct"
}

func scanRouteSettings(cfg map[string]any, groupID string) (map[string]any, string, string) {
	for _, group := range configuredGroupList(cfg) {
		if toString(group["id"]) != groupID {
			continue
		}
		settings, ok := group["autoForward"].(map[string]any)
		if !ok || settings["enabled"] != true {
			return nil, "", "download"
		}
		mode := toString(settings["scanRoute"])
		if mode == "" {
			mode = "download"
		}
		return settings, toString(group["forwardAccount"]), mode
	}
	return nil, "", "download"
}

func (a *App) routeLiveScan(ctx context.Context, accountID string, target engine.Target, message *tg.Message) (bool, error) {
	cfg, err := a.config.Load(ctx)
	if err != nil {
		return false, err
	}
	settings, forwardAccount, mode := scanRouteSettings(cfg, target.ID)
	if mode != "direct" && mode != "both" {
		return false, nil
	}
	if err := a.queueDirectScan(ctx, target.ID, target.Name, forwardAccount, settings, cfg, message); err != nil {
		return false, err
	}
	return mode == "direct", nil
}

func insertDirectScanTx(ctx context.Context, tx *sql.Tx, groupID, groupName, accountID string, settings, globalConfig map[string]any, queueLimit int, message *tg.Message) (bool, error) {
	attachment, err := telegram.MessageAttachment(message)
	if err != nil {
		return false, err
	}
	topicID := telegram.MessageTopicID(message)
	destinations := make([]forwardDestination, 0)
	for _, route := range matchingForwardRoutes(settings, topicID) {
		routeSettings := effectiveForwardProtection(inheritCaptionSettings(route, settings), settings, route, topicID, globalConfig)
		destinations = append(destinations, forwardDestination{Settings: routeSettings, Status: "pending"})
	}
	if len(destinations) == 0 {
		return false, nil
	}
	facts, err := json.Marshal(attachment.Facts)
	if err != nil {
		return false, err
	}
	config, err := json.Marshal(forwardConfigSnapshot{Settings: settings, AccountID: accountID, Destinations: destinations})
	if err != nil {
		return false, err
	}
	destinationState, err := json.Marshal(destinations)
	if err != nil {
		return false, err
	}
	var encodedMessage bin.Buffer
	if err := message.Encode(&encodedMessage); err != nil {
		return false, err
	}
	now := time.Now().UnixMilli()
	result, err := tx.ExecContext(ctx, `INSERT INTO tgdl_forward_queue(group_id,group_name,message_id,file_name,topic_id,caption,facts_json,source_message,forward_config_json,destinations_json,status,reason,stage,source_kind,created_at,updated_at,retry_at)
		VALUES(?,?,?,?,?,?,?,?,?,?,'pending',CASE WHEN (SELECT COUNT(*) FROM tgdl_forward_queue WHERE status IN ('pending','processing'))>=? THEN 'forward queue capacity reached; deferred for automatic retry' ELSE '' END,'scan_direct','scan_direct',?,?,
		CASE WHEN (SELECT COUNT(*) FROM tgdl_forward_queue WHERE status IN ('pending','processing'))>=? THEN ?+1000 ELSE 0 END)
		ON CONFLICT(group_id,message_id) WHERE source_kind='scan_direct' DO NOTHING`, groupID, groupName, message.ID, attachment.Name, topicID, message.Message, string(facts), encodedMessage.Raw(), string(config), string(destinationState), queueLimit, now, now, queueLimit, now)
	if err != nil {
		return false, err
	}
	n, err := result.RowsAffected()
	return n > 0, err
}

func (a *App) queueDirectScan(ctx context.Context, groupID, groupName, accountID string, settings, globalConfig map[string]any, message *tg.Message) error {
	queueLimit := a.forwarderConfig(ctx).queueSize
	tx, err := a.db.Writer.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = insertDirectScanTx(ctx, tx, groupID, groupName, accountID, settings, globalConfig, queueLimit, message); err != nil {
		return err
	}
	if err = tx.Commit(); err != nil {
		return err
	}
	a.notifyForwardQueue()
	select {
	case a.forwards <- struct{}{}:
	default:
	}
	return nil
}
