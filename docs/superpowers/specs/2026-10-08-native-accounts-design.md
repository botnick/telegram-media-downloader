# Native account management

The authorized migration retains the existing account list and phone/code/2FA
wizard HTTP contract while replacing its Node implementation with Go/gotd.
The owner explicitly delegated design and execution decisions; implement inline.
This increment precedes history/dialog APIs and automatic update-gap recovery.

One wizard owns one fresh authentication key. Begin returns a phone prompt
without opening a connection; phone submission starts gotd. Commands are serialized
per flow, RPCs have deadlines, wrong credentials keep the appropriate prompt,
and flood waits prevent another RPC before their deadline. Codes/passwords are
never persisted, included in status, or logged. Flows expire after ten minutes,
terminal state is retained one minute, and at most eight flows exist. Cancel and
server shutdown cancel and join the connection; pending files are not accounts.

Use encrypted temporary native storage under data/sessions/pending. After
successful authorization, stop the connection before publishing its encrypted
session into sessions/native, preventing two clients from owning a key. Publish
without replacing an existing account. Account metadata preserves the config
schema; IDs are safe single filenames. A SQLite operation journal bridges
filesystem publication/removal and config commit. Startup replays unfinished
operations before account discovery; unrelated sessions and media are retained.
Deleting an account stops its monitor owner first, removes both native/import
session files, clears only matching group pins, and refreshes a previously running
monitor. Adding while stopped must not start monitoring implicitly.

HTTP routes remain admin-only. Saved account listing uses filesystem discovery
and config metadata without dialing Telegram. Missing API credentials preserve
existing route-specific errors. Successful mutations notify config/account UI
and update the monitor once as part of the mutation, never from repeated polls.

Verification: native HTTP tests with injected Telegram RPC transport for invalid
code, password requirement, wrong password, flood wait, successful encrypted
publication, cancellation, mutation recovery and shutdown. Frozen accounts
contracts remain unchanged and must pass. Full Go race/vet/build and focused
read-only review complete this increment. Live Telegram remains unverified until
an authorized test account is available; the overall migration goal remains open.
