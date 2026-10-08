# Native accounts implementation plan

> Execute inline using superpowers:executing-plans; no implementation agents.

Goal: make account list/add/remove and the phone authentication workflow run
through native Go, including durable session/config handoff.
Architecture: internal/accounts owns wizard lifetime and operation journal;
internal/telegram supplies the gotd login adapter; App binds HTTP, config and
monitor ownership. Tech stack: Go, gotd v0.115.0, SQLite, encrypted session storage.
Spec: ../specs/2026-10-08-native-accounts-design.md

Constraints: room-only changes, ./git-project and botnick metadata, no Node runtime
path, original private sessions preserved except an explicit remove-account API.
User delegates decisions; no new approval gates. Existing linked checkout retained.

Review focus: simultaneous submissions; cancel racing successful login; label
path traversal/collision; process death between file/config commit; wrong password
and flood wait resubmitting an earlier secret. Pin each with behavioral tests.

- [x] HTTP contract foundation: failing native accounts list/missing-credential
  tests in internal/app/accounts_test.go; implement registerAccountRoutes and
  account metadata listing in accounts_api.go, preserving existing role gates.
- [x] Native wizard: failing state/RPC cancellation/retry/expiry tests in
  internal/accounts/wizard_test.go. Implement Wizard Begin/Submit/Status/Cancel/
  Close using a per-flow goroutine, bounded lifetime and injectable LoginFactory;
  internal/telegram/login.go adapts gotd SendCode/SignIn/Password and user metadata.
- [x] Durable lifecycle: journal add/delete, encrypted exclusive publication,
  config merge and matching pin cleanup in internal/accounts/repository.go;
  recovery and collision tests. App serializes lifecycle via monitorOp, joins
  login clients before monitor restart, and closes wizard before DB shutdown.
- [x] Native HTTP success integration with a fake RPC (real encrypted storage,
  filesystem/config changes), unchanged accounts frozen contract, existing
  auth/share contracts, full Go race/vet/build, read-only review and fixes.
- [x] Update migration status with verified features and remaining history/queue
  work; commit all code/test/docs under botnick. Do not claim full migration done.

Verification commands: /usr/local/go/bin/go -C source/core-service test -race ./...
; go vet ./... ; go build ./cmd/tgdl-server. Frozen contracts use existing Go-target
runner during transition; do not change golden responses to conceal missing APIs.
