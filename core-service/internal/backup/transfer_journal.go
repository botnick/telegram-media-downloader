package backup

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/service/s3"
)

// Retain the original encrypted destination config independently of destination
// deletion/edits, so cleanup cannot be redirected to a new bucket or server.
type transferJournal struct {
	manager     *Manager
	destination int64
	provider    string
	config      []byte
}
type transferLease struct {
	journal *transferJournal
	id      string
}

func (j *transferJournal) track(ctx context.Context, kind, name, uploadID string) (*transferLease, error) {
	if j == nil {
		return nil, nil
	}
	id, err := randomSFTPName("")
	if err != nil {
		return nil, err
	}
	_, err = j.manager.opts.Writer.ExecContext(ctx, `INSERT INTO native_backup_transfers(id,destination_id,provider,config_blob,kind,remote_path,upload_id,state,created_at) VALUES(?,?,?,?,?,?,?,'active',?)`, id, j.destination, j.provider, j.config, kind, name, uploadID, time.Now().UnixMilli())
	if err != nil {
		return nil, fmt.Errorf("persist backup transfer ownership: %w", err)
	}
	return &transferLease{j, id}, nil
}
func (l *transferLease) finish(removed bool, cause error) error {
	if l == nil {
		return nil
	}
	m := l.journal.manager
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var err error
	if removed {
		_, err = m.opts.Writer.ExecContext(ctx, `DELETE FROM native_backup_transfers WHERE id=?`, l.id)
	} else {
		message := "remote cleanup remains pending"
		if cause != nil {
			message = cause.Error()
		}
		_, err = m.opts.Writer.ExecContext(ctx, `UPDATE native_backup_transfers SET state='pending',error=?,attempts=1,next_retry_at=? WHERE id=?`, message, time.Now().Add(5*time.Second).UnixMilli(), l.id)
	}
	if err != nil {
		// Once the transfer has joined it can be reclaimed even when the first
		// database update failed. A restart also recovers every nonterminal row.
		m.strandedTransfers.Store(l.id, struct{}{})
		return fmt.Errorf("persist backup cleanup outcome: %w", err)
	}
	return nil
}

type pendingTransfer struct {
	id                   string
	destination          int64
	provider             string
	config               []byte
	kind, name, uploadID string
	attempts             int
}

const cleanupWorkers = 4

