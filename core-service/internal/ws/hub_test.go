package ws

import (
	"testing"
	"time"
)

func TestHubBroadcastDoesNotBlockAndHonorsRole(t *testing.T) {
	h := NewHub(4)
	admin := h.Add("admin")
	guest := h.Add("guest")
	h.Broadcast(Event{Type: "secret", Roles: []string{"admin"}, Payload: map[string]any{"ok": true}})
	select {
	case <-admin.Events():
	case <-time.After(time.Second):
		t.Fatal("admin did not receive event")
	}
	select {
	case <-guest.Events():
		t.Fatal("guest received admin event")
	case <-time.After(10 * time.Millisecond):
	}
	h.Remove(admin)
	h.Remove(guest)
}
