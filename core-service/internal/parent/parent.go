// Package parent ties tgdl-core's lifetime to the process that spawned it.
//
// The Node app spawns tgdl-core with a stdin pipe it never writes to and
// never closes. When Node exits for any reason (crash, kill -9, Task
// Manager on Windows, where child processes are not reaped with the
// parent) the OS closes the pipe, stdin reads EOF and tgdl-core shuts
// down instead of lingering as an orphan.
package parent

import "io"

// WatchStdin calls onEOF once r reaches EOF or fails. It returns at once;
// the read runs on its own goroutine.
func WatchStdin(r io.Reader, onEOF func()) {
	go func() {
		_, _ = io.Copy(io.Discard, r)
		onEOF()
	}()
}
