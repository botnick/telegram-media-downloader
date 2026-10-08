package app

import (
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
