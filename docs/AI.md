# Local AI subsystem

Self-hosted Telegram Media Downloader v2.6 ships an opt-in AI layer that runs
**entirely on the host that runs the dashboard**. No external APIs are
contacted; nothing is uploaded; no cloud accounts are required. Every model
is downloaded from Hugging Face on first use of its capability and cached
under `data/models/` (override with `AI_MODELS_DIR`).

The four capabilities are independent and default-off. Enable only what you
need — a Telegram archive that just wants near-duplicate dedup pays nothing
for the 90 MB CLIP model.

## Capabilities

| Capability        | Model (default)                      | Disk    | Use                                          |
| ----------------- | ------------------------------------ | ------- | -------------------------------------------- |
| Semantic search   | `Xenova/clip-vit-base-patch32`       | ~90 MB  | Free-text search ("beach photos at sunset"). |
| Face clustering   | `Xenova/yolov5n-face` + CLIP crops   | ~5 MB   | "People" view — group photos by who's in them. |
| Auto-tagging      | `Xenova/mobilenet_v2`                | ~14 MB  | Per-image labels → tag cloud + #tag filters. |
| Perceptual dedup  | DCT pHash (no model)                 | 0       | Find near-duplicates (resized / re-encoded). |

All four use the WASM execution provider through `@huggingface/transformers`
— the same path that powers the NSFW classifier — so they work identically
on Windows, macOS, glibc Linux, musl Linux (Alpine), Docker, and ARM hosts.

## Configuration

Add to the runtime config (Settings tab in the dashboard, or directly in the `kv['config']` row of `data/db.sqlite`):

```json
{
    "advanced": {
        "ai": {
            "enabled": true,
            "embeddings": { "enabled": true, "model": "Xenova/clip-vit-base-patch32" },
            "faces":      { "enabled": false, "model": "Xenova/yolov5n-face" },
            "tags":       { "enabled": true,  "model": "Xenova/mobilenet_v2", "topK": 5 },
            "phash":      { "enabled": true },
            "fileTypes": ["photo"],
            "indexConcurrency": 1,
            "batchSize": 25
        }
    }
}
```

`enabled: false` everywhere is the default. Capabilities can be flipped at
runtime — the next scan picks up the new config without a restart.

## Running a scan

The Maintenance → AI search & people page (admin-only) provides:

- A toggle + "Start scan" button per capability.
- Live progress via WebSocket (`ai_index_progress`, `ai_people_progress`,
  `ai_tags_progress`, `ai_phash_progress`).
- Search box wired to `POST /api/ai/search`.
- Tag cloud, people grid, near-duplicate groups.

Scans are background jobs — every endpoint returns 200 immediately and the
work continues across page navigations / WebSocket reconnects (the `_status`
sibling lets a re-mounted page re-attach to a running scan).

## Privacy

Everything runs on your host. No model inference, no embeddings, no images
are sent to any external service. The `@huggingface/transformers` package is
used purely as a WASM runtime; the only network traffic is the one-time
model download from Hugging Face's CDN when a capability is first enabled.
You can pre-seed the cache by copying `data/models/` between hosts.

## Disk + memory budget

| Knob                | Default                  | Notes                                                  |
| ------------------- | ------------------------ | ------------------------------------------------------ |
| `AI_MODELS_DIR`     | `data/models/`           | Override with an absolute path or another relative one. |
| In-memory vec cache | 50 000 vectors (~100 MB) | Hard cap; above that, install `sqlite-vec` for fast search. |
| `indexConcurrency`  | 1                        | Higher values risk OOM on small hosts (each WASM heap is ~150 MB). |
| `batchSize`         | 25                       | Rows per scan-loop iteration. Tune lower on slow disks. |

The vector cache is a per-process structure; restarting the dashboard
rebuilds it lazily from the SQLite `image_embeddings` table.

## Optional: sqlite-vec

If `sqlite-vec` is available on your host, the dashboard auto-detects it on
first use of the AI status endpoint and uses it for search. The fallback
in-memory cosine path is fine up to ~50k photos. Install with:

```bash
npm install sqlite-vec
```

This is **completely optional**; default installs work fine without it.

## Troubleshooting

- **"AI subsystem disabled"** — set `advanced.ai.enabled: true` via the
  dashboard (or the `kv['config']` row) and reload the page. Each capability
  also needs its own `enabled: true`.
- **First scan is slow** — the model is being downloaded. Watch the realtime
  log on Maintenance → Logs (source: `ai`) to see download progress. After
  the first scan the cache is local.
- **`AI_LIB_MISSING` error** — `@huggingface/transformers` is in
  `optionalDependencies`. Reinstall with
  `npm install @huggingface/transformers` to enable AI features.
- **Out of memory** — drop `indexConcurrency` to 1, drop `batchSize` to 10.

## Architecture

```
src/core/ai/
├── index.js          # public entry — re-exports the surface used by server.js
├── manager.js        # JobTracker-driven scan loops + downloader hook
├── embeddings.js     # CLIP image+text encoder
├── faces.js          # face detection + CLIP-on-crop embeddings + DBSCAN
├── tags.js           # ImageNet classifier wrapper
├── phash.js          # DCT pHash + Hamming distance + clustering
├── vector-store.js   # cosine sim, top-K, BLOB round-trip, sqlite-vec adapter
└── models.js         # lazy model loader + cache directory resolution
```