func (m *Manager) cleanupTransfers() {
	defer m.wg.Done()
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		if m.ctx.Err() != nil {
			return
		}
		m.strandedTransfers.Range(func(key, value any) bool {
			if _, owned := m.strandedTransfers.LoadAndDelete(key); !owned {
				return m.ctx.Err() == nil
			}
			if _, err := m.opts.Writer.ExecContext(m.ctx, `UPDATE native_backup_transfers SET state='pending',next_retry_at=0 WHERE id=?`, key); err != nil {
				m.strandedTransfers.Store(key, struct{}{})
			}
			return m.ctx.Err() == nil
		})
		record, err := m.claimCleanup(m.ctx)
		if err == nil {
			ctx, cancel := context.WithTimeout(m.ctx, 30*time.Second)
			err = m.reclaimTransfer(ctx, record)
			cancel()
			if m.ctx.Err() != nil {
				return
			}
			if err == nil {
				_, err = m.opts.Writer.ExecContext(m.ctx, `DELETE FROM native_backup_transfers WHERE id=?`, record.id)
				if err == nil {
					m.Log("info", fmt.Sprintf("reclaimed interrupted %s transfer for destination #%d", record.provider, record.destination))
					continue
				}
			} else {
				delay := min(30*time.Minute, 5*time.Second*time.Duration(1<<min(record.attempts, 9)))
				_, saveErr := m.opts.Writer.ExecContext(m.ctx, `UPDATE native_backup_transfers SET state='pending',attempts=attempts+1,error=?,next_retry_at=? WHERE id=?`, err.Error(), time.Now().Add(delay).UnixMilli(), record.id)
				m.Log("warn", fmt.Sprintf("interrupted %s transfer for destination #%d still needs cleanup: %v", record.provider, record.destination, err))
				if saveErr == nil {
					continue
				}
			}
			m.strandedTransfers.Store(record.id, struct{}{})
		}
		select {
		case <-m.ctx.Done():
			return
		case <-ticker.C:
		}
	}
}
func (m *Manager) claimCleanup(ctx context.Context) (pendingTransfer, error) {
	var r pendingTransfer
	err := m.opts.Writer.QueryRowContext(ctx, `UPDATE native_backup_transfers SET state='cleaning' WHERE id=(SELECT id FROM native_backup_transfers WHERE state='pending' AND next_retry_at<=? ORDER BY next_retry_at,created_at,id LIMIT 1) RETURNING id,destination_id,provider,config_blob,kind,remote_path,upload_id,attempts`, time.Now().UnixMilli()).Scan(&r.id, &r.destination, &r.provider, &r.config, &r.kind, &r.name, &r.uploadID, &r.attempts)
	return r, err
}
func (m *Manager) reclaimTransfer(ctx context.Context, r pendingTransfer) error {
	secret, err := m.opts.Secret(ctx)
	if err != nil {
		return errors.New("backup cleanup credentials are unavailable")
	}
	defer clear(secret)
	cfg, err := openConfig(r.config, secret)
	if err != nil {
		return errors.New("backup cleanup credentials cannot be decrypted")
	}
	switch r.kind {
	case "s3-multipart":
		if r.provider != "s3" || r.uploadID == "" {
			return errors.New("invalid multipart cleanup record")
		}
		p, err := newS3(cfg)
		if err != nil {
			return err
		}
		defer p.Close()
		prefix := ""
		if p.prefix != "" {
			prefix = p.prefix + "/"
		}
		if !strings.HasPrefix(r.name, prefix) {
			return errors.New("multipart cleanup path is outside its recorded prefix")
		}
		if err = validObject(strings.TrimPrefix(r.name, prefix)); err != nil {
			return err
		}
		return p.abortMultipart(ctx, r.name, r.uploadID)
	case "sftp-temp":
		if r.provider != "sftp" {
			return errors.New("invalid SFTP cleanup record")
		}
		p, err := newSFTP(cfg, m.checkSSHHost)
		if err != nil {
			return err
		}
		defer p.Close()
		return p.removeOwnedTemporary(ctx, r.name)
	}
	return errors.New("unknown backup transfer cleanup kind")
}
func (p *s3Provider) abortMultipart(ctx context.Context, key, id string) error {
	_, err := p.client.AbortMultipartUpload(ctx, &s3.AbortMultipartUploadInput{Bucket: &p.bucket, Key: &key, UploadId: &id})
	if err != nil && !s3Missing(err) {
		return s3Error("AbortMultipartUpload", err)
	}
	// A server may finish an in-flight part after accepting Abort. Keep the
	// journal until ListParts confirms the upload is absent or has no parts.
	one := int32(1)
	parts, err := p.client.ListParts(ctx, &s3.ListPartsInput{Bucket: &p.bucket, Key: &key, UploadId: &id, MaxParts: &one})
	if s3Missing(err) {
		return nil
	}
	if err != nil {
		return s3Error("ListParts", err)
	}
	if len(parts.Parts) != 0 || parts.IsTruncated != nil && *parts.IsTruncated {
		return errors.New("S3 multipart parts remain after abort")
	}
	return nil
}

func (m *Manager) Cleanup(ctx context.Context, limit, offset int) ([]map[string]any, error) {
	rows, err := m.opts.Reader.QueryContext(ctx, `SELECT destination_id,provider,kind,remote_path,state,attempts,error,next_retry_at,created_at FROM native_backup_transfers ORDER BY created_at,id LIMIT ? OFFSET ?`, max(1, min(limit, 200)), max(0, offset))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var destination, next, created int64
		var provider, kind, name, state string
		var attempts int
		var message sql.NullString
		if err = rows.Scan(&destination, &provider, &kind, &name, &state, &attempts, &message, &next, &created); err != nil {
			return nil, err
		}
		out = append(out, map[string]any{"destinationId": destination, "provider": provider, "kind": kind, "remotePath": name, "state": state, "attempts": attempts, "error": nullableString(message), "nextRetryAt": next, "createdAt": created})
	}
	return out, rows.Err()
}
