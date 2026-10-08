package ws

import (
	"encoding/json"
	"testing"
	"time"
)

func TestWireEventOmitsRolesAndFlattensPayload(t *testing.T) {
	raw, err := json.Marshal(Event{Type: "file_deleted", Roles: []string{"admin"}, Payload: map[string]any{"id": 5}})
	if err != nil {
		t.Fatal(err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatal(err)
	}
	if len(decoded) != 2 || decoded["id"] != float64(5) || decoded["type"] != "file_deleted" {
		t.Fatalf("wire event: %s", raw)
	}
}

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
