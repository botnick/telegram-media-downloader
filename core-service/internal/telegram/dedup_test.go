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
