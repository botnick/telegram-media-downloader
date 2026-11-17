package app

import (
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestSetDialogsServerTiming(t *testing.T) {
	rec := httptest.NewRecorder()
	setDialogsServerTiming(rec, 1250*time.Millisecond)
	got := rec.Header().Get("Server-Timing")
	if got != "dialogs;dur=1250.0" {
		t.Fatalf("unexpected Server-Timing: %q", got)
	}
	if strings.Contains(got, "\n") {
		t.Fatal("invalid header value")
	}
}

func TestSetDialogsServerTimingZero(t *testing.T) {
	rec := httptest.NewRecorder()
	setDialogsServerTiming(rec, 0)
	if got := rec.Header().Get("Server-Timing"); got != "dialogs;dur=0.0" {
		t.Fatalf("unexpected zero duration: %q", got)
	}
}
