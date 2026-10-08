// Package ws provides a bounded, non-blocking event hub for dashboard clients.
package ws

import (
	"encoding/json"
	"sync"
)

type Event struct {
	Type    string
	Roles   []string
	Payload any
	Flat    bool
}

// Dashboard events preserve the released wire shape for each event family.
// Most runtime events use {type,payload}; a few legacy broadcasts put their
// fields beside type. Routing roles are internal metadata and never go wire.
func (e Event) MarshalJSON() ([]byte, error) {
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
