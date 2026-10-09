GO ?= go

.PHONY: build run test check

build:
	CGO_ENABLED=0 $(GO) -C core-service build -trimpath -o tgdl-server ./cmd/tgdl-server

run: build
	./runner.sh

test:
	$(GO) -C core-service test ./...

check:
	@test -z "$$(gofmt -l core-service)" || { echo 'Run gofmt on the changed Go files.'; exit 1; }
	$(GO) -C core-service vet ./...
	$(GO) -C core-service test -race ./...
