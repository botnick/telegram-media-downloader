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
 attempts INTEGER NOT NULL DEFAULT 0,
 retry_at INTEGER NOT NULL DEFAULT 0,
 error TEXT,
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL,
 UNIQUE(group_id,message_id)
);
CREATE INDEX IF NOT EXISTS idx_tgdl_work_pending ON tgdl_work(status,account_id,retry_at,id);
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
