package telegram

import (
	"fmt"
	"strings"
	"sync"
)

// MediaIdentity is the identity Telegram exposes before the bytes are
// downloaded. Reserving it at enqueue time prevents duplicate work when the
// same update is observed by both live updates and a history catch-up.
type MediaIdentity struct {
	Kind string
	ID   string
	Size int64
}

func (m MediaIdentity) Key() string {
	return fmt.Sprintf("%s\x00%s\x00%d", strings.ToLower(strings.TrimSpace(m.Kind)), strings.TrimSpace(m.ID), m.Size)
}

type DedupIndex struct {
	mu   sync.Mutex
	seen map[string]struct{}
}

func NewDedupIndex() *DedupIndex {
	return &DedupIndex{seen: make(map[string]struct{})}
}

func (d *DedupIndex) Reserve(identity MediaIdentity) bool {
	key := identity.Key()
	if key == "\x00\x00" || identity.ID == "" || identity.Size < 0 {
		return false
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	if _, exists := d.seen[key]; exists {
		return false
	}
	d.seen[key] = struct{}{}
	return true
}

func (d *DedupIndex) Release(identity MediaIdentity) {
	d.mu.Lock()
	delete(d.seen, identity.Key())
	d.mu.Unlock()
}

func (d *DedupIndex) Has(identity MediaIdentity) bool {
	d.mu.Lock()
	_, ok := d.seen[identity.Key()]
	d.mu.Unlock()
	return ok
}
