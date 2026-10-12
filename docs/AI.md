---
title: "AI: faces, NSFW and previews"
description: "Face recognition and NSFW review through the tgdl-faces and tgdl-nsfw containers, plus built-in video seekbar previews: setup, settings and limits."
parent: Features
nav_order: 3
---

# AI: faces, NSFW and previews

Since 3.3 the analysis features of 2.x work again. Video seekbar previews are
made inside `tgdl-server` with ffmpeg. Face recognition and NSFW scoring run
in two optional companion containers, `tgdl-faces` and `tgdl-nsfw`, that the
server calls over HTTP. Results made by 2.x (people, faces, NSFW scores,
sprites) are reused as they are.

Semantic search and auto-tagging were removed in 2.16 and are not part of 3.x
(`POST /api/ai/search` answers `501 SEARCH_UNAVAILABLE`).

## Overview

| Feature | Runs in | Needs | Default |
|---|---|---|---|
| **Seekbar previews** (hover thumbnails on the video scrub bar) | `tgdl-server` (since 3.2.0) | ffmpeg and ffprobe (in the Docker image) | On: `advanced.seekbar.enabled` and `autoOnDownload` default to `true` |
| **NSFW scoring and review** | `tgdl-nsfw` container (since 3.2.0) | `TGDL_NSFW_SIDECAR_URL` or the External URL on the NSFW page | Off: scores new downloads only with `advanced.nsfw.enabled` |
| **Face detection, people** | `tgdl-faces` container (since 3.3.0) | `FACES_SERVICE_URL`, `TGDL_FACES_SIDECAR_URL` or the External URL under Safety & AI → Faces | Off: `advanced.ai.enabled` |
| **Thumbnails** (for comparison) | `tgdl-server` | ffmpeg | On |
| Semantic search, auto tags | — | — | Removed in 2.16 |

Without a sidecar the matching page says so instead of failing: the review
pages still show, edit and delete what is already in the database, and only
scanning needs the sidecar.

## Seekbar previews

Sprites are built with ffmpeg in the server process, so no sidecar is needed.

- **After each video download**, when `advanced.seekbar.enabled` and
  `advanced.seekbar.autoOnDownload` are on (both are by default). Live
  downloads go ahead of history backfill in the sprite queue.
- **Maintenance → Seekbar**: build the backlog for every video (or one chat),
  rebuild all, regenerate one video, cancel, and view stats and health.
- Sprites keep the 2.x layout (`data/seekbar/<id>.webp` or `.jpg`, plus
  `<id>.json`), so previews made by 2.x keep working and are not rebuilt
  unless you ask (`overwrite`: `never`, `if-changed` (default) or `always`).
- Settings under `advanced.seekbar`: `intervalSec` (4), `tileWidth` (160),
  `columns` (10), `maxTiles` (240), `format` (`webp` or `jpeg`), `quality`
  (75), `concurrency` (4), `maxRetries` (3) and `hwaccel`.
- `advanced.seekbar.sidecarUrl` and `SEEKBAR_SIDECAR_URL` are ignored: the
  `seekbar-service` sidecar is not used any more.

To stop sprite generation, turn off `advanced.seekbar.enabled` (or only
`autoOnDownload` to keep the manual tools).

## Hardware acceleration

Thumbnails and seekbar sprites decode video with the backend set in
`FFMPEG_HWACCEL` (`vaapi`, `qsv`, `cuda`, `videotoolbox`, `d3d11va` or
`dxva2`), which wins over **Settings → Advanced** (`advanced.thumbs.hwaccel`).
`advanced.seekbar.hwaccel` can force `none` for sprites or pick its own
backend; empty means "same as thumbnails". When the backend can't start on
the host, that file is decoded on the CPU instead. In Docker, pass the device
through (for example `/dev/dri` for VAAPI/QSV, as the Synology compose file
does).

## NSFW review with the tgdl-nsfw sidecar

The Go server has no built-in classifier. It sends images to the `tgdl-nsfw`
container (source in `nsfw-service/`, image `ghcr.io/botnick/tgdl-nsfw`,
model `AdamCodd/vit-base-nsfw-detector`) over HTTP.

### Run it

The bundled `docker-compose.yml` and `docker-compose.synology.yml` contain a
commented `tgdl-nsfw` service. Uncomment it (and the `volumes:` block at the
end of the file), then add to `.env`:

```sh
TGDL_NSFW_SIDECAR_URL=http://tgdl-nsfw:8012
# TGDL_NSFW_API_TOKEN=a-long-random-value   # same value on both services
```

