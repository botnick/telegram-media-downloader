package cluster

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

func TestChangesReadCommittedAddEditAndDelete(t *testing.T) {
	s, close := testClusterStore(t, t.TempDir())
	defer close()
	ctx := context.Background()
	if _, err := s.Writer.Exec(`INSERT INTO downloads(id,group_id,message_id,file_path,file_name,file_size) VALUES(1,'fixture',1,'first.bin','first.bin',4),(2,'fixture',2,'kept.bin','kept.bin',8)`); err != nil {
		t.Fatal(err)
	}
	page, err := s.Changes(ctx, "", 0, 1)
	if err != nil {
		t.Fatal("read first change page", err)
	}
	if !page.Reset || !page.More || len(page.Changes) != 1 || page.Next != 1 {
		t.Fatal(page)
	}
	var row CatalogRow
	if err = json.Unmarshal(page.Changes[0].Payload, &row); err != nil || row.ID != 1 || row.FileName == nil || *row.FileName != "first.bin" {
		t.Fatal(row, err)
	}
	page, err = s.Changes(ctx, page.Epoch, page.Next, 500)
	if err != nil || page.Reset || page.More || len(page.Changes) != 1 || page.Next != 2 {
		t.Fatal(page, err)
	}
	if _, err = s.Writer.Exec(`UPDATE downloads SET file_name='edited.bin' WHERE id=1; DELETE FROM downloads WHERE id=2`); err != nil {
		t.Fatal(err)
	}
	page, err = s.Changes(ctx, page.Epoch, page.Next, 500)
	if err != nil || page.More || len(page.Changes) != 2 {
		t.Fatal(page, err)
	}
	if page.Changes[0].Type != "download_updated" || page.Changes[1].Type != "download_deleted" {
		t.Fatal(page.Changes)
	}
	if err = json.Unmarshal(page.Changes[0].Payload, &row); err != nil || *row.FileName != "edited.bin" {
		t.Fatal(row, err)
	}
}

func testChange(id, rev int64, path string) Change {
	raw, _ := json.Marshal(map[string]any{"id": id, "file_path": path, "file_size": 4})
	return Change{Revision: rev, Type: "download_updated", Payload: raw}
}
func TestChangePageRollbackResetAndStalePair(t *testing.T) {
	s, close := testClusterStore(t, t.TempDir())
	defer close()
	ctx := context.Background()
	p, err := s.SaveOutbound(ctx, Handshake{PeerID: testPeerID, Name: "source", URL: "http://source.invalid", SharedSecret: testSecret}, testSecret)
	if err != nil {
		t.Fatal(err)
	}
	page := ChangePage{PeerID: p.PeerID, Epoch: testSecret, Head: 2, Next: 2, Reset: true, Changes: []Change{testChange(1, 1, "a"), testChange(2, 2, "b")}}
	if _, err = s.Writer.Exec(`INSERT INTO peer_downloads(peer_id,remote_id,file_path,cached_at) VALUES(?,99,'old',1);`, p.PeerID); err != nil {
		t.Fatal(err)
	}
	if _, err = s.Writer.Exec(`CREATE TRIGGER reject_second BEFORE INSERT ON peer_downloads WHEN NEW.remote_id=2 BEGIN SELECT RAISE(ABORT,'injected'); END`); err != nil {
		t.Fatal(err)
	}
	if err = s.SaveChanges(ctx, p, SyncState{}, page); err == nil {
		t.Fatal("failed page accepted")
	}
	var count, id int
	if err = s.Reader.QueryRow(`SELECT count(*),remote_id FROM peer_downloads`).Scan(&count, &id); err != nil || count != 1 || id != 99 {
		t.Fatal("reset escaped rollback", count, id, err)
	}
	state, err := s.SyncState(ctx)
	if err != nil || len(state) != 0 {
		t.Fatal("cursor escaped rollback", state, err)
	}
	if _, err = s.Writer.Exec(`DROP TRIGGER reject_second`); err != nil {
		t.Fatal(err)
	}
	if err = s.SaveChanges(ctx, p, SyncState{}, page); err != nil {
		t.Fatal(err)
	}
	if err = s.SaveChanges(ctx, p, SyncState{}, page); err == nil {
		t.Fatal("stale cursor accepted")
	}
	state, err = s.SyncState(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.Update(ctx, p.PeerID, map[string]any{"url": "http://moved.invalid"}); err != nil {
		t.Fatal(err)
	}
	page.Reset = false
	page.Changes = []Change{}
	if err = s.SaveChanges(ctx, p, state[p.PeerID], page); !errors.Is(err, ErrPeerChanged) {
		t.Fatal("old endpoint accepted", err)
	}
	if _, err = s.Revoke(ctx, p.PeerID); err != nil {
		t.Fatal(err)
	}
	if err = s.SaveChanges(ctx, p, state[p.PeerID], page); !errors.Is(err, ErrPeerChanged) {
		t.Fatal("revoked peer accepted", err)
	}
}

func TestInvalidChangePageNeverAdvances(t *testing.T) {
	ctx := context.Background()
	for _, tc := range []struct {
		name   string
		mutate func(*ChangePage)
	}{
		{"null_rows", func(p *ChangePage) { p.Changes = nil; p.Head = 0; p.Next = 0 }},
		{"negative_cursor", func(p *ChangePage) { p.Next = -1 }},
		{"wrong_peer", func(p *ChangePage) { p.PeerID = "other" }},
		{"missing_path", func(p *ChangePage) { p.Changes[0].Payload = json.RawMessage(`{"id":1}`) }},
		{"zero_id", func(p *ChangePage) { p.Changes[0] = testChange(0, 1, "a") }},
		{"negative_size", func(p *ChangePage) { p.Changes[0].Payload = json.RawMessage(`{"id":1,"file_path":"a","file_size":-1}`) }},
		{"invalid_deleted", func(p *ChangePage) {
			p.Changes[0] = Change{Revision: 1, Type: "download_deleted", Payload: json.RawMessage(`{}`)}
		}},
		{"nonadvancing", func(p *ChangePage) { p.Changes[0].Revision = 0 }},
		{"unknown_event", func(p *ChangePage) { p.Changes[0].Type = "other" }},
		{"inconsistent_more", func(p *ChangePage) { p.More = true }},
		{"oversized", func(p *ChangePage) { p.Changes[0] = testChange(1, 1, strings.Repeat("x", 600<<10)) }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s, close := testClusterStore(t, t.TempDir())
			defer close()
			p, err := s.SaveOutbound(ctx, Handshake{PeerID: testPeerID, Name: "source", URL: "http://source.invalid", SharedSecret: testSecret}, testSecret)
			if err != nil {
				t.Fatal(err)
			}
			page := ChangePage{PeerID: p.PeerID, Epoch: testSecret, Head: 1, Next: 1, Reset: true, Changes: []Change{testChange(1, 1, "a")}}
			tc.mutate(&page)
			if err := s.SaveChanges(ctx, p, SyncState{}, page); err == nil {
				t.Fatal("invalid page accepted")
			}
			state, err := s.SyncState(ctx)
			if err != nil || len(state) != 0 {
				t.Fatal(state, err)
			}
		})
	}
}

