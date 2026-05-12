# Makefile — cross-platform build for seekbar-service v0.2.0
#
# Binary naming convention: tgdl-seekbar-{platform}-{arch}[.exe]
#
#   tgdl-seekbar-win-x64.exe
#   tgdl-seekbar-win-arm64.exe
#   tgdl-seekbar-linux-x64
#   tgdl-seekbar-linux-arm64
#   tgdl-seekbar-linux-x86       (Synology DSM x86)
#   tgdl-seekbar-mac-x64
#   tgdl-seekbar-mac-arm64
#
# Usage:
#   make all            — build every platform (server + CLI)
#   make release-all    — alias for all
#   make release-win    — Windows x64 + arm64
#   make release-linux  — Linux x64 + arm64 + x86
#   make release-mac    — macOS x64 + arm64
#   make release-dsm    — Synology DSM x64 + arm64
#   make linux-x64      — build a single target
#   make clean          — remove bin/
#   make test           — run Go tests
#   make vet            — run go vet
#
# Requirements: Go 1.22+. CGO is disabled for all targets — no C toolchain
# needed. Set GOFLAGS=-v for verbose output.

MODULE   := github.com/botnick/telegram-media-downloader/seekbar-service
SERVER   := ./cmd/server
CLI      := ./cmd/cli
BINDIR   := ./bin
LDFLAGS  := -s -w

# Version from git tag, falling back to dev.
VERSION  ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
LDFLAGS  += -X $(MODULE)/internal/api.ServiceVersion=$(VERSION)

GOBUILD  := CGO_ENABLED=0 go build -trimpath -ldflags "$(LDFLAGS)"

.PHONY: all release-all release-win release-linux release-mac release-dsm \
        all-dsm clean test vet \
        win-x64 win-arm64 \
        linux-x64 linux-arm64 linux-x86 \
        mac-x64 mac-arm64 \
        dsm-x64 dsm-arm64

all: win-x64 win-arm64 linux-x64 linux-arm64 linux-x86 mac-x64 mac-arm64 dsm-x64 dsm-arm64

# Convenience group targets — build a specific OS family.
release-all:   all
release-win:   win-x64 win-arm64
release-linux: linux-x64 linux-arm64 linux-x86
release-mac:   mac-x64 mac-arm64
release-dsm:   dsm-x64 dsm-arm64

# DSM targets build the same linux binaries but with a "-dsm" name suffix
# so operators can drop them into a Synology NAS package alongside the
# standard linux build. DSM 7.x runs on x86_64 or arm64 depending on model.
all-dsm: dsm-x64 dsm-arm64

$(BINDIR):
	mkdir -p $(BINDIR)

# ---- Windows ----------------------------------------------------------------

win-x64: $(BINDIR)
	GOOS=windows GOARCH=amd64 $(GOBUILD) -o $(BINDIR)/tgdl-seekbar-win-x64.exe $(SERVER)
	GOOS=windows GOARCH=amd64 $(GOBUILD) -o $(BINDIR)/tgdl-seekbar-cli-win-x64.exe $(CLI)
	@echo "  => $(BINDIR)/tgdl-seekbar-win-x64.exe"

win-arm64: $(BINDIR)
	GOOS=windows GOARCH=arm64 $(GOBUILD) -o $(BINDIR)/tgdl-seekbar-win-arm64.exe $(SERVER)
	GOOS=windows GOARCH=arm64 $(GOBUILD) -o $(BINDIR)/tgdl-seekbar-cli-win-arm64.exe $(CLI)
	@echo "  => $(BINDIR)/tgdl-seekbar-win-arm64.exe"

# ---- Linux ------------------------------------------------------------------

linux-x64: $(BINDIR)
	GOOS=linux GOARCH=amd64 $(GOBUILD) -o $(BINDIR)/tgdl-seekbar-linux-x64 $(SERVER)
	GOOS=linux GOARCH=amd64 $(GOBUILD) -o $(BINDIR)/tgdl-seekbar-cli-linux-x64 $(CLI)
	@echo "  => $(BINDIR)/tgdl-seekbar-linux-x64"

linux-arm64: $(BINDIR)
	GOOS=linux GOARCH=arm64 $(GOBUILD) -o $(BINDIR)/tgdl-seekbar-linux-arm64 $(SERVER)
	GOOS=linux GOARCH=arm64 $(GOBUILD) -o $(BINDIR)/tgdl-seekbar-cli-linux-arm64 $(CLI)
	@echo "  => $(BINDIR)/tgdl-seekbar-linux-arm64"

# x86 (32-bit) — Synology DSM x86 and other legacy NAS units.
linux-x86: $(BINDIR)
	GOOS=linux GOARCH=386 $(GOBUILD) -o $(BINDIR)/tgdl-seekbar-linux-x86 $(SERVER)
	GOOS=linux GOARCH=386 $(GOBUILD) -o $(BINDIR)/tgdl-seekbar-cli-linux-x86 $(CLI)
	@echo "  => $(BINDIR)/tgdl-seekbar-linux-x86"

# ---- macOS ------------------------------------------------------------------

mac-x64: $(BINDIR)
	GOOS=darwin GOARCH=amd64 $(GOBUILD) -o $(BINDIR)/tgdl-seekbar-mac-x64 $(SERVER)
	GOOS=darwin GOARCH=amd64 $(GOBUILD) -o $(BINDIR)/tgdl-seekbar-cli-mac-x64 $(CLI)
	@echo "  => $(BINDIR)/tgdl-seekbar-mac-x64"

mac-arm64: $(BINDIR)
	GOOS=darwin GOARCH=arm64 $(GOBUILD) -o $(BINDIR)/tgdl-seekbar-mac-arm64 $(SERVER)
	GOOS=darwin GOARCH=arm64 $(GOBUILD) -o $(BINDIR)/tgdl-seekbar-cli-mac-arm64 $(CLI)
	@echo "  => $(BINDIR)/tgdl-seekbar-mac-arm64"

# ---- DSM (Synology NAS) -----------------------------------------------------
# Identical compilation flags to the standard linux targets; the "-dsm" suffix
# in the binary name lets package maintainers ship them in a .spk alongside
# the standard linux binaries without filename collisions.

dsm-x64: $(BINDIR)
	GOOS=linux GOARCH=amd64 $(GOBUILD) -o $(BINDIR)/tgdl-seekbar-linux-x64-dsm $(SERVER)
	GOOS=linux GOARCH=amd64 $(GOBUILD) -o $(BINDIR)/tgdl-seekbar-cli-linux-x64-dsm $(CLI)
	@echo "  => $(BINDIR)/tgdl-seekbar-linux-x64-dsm"

dsm-arm64: $(BINDIR)
	GOOS=linux GOARCH=arm64 $(GOBUILD) -o $(BINDIR)/tgdl-seekbar-linux-arm64-dsm $(SERVER)
	GOOS=linux GOARCH=arm64 $(GOBUILD) -o $(BINDIR)/tgdl-seekbar-cli-linux-arm64-dsm $(CLI)
	@echo "  => $(BINDIR)/tgdl-seekbar-linux-arm64-dsm"

# ---- Utilities --------------------------------------------------------------

test:
	go test ./...

vet:
	go vet ./...

clean:
	rm -rf $(BINDIR) dist/