and run `docker compose up -d`. The first start downloads the model, which
takes a few minutes. Open **Maintenance → NSFW review** and press **Test**.

On another machine (for example a GPU box, image tag `gpu-latest`), run the
container there, set `TGDL_NSFW_API_TOKEN` on it, and point
`TGDL_NSFW_SIDECAR_URL` (or the External URL on the NSFW page,
`advanced.nsfw.sidecarUrl`) at it. The environment variable wins over the
dashboard value.

### What it does

Without a URL, scan and preload answer `503` with code
`NSFW_SIDECAR_REQUIRED`; the review page still shows, whitelists and deletes
rows that already have a score.

- **Scan** scores every unscanned row whose type is in `fileTypes` (photos by
  default). It runs `concurrency` requests at a time (1–4) and can be
  cancelled. A missing or unreadable file is marked checked with no score. If
  the sidecar is down or rejects the token, the scan stops and leaves the
  remaining rows for the next run.
- **Videos** are scored from tiles of their seekbar sprite (up to
  `videoMaxTiles`). The score is the mean of the three highest tiles. A video
  without a sprite is skipped and stays unscanned until its sprite exists.
- **New downloads** are scored in the background when `advanced.nsfw.enabled`
  is on. With `blocklistEnabled`, a download whose SHA-256 matches a file
  deleted from the review page is deleted again. Downloads never wait for the
  sidecar. When it can't keep up, the next scan catches up.
- **Review**: tiers by score, histogram, bulk delete, whitelist and
  un-whitelist, reclassify, model preload and the hash blocklist.
- **Transfer:** the server first sends the file path (rewritten through
  `TGDL_NSFW_PATH_MAP` / `pathMap`). If the sidecar can't read it, the server
  uploads the image bytes. Path mode is optional and only saves bandwidth: it
  needs the downloads folder mounted in the sidecar and `TGDL_NSFW_ALLOW_ROOTS`
  set there.

## Face recognition with the tgdl-faces sidecar

Faces are detected by the `tgdl-faces` container (source in `faces-service/`,
image `ghcr.io/botnick/tgdl-faces`, insightface `buffalo_l`). The server
clusters the faces into people itself and stores them in the same tables as
2.x, so people and names from 2.x are kept; re-clustering carries names over
to the closest new cluster.

### Run it

There is no bundled compose block for faces. Add a service like this to your
`docker-compose.yml`:

```yaml
  tgdl-faces:
    image: ghcr.io/botnick/tgdl-faces:latest
    container_name: telegram-downloader-faces
    restart: unless-stopped
    environment:
      # Optional path mode: read files directly instead of receiving uploads.
      - TGDL_FACES_ALLOW_ROOTS=/app/data/downloads
      # - TGDL_FACES_API_TOKEN=a-long-random-value
    volumes:
      - ./data/downloads:/app/data/downloads:ro
```

Then set `FACES_SERVICE_URL=http://tgdl-faces:8011` in the
`environment:` list of the `telegram-downloader` service (or enter the URL
as **External** under Safety & AI → Faces), turn face recognition on and run
`docker compose up -d`.

The sidecar URL is taken in this order: `TGDL_FACES_SIDECAR_URL`, the
dashboard's External URL (`advanced.ai.faces.sidecarUrl`), then
`FACES_SERVICE_URL`. The token comes from `TGDL_FACES_SIDECAR_TOKEN` or
`advanced.ai.faces.sidecarToken` and must match the sidecar's
`TGDL_FACES_API_TOKEN`.

### What it does

- **Scan / Cancel** detects faces in every photo not yet scanned, then
  clusters them into people. Videos are scanned only with `scanVideos` on,
  and only in path mode (the sidecar must see the file).
- **New downloads** are detected in the background while face recognition
  and face clustering are on. **Auto-scan** (`advanced.ai.autoScan` = `running`) also works through
  the backlog in small batches.
- **Re-cluster**, sidecar status and **Doctor**, health, provider and
  detect tests, model preload and the quality backfill are under
  Safety & AI → Faces. **Reindex** deletes every face and person (names
  included) and marks all photos for a new scan; use Re-cluster to regroup
  without losing names.
- **People**: browse, rename, merge, split, move a face, delete a person.
- Files are sent by path when the sidecar can read them (rewritten through
  `TGDL_FACES_PATH_MAP` / `pathMap`), otherwise as uploaded bytes.

## Settings

