//go:build linux || darwin || freebsd || netbsd || openbsd || dragonfly

package seekbar

import (
	"os/exec"
	"syscall"
)

// Sprite encodes are background work: run them at a lower CPU priority so a
// long decode never competes with downloads or the web server.
const niceness = 10

func runLowPriority(cmd *exec.Cmd) error {
	if err := cmd.Start(); err != nil {
		return err
	}
	_ = syscall.Setpriority(syscall.PRIO_PROCESS, cmd.Process.Pid, niceness)
	return cmd.Wait()
}