func TestChangesConcurrentEditsAreNotSkippedByPaging(t *testing.T) {
	s, close := testClusterStore(t, t.TempDir())
	defer close()
	ctx := context.Background()
	if _, err := s.Writer.Exec(`INSERT INTO downloads(id,group_id,message_id,file_path) VALUES(1,'fixture',1,'a'),(2,'fixture',2,'b'),(3,'fixture',3,'c')`); err != nil {
		t.Fatal(err)
	}
	page, err := s.Changes(ctx, "", 0, 1)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.Writer.Exec(`UPDATE downloads SET file_path='a2' WHERE id=1; DELETE FROM downloads WHERE id=2; UPDATE downloads SET id=4 WHERE id=3`); err != nil {
		t.Fatal(err)
	}
	seen := map[int64]string{}
	for page.More {
		page, err = s.Changes(ctx, page.Epoch, page.Next, 1)
		if err != nil {
			t.Fatal(err)
		}
		for _, c := range page.Changes {
			var p struct {
				ID      int64  `json:"id"`
				Deleted int64  `json:"remote_id"`
				Path    string `json:"file_path"`
			}
			if err = json.Unmarshal(c.Payload, &p); err != nil {
				t.Fatal(err)
			}
			if p.Deleted > 0 {
				seen[p.Deleted] = "deleted"
			} else {
				seen[p.ID] = p.Path
			}
		}
	}
	if len(seen) != 4 || seen[1] != "a2" || seen[2] != "deleted" || seen[3] != "deleted" || seen[4] != "c" {
		t.Fatal("missed concurrent change", seen)
	}
	var retained int
	if err = s.Reader.QueryRow(`SELECT count(*) FROM tgdl_cluster_catalog`).Scan(&retained); err != nil || retained != 4 {
		t.Fatal(retained, err)
	}
	before := page.Next
	tx, err := s.Writer.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(`DELETE FROM downloads`); err != nil {
		t.Fatal(err)
	}
	if err = tx.Rollback(); err != nil {
		t.Fatal(err)
	}
	page, err = s.Changes(ctx, page.Epoch, before, 500)
	if err != nil || len(page.Changes) != 0 || page.Next != before {
		t.Fatal("rollback leaked change", page, err)
	}
}

func TestChangesResponseFitsBoundEvenWhenJSONEscapesExpand(t *testing.T) {
	s, close := testClusterStore(t, t.TempDir())
	defer close()
	if _, err := s.Writer.Exec(`INSERT INTO downloads(id,group_id,message_id,file_path,file_name) VALUES(1,'fixture',1,'a',?),(2,'fixture',2,'b',?)`, strings.Repeat("<", 60000), strings.Repeat("<", 60000)); err != nil {
		t.Fatal(err)
	}
	page, err := s.Changes(context.Background(), "", 0, 500)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(page)
	if err != nil {
		t.Fatal(err)
	}
	if len(raw) > 600<<10 || !page.More || len(page.Changes) != 1 {
		t.Fatalf("page bound lost after JSON escaping: bytes=%d rows=%d more=%v", len(raw), len(page.Changes), page.More)
	}
}
