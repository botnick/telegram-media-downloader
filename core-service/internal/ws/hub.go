// Package ws provides a bounded, non-blocking event hub for dashboard clients.
package ws

import (
	"encoding/json"
	"errors"
	"sync"
)

type Event struct {
	Type    string
	Roles   []string
	Payload any
	Flat    bool
	batch   []Event
}

// Frames expands an internal transaction batch into ordinary wire events.
// The caller must not mutate returned events or their payloads.
func (e Event) Frames() []Event {
	if e.batch != nil {
		return e.batch
	}
	return []Event{e}
}

// Dashboard events preserve the released wire shape for each event family.
// Most runtime events use {type,payload}; a few legacy broadcasts put their
// fields beside type. Routing roles are internal metadata and never go wire.
func (e Event) MarshalJSON() ([]byte, error) {
	if e.batch != nil {
		return nil, errors.New("event batch must be expanded before writing")
	}
	if e.Flat {
		fields := map[string]json.RawMessage{}
		if e.Payload != nil {
			raw, err := json.Marshal(e.Payload)
			if err != nil {
				return nil, err
			}
			if err := json.Unmarshal(raw, &fields); err != nil {
				return nil, err
			}
		}
		if fields == nil {
			fields = map[string]json.RawMessage{}
		}
		fields["type"], _ = json.Marshal(e.Type)
		return json.Marshal(fields)
	}
	return json.Marshal(struct {
		Type    string `json:"type"`
		Payload any    `json:"payload,omitempty"`
	}{Type: e.Type, Payload: e.Payload})
}

type Client struct {
	role   string
	events chan Event
}

func (c *Client) Events() <-chan Event { return c.events }
func (c *Client) Role() string         { return c.role }

type Hub struct {
	mu      sync.RWMutex
	cap     int
	clients map[*Client]struct{}
	closed  bool
}

func NewHub(capacity int) *Hub {
	if capacity < 1 {
		capacity = 1
	}
	return &Hub{cap: capacity, clients: make(map[*Client]struct{})}
}
func (h *Hub) Add(role string) *Client {
	c := &Client{role: role, events: make(chan Event, h.cap)}
	h.mu.Lock()
	if h.closed {
		close(c.events)
	} else {
		h.clients[c] = struct{}{}
	}
	h.mu.Unlock()
	return c
}

func (h *Hub) Close() {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.closed = true
	for c := range h.clients {
		close(c.events)
		delete(h.clients, c)
	}
}
func (h *Hub) Remove(c *Client) {
	if c == nil {
		return
	}
	h.mu.Lock()
	if _, ok := h.clients[c]; ok {
		delete(h.clients, c)
		close(c.events)
	}
	h.mu.Unlock()
}

// Count reports currently connected dashboard clients for the health surface.
func (h *Hub) Count() int {
	if h == nil {
		return 0
	}
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.clients)
}
func (h *Hub) Broadcast(e Event) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	for c := range h.clients {
		if !allowed(c.role, e.Roles) {
			continue
		}
		select {
		case c.events <- e:
		default:
		}
	}
}

// BroadcastBatch reserves one queue slot per transaction-sized group, so a
// single 500-row sweep cannot overflow a healthy client's 64-slot queue.
// Frames retain their original order and role checks. Slow clients remain
// bounded: groups larger than 512 are split, and full queues never block work.
func (h *Hub) BroadcastBatch(events []Event) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	for start := 0; start < len(events); start += 512 {
		part := events[start:min(start+512, len(events))]
		for c := range h.clients {
			frames := make([]Event, 0, len(part))
			for _, e := range part {
				if allowed(c.role, e.Roles) {
					frames = append(frames, e)
				}
			}
			if len(frames) == 0 {
				continue
			}
			select {
			case c.events <- Event{batch: frames}:
			default:
			}
		}
	}
}
func allowed(role string, roles []string) bool {
	if len(roles) == 0 {
		return true
	}
	for _, r := range roles {
		if r == role {
			return true
		}
	}
	return false
}
