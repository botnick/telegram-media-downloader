---
title: "AI: faces, NSFW and previews"
description: "Face clustering, NSFW review and seekbar previews in v3.0: what still works from saved results, what is paused, and what your settings do now."
parent: Features
nav_order: 3
---

# AI: faces, NSFW and previews

Version 3.0 replaced the Node backend with one Go server (`tgdl-server`). The
port concentrated on downloading, the queue, files and the dashboard. The
optional analysis features were **not** ported: 3.0 does not detect faces,
classify NSFW content or generate seekbar sprites. Results that 2.x already
produced stay in the database, and most of them still appear in the
dashboard.

Semantic search and auto-tagging were removed back in 2.16 and are not part
of 3.0 either.

## What works in 3.0

| Feature | Uses existing results | Creates new results | Needs |
|---|---|---|---|
| **People (face clusters)** | Yes: browse people, photos per person, face boxes in the viewer, avatars | No: no face scan, no re-cluster | Faces found by 2.x |
| **People editing** | Rename, merge, split, move a face, delete a person | n/a | Admin login |
| **NSFW review** | Scores stay in the database and sync to cluster peers | No: no classifier and no review/scan pages | Scores from 2.x |
| **Seekbar previews** | Yes: hover previews on the video scrub bar | No: no generation for new videos | Sprites from 2.x in `data/seekbar/` |
| **Thumbnails** (for comparison) | Yes | Yes, in-process with ffmpeg on the CPU | `ffmpeg` (in the Docker image) |
| Semantic search, auto tags | No | No | Removed in 2.16 |

Notes:

- Face avatars and crops are cut from the original file and can only be decoded
  from JPEG and PNG photos. Faces found in WebP images or in videos show a
  blank tile.
- The faces **Reindex** action on the AI maintenance page doesn't do anything
  in 3.0. It only tells open dashboards to refresh.
- The AI, NSFW and seekbar maintenance panels still call status routes that 3.0
  does not serve, so they show errors or stay empty. This is expected.
- When a download is deleted or replaced, the server still removes its faces,
  NSFW score and seekbar sprite, so stale analysis never points at the wrong
  file.

If you rely on face scanning, NSFW classification or sprite generation, stay
on **2.32.1** for now. To roll back after updating, restore
`data/backups/db-pre-update-*.sqlite` with 2.32.1 (see [Upgrading](UPGRADING.md)).

## Settings

Your saved settings under `advanced.ai`, `advanced.nsfw` and
`advanced.seekbar` are kept and checked when you save, so they still work if
you go back to 2.x. **The 3.0 server doesn't use them to start any work.**

| Block | Keys kept (selection) | Effect in 3.0 |
|---|---|---|
| `advanced.ai` | `enabled`, `faceClustering`, `autoScan`, `faces.*` (`sidecarUrl`, `sidecarToken`, `detectorModel`, `epsilon`, `minPoints`, `providers`, …) | Stored only |
| `advanced.nsfw` | `enabled`, `threshold` (0.1–0.99, default 0.6), `fileTypes`, `sidecarUrl`, `apiToken`, `pathMap`, `blocklistEnabled` | Stored only |
| `advanced.seekbar` | `enabled`, `autoOnDownload`, `intervalSec`, `tileWidth`, `columns`, `maxTiles`, `format`, `quality`, `hwaccel`, `sidecarUrl`, `apiToken`, `pathMap` | Stored only. Existing sprites are served no matter what these say |
| `advanced.thumbs` | `autoOnDownload`, `warnMisses`, `hwaccel` | `hwaccel` is stored but ignored: thumbnails always use the CPU |

Tokens (`advanced.ai.faces.sidecarToken`, `advanced.nsfw.apiToken`,
`advanced.seekbar.apiToken`) are redacted when you view or export the
configuration.

