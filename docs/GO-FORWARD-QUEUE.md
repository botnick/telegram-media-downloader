---
title: "Forward queue"
description: "How Telegram Media Downloader 3.5 forwards media: the durable forward queue, job states, retries, FloodWait protection, restart recovery and uncertain deliveries."
parent: Features
nav_order: 4
---

# Forward queue

Since 3.5.0 every forward goes through a queue stored in the database
(`tgdl_forward_queue`), so forwarding work survives restarts and crashes.
This page explains what enters the queue, how a job moves through it and what
happens when Telegram, the network or the server gets in the way. Per-chat
settings are in [Configuration](CONFIGURATION.md#auto-forward), the HTTP
routes in the [API reference](API.md#forward-queue).

The forward queue shows destinations and caption rules, so it is **admin
only**: guests do not see it, not even inside the download queue snapshot.

## What enters the queue

| Source | When |
|---|---|
| Auto-forward after a download | A chat with **Forward new files** on downloads a new file. A file that was a duplicate skip, or a message that already has a forward job, is not forwarded again (so a download retried after a failure does not forward twice). |
| Native forward during the download | With **Try direct forward first** on and no destination needing an upload, the native forward starts while the file downloads. It is recorded in the queue as it runs. When the queue is paused or full, it waits for the download and goes through the queue instead. |
| Direct scan route | `scanRoute` `direct` or `both`: each message seen by the live monitor or a backfill is queued for forwarding straight away, at most once per message, without waiting for a download. |
| Manual forward | Selected library items forwarded from the dashboard (1–100 at a time). |
| Forward download history | Queue → **Forward download history…**: older downloads of one chat, up to 100 per batch, newest first. |

Manual and history forwards skip a message that is already pending,
running, forwarded or uncertain for the same destination.

## Jobs and destinations

One job is one source message. When it is queued, the job saves a snapshot
of the rule: the destinations that match the message's forum topic, the
forward account, caption and protection settings. Editing the chat's rule
later changes only new jobs; a waiting job keeps the destinations it was
created with.

Each destination has its own state and delivery method:

| Method | Used when |
|---|---|
| `native_forward` | Telegram's own forward. No local file is needed. Used with **Try direct forward first**, the direct scan route and manual forwards when nothing below applies. |
| `native_forward_edit` | A native forward followed by a caption edit, for a custom caption on a direct forward. |
| `caption_edit` | Retrying only the caption edit of a message that was already forwarded. |
| `upload` | The file is uploaded to the destination. Used for protected copies, custom captions without direct forwarding, and as the fallback when Telegram rejects a native forward (the local file is used, or the source is downloaded first if there is none). |

A destination that is already forwarded is skipped when the job runs again,
so a retry only sends to the destinations that still need it.

## Job states

| State | Meaning | What happens next |
|---|---|---|
| `pending` | Waiting for a worker, or for its retry time. | Picked up oldest first when it is due and the queue is not paused. |
| `processing` | A worker is sending it. | Ends in one of the states below. |
| `forwarded` | Every destination received it. | The last 10 are listed under the queue. **Delete after forward** removes the local copy now. |
| `failed` | It failed 3 times, Telegram refused the destination, or its saved data is unusable. | **Retry** or **Retry all** sends it back to `pending`. |
| `interrupted` | The worker was stopped while the job was running, before any destination was being sent. | **Retry** or **Retry all**. A destination that was being sent at that moment makes the job `uncertain` instead. |
| `uncertain` | A request reached Telegram but its answer was lost, so the message may or may not be in the destination. | Never resent automatically. An operator reconciles it (see below). |
| `not_applicable` | When the job ran, the chat's rule was off or no route matched the message's topic. | Nothing. Counted separately and not listed. |

Manual forwards, history forwards and direct scan jobs still run when the
chat's rule has been switched off after they were queued.

## Workers, pacing and capacity

Forward workers run only while the monitor is running; jobs wait with
"Waiting for monitor to start" otherwise. They never hold up downloads.

- `advanced.forwarder.concurrency` (1–5, default 1) jobs run at once.
- `advanced.forwarder.intervalSec` (0–3600, default 1) is the smallest gap
  between two job starts across all workers. The Queue page's menu changes it
  too.
- `advanced.forwarder.queueSize` (1–10000, default 256) caps pending and
  running jobs. A job added over the cap is kept as `pending` with the reason
  "forward queue capacity reached" and picked up once the backlog drains; it
  is never dropped.

See [Configuration](CONFIGURATION.md#advanced-settings) for all
`advanced.forwarder` keys.

## Retries

A job whose attempt fails goes back to `pending` and is retried after 1 s,
then 2 s. After the **third** failed attempt it stays `failed`. A Telegram
answer that the destination refuses the forward account (not a member, no
right to post, the chat is gone) is not retried automatically: that
destination is paused and checked again after about 1 h, 6 h and 24 h.

**Retry** on one job resets its attempt count. **Retry all** returns every
`failed` and `interrupted` job to the queue; it never touches `uncertain`
jobs.

## FloodWait

When Telegram answers a forward with a FloodWait, the forward account's gate
is closed until the wait is over (plus one second). The gate is stored in
`tgdl_forward_account_limits`, so every forward worker respects it and it
still holds after a restart.

- During an upload, the same send is tried again after the wait, up to
  `advanced.forwarder.floodWaitAttempts` sends in total (1–10, default 3).
- After that, or for a native forward, the job goes back to `pending` with
  its retry time set to the end of the wait. A FloodWait does not use up one
  of the 3 attempts.

## Pause

Pausing the forward queue is stored in `tgdl_forward_queue_state` and
survives restarts. A paused queue starts no new job (the job already
running finishes), and the inline native forward during a download waits for
the queue too. The Queue page's **Pause all** and **Resume all** also pause
and resume forwarding; the forward view has its own pause button that leaves
downloads alone.

## Restart and shutdown recovery

Only a destination that was being sent can have reached Telegram. On start,
the server sorts the jobs that were left `processing`:

- A job with a destination in the middle of a send becomes `uncertain`
  ("server restarted while Telegram delivery outcome was unknown").
- Any other job goes back to `pending` ("server restarted before forwarding
  completed"), for example one that was waiting for its pacing slot, the
  FloodWait gate or a fallback download.

A clean shutdown follows the same rule while it runs: a job stopped before
anything was sent returns to `pending` by itself, and an upload cancelled
while sending is marked `uncertain`, not resent.

## Uncertain deliveries

A forward whose Telegram response was lost (timeout, dropped connection, an
upload cancelled while sending) may have been delivered. Telegram gives no
receipt to check, so the app never sends it again by itself and does not fall
back to an upload. The job shows as `uncertain` until an operator looks at
the destination and reconciles it in the forward view:

- **Confirm sent**: the message is there. The uncertain destinations are marked
  `forwarded`; the job is `forwarded` when every destination is, otherwise
  the remaining ones go back to the queue.
- **Resend**: the message is missing. This needs an explicit confirmation
  that a duplicate may be created; the uncertain destinations go back to
  `pending`.

Either action can be limited to one destination. Every reconcile is written
to `tgdl_forward_queue_audit`. Delivery is at most once without an operator,
not exactly once.

## Processing history

**Maintenance → Logs** also shows the processing history
(`tgdl_processing_attempts`): every download attempt with its outcome
(downloaded, reused, duplicate skipped, failed, interrupted), the forward
result and whether the local copy was deleted after forwarding, with totals
and a per-chat filter. It is a diagnostic log, not the library: attempts
older than 30 days, and anything beyond the newest 200,000 attempts, are
removed (a minute after start, then every 6 hours). Attempts that an open
forward job still points at are kept.
