# seekbar-service

A plug-and-play Go HTTP service (+ CLI) that generates WebP sprite-sheet
thumbnails for video timelines / seek-bar hover previews. Built to drop
in next to an existing media system (the parent
[telegram-media-downloader](https://github.com/botnick/telegram-media-downloader)
ships with the integration baked in) but works standalone with any
backend that can speak HTTP.

## Why a separate service

- **Cross-platform** — Linux (x86_64 + ARM 32/64 → Raspberry Pi, NAS),
  macOS, Windows, Docker. Multi-arch Docker images (`amd64` + `arm64`).
- **One binary** — no Python venv, no Node runtime, no JVM. Static Go
  build links nothing but libc; the only external dependency is the
  `ffmpeg` / `ffprobe` pair on `PATH`.
- **Stable contract** — the JSON sidecar + sprite filename layout is
  versioned, so a frontend that integrates against v1 keeps working when
  the service upgrades.
- **Scale** — designed for 100 000+ legacy clips plus a constant trickle
  of new downloads. Concurrency is bounded by the worker pool; the
  backfill CLI streams files one at a time so RAM stays flat regardless
  of library size.

## Features

| Capability                  | Notes                                                                 |
|-----------------------------|-----------------------------------------------------------------------|
| WebP sprite sheet           | libwebp encode in-process; JPEG fallback when ffmpeg lacks libwebp     |
| Deterministic metadata JSON | One sidecar per video; includes cols / rows / interval / source hash  |
| Live + backfill workflows   | HTTP API for new clips; CLI / batch endpoint for legacy backfill      |
| Job tracking                | Pending / running / done / failed / cancelled per submission           |
| Hardware acceleration       | Auto-detect → CUDA / QSV / VAAPI / VideoToolbox / V4L2 M2M; CPU fallback |
| Atomic writes               | `.tmp.<rand>` → fsync → rename; a crash mid-write never poisons cache |
| Overwrite policy            | `never` / `if-changed` (source size+mtime) / `always`                 |
| Multi-arch container        | One image runs on x86 servers AND ARM NAS / Pi 4 / Pi 5                |
| Structured logs             | Plain text or JSON; configurable level                                |
| Health check                | `GET /health` — used by Docker `HEALTHCHECK` + parent app probe       |

## Quick start

### Docker

```bash
docker run --rm -p 8089:8089 \
  -v /path/to/videos:/videos:ro \
  -v /path/to/sprites:/data/output \
  -e SEEKBAR_HWACCEL=auto \
  ghcr.io/botnick/tgdl-seekbar:latest
```

```bash
curl -sS -X POST http://localhost:8089/v1/sprite \
  -H 'Content-Type: application/json' \
  -d '{"video_id":"clip-001","path":"/videos/clip-001.mp4"}'

# fetch the sprite:
curl -sSL http://localhost:8089/sprite/clip-001 -o sprite.webp
curl -sSL http://localhost:8089/meta/clip-001   | jq
```

### docker-compose

Copy `.env.example` → `.env`, edit, then:

```bash
docker compose up -d
docker compose logs -f seekbar
```

### Native binary

```bash
go build -trimpath -ldflags '-s -w' -o seekbar-server ./cmd/server
go build -trimpath -ldflags '-s -w' -o seekbar-cli    ./cmd/cli

./seekbar-server --config config.yaml
./seekbar-cli   --dir /path/to/legacy/clips
```

## HTTP API

| Method + Path                    | Purpose                                  |
|----------------------------------|------------------------------------------|
| `GET  /health`                   | Liveness probe — always public           |
| `GET  /sprite/{id}`              | Serves the WebP/JPEG sprite             |
| `GET  /meta/{id}`                | Serves the JSON sidecar                  |
| `POST /v1/sprite`                | Submit one video (sync via `async:false` or async) |
| `POST /v1/batch`                 | Submit many at once                      |
| `GET  /v1/jobs`                  | Recent job list (newest first, cap 200)  |
| `GET  /v1/jobs/{id}`             | One job's status                         |
| `POST /v1/jobs/{id}/cancel`      | Cancel a pending job                     |
| `DELETE /v1/sprite/{id}`         | Remove sprite + meta from disk           |
| `GET  /v1/hwaccel`               | Probe what backends actually work here   |
| `GET  /v1/stats`                 | Pool counters (total / done / queued)    |

Authentication: leave `http.api_token` empty for open access, or set
`SEEKBAR_API_TOKEN=<long-random>` and have callers send `X-API-Token:`.

### Submit one (synchronous)

```bash
curl -sS -X POST http://localhost:8089/v1/sprite \
  -H 'X-API-Token: secret' \
  -H 'Content-Type: application/json' \
  -d '{
    "video_id": "abc123",
    "path":     "/videos/abc123.mp4",
    "async":    false
  }'
```

Returns:

```json
{
  "id": "uuid-...",
  "video_id": "abc123",
  "status": "done",
  "sprite_path": "/data/output/abc123.webp",
  "meta_path":   "/data/output/abc123.json",
  "duration":    284.16,
  "frames":      57,
  "cols":        10,
  "rows":        6,
  "tile_w":      160,
  "bytes":       182740
}
```

### Submit a batch

```bash
curl -sS -X POST http://localhost:8089/v1/batch \
  -H 'Content-Type: application/json' \
  -d '{
    "items": [
      {"video_id":"a","path":"/videos/a.mp4"},
      {"video_id":"b","path":"/videos/b.mp4"}
    ]
  }'
```

### Metadata JSON shape

```json
{
  "version":      1,
  "video_id":     "abc123",
  "sprite_url":   "/sprite/abc123",
  "meta_url":     "/meta/abc123",
  "duration_sec": 284.16,
  "frames":       57,
  "cols":         10,
  "rows":         6,
  "tile_w":       160,
  "tile_h":       0,
  "interval_sec": 4.985,
  "format":       "webp",
  "bytes":        182740,
  "source_size":  41280184,
  "source_mtime": 1715582400000,
  "generated_at": 1715592400000
}
```

`tile_h: 0` means "derive from the sprite image height at render time"
(image.height / rows); ffmpeg keeps aspect ratio so the value depends on
the source clip.

## CLI

```bash
# Single
seekbar-cli --video-id abc --path /videos/abc.mp4

# Recursive backfill — walks .mp4/.mov/.mkv/.webm/.avi/.m4v/.ts/.mpg
seekbar-cli --dir /videos

# Stdin batch (one JSON per line) — easy to pipe from any script
jq -c '.[]' inventory.json | seekbar-cli --stdin
```

The CLI shares the same `config.yaml` / env vars as the server; the
worker pool and ffmpeg pipeline are identical. CLI exits when the queue
drains.

### Backfilling 100 000+ legacy clips

Two patterns work well:

1. **From the parent app's database** — generate a JSON-lines stream of
   `{"video_id":..., "path":...}` and pipe it into `seekbar-cli --stdin`.
   Memory stays flat because the CLI reads one line at a time.
2. **From a filesystem tree** — `seekbar-cli --dir /videos` walks the
   tree with `filepath.WalkDir`, which is also constant-memory. Run
   under tmux/systemd; the operator can `pkill -INT seekbar-cli` to
   pause and re-run later (already-done sprites are skipped via the
   `if-changed` policy).

Both modes honour `SEEKBAR_CONCURRENCY` so a 16-core NAS can grind in
parallel; a Pi 4 should leave it at 2.

## Hardware acceleration

Set `SEEKBAR_HWACCEL=auto` (the default) and the service:

1. Asks `ffmpeg -hwaccels` for the compiled-in backend list.
2. Probes each candidate with a 40 ms lavfi-null encode (5 s timeout).
3. Picks the first match in the platform's preference order:
   - Linux x86_64 → `cuda` → `vaapi` → `qsv`
   - Linux ARM    → `v4l2m2m` → `vaapi` (Pi 4 / Pi 5 / Rockchip)
   - macOS         → `videotoolbox`
   - Windows       → `cuda` → `qsv` → `d3d11va`
4. Falls back silently to CPU when nothing works.

Force a specific backend with `SEEKBAR_HWACCEL=vaapi` (or `cuda`, `qsv`,
…). Pass `none` / `cpu` to skip hwaccel even when available.

For VAAPI / QSV inside Docker the host needs `/dev/dri/renderD128` mapped
in — see `docker-compose.yml`.

## Frontend integration

Minimal vanilla-JS hover-preview is in `examples/frontend/seekbar.html`.
The relevant snippet:

```js
const meta = await fetch(`/meta/${videoId}`).then(r => r.json());
const sprite = document.getElementById('sprite-preview');

scrubBar.addEventListener('pointermove', (e) => {
  const rect = scrubBar.getBoundingClientRect();
  const ratio = (e.clientX - rect.left) / rect.width;
  const sec = ratio * meta.duration_sec;
  const idx = Math.min(meta.frames - 1, Math.floor(sec / meta.interval_sec));
  const col = idx % meta.cols;
  const row = Math.floor(idx / meta.cols);
  // Sprite's actual tile height = image.height / meta.rows.
  sprite.style.backgroundImage    = `url(/sprite/${videoId})`;
  sprite.style.backgroundPosition = `-${col * meta.tile_w}px -${row * tileH}px`;
  sprite.style.width  = meta.tile_w + 'px';
  sprite.style.height = tileH + 'px';
});
```

## Integration with telegram-media-downloader

The parent app ships an opt-in *Maintenance → Seekbar* page that spawns
this service as a local sidecar binary (matching the `tgdl-faces` /
face-clustering pattern). The Node side handles:

- Reading `cfg.advanced.seekbar.{enabled,autoOnDownload,…}` from the kv
  config store.
- Pregenerate hook in `src/core/downloader.js` after each new download.
- Bulk backfill driven by the dashboard's `JobTracker`, posting to
  `POST /v1/batch` in chunks.
- Serving sprites to the SPA viewer via a reverse-proxy route.

No special configuration is required on the seekbar-service side — the
parent app sets `SEEKBAR_API_TOKEN` + listens for the spawn URL on
localhost.

## Configuration

When this service runs as a sidecar of
[telegram-media-downloader](https://github.com/botnick/telegram-media-downloader),
**every knob is editable from the dashboard's *Maintenance → Seekbar*
page** — interval, tile width, columns, quality, hardware acceleration,
concurrency. The dashboard writes the value into its kv-backed config
and the sidecar reads the matching env var on next start. No separate
YAML or per-service `.env` file is required.

When running this service standalone, the same knobs are accepted via:

- Environment variables — the canonical way for Docker / Compose / Kubernetes.
  Every key is documented in the parent project's `.env.example` under
  the `SEEKBAR_*` block.
- A YAML file passed via `--config path/to/config.yaml` for traditional
  systemd-managed installs. Same keys as the env vars, nested by
  section (see `internal/config/config.go` for the exact shape).

The two layers compose: env vars override YAML, YAML overrides built-in
defaults, defaults work out of the box on any host with `ffmpeg` on
`PATH`.

## Operational notes

- **Atomic writes** — every sprite + JSON is written to a randomised
  `.tmp.<hex>` next to the destination, fsynced, then renamed. A crash
  or `docker kill` between writes leaves the previous good sprite in
  place.
- **Determinism** — same source bytes + same config produces a
  byte-identical sprite. Useful for content-addressable caching layers.
- **NAS / mounted volume safe** — file ops use rename-within-dir so the
  output can live on NFS / SMB / Docker bind mount without crossing
  filesystem boundaries.
- **Metrics** — the `/v1/stats` endpoint returns counters in a
  Prometheus-friendly JSON shape; wrap it with a Prometheus scrape
  config if you need a dashboard. (Native `/metrics` text exposition is
  a planned add-on.)

## Build matrix

| OS / Arch          | Status | Notes |
|--------------------|--------|-------|
| linux/amd64        | ✅     | Primary target |
| linux/arm64        | ✅     | Pi 4 / Pi 5 64-bit, AWS Graviton, ARM NAS |
| linux/arm/v7       | ✅ via Go | Build with `GOOS=linux GOARCH=arm GOARM=7` |
| darwin/amd64       | ✅     | Intel Mac |
| darwin/arm64       | ✅     | Apple Silicon |
| windows/amd64      | ✅     | `seekbar-server.exe` / `seekbar-cli.exe` |

## Licence

Same as the parent `telegram-media-downloader` repository.
