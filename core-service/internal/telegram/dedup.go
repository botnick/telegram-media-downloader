package telegram

import (
	"strconv"
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
	return strings.ToLower(strings.TrimSpace(m.Kind)) + "\x00" + strings.TrimSpace(m.ID) + "\x00" + strconv.FormatInt(m.Size, 10)
}

func (m MediaIdentity) Valid() bool {
	return strings.TrimSpace(m.Kind) != "" && strings.TrimSpace(m.ID) != "" && !strings.ContainsRune(m.Kind, '\x00') && !strings.ContainsRune(m.ID, '\x00') && m.Size >= 0
}

type dedupState uint8

const (
	reserved dedupState = iota + 1
	claimed
	completed
)

type DedupIndex struct {
	mu   sync.Mutex
	seen map[string]dedupState
}

func NewDedupIndex() *DedupIndex {
	return &DedupIndex{seen: make(map[string]dedupState)}
}

func (d *DedupIndex) Reserve(identity MediaIdentity) bool {
	key := identity.Key()
	if !identity.Valid() {
		return false
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	if _, exists := d.seen[key]; exists {
		return false
	}
	d.seen[key] = reserved
	return true
}

// Claim transfers queued work to exactly one network worker. Observing a
// reservation with Has is insufficient because multiple workers can see it.
func (d *DedupIndex) Claim(identity MediaIdentity) bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	key := identity.Key()
	if d.seen[key] != reserved {
		return false
	}
	d.seen[key] = claimed
	return true
}

func (d *DedupIndex) Complete(identity MediaIdentity) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.seen[identity.Key()] == claimed {
		d.seen[identity.Key()] = completed
	}
}

func (d *DedupIndex) Release(identity MediaIdentity) {
	d.mu.Lock()
	if d.seen[identity.Key()] == reserved {
		delete(d.seen, identity.Key())
	}
	d.mu.Unlock()
}

// AbortClaim is the worker's failure path. Queue rejection uses Release,
// which cannot release work already claimed by a running worker.
func (d *DedupIndex) AbortClaim(identity MediaIdentity) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.seen[identity.Key()] == claimed {
		delete(d.seen, identity.Key())
	}
}

func (d *DedupIndex) Has(identity MediaIdentity) bool {
	d.mu.Lock()
	_, ok := d.seen[identity.Key()]
	d.mu.Unlock()
	return ok
}
