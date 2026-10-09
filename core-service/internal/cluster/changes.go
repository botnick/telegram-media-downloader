package cluster

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

type Change struct {
	Revision int64           `json:"revision"`
	Type     string          `json:"type"`
	Payload  json.RawMessage `json:"payload"`
}
type ChangePage struct {
	PeerID  string   `json:"peerId"`
	Epoch   string   `json:"epoch"`
	Head    int64    `json:"head"`
	Next    int64    `json:"next"`
	Reset   bool     `json:"reset"`
	More    bool     `json:"more"`
	Changes []Change `json:"changes"`
}

const catalogJSON = `json_object('id',ROW.id,'group_id',CAST(ROW.group_id AS TEXT),'group_name',ROW.group_name,'message_id',ROW.message_id,'file_name',ROW.file_name,'file_size',ROW.file_size,'file_type',ROW.file_type,'file_path',ROW.file_path,'file_hash',ROW.file_hash,'status',ROW.status,'created_at',CAST(ROW.created_at AS TEXT),'nsfw_score',ROW.nsfw_score)`

// The feed retains one latest version (or tombstone) per ID. Repeated edits do
// not append unbounded history. Triggers share the catalog mutation transaction.
func initializeCatalog(ctx context.Context, tx *sql.Tx) error {
	var epoch string
	err := kvRead(ctx, tx, "cluster_catalog_epoch", &epoch)
	if errors.Is(err, sql.ErrNoRows) {
		if epoch, err = NewSecret(); err != nil {
			return err
		}
		if err = kvWrite(ctx, tx, "cluster_catalog_epoch", epoch); err != nil {
			return err
		}
		if _, err = tx.ExecContext(ctx, `INSERT INTO tgdl_cluster_catalog(remote_id,revision,event_type,payload)
 SELECT d.id,row_number() OVER (ORDER BY d.id),'download_added',`+strings.ReplaceAll(catalogJSON, "ROW.", "d.")+` FROM downloads d WHERE d.file_path IS NOT NULL AND d.file_path<>'';
 UPDATE tgdl_cluster_revision SET revision=COALESCE((SELECT MAX(revision) FROM tgdl_cluster_catalog),0) WHERE id=1;`); err != nil {
			return err
		}
	} else if err != nil {
		return err
	}
	if !secretPattern.MatchString(epoch) {
		return errors.New("invalid catalog epoch")
	}
	payload := strings.ReplaceAll(catalogJSON, "ROW.", "NEW.")
	upsert := `INSERT INTO tgdl_cluster_catalog(remote_id,revision,event_type,payload) VALUES(NEW.id,(SELECT revision FROM tgdl_cluster_revision WHERE id=1),EVENT,PAYLOAD)
 ON CONFLICT(remote_id) DO UPDATE SET revision=excluded.revision,event_type=excluded.event_type,payload=excluded.payload;`
	insert := strings.NewReplacer("EVENT", "'download_added'", "PAYLOAD", payload).Replace(upsert)
	update := strings.NewReplacer("EVENT", `CASE WHEN NEW.file_path IS NULL OR NEW.file_path='' THEN 'download_deleted' ELSE 'download_updated' END`, "PAYLOAD", `CASE WHEN NEW.file_path IS NULL OR NEW.file_path='' THEN json_object('remote_id',NEW.id) ELSE `+payload+` END`).Replace(upsert)
	_, err = tx.ExecContext(ctx, `CREATE TRIGGER IF NOT EXISTS tgdl_cluster_download_added AFTER INSERT ON downloads WHEN NEW.file_path IS NOT NULL AND NEW.file_path<>'' BEGIN
 UPDATE tgdl_cluster_revision SET revision=revision+1 WHERE id=1; `+insert+` END;
 CREATE TRIGGER IF NOT EXISTS tgdl_cluster_download_updated AFTER UPDATE OF id,group_id,group_name,message_id,file_name,file_size,file_type,file_path,file_hash,status,created_at,nsfw_score ON downloads
 WHEN OLD.id IS NOT NEW.id OR OLD.group_id IS NOT NEW.group_id OR OLD.group_name IS NOT NEW.group_name OR OLD.message_id IS NOT NEW.message_id OR OLD.file_name IS NOT NEW.file_name OR OLD.file_size IS NOT NEW.file_size OR OLD.file_type IS NOT NEW.file_type OR OLD.file_path IS NOT NEW.file_path OR OLD.file_hash IS NOT NEW.file_hash OR OLD.status IS NOT NEW.status OR OLD.created_at IS NOT NEW.created_at OR OLD.nsfw_score IS NOT NEW.nsfw_score BEGIN
 UPDATE tgdl_cluster_revision SET revision=revision+1 WHERE id=1; `+update+` END;
 CREATE TRIGGER IF NOT EXISTS tgdl_cluster_download_deleted AFTER DELETE ON downloads BEGIN
 UPDATE tgdl_cluster_revision SET revision=revision+1 WHERE id=1;
 INSERT INTO tgdl_cluster_catalog(remote_id,revision,event_type,payload) VALUES(OLD.id,(SELECT revision FROM tgdl_cluster_revision WHERE id=1),'download_deleted',json_object('remote_id',OLD.id))
 ON CONFLICT(remote_id) DO UPDATE SET revision=excluded.revision,event_type=excluded.event_type,payload=excluded.payload; END;
 CREATE TRIGGER IF NOT EXISTS tgdl_cluster_download_rekeyed AFTER UPDATE OF id ON downloads WHEN OLD.id<>NEW.id BEGIN
 UPDATE tgdl_cluster_revision SET revision=revision+1 WHERE id=1;
 INSERT INTO tgdl_cluster_catalog(remote_id,revision,event_type,payload) VALUES(OLD.id,(SELECT revision FROM tgdl_cluster_revision WHERE id=1),'download_deleted',json_object('remote_id',OLD.id))
 ON CONFLICT(remote_id) DO UPDATE SET revision=excluded.revision,event_type=excluded.event_type,payload=excluded.payload; END;`)
	return err
}