| Block | Main keys | Used for |
|---|---|---|
| `advanced.seekbar` | `enabled`, `autoOnDownload`, `intervalSec`, `tileWidth`, `columns`, `maxTiles`, `format`, `quality`, `concurrency`, `maxRetries`, `overwrite`, `hwaccel` | Built-in sprite generation |
| `advanced.nsfw` | `enabled`, `threshold` (0.1–0.99, default 0.6), `fileTypes`, `concurrency`, `batchSize`, `videoMaxTiles`, `sidecarUrl`, `apiToken`, `pathMap`, `blocklistEnabled` | NSFW sidecar |
| `advanced.ai` | `enabled`, `faceClustering`, `autoScan`, `autoScanIntervalMs`, `autoScanBatchSize`, `faces.*` (`sidecarUrl`, `sidecarToken`, `pathMap`, `scanVideos`, `detectorModel`, `providers`, `minDetectionScore`, `minFaceSizePx`, `epsilon`, `minPoints`, …) | Faces sidecar and clustering |
| `advanced.thumbs` | `autoOnDownload`, `warnMisses`, `hwaccel` | Thumbnails |

Tokens (`advanced.ai.faces.sidecarToken`, `advanced.nsfw.apiToken`,
`advanced.seekbar.apiToken`) are redacted when you view or export the
configuration. The environment variables are listed in
[Configuration](CONFIGURATION.md#ai-sidecars).

## Sidecar projects

| Folder | Image | Default port | Used by 3.x |
|---|---|---|---|
| `faces-service/` | `ghcr.io/botnick/tgdl-faces` | 8011 | Yes, for faces |
| `nsfw-service/` | `ghcr.io/botnick/tgdl-nsfw` (`gpu-latest` for CUDA) | 8012 | Yes, for NSFW |
| `seekbar-service/` | — | 8089 | No: sprites are built in the server |

Each sidecar reads its own environment variables:

- **tgdl-faces:** `TGDL_FACES_HOST`, `TGDL_FACES_PORT`, `TGDL_FACES_PROVIDERS`
  (`auto`, `cpu`, `cuda`, `coreml`, `directml`), `TGDL_FACES_DETECTOR_MODEL`,
  `TGDL_FACES_DET_SIZE`, `TGDL_FACES_ALLOW_ROOTS` (folders it may read by
  path) and `TGDL_FACES_API_TOKEN`. Without Docker: `pip install -e
  faces-service/` (`[gpu]` for NVIDIA) and `python -m tgdl_faces`; on Windows
  `run-faces-gpu.bat` starts it with CUDA.
- **tgdl-nsfw:** `TGDL_NSFW_HOST`, `TGDL_NSFW_PORT`, `TGDL_NSFW_MODEL`,
  `TGDL_NSFW_ALLOW_ROOTS`, `TGDL_NSFW_API_TOKEN` and `TGDL_NSFW_MAX_UPLOAD_MB`.
  Without Docker: `cd nsfw-service && pip install -r requirements.txt && python
  main.py`.

On any network other than a private Docker network or localhost, set the
sidecar's API token. Every route except `/health` then requires it.

## Not available in 3.x

- **Local face sidecar mode.** 2.x could download a `tgdl-faces` binary and
  start it itself. 3.x cannot: run the `tgdl-faces` container (or `python -m
  tgdl_faces`) and give its URL. *Install dependencies* answers
  `NOT_APPLICABLE`.
- **In-process NSFW model.** NSFW scoring always needs the `tgdl-nsfw`
  container.
- **Face crops from WebP images and videos.** Avatars and crops can only be
  cut from JPEG and PNG files; others show a blank tile.
- **Semantic search and auto-tags** (removed in 2.16).

## Troubleshooting

**The Faces page says "no face sidecar is configured".** Start `tgdl-faces`
and set its URL as described above, then use the health test.

**NSFW scan says "Configure the NSFW sidecar first".** Start `tgdl-nsfw` and
set `TGDL_NSFW_SIDECAR_URL` (or the URL on the NSFW review page), then press
**Test**.

**The sidecar answers 401.** The token differs: `TGDL_NSFW_API_TOKEN` (or
`TGDL_FACES_SIDECAR_TOKEN` for faces) on the server must equal the token set
on the sidecar.

**Videos are never NSFW-scored.** They are scored from their seekbar sprite;
build sprites under Maintenance → Seekbar first.

**New videos have no hover preview.** Check that `advanced.seekbar.enabled`
and `autoOnDownload` are on and that Maintenance → Seekbar → health finds
ffmpeg.

**Some face avatars are blank.** The face comes from a video or a WebP image;
see [Not available in 3.x](#not-available-in-3x).

For other problems see [Troubleshooting](TROUBLESHOOTING.md).
