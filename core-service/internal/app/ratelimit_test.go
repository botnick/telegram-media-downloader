package app

import (
	"fmt"
	"testing"
	"time"
)

func TestRateLimiterExpiresEntriesAndReportsRemaining(t *testing.T) {
	l := newRateLimiter(2, time.Minute)
	now := time.Unix(100, 0)
	if ok, remaining, _ := l.allow("ip", now); !ok || remaining != 1 {
		t.Fatalf("first result = %v %d", ok, remaining)
	}
	if ok, remaining, _ := l.allow("ip", now.Add(time.Second)); !ok || remaining != 0 {
		t.Fatalf("second result = %v %d", ok, remaining)
	}
	if ok, _, retry := l.allow("ip", now.Add(2*time.Second)); ok || retry <= 0 {
		t.Fatalf("third result = %v retry=%s", ok, retry)
	}
	if ok, remaining, _ := l.allow("ip", now.Add(time.Minute+time.Second)); !ok || remaining != 1 {
		t.Fatalf("expired result = %v %d", ok, remaining)
	}
}

func TestRateLimiterCapacityNeverResetsLiveQuotas(t *testing.T) {
	l := newRateLimiter(1, time.Minute)
	now := time.Unix(100, 0)
	for i := 0; i < 10000; i++ {
		if ok, _, _ := l.allow(fmt.Sprint(i), now); !ok {
			t.Fatal("capacity", i)
		}
	}
	if ok, _, _ := l.allow("new", now); ok {
		t.Fatal("capacity failed open")
	}
	if ok, _, _ := l.allow("0", now); ok {
		t.Fatal("old client evicted")
	}
	if ok, _, _ := l.allow("new", now.Add(time.Minute)); !ok {
		t.Fatal("capacity not reclaimed")
	}
	if len(l.clients) != 1 || len(l.expires) != 1 {
		t.Fatal("expired state retained")
	}
	l.configure(2, time.Second)
	if len(l.clients) != 0 || len(l.expires) != 0 {
		t.Fatal("window change left stale expirations")
	}
}