**Environment variables.** The 3.0 server does not read `FACES_SERVICE_URL`,
`TGDL_FACES_*`, `TGDL_NSFW_SIDECAR_URL`, `TGDL_NSFW_*`, `SEEKBAR_SIDECAR_URL`
or `FFMPEG_HWACCEL`. Leftover values in `.env` do nothing; you can delete
them. The bundled `docker-compose.yml` has no faces, NSFW or seekbar services
or profiles. See [Configuration](CONFIGURATION.md) and [Deploy](DEPLOY.md) for
the variables that 3.0 does read.

**Hardware acceleration.** The ffmpeg hardware probe in the advanced settings lists
the accelerators your ffmpeg build was compiled with, but it always reports
none as verified. 3.0 has no hardware-accelerated thumbnails or previews.

## Sidecar projects

The three sidecars are still in the repository as separate projects. 2.x used
them; **the 3.0 server never calls them**, even if a URL is set. Run one only
for 2.x or to test the service on its own.

| Folder | What it is | Default port | Start from source |
|---|---|---|---|
| `faces-service/` | Python, insightface `buffalo_l`, face detection + 512-dim embeddings | 8011 | `pip install -e faces-service/` then `python -m tgdl_faces` |
| `nsfw-service/` | Python, `AdamCodd/vit-base-nsfw-detector` | 8012 | `cd nsfw-service && pip install -r requirements.txt && python main.py` |
| `seekbar-service/` | Go + ffmpeg, WebP sprite sheets | 8089 | see `seekbar-service/README.md` (Docker, `docker compose up -d` in that folder, or the `cli` / `server` commands) |

Each sidecar reads its own environment variables, not the server's:

- **faces-service:** `TGDL_FACES_HOST`, `TGDL_FACES_PORT`, `TGDL_FACES_PROVIDERS`
  (`auto`, `cpu`, `cuda`, `coreml`, `directml`), `TGDL_FACES_DETECTOR_MODEL`,
  `TGDL_FACES_DET_SIZE`, `TGDL_FACES_ALLOW_ROOTS` (folders it may read by path)
  and `TGDL_FACES_API_TOKEN`. For an NVIDIA GPU, install with
  `pip install -e faces-service/[gpu]`; on Windows, `run-faces-gpu.bat` starts
  it with CUDA. `python -m tgdl_faces.install` picks the right onnxruntime build
  for the host.
- **nsfw-service:** `TGDL_NSFW_HOST`, `TGDL_NSFW_PORT`, `TGDL_NSFW_MODEL`,
  `TGDL_NSFW_ALLOW_ROOTS`, `TGDL_NSFW_API_TOKEN` and `TGDL_NSFW_MAX_UPLOAD_MB`.
  `Dockerfile.gpu` builds a CUDA image.
- **seekbar-service:** `SEEKBAR_*` variables, including `SEEKBAR_API_TOKEN` and
  `SEEKBAR_HWACCEL`. See its README.

On any network other than localhost, set the sidecar's API token. Every route
except `/health` then requires it. Path mapping (`pathMap`) only matters when a
2.x server talks to a sidecar that mounts your downloads at a different path.

## Troubleshooting

**The People page is empty.** 3.0 shows only people that 2.x found. A
library that was never scanned under 2.x has no faces, and 3.0 cannot create
them.

**New videos have no hover preview.** That's expected: 3.0 doesn't generate
sprites. Videos that already had previews in 2.x keep them, as long as
`data/seekbar/` is intact.

**Some face avatars are blank.** The face comes from a video or a WebP image,
and 3.0 can only crop faces from JPEG or PNG files.

**The AI / NSFW / seekbar maintenance cards show errors.** Their status routes
don't exist in 3.0. This doesn't affect downloads.

**I set a sidecar URL and nothing happens.** 3.0 ignores sidecar URLs. Saving
a seekbar URL can show a "fetch failed" status; no request is actually sent.

For other problems see [Troubleshooting](TROUBLESHOOTING.md).