func (s Store) Changes(ctx context.Context, epoch string, after int64, limit int) (ChangePage, error) {
	page := ChangePage{Changes: []Change{}}
	tx, err := s.Reader.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return page, err
	}
	defer tx.Rollback()
	if err = kvRead(ctx, tx, "peer_id", &page.PeerID); err != nil {
		return page, err
	}
	if err = kvRead(ctx, tx, "cluster_catalog_epoch", &page.Epoch); err != nil {
		return page, err
	}
	if err = tx.QueryRowContext(ctx, `SELECT revision FROM tgdl_cluster_revision WHERE id=1`).Scan(&page.Head); err != nil {
		return page, err
	}
	page.Reset = epoch != page.Epoch || after < 0 || after > page.Head
	if page.Reset {
		after = 0
	}
	page.Next = after
	rows, err := tx.QueryContext(ctx, `SELECT revision,event_type,CASE WHEN length(CAST(payload AS BLOB))<=524288 THEN payload ELSE NULL END FROM tgdl_cluster_catalog WHERE revision>? ORDER BY revision LIMIT ?`, after, max(1, min(500, limit)))
	if err != nil {
		return page, err
	}
	defer rows.Close()
	size := 0
	for rows.Next() {
		var change Change
		var payload sql.NullString
		if err = rows.Scan(&change.Revision, &change.Type, &payload); err != nil {
			return page, err
		}
		if !payload.Valid {
			return page, errors.New("catalog record exceeds 512 KiB")
		}
		change.Payload = json.RawMessage(payload.String)
		encoded, err := json.Marshal(change)
		if err != nil {
			return page, err
		}
		if len(encoded) > 512<<10 {
			return page, errors.New("catalog record exceeds 512 KiB")
		}
		if size+len(encoded) > 512<<10 && len(page.Changes) > 0 {
			break
		}
		page.Changes = append(page.Changes, change)
		page.Next = change.Revision
		size += len(encoded)
	}
	if err = rows.Err(); err != nil {
		return page, err
	}
	page.More = page.Next < page.Head
	return page, nil
}

