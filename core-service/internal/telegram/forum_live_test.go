package telegram

import (
	"bytes"
	"context"
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/botnick/telegram-media-downloader/core-service/internal/auth"
	"github.com/gotd/td/tg"
	_ "modernc.org/sqlite"
)

// Opt-in acceptance check. Creates and deletes only its own private forum.
func TestForumLiveAcceptance(t *testing.T) {
	dataDir := os.Getenv("TGDL_LIVE_DATA_DIR")
	accountID := os.Getenv("TGDL_LIVE_ACCOUNT")
	if dataDir == "" || accountID == "" {
		t.Skip("requires explicit live account opt-in")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Second)
	defer cancel()
	db, err := sql.Open("sqlite", "file:"+filepath.Join(dataDir, "db.sqlite")+"?mode=ro")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	cfg, err := (auth.ConfigStore{DB: db}).Load(ctx)
	if err != nil {
		t.Fatal(err)
	}
	apiCfg, _ := cfg["telegram"].(map[string]any)
	id, _ := strconv.Atoi(fmt.Sprint(apiCfg["apiId"]))
	if n, ok := apiCfg["apiId"].(float64); ok {
		id = int(n)
	}
	hash, _ := apiCfg["apiHash"].(string)
	secret, err := os.ReadFile(filepath.Join(dataDir, "secret.key"))
	if err != nil {
		t.Fatal(err)
	}
	session, err := os.ReadFile(filepath.Join(dataDir, "sessions", "native", accountID+".enc"))
	if err != nil {
		t.Fatal(err)
	}
	scratch := t.TempDir()
	native := filepath.Join(scratch, "session.enc")
	if err = os.WriteFile(native, session, 0600); err != nil {
		t.Fatal(err)
	}
	client, err := NewGotdClient(GotdConfig{AppID: id, AppHash: hash, SessionPath: native, SessionSecret: strings.TrimSpace(string(secret))})
	if err != nil {
		t.Fatal(err)
	}
	stateDB, err := sql.Open("sqlite", filepath.Join(scratch, "state.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer stateDB.Close()
	_, err = stateDB.Exec(`CREATE TABLE tgdl_update_channels(account_id TEXT,user_id INTEGER,channel_id INTEGER,access_hash INTEGER,PRIMARY KEY(account_id,user_id,channel_id))`)
	if err != nil {
		t.Fatal(err)
	}
	err = client.Run(ctx, func(ctx context.Context) error {
		users, err := client.API().UsersGetUsers(ctx, []tg.InputUserClass{&tg.InputUserSelf{}})
		if err != nil {
			return err
		}
		if len(users) != 1 {
			return fmt.Errorf("expected own user")
		}
		self, ok := users[0].(*tg.User)
		if !ok {
			return fmt.Errorf("own user unavailable")
		}
		t.Log("authenticated existing account; credentials remain on host")
		runID := time.Now().UnixNano()
		result, err := client.API().ChannelsCreateChannel(ctx, &tg.ChannelsCreateChannelRequest{Megagroup: true, Forum: true, Title: fmt.Sprintf("TGDL private routing test %d", runID), About: "Temporary private acceptance test; no members invited."})
		if err != nil {
			return err
		}
		updates, ok := result.(*tg.Updates)
		if !ok {
			return fmt.Errorf("unexpected create response %T", result)
		}
		var channel *tg.Channel
		for _, chat := range updates.Chats {
			if c, ok := chat.(*tg.Channel); ok && c.Creator {
				channel = c
				break
			}
		}
		if channel == nil {
			return fmt.Errorf("created private forum not found")
		}
		t.Logf("created private test forum id=%d", channel.ID)
		peer := &tg.InputPeerChannel{ChannelID: channel.ID, AccessHash: channel.AccessHash}
		input := &tg.InputChannel{ChannelID: channel.ID, AccessHash: channel.AccessHash}
		defer func() {
			cleanCtx, cleanCancel := context.WithTimeout(context.Background(), 25*time.Second)
			defer cleanCancel()
			if _, e := client.API().ChannelsDeleteChannel(cleanCtx, input); e != nil {
				t.Errorf("cleanup newly created forum %d: %v", channel.ID, e)
			} else {
				t.Log("deleted only the newly created private forum")
			}
		}()
		state := &UpdateState{Writer: stateDB, Reader: stateDB, AccountID: accountID}
		if err = state.SetChannelAccessHash(ctx, self.ID, channel.ID, channel.AccessHash); err != nil {
			return err
		}
		account := &Account{GotdClient: client, state: state, selfID: self.ID}
		for i, title := range []string{"Route A", "Route B"} {
			_, err = client.API().MessagesCreateForumTopic(ctx, &tg.MessagesCreateForumTopicRequest{Peer: peer, Title: title, RandomID: runID + int64(i) + 1})
			if err != nil {
				return err
			}
		}
		destination := strconv.FormatInt(-1000000000000-channel.ID, 10)
		topics, err := account.ForumTopics(ctx, destination)
		if err != nil {
			return err
		}
		checked := 0
		sourceMessageIDs := make([]int, 0, 2)
		for _, topic := range topics {
			if topic.Name != "Route A" && topic.Name != "Route B" {
				continue
			}
			payload := []byte("TGDL acceptance fixture: " + topic.Name + "\n")
			messageID, err := account.SendFile(ctx, SendFileRequest{Destination: destination, TopicID: topic.ID, Name: "tgdl-routing-test.txt", Size: int64(len(payload)), Body: bytes.NewReader(payload), Caption: "Verified " + topic.Name})
			if err != nil {
				return err
			}
			if messageID <= 0 {
				return fmt.Errorf("send returned no message ID")
			}
			sourceMessageIDs = append(sourceMessageIDs, messageID)
			messages, err := client.API().ChannelsGetMessages(ctx, &tg.ChannelsGetMessagesRequest{Channel: input, ID: []tg.InputMessageClass{&tg.InputMessageID{ID: messageID}}})
			if err != nil {
				return err
			}
			page, ok := messages.(*tg.MessagesChannelMessages)
			if !ok {
				return fmt.Errorf("unexpected readback %T", messages)
			}
			if len(page.Messages) != 1 {
				return fmt.Errorf("readback count %d", len(page.Messages))
			}
			m, ok := page.Messages[0].(*tg.Message)
			if !ok {
				return fmt.Errorf("readback is not media message")
			}
			if MessageTopicID(m) != topic.ID || m.Message != "Verified "+topic.Name {
				return fmt.Errorf("wrong topic or caption: expected %d got %d", topic.ID, MessageTopicID(m))
			}
			media, ok := m.Media.(*tg.MessageMediaDocument)
			if !ok {
				return fmt.Errorf("missing uploaded document")
			}
			document, ok := media.Document.(*tg.Document)
			if !ok || document.Size != int64(len(payload)) {
				return fmt.Errorf("uploaded document size mismatch")
			}
			checked++
			t.Logf("PASS %s topic=%d message=%d bytes=%d caption and target verified by readback", topic.Name, topic.ID, messageID, len(payload))
		}
		if checked != 2 {
			return fmt.Errorf("expected 2 topic routes, verified %d", checked)
		}
		var storageChannelID int64
		for _, folder := range []int{0, 1} {
			storageDialogs, err := fetchDialogs(ctx, client.API(), -1, folder)
			if err != nil {
				return fmt.Errorf("list storage destinations: %w", err)
			}
			for _, dialog := range storageDialogs {
				if dialog.Name == StorageChannelTitle {
					if peer, ok := dialog.peer.(*tg.InputPeerChannel); ok {
						storageChannelID = peer.ChannelID
						break
					}
				}
			}
			if storageChannelID != 0 {
				break
			}
		}
		var storageInput *tg.InputChannel
		createdStorageForTest := storageChannelID == 0
		if createdStorageForTest {
			sender := &fileSender{api: client.API(), resolve: account.ResolveDialog, scan: account.RecoveryDialogs}
			peer, err := sender.destination(ctx, "storage")
			if err != nil {
				return fmt.Errorf("create temporary storage test channel: %w", err)
			}
			channel, ok := peer.(*tg.InputPeerChannel)
			if !ok {
				return fmt.Errorf("temporary storage peer has type %T", peer)
			}
			storageChannelID = channel.ChannelID
			storageInput = &tg.InputChannel{ChannelID: channel.ChannelID, AccessHash: channel.AccessHash}
		}
		storageMessageIDs := make([]int, 0, len(sourceMessageIDs))
		defer func() {
			if storageInput == nil {
				return
			}
			cleanCtx, cleanCancel := context.WithTimeout(context.Background(), 25*time.Second)
			defer cleanCancel()
			if len(storageMessageIDs) > 0 {
				if _, e := client.API().ChannelsDeleteMessages(cleanCtx, &tg.ChannelsDeleteMessagesRequest{Channel: storageInput, ID: storageMessageIDs}); e != nil {
					t.Errorf("cleanup storage test messages: %v", e)
				} else {
					t.Log("deleted only the temporary storage test messages")
				}
			}
			if createdStorageForTest {
				if _, e := client.API().ChannelsDeleteChannel(cleanCtx, storageInput); e != nil {
					t.Errorf("cleanup temporary storage test channel: %v", e)
				} else {
					t.Log("deleted temporary storage test channel")
				}
			}
		}()
		for _, sourceMessageID := range sourceMessageIDs {
			// A new sender per content simulates a fresh worker and proves the
			// existing storage target is found again instead of recreated.
			sender := &fileSender{api: client.API(), resolve: account.ResolveDialog, scan: account.RecoveryDialogs}
			target, err := sender.destination(ctx, "storage")
			if err != nil {
				return fmt.Errorf("resolve existing storage channel: %w", err)
			}
			targetPeer, ok := target.(*tg.InputPeerChannel)
			if !ok || targetPeer.ChannelID != storageChannelID {
				return fmt.Errorf("storage channel changed between contents: expected %d, got %#v", storageChannelID, target)
			}
			storageInput = &tg.InputChannel{ChannelID: targetPeer.ChannelID, AccessHash: targetPeer.AccessHash}
			forwardedID, err := sender.forward(ctx, ForwardMessageRequest{Source: destination, Destination: "storage", MessageID: sourceMessageID})
			if err != nil {
				return fmt.Errorf("forward live fixture to storage: %w", err)
			}
			if forwardedID <= 0 {
				return fmt.Errorf("storage forward returned no message ID")
			}
			storageMessageIDs = append(storageMessageIDs, forwardedID)
			messages, err := client.API().ChannelsGetMessages(ctx, &tg.ChannelsGetMessagesRequest{Channel: storageInput, ID: []tg.InputMessageClass{&tg.InputMessageID{ID: forwardedID}}})
			if err != nil {
				return err
			}
			page, ok := messages.(*tg.MessagesChannelMessages)
			if !ok || len(page.Messages) != 1 {
				return fmt.Errorf("storage readback returned %T with %d messages", messages, len(page.Messages))
			}
			stored, ok := page.Messages[0].(*tg.Message)
			if !ok {
				return fmt.Errorf("storage readback is not a Telegram message")
			}
			if _, hasForwardHeader := stored.GetFwdFrom(); hasForwardHeader {
				return fmt.Errorf("storage message still includes source attribution: %#v", page.Messages[0])
			}
			t.Logf("PASS storage reused channel=%d message=%d without source attribution", storageChannelID, forwardedID)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}
