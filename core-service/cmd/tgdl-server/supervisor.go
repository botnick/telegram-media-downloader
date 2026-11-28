package main

import (
	"os"
	"strings"
)

// supervisedRestart reports whether something will start the server again
// after it exits with restartExitCode. TGDL_RESTART_ON_EXIT=1 or 0 overrides
// the guess: set it to 1 for a supervisor that is not detected, or 0 when a
// container runs without a restart policy.
func supervisedRestart(getenv func(string) string, exists func(string) bool) bool {
	switch strings.TrimSpace(getenv("TGDL_RESTART_ON_EXIT")) {
	case "1", "true", "yes":
		return true
	case "0", "false", "no":
		return false
	}
	// systemd sets INVOCATION_ID for every unit it starts; PM2 sets pm_id.
	if getenv("INVOCATION_ID") != "" || getenv("pm_id") != "" {
		return true
	}
	// Docker and Podman. Our compose files use restart: unless-stopped.
	return exists("/.dockerenv") || exists("/run/.containerenv")
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}
