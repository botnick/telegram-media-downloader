package app

import (
	"context"
	"errors"
	"fmt"
	"strconv"

	"github.com/botnick/telegram-media-downloader/core-service/internal/download"
	"github.com/botnick/telegram-media-downloader/core-service/internal/engine"
	"github.com/botnick/telegram-media-downloader/core-service/internal/rescue"
	"github.com/botnick/telegram-media-downloader/core-service/internal/telegram"
	"github.com/botnick/telegram-media-downloader/core-service/internal/ws"
	"github.com/gotd/td/tg"
)

// IngestTelegram is the common application boundary for live messages and
// history. Account runners supply their own authenticated media transport.
func (a *App) IngestTelegram(ctx context.Context, message *tg.Message, groupName string, transport telegram.MediaDownloader) (download.Record, error) {
	return a.ingestTelegram(ctx, message, "", groupName, "", transport)
}
func (a *App) ingestTelegram(ctx context.Context, message *tg.Message, groupID, groupName, accountID string, transport telegram.MediaDownloader) (download.Record, error) {
	return a.ingestTelegramWithForward(ctx, message, groupID, groupName, accountID, transport, nil)
}

func (a *App) ingestTelegramWithForward(ctx context.Context, message *tg.Message, groupID, groupName, accountID string, transport telegram.MediaDownloader, directForward func(context.Context, telegram.ForwardMessageRequest) error) (download.Record, error) {
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
	ttl := telegram.MessageTTL(message)
	item := download.Item{GroupID: groupID, GroupName: groupName, MessageID: attachment.MessageID, Name: attachment.Name, Type: attachment.Type, Identity: attachment.Identity, Facts: attachment.Facts, TTLSeconds: ttl}
	if engine.Origin(ctx) == "stories" {
		item.MessageID, err = telegram.StoryKey(message.ID)
		if err != nil {
			return download.Record{}, err
		}
		item.Type = "stories"
	} else if engine.Origin(ctx) != "url" {
		// A link the operator pasted is always catalogued; monitored and
		// backfilled messages follow download.skipDuplicates.
		item.SkipDuplicates = a.skipDuplicates(ctx)
	}
	origin := engine.Origin(ctx)
	attemptID, err := a.startProcessingAttempt(ctx, item, origin)
	if err != nil {
		return download.Record{}, err
	}
	if err := rescue.Observe(ctx, a.db.Writer, accountID, groupID, message, engine.Origin(ctx)); err != nil {
		return download.Record{}, a.failProcessingAttempt(context.WithoutCancel(ctx), attemptID, err)
	}
	forward, forwardSettings, forwardAccountID, err := a.forwardCandidate(ctx, item.GroupID, item.MessageID)
	if err != nil {
		return download.Record{}, a.failProcessingAttempt(context.WithoutCancel(ctx), attemptID, err)
	}
	type directForwardResult struct {
		job forwardJob
		err error
	}
	var parallelForward *forwardJob
	var directResult <-chan directForwardResult
	if forward && forwardSettings["directForward"] == true && directForward != nil && ttl == 0 && !item.SkipDuplicates && len(matchingForwardRoutes(forwardSettings, telegram.MessageTopicID(message))) > 0 {
		cfg, _ := a.config.Load(ctx)
		topicID := telegram.MessageTopicID(message)
		needsUpload := false
		var destinations []forwardDestination
		for _, route := range matchingForwardRoutes(forwardSettings, topicID) {
			settings := effectiveForwardProtection(inheritCaptionSettings(route, forwardSettings), forwardSettings, route, topicID, cfg)
			destinations = append(destinations, forwardDestination{Settings: settings, Status: "pending"})
			captionCanEditAfterForward := toString(settings["captionMode"]) == "custom"
			if settings["protect"] == true || (customCaption(settings) && !captionCanEditAfterForward) {
				needsUpload = true
			}
		}
		if len(destinations) > 0 && !needsUpload {
			job := forwardJob{groupID: item.GroupID, groupName: groupName, fileName: attachment.Name, messageID: message.ID, topicID: topicID, text: message.Message, historyID: attemptID, facts: attachment.Facts, settings: forwardSettings, accountID: forwardAccountID, stage: "native_forward", destinations: destinations}
			job.directForward = directForward
			if a.reserveForward(&job) {
				result := make(chan directForwardResult, 1)
				go func() {
					nativeJob := job
					baseCtx := a.ctx
					if baseCtx == nil {
						baseCtx = context.Background()
					}
					forwardCtx, cancel := context.WithTimeout(baseCtx, forwardTimeout(attachment.Identity.Size))
					defer cancel()
					err := a.directForwardNow(forwardCtx, &nativeJob)
					result <- directForwardResult{job: nativeJob, err: err}
				}()
				parallelForward, directResult = &job, result
			}
		}
	}
	record, err := a.library.Ingest(ctx, item, telegram.AttachmentClient{Source: transport, Media: attachment})
	if err != nil {
		failure := a.failProcessingAttempt(context.WithoutCancel(ctx), attemptID, err)
		if parallelForward != nil {
			go func() {
				result := <-directResult
				job := result.job
				if result.err != nil {
					status := "failed"
					if hasUncertainDestination(job.destinations) {
						status = "uncertain"
					}
					a.updateForwardReservation(context.WithoutCancel(ctx), job, status, "")
					a.failProcessingForward(context.WithoutCancel(ctx), attemptID, result.err)
					a.finishProcessingForward(context.WithoutCancel(ctx), attemptID, status)
				} else {
					job.stage = "complete"
					a.updateForwardReservation(context.WithoutCancel(ctx), job, "forwarded", "")
					a.finishProcessingForward(context.WithoutCancel(ctx), attemptID, "forwarded")
				}
			}()
		}
		return record, failure
	}
	outcome := "downloaded"
	if record.Skipped {
		outcome = "duplicate_skipped"
	} else if record.Reused {
		outcome = "reused"
	}
	forwardStatus := "not_applicable"
	deleteAfterForward := false
	if forward && !record.Skipped {
		forwardStatus = "pending"
		deleteAfterForward = forwardSettings["deleteAfterForward"] == true
	}
	if err := a.finishProcessingAttempt(ctx, attemptID, outcome, record.SkipReason, record.SHA256, forwardStatus, deleteAfterForward); err != nil {
		return record, err
	}
	if record.Skipped {
		payload := map[string]any{"key": item.GroupID + "_" + strconv.FormatInt(item.MessageID, 10), "groupId": item.GroupID, "groupName": item.GroupName, "messageId": item.MessageID, "fileName": item.Name, "filePath": record.Path, "fileSize": item.Identity.Size, "mediaType": item.Type, "deduped": true, "skipped": true, "addedAt": nil, "accountId": accountID, "accountName": nil}
		a.hub.Broadcast(ws.Event{Type: "download_complete", Payload: payload})
		return record, nil
	}
	if ttl > 0 {
		// 2.x announced captured self-destructing media to the dashboard.
		a.hub.Broadcast(ws.Event{Type: "monitor_download", Payload: map[string]any{"group": groupName, "type": "ttl", "messageId": message.ID, "ttl": ttl}})
	}
	if forward {
		if parallelForward == nil {
			a.queueForward(forwardJob{groupID: item.GroupID, groupName: groupName, messageID: message.ID, topicID: telegram.MessageTopicID(message), text: message.Message, recordID: record.ID, historyID: attemptID, path: record.Path, facts: attachment.Facts, settings: forwardSettings, accountID: forwardAccountID})
		} else {
			job := *parallelForward
			job.recordID, job.path = record.ID, record.Path
			go func() {
				result := <-directResult
				job.stage, job.destinations = result.job.stage, result.job.destinations
				job.retryAt = result.job.retryAt
				if result.err != nil {
					if hasUncertainDestination(job.destinations) {
						a.updateForwardReservation(context.WithoutCancel(ctx), job, "uncertain", "")
						a.failProcessingForward(context.WithoutCancel(ctx), attemptID, result.err)
						a.finishProcessingForward(context.WithoutCancel(ctx), attemptID, "uncertain")
						return
					}
					if errors.Is(result.err, telegram.ErrForwardCaptionUnresolved) {
						a.updateForwardReservation(context.WithoutCancel(ctx), job, "failed", result.err.Error())
						a.failProcessingForward(context.WithoutCancel(ctx), attemptID, result.err)
						a.finishProcessingForward(context.WithoutCancel(ctx), attemptID, "failed")
						return
					}
					if a.deferForwardFlood(context.WithoutCancel(ctx), &job, result.err) {
						job.attempts = max(0, result.job.attempts-1)
						a.updateForwardReservation(context.WithoutCancel(ctx), job, "pending", "Telegram FloodWait; automatically retrying after the requested wait")
						a.finishProcessingForward(context.WithoutCancel(ctx), attemptID, "pending")
						select {
						case a.forwards <- struct{}{}:
						default:
						}
						return
					}
					for i := range job.destinations {
						job.destinations[i].Method = "upload"
						job.destinations[i].FallbackReason = "Direct forward was rejected; downloaded and uploaded instead: " + a.safeForwardReason(result.err.Error())
					}
					job.stage = "fallback_upload"
					a.updateForwardReservation(context.WithoutCancel(ctx), job, "pending", "")
					select {
					case a.forwards <- struct{}{}:
					default:
					}
					return
				}
				deleteAfterForward := forwardSettings["deleteAfterForward"] == true
				if err := a.finishProcessingAttempt(context.WithoutCancel(ctx), attemptID, "downloaded", "", record.SHA256, "forwarded", deleteAfterForward); err != nil {
					if a.output != nil {
						fmt.Fprintf(a.output, "AutoForward: could not finalize forwarded download: %v\n", err)
					}
					return
				}
				a.finishProcessingForward(context.WithoutCancel(ctx), attemptID, "forwarded")
				job.stage = "complete"
				a.updateForwardReservation(context.WithoutCancel(ctx), job, "forwarded", "")
				if deleteAfterForward {
					a.deleteForwarded(context.WithoutCancel(ctx), job)
				}
			}()
		}
	}
	payload := map[string]any{"key": item.GroupID + "_" + strconv.FormatInt(item.MessageID, 10), "groupId": item.GroupID, "groupName": item.GroupName, "messageId": item.MessageID, "fileName": item.Name, "filePath": record.Path, "fileSize": item.Identity.Size, "mediaType": item.Type, "deduped": record.Reused, "addedAt": nil, "accountId": accountID, "accountName": nil}
	a.hub.Broadcast(ws.Event{Type: "download_complete", Payload: payload})
	if attachment.Type == "video" {
		// History backfill yields to live downloads in the sprite queue.
		a.enqueueSeekbar(record.ID, engine.Origin(ctx) != "history")
	}
	a.queueNSFW(record.ID, payload["key"].(string))
	// Background face detection; live downloads go ahead of history backfill.
	a.faces.enqueue(record.ID, engine.Origin(ctx) != "history")
	if a.backups != nil {
		a.backups.Wake()
	}
	return record, a.drainFileCleanup(ctx)
}

// skipDuplicates reads download.skipDuplicates. Off unless set, so an
// upgrade keeps cataloguing every message as before.
func (a *App) skipDuplicates(ctx context.Context) bool {
	cfg, err := a.config.Load(ctx)
	if err != nil {
		return false
	}
	dl, _ := cfg["download"].(map[string]any)
	return dl["skipDuplicates"] == true
}
