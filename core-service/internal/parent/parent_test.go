package parent

import (
	"io"
	"testing"
	"time"
)

func TestWatchStdinCallsOnEOFOnce(t *testing.T) {
	reader, writer := io.Pipe()
	defer reader.Close()
	called := make(chan struct{}, 2)
	WatchStdin(reader, func() { called <- struct{}{} })
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case <-called:
	case <-time.After(time.Second):
		t.Fatal("onEOF was not called")
	}
	select {
	case <-called:
		t.Fatal("onEOF was called more than once")
	case <-time.After(20 * time.Millisecond):
	}
}
