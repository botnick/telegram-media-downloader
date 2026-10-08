package app

import (
	"context"
	"github.com/botnick/telegram-media-downloader/core-service/internal/download"
	"github.com/botnick/telegram-media-downloader/core-service/internal/engine"
	"github.com/botnick/telegram-media-downloader/core-service/internal/telegram"
	"github.com/botnick/telegram-media-downloader/core-service/internal/ws"
	"github.com/gotd/td/tg"
	"strconv"
)

// IngestTelegram is the common application boundary for live messages and
// history. Account runners supply their own authenticated media transport.
func (a *App) IngestTelegram(ctx context.Context, message *tg.Message, groupName string, transport telegram.MediaDownloader) (download.Record, error) {
	return a.ingestTelegram(ctx, message, "", groupName, "", transport)
}
func (a *App) ingestTelegram(ctx context.Context, message *tg.Message, groupID, groupName, accountID string, transport telegram.MediaDownloader) (download.Record, error) {
	a.mediaMu.RLock()
	defer a.mediaMu.RUnlock()
	if err := a.mediaWritable(ctx); err != nil {
		return download.Record{}, err
	}
	attachment, err := telegram.MessageAttachment(message)
	if err != nil {
		return download.Record{}, err
	}
	if groupID == "" {
		groupID = attachment.GroupID
	}
	item := download.Item{GroupID: groupID, GroupName: groupName, MessageID: attachment.MessageID, Name: attachment.Name, Type: attachment.Type, Identity: attachment.Identity}
	if engine.Origin(ctx) == "stories" {
		item.MessageID, err = telegram.StoryKey(message.ID)
		if err != nil {
			return download.Record{}, err
		}
		item.Type = "stories"
	}
	record, err := a.library.Ingest(ctx, item, telegram.AttachmentClient{Source: transport, Media: attachment})
	if err != nil {
		return record, err
	}
	payload := map[string]any{"key": item.GroupID + "_" + strconv.FormatInt(item.MessageID, 10), "groupId": item.GroupID, "groupName": item.GroupName, "messageId": item.MessageID, "fileName": item.Name, "filePath": record.Path, "fileSize": item.Identity.Size, "mediaType": item.Type, "deduped": record.Reused, "addedAt": nil, "accountId": accountID, "accountName": nil}
	a.hub.Broadcast(ws.Event{Type: "download_complete", Payload: payload})
	return record, a.drainFileCleanup(ctx)
}
