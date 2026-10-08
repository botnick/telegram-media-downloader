package telegram

import (
	"testing"
)

func TestDedupIndexReservesLiveTelegramIdentity(t *testing.T) {
	index := NewDedupIndex()
	identity := MediaIdentity{Kind: "document", ID: "123", Size: 42}
	if !index.Reserve(identity) {
		t.Fatal("first identity should reserve")
	}
	if index.Reserve(identity) {
		t.Fatal("same live identity should be rejected")
	}
	index.Release(identity)
	if !index.Reserve(identity) {
		t.Fatal("released identity should reserve again")
	}
}

func TestDedupIdentityIncludesSizeAndKind(t *testing.T) {
	if (MediaIdentity{Kind: "photo", ID: "7", Size: 10}).Key() == (MediaIdentity{Kind: "photo", ID: "7", Size: 11}).Key() {
		t.Fatal("size must participate in identity")
	}
	if (MediaIdentity{Kind: "photo", ID: "7", Size: 10}).Key() == (MediaIdentity{Kind: "video", ID: "7", Size: 10}).Key() {
		t.Fatal("kind must participate in identity")
	}
}

func TestDedupRejectsBlankAndAmbiguousIdentities(t *testing.T) {
	for _, id := range []MediaIdentity{{Kind: "", ID: "123", Size: 1}, {Kind: "photo", ID: "  ", Size: 1}, {Kind: "photo", ID: "a\x00b", Size: 1}, {Kind: "photo", ID: "123", Size: -1}} {
		if NewDedupIndex().Reserve(id) {
			t.Errorf("invalid identity accepted: %#v", id)
		}
	}
}

func TestQueueReleaseCannotClearActiveOrCompletedIdentity(t *testing.T) {
	index := NewDedupIndex()
	id := MediaIdentity{Kind: "photo", ID: "5", Size: 1}
	if !index.Reserve(id) || !index.Claim(id) {
		t.Fatal("claim failed")
	}
	index.Release(id)
	if index.Reserve(id) || index.Claim(id) {
		t.Fatal("active download was released by queue")
	}
	index.Complete(id)
	index.Release(id)
	index.AbortClaim(id)
	if index.Reserve(id) {
		t.Fatal("completed download was released")
	}
}