// RestoreSnapshot calls this on its private, validated database before
// publication. Ordinary process restarts retain the epoch and incremental cursor.
func (s Store) RotateCatalogEpoch(ctx context.Context) error {
	tx, err := s.transaction(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var old string
	if err = kvRead(ctx, tx, "cluster_catalog_epoch", &old); errors.Is(err, sql.ErrNoRows) {
		return nil
	} else if err != nil {
		return err
	}
	epoch, err := NewSecret()
	if err != nil {
		return err
	}
	if err = kvWrite(ctx, tx, "cluster_catalog_epoch", epoch); err != nil {
		return err
	}
	return tx.Commit()
}

func applyCatalogChange(ctx context.Context, tx *sql.Tx, peer string, c Change, now int64) (int64, error) {
	if c.Type == "download_deleted" {
		var p struct {
			ID int64 `json:"remote_id"`
		}
		if err := json.Unmarshal(c.Payload, &p); err != nil || p.ID <= 0 {
			return 0, errors.New("invalid deleted peer row")
		}
		_, err := tx.ExecContext(ctx, `DELETE FROM peer_downloads WHERE peer_id=? AND remote_id=?`, peer, p.ID)
		return p.ID, err
	}
	if c.Type != "download_added" && c.Type != "download_updated" {
		return 0, errors.New("unsupported catalog change")
	}
	var r CatalogRow
	if err := json.Unmarshal(c.Payload, &r); err != nil {
		return 0, err
	}
	if r.ID <= 0 || r.FilePath == nil || *r.FilePath == "" || strings.ContainsRune(*r.FilePath, 0) || r.FileSize != nil && *r.FileSize < 0 {
		return 0, errors.New("invalid peer catalog row")
	}
	return r.ID, upsertCatalogRow(ctx, tx, peer, r, now)
}

func (s Store) SaveChanges(ctx context.Context, p Peer, start SyncState, page ChangePage) error {
	if page.PeerID != p.PeerID || !secretPattern.MatchString(page.Epoch) || page.Head < 0 || page.Next < 0 || page.Next > page.Head || page.Changes == nil || len(page.Changes) > 500 {
		return errors.New("invalid change page")
	}
	base := start.ChangeRevision
	if page.Reset {
		base = 0
	} else if page.Epoch != start.CatalogEpoch {
		return errors.New("catalog epoch changed without reset")
	}
	last := base
	bytes := 0
	for _, c := range page.Changes {
		raw, err := json.Marshal(c)
		if err != nil {
			return err
		}
		bytes += len(raw)
		if bytes > 512<<10 {
			return errors.New("catalog page exceeds 512 KiB")
		}
		if c.Revision <= last || c.Revision > page.Head {
			return errors.New("nonadvancing change page")
		}
		last = c.Revision
	}
	if page.Next != last || page.More != (last < page.Head) || page.More && len(page.Changes) == 0 {
		return errors.New("inconsistent catalog cursor")
	}
	tx, err := s.transaction(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err = checkPeer(ctx, tx, p); err != nil {
		return err
	}
	state, err := syncState(ctx, tx)
	if err != nil {
		return err
	}
	ps := state[p.PeerID]
	if ps.CatalogEpoch != start.CatalogEpoch || ps.ChangeRevision != start.ChangeRevision {
		return errors.New("catalog cursor changed while syncing")
	}
	if page.Reset {
		if _, err = tx.ExecContext(ctx, `DELETE FROM peer_downloads WHERE peer_id=?`, p.PeerID); err != nil {
			return err
		}
		ps.SinceID = nil
	}
	now := time.Now().UnixMilli()
	maxID := int64(0)
	if ps.SinceID != nil {
		maxID = *ps.SinceID
	}
	for _, c := range page.Changes {
		id, e := applyCatalogChange(ctx, tx, p.PeerID, c, now)
		if e != nil {
			return e
		}
		maxID = max(maxID, id)
	}
	ps.SinceID = &maxID
	ps.CatalogEpoch = page.Epoch
	ps.ChangeRevision = page.Next
	ps.LastSuccessAt = &now
	ps.LastError = nil
	state[p.PeerID] = ps
	if err = kvWrite(ctx, tx, "cluster_sync_state", state); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, `UPDATE peers SET status='online',last_seen_at=? WHERE peer_id=?`, now, p.PeerID); err != nil {
		return err
	}
	if len(page.Changes) > 0 || page.Reset {
		if err = audit(ctx, tx, p.PeerID, "sync", fmt.Sprintf("%d changes, revision=%d", len(page.Changes), page.Next), true); err != nil {
			return err
		}
	}
	return tx.Commit()
}
