// Package version identifies this build of tgdl-core.
//
// Release builds stamp Version at link time:
//
//	go build -ldflags "-X github.com/botnick/telegram-media-downloader/core-service/internal/version.Version=0.2.0"
//
// The default matches the source tree so a plain `go build` reports the
// version the Node side pins (CORE_VERSION in src/core/gocore/spawn.js).
package version

// Service is the name reported on /health and by `tgdl-core version`.
const Service = "tgdl-core"

// Version is overridden with -ldflags on release builds.
var Version = "0.2.0"

// Features lists what this build can do; the Node side only routes a
// feature to Go when /health advertises it.
var Features = []string{"hash", "stat", "walk", "dbscan"}
