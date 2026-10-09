CREATE TABLE IF NOT EXISTS tgdl_user_peers (
    account_id TEXT NOT NULL, self_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
    access_hash INTEGER NOT NULL, PRIMARY KEY(account_id,self_id,user_id)
);
-- Rescue receipts are written before download/cursor acknowledgement and
-- survive a source delete received while the file is still being transferred.
CREATE TABLE IF NOT EXISTS tgdl_rescue_messages (
 group_id TEXT NOT NULL, message_id INTEGER NOT NULL,
 account_id TEXT NOT NULL, channel_id INTEGER NOT NULL,
 pending_until INTEGER NOT NULL, rescued_at INTEGER,
 PRIMARY KEY(group_id,message_id)
);
CREATE INDEX IF NOT EXISTS idx_tgdl_rescue_channel ON tgdl_rescue_messages(channel_id,message_id);
CREATE INDEX IF NOT EXISTS idx_tgdl_rescue_account ON tgdl_rescue_messages(account_id,message_id) WHERE channel_id=0;
CREATE TABLE IF NOT EXISTS tgdl_work (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 account_id TEXT NOT NULL,
 group_id TEXT NOT NULL,
 group_name TEXT NOT NULL,
 message_id INTEGER NOT NULL,
 version INTEGER NOT NULL,
 source_pts INTEGER NOT NULL DEFAULT 0,
 identity TEXT NOT NULL,
 media_type TEXT NOT NULL,
 file_name TEXT NOT NULL,
 file_size INTEGER NOT NULL,
 body BLOB NOT NULL,
 generation INTEGER NOT NULL DEFAULT 1,
 claim_generation INTEGER,
 status TEXT NOT NULL DEFAULT 'pending',
 paused INTEGER NOT NULL DEFAULT 0,
 refresh_required INTEGER NOT NULL DEFAULT 0,
 origin TEXT NOT NULL DEFAULT 'live',
 attempts INTEGER NOT NULL DEFAULT 0,
 retry_at INTEGER NOT NULL DEFAULT 0,
 error TEXT,
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL,
 UNIQUE(group_id,message_id)
);
CREATE INDEX IF NOT EXISTS idx_tgdl_work_pending ON tgdl_work(status,account_id,retry_at,id);
CREATE TABLE IF NOT EXISTS tgdl_queue_state (
 id INTEGER PRIMARY KEY CHECK (id=1),
 paused INTEGER NOT NULL DEFAULT 0,
 updated_at INTEGER NOT NULL
);
INSERT INTO tgdl_queue_state(id,paused,updated_at)
 SELECT 1,0,0 WHERE NOT EXISTS (SELECT 1 FROM tgdl_queue_state WHERE id=1);
CREATE TABLE IF NOT EXISTS tgdl_update_state (
 account_id TEXT NOT NULL,user_id INTEGER NOT NULL,
 pts INTEGER NOT NULL,qts INTEGER NOT NULL,date INTEGER NOT NULL,seq INTEGER NOT NULL,
 PRIMARY KEY(account_id,user_id)
);
CREATE TABLE IF NOT EXISTS tgdl_update_channels (
 account_id TEXT NOT NULL,user_id INTEGER NOT NULL,channel_id INTEGER NOT NULL,
 pts INTEGER,access_hash INTEGER,
 PRIMARY KEY(account_id,user_id,channel_id)
);
CREATE TABLE IF NOT EXISTS tgdl_update_recovery (
 account_id TEXT NOT NULL,channel_id INTEGER NOT NULL,
 reason TEXT NOT NULL,created_at INTEGER NOT NULL,
 PRIMARY KEY(account_id,channel_id)
);
CREATE TABLE IF NOT EXISTS tgdl_update_recovery_state (
 account_id TEXT NOT NULL,channel_id INTEGER NOT NULL,
 user_id INTEGER NOT NULL,pts INTEGER NOT NULL,
 PRIMARY KEY(account_id,channel_id)
);
CREATE TABLE IF NOT EXISTS tgdl_account_ops (
 id TEXT PRIMARY KEY NOT NULL,payload TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tgdl_purge_jobs (
 id TEXT PRIMARY KEY NOT NULL,payload TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tgdl_history_jobs (
 id TEXT PRIMARY KEY NOT NULL,
 group_id TEXT NOT NULL,
 state TEXT NOT NULL,
 payload TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tgdl_history_running ON tgdl_history_jobs(group_id) WHERE state='running';
