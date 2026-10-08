package app

import (
	"context"
	"github.com/gotd/td/tg"
	"testing"
)

func TestSelfOwnedGroupIsAccepted(t *testing.T) {
	ctx := context.Background()
	a, err := newConfiguredTestApp(ctx, Config{DataDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	self := "11111111-1111-4111-8111-111111111111"
	if _, err = a.db.Writer.ExecContext(ctx, `INSERT OR REPLACE INTO kv(key,value,updated_at) VALUES('peer_id',?,0)`, `"`+self+`"`); err != nil {
		t.Fatal(err)
	}
	cfg, err := a.config.Load(ctx)
	if err != nil {
		t.Fatal(err)
	}
	cfg["groups"] = []any{map[string]any{"id": "-1000000000042", "name": "self-owned", "enabled": true, "ownerPeerId": self}}
	if err = a.config.Save(ctx, cfg); err != nil {
		t.Fatal(err)
	}
	u := updateFixture()
	m := u.Updates[0].(*tg.UpdateNewChannelMessage).Message.(*tg.Message)
	_, allowed, err := a.monitorFilter(ctx, "one", m, u)
	if err != nil {
		t.Fatal(err)
	}
	if !allowed {
		t.Fatal("explicitly self-owned group was silently rejected")
	}
}
