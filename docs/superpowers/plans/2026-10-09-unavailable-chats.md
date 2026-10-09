# Unavailable chats and account cleanup implementation plan

> For agentic workers: use superpowers:executing-plans for integration; independently scoped UI and Telegram transport tasks may run in parallel.

**Goal:** Separate stale/restricted/deleted chats and let the owner explicitly leave a selected chat or delete a DM from a selected Telegram account.

**Architecture:** Classify current Telegram entities, carry per-account evidence through the existing dialogs API, and render unavailable entries separately. Use the existing account-run lease for explicit, authenticated removal; never substitute a different account or delete downloaded media.

**Tech stack:** Go, gotd/td, SQLite, embedded browser JavaScript.

**Spec:** Owner's requests on 2026-10-09: groups/channels/DM, including the supplied Telegram Terms-of-Service restriction screenshot; provide an action to leave/remove from the account. Existing instructions authorize autonomous implementation and retaining project isolation.

## Constraints and review focus

- Project only; Git via git-project, author botnick, no Node runtime or fallback.
- Forbidden/inaccessible does not prove deletion; deactivated basic groups are migrated, not deleted. Unknown/minimal entities never prove deletion.
- Preserve per-account evidence; one accessible account must not be hidden by another account's restriction.
- Read/list/recheck never leaves a chat. Removal requires admin, explicit chat confirmation and a valid selected account.
- Delete DM history only for the selected account; no revoke-for-everyone, global channel deletion or leave-all command.
- Failures/cancellation retain visible state; never claim remote success merely because the local list was hidden.
- Real preview verification is read-only for remote chats; destructive RPCs are verified with transport fixtures and browser confirmation cancellation.

## Tasks

- [x] Add failing Telegram mapping tests for deleted users, restricted users/channels, forbidden groups/channels, migration and unknown entities; implement typed DialogAccess metadata in telegram/dialogs.go.
- [x] Add engine merging and app HTTP tests; carry access/accountAccess through engine.Dialog and /api/dialogs, retain unavailable DM visibility with download actions disabled, persist observed states without interpreting absence as deletion.
- [x] Independently add telegram/dialog_remove.go and tests: Account.RemoveDialog(ctx, id) error, selected-account full dialog resolution, leave channel/basic group or self-only DM deletion, cancellation and partial/error behavior.
- [x] Add authenticated POST /api/chats/{id}/leave with {accountId, confirm:id}, account-run lease, no account switching; test guards and local-data preservation.
- [x] Independently update browser Chats, shared rows, account wizard and EN/TH text: normal/unavailable separation, per-account confirmation sheet, remote removal errors, fresh listing after success. Recheck refreshes actual Telegram metadata.
- [x] Run affected race/vet/build, bounded independent review, isolated browser fixture for classification and removal/cancel, and live read-only preview listing; update documentation with Telegram primary references.
- [x] Commit as botnick, update only owned preview process while preserving data, report exact completed behavior and limits.

## Additional live findings resolved

- Jobs-only chat browsing deferred durable history recovery until monitor promotion; promotion stop preserves manual leases. Pending recovery is never erased to start browsing.
- Actual JPEG requests exposed home-DC authorization export failures. Use gotd Pool for the home DC, DC for a foreign DC, with verified bytes retained.
- Advance browser/service-worker versions together to invalidate old modules.
- Full-project live media/dedup acceptance remains explicitly unverified in GO-CORE-ACCEPTANCE.md.
