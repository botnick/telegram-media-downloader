//go:build !(linux || darwin || freebsd || netbsd || openbsd || dragonfly)

package seekbar

import "os/exec"

func runLowPriority(cmd *exec.Cmd) error { return cmd.Run() }
