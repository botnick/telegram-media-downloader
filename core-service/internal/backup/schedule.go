package backup

import (
	"fmt"
	"strconv"
	"strings"
	"time"
)

// The five-field schedule supports the existing *, */N and comma-list syntax
// plus inclusive ranges. Day-of-month and weekday follow cron OR semantics.
func cronField(raw string, value, lo, hi int) (bool, error) {
	matched := false
	for _, part := range strings.Split(raw, ",") {
		step := 1
		pieces := strings.Split(part, "/")
		if len(pieces) > 2 {
			return false, fmt.Errorf("invalid cron field %q", raw)
		}
		if len(pieces) == 2 {
			n, err := strconv.Atoi(pieces[1])
			if err != nil || n < 1 || n > hi-lo+1 {
				return false, fmt.Errorf("invalid cron step %q", raw)
			}
			step = n
		}
		start, end := lo, hi
		if pieces[0] != "*" {
			rangeParts := strings.Split(pieces[0], "-")
			n, err := strconv.Atoi(rangeParts[0])
			if err != nil {
				return false, fmt.Errorf("invalid cron field %q", raw)
			}
			start, end = n, n
			if len(rangeParts) == 2 {
				end, err = strconv.Atoi(rangeParts[1])
				if err != nil {
					return false, err
				}
			} else if len(rangeParts) > 2 {
				return false, fmt.Errorf("invalid cron range %q", raw)
			}
		}
		if start < lo || end > hi || start > end {
			return false, fmt.Errorf("cron value out of range %q", raw)
		}
		if value >= start && value <= end && (value-start)%step == 0 {
			matched = true
		}
	}
	return matched, nil
}
func cronMatches(expr string, t time.Time) (bool, error) {
	parts := strings.Fields(expr)
	if len(parts) != 5 {
		return false, fmt.Errorf("cron requires five fields")
	}
	values := []int{t.Minute(), t.Hour(), t.Day(), int(t.Month()), int(t.Weekday())}
	bounds := [][2]int{{0, 59}, {0, 23}, {1, 31}, {1, 12}, {0, 6}}
	matches := make([]bool, 5)
	for i, p := range parts {
		v, err := cronField(p, values[i], bounds[i][0], bounds[i][1])
		if err != nil {
			return false, err
		}
		matches[i] = v
	}
	day := matches[2] && matches[4]
	if parts[2] != "*" && parts[4] != "*" {
		day = matches[2] || matches[4]
	}
	return matches[0] && matches[1] && matches[3] && day, nil
}
func validateCron(expr string) error { _, err := cronMatches(expr, time.Now()); return err }
func (m *Manager) schedule() {
	defer m.wg.Done()
	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-m.ctx.Done():
			return
		case now := <-ticker.C:
			m.scheduleAt(now)
		}
	}
}
func (m *Manager) scheduleAt(now time.Time) {
	m.op.Lock()
	defer m.op.Unlock()
	if m.available() != nil {
		return
	}
	ds, err := m.destinations(m.ctx)
	if err != nil {
		return
	}
	for _, d := range ds {
		if !d.Enabled || d.Mode != "snapshot" || !d.Cron.Valid {
			continue
		}
		match, e := cronMatches(d.Cron.String, now)
		if e != nil || !match {
			continue
		}
		tx, e := m.opts.Writer.BeginTx(m.ctx, nil)
		if e != nil {
			return
		}
		_, e = tx.ExecContext(m.ctx, `INSERT OR IGNORE INTO native_backup_state(destination_id) VALUES(?)`, d.ID)
		if e == nil {
			res, er := tx.ExecContext(m.ctx, `UPDATE native_backup_state SET last_scheduled_minute=? WHERE destination_id=? AND paused=0 AND (last_scheduled_minute IS NULL OR last_scheduled_minute<?)`, now.Unix()/60, d.ID, now.Unix()/60)
			e = er
			if e == nil {
				n, er := res.RowsAffected()
				e = er
				if e == nil && n > 0 {
					_, e = tx.ExecContext(m.ctx, `INSERT INTO backup_jobs(destination_id) SELECT ? WHERE NOT EXISTS(SELECT 1 FROM backup_jobs WHERE destination_id=? AND download_id IS NULL AND status IN ('pending','uploading'))`, d.ID, d.ID)
				}
			}
		}
		if e == nil {
			e = tx.Commit()
		}
		_ = tx.Rollback()
		if e != nil {
			m.Log("error", fmt.Sprintf("snapshot schedule #%d: %v", d.ID, e))
		} else {
			m.wake(d.ID)
		}
	}
}
