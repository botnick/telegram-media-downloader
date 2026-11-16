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
CREATE TABLE IF NOT EXISTS tgdl_cluster_replay (
 peer_id TEXT NOT NULL, signature TEXT NOT NULL, expires_at INTEGER NOT NULL,
 PRIMARY KEY(peer_id,signature)
);
CREATE INDEX IF NOT EXISTS idx_tgdl_cluster_replay_expiry ON tgdl_cluster_replay(expires_at);

CREATE TABLE IF NOT EXISTS tgdl_cluster_revision (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL);
INSERT OR IGNORE INTO tgdl_cluster_revision(id,revision) VALUES(1,0);
CREATE TABLE IF NOT EXISTS tgdl_cluster_catalog (
    remote_id INTEGER PRIMARY KEY,
    revision INTEGER NOT NULL UNIQUE,
    event_type TEXT NOT NULL,
    payload TEXT NOT NULL
);
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
 ttl_seconds INTEGER NOT NULL DEFAULT 0,
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

CREATE TABLE IF NOT EXISTS tgdl_mcp_agents (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('read-only','operator','admin','custom')),
    client_id TEXT NOT NULL UNIQUE,
    client_secret_hash TEXT NOT NULL,
    scopes_json TEXT NOT NULL DEFAULT '[]',
    account_ids_json TEXT NOT NULL DEFAULT '[]',
    chat_ids_json TEXT NOT NULL DEFAULT '[]',
    active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    revoked_at INTEGER
);

CREATE TABLE IF NOT EXISTS tgdl_mcp_tokens (
    token_hash TEXT PRIMARY KEY NOT NULL,
    agent_id TEXT NOT NULL REFERENCES tgdl_mcp_agents(id),
    scopes_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tgdl_mcp_tokens_agent ON tgdl_mcp_tokens(agent_id, expires_at);

CREATE TABLE IF NOT EXISTS tgdl_mcp_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    occurred_at INTEGER NOT NULL,
    actor_type TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    action TEXT NOT NULL,
    target TEXT NOT NULL DEFAULT '',
    change_summary TEXT NOT NULL DEFAULT '',
    payload_hash TEXT NOT NULL DEFAULT '',
    outcome TEXT NOT NULL,
    approval_id TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_tgdl_mcp_audit_time ON tgdl_mcp_audit(occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_tgdl_mcp_audit_actor ON tgdl_mcp_audit(actor_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS tgdl_mcp_approvals (
    id TEXT PRIMARY KEY NOT NULL,
    requester_agent_id TEXT NOT NULL REFERENCES tgdl_mcp_agents(id),
    operation TEXT NOT NULL,
    target TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    payload_hash TEXT NOT NULL,
    payload_ciphertext BLOB NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected','expired','executed','partial','failed')),
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    decided_at INTEGER,
    decided_by TEXT NOT NULL DEFAULT '',
    result_json TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_tgdl_mcp_approvals_status ON tgdl_mcp_approvals(status, expires_at);

CREATE TABLE IF NOT EXISTS tgdl_mcp_idempotency (
    agent_id TEXT NOT NULL REFERENCES tgdl_mcp_agents(id),
    idempotency_key TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    result_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY(agent_id, idempotency_key)
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
