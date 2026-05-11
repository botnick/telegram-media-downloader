# AI subsystem

Face detection + face clustering — backed by a small Python sidecar
(`faces-service/`) running insightface buffalo_l (MIT, 512-dim ArcFace
embeddings). The Node app speaks HTTP to the sidecar; everything else
(DBSCAN, cluster ops, label preservation) stays in-process.

The sidecar is **zero-install** on every supported platform — see the
support matrix below.

> **What changed in v2.16.** Semantic image search and auto-tagging were
> removed. Face clustering moved out-of-process. The Node side no longer
> bundles `@vladmandic/face-api` or `@tensorflow/tfjs-node`, both of
> which had broken installs on Windows + Node 22.

## Architecture

```
Standalone install               Docker compose install
─────────────────────             ─────────────────────────────
                                  ┌──────────────────────────┐
┌────────────────────┐            │  tgdl-app (Node)         │
│  tgdl Node app     │            │  ↓ HTTP                  │
│  ↓ HTTP            │            │  tgdl-faces (Python)     │
│  127.0.0.1:4xxxx   │            │  on tgdl-faces:8011      │
│  (auto-spawned)    │            └──────────────────────────┘
└────────────────────┘
        ↓ spawn
┌────────────────────┐            ┌──────────────────────────┐
│ data/faces-service │            │ Image: tgdl-faces:latest │
│  bin/tgdl-faces-*  │            │ (Python+insightface+     │
│  + buffalo_l model │            │  buffalo_l bundled)      │
└────────────────────┘            └──────────────────────────┘

Auto-download on first       Pulled via `docker compose up`
boot (HTTPS to GitHub          (--profile faces)
Releases). Cached forever.
```

## Platform support matrix

| Platform | Architecture | Mode | Notes |
|---|---|---|---|
| Windows 11 | x64 | Standalone `npm start` | Auto-downloads `tgdl-faces-win-x64.exe.tar.gz`, healthy in ≤60 s |
| Windows 11 | ARM64 | Standalone | Auto-downloads `tgdl-faces-win-arm64.exe.tar.gz` (planned — until binary lands, drop a manual build at `data/faces-service/bin/`) |
| macOS | Intel (x64) | Standalone | Auto-downloads `tgdl-faces-mac-x64.tar.gz` |
| macOS | Apple Silicon (arm64) | Standalone | Auto-downloads `tgdl-faces-mac-arm64.tar.gz`; CoreML provider auto-picked when available |
| Linux | x64 (bare-metal) | Standalone | Auto-downloads `tgdl-faces-linux-x64.tar.gz` |
| Linux | arm64 (Pi 4 / NAS) | Standalone | Auto-downloads `tgdl-faces-linux-arm64.tar.gz`; set `TGDL_FACES_DET_SIZE=480` for ~3× faster scan on Pi 4 |
| Linux | arm64 (Synology DSM) | Docker compose | `docker compose --profile faces up`; pulls `ghcr.io/botnick/tgdl-faces:latest` arm64 layer |
| Linux | amd64 | Docker compose | Same as above, amd64 layer |
| Offline / air-gapped | any | Standalone | Drop the binary at `data/faces-service/bin/`, set `TGDL_FACES_AUTO_DOWNLOAD=false` |

Architectures NOT in the prebuilt matrix (32-bit ARM on Pi Zero / Pi 3,
s390x, riscv64, FreeBSD) — the spawn module refuses to download and the
AI maintenance card surfaces an "unsupported platform" message instead
of crashing. Operators on those platforms can build the sidecar from
source (`faces-service/README.md`).

### Python fallback (used when the prebuilt binary is unavailable)

If the prebuilt-binary download fails (the GitHub Release hasn't been
tagged yet, the asset 404s, your corporate proxy blocks GitHub, etc.)
the spawn module falls back to running `python -m tgdl_faces` from the
co-located `faces-service/` source tree. Requirements:

1. The `faces-service/` folder is present next to the Node app (true
   for both dev checkouts and standard installs).
2. A `python3` (or `python` on Windows) interpreter ≥ 3.10 is on PATH.
3. The package deps are installed: `pip install -e faces-service/` from
   the repo root.

When all three gates pass, the sidecar comes up under the host's Python
just like the prebuilt would — the same `/health`, `/info`,
`/detect`, and `/providers` routes are exposed. The dashboard's AI
maintenance page shows the chosen mode in the log feed
(`starting via python fallback` vs `starting prebuilt binary`).

Set `TGDL_FACES_AUTO_DOWNLOAD=false` to opt out of both the binary
download AND the Python fallback in one switch — useful for strict
air-gapped deployments where every auto-acquisition path must be
disabled.

### Inference provider (onnxruntime backend)

The Python sidecar can run on any onnxruntime execution provider
compiled into its wheel. Default is `auto` — sidecar picks the fastest
available (CUDA → CoreML → DirectML → OpenVINO → CPU). Override via
`config.advanced.ai.faces.providers` (or the matching env var) when
the auto-pick guesses wrong (e.g. CUDA driver mismatch).

The AI maintenance page exposes a **Run hardware probe** button that
asks the sidecar to allocate a tiny onnxruntime session against every
candidate provider — only the backends that actually initialise on the
host show up as verified. Same UX as the ffmpeg hardware probe in the
Build thumbnails page.

### onnxruntime variant install matrix

The base `onnxruntime` wheel is **CPU-only** and ships with every
`pip install -e faces-service/`. To unlock GPU acceleration, install
the variant that matches your host. The three variants share the
`onnxruntime` Python module name and cannot coexist — installing a
new one auto-uninstalls the old one.

#### Recommended: auto-detect installer

```bash
pip install -e faces-service/
python -m tgdl_faces.install        # or: tgdl-faces-install
```

The installer probes the host (OS, arch, NVIDIA via `nvidia-smi`,
Intel iGPU via `lspci` / `/dev/dri`) and `pip install`s the matching
extra automatically. Idempotent — safe to re-run after a hardware
change. Flags: `--dry-run`, `--force {cpu,gpu,directml,openvino}`,
`--no-uninstall`.

#### Manual

| Host | GPU vendor | Recommended variant | Install command |
|---|---|---|---|
| Windows 10+ | NVIDIA (any) | DirectML | `py -m pip install onnxruntime-directml` |
| Windows 10+ | AMD / Intel | DirectML | `py -m pip install onnxruntime-directml` |
| Windows 10+ | NVIDIA + CUDA Toolkit installed | CUDA | `py -m pip install onnxruntime-gpu` |
| Linux | NVIDIA + nvidia-container-toolkit | CUDA | `pip install onnxruntime-gpu` |
| Linux | Intel iGPU / dGPU / NPU | OpenVINO | `pip install onnxruntime-openvino` |
| Linux ARM64 (Pi 4, NAS) | none / no support | CPU | (default) |
| macOS Apple Silicon | M-series GPU | CoreML | (built into base wheel — no extra install) |
| macOS Intel | none | CPU | (default) |

After installing a variant, restart the sidecar (Maintenance → AI →
provider dropdown's change handler triggers `/api/ai/faces/restart`,
or `docker compose restart tgdl-faces`, or just restart the Node app).
Re-run the hardware probe; the new EP should appear verified.

The same extras are exposed via pyproject:

```bash
pip install -e faces-service/[gpu]         # NVIDIA CUDA
pip install -e faces-service/[directml]    # Windows DirectML
pip install -e faces-service/[openvino]    # Intel OpenVINO
```

### Docker / DSM / Synology GPU variants

The compose file ships three mutually-exclusive profiles for the
faces sidecar — pick the one that matches your host hardware:

| Profile | Image tag | Hardware | Compose command |
|---|---|---|---|
| `faces` | `ghcr.io/botnick/tgdl-faces:latest` | CPU only (default; works everywhere) | `docker compose --profile faces up -d` |
| `faces-cuda` | `ghcr.io/botnick/tgdl-faces:cuda-latest` | NVIDIA + nvidia-container-toolkit | `docker compose --profile faces-cuda up -d` |
| `faces-openvino` | `ghcr.io/botnick/tgdl-faces:openvino-latest` | Intel iGPU/dGPU/NPU via /dev/dri | `docker compose --profile faces-openvino up -d` |

All three bind to `container_name: tgdl-faces` and port 8011 inside
the compose network so the main app's `FACES_SERVICE_URL=http://
tgdl-faces:8011` resolves to whichever variant you bring up. Compose
refuses to start more than one at a time.

**CUDA path** — requires the host to have:
1. NVIDIA driver matching the CUDA runtime baked into the image (the
   sidecar uses CUDA 12.x; driver 525+ on Linux, 530+ on Windows WSL2).
2. `nvidia-container-toolkit` installed and configured:
   ```bash
   sudo apt-get install nvidia-container-toolkit
   sudo nvidia-ctk runtime configure --runtime=docker
   sudo systemctl restart docker
   ```
3. `runtime: nvidia` in the compose service (already set on the
   `tgdl-faces-cuda` block).

Verify with `docker run --rm --gpus all
ghcr.io/botnick/tgdl-faces:cuda-latest nvidia-smi`.

**OpenVINO path** — requires `/dev/dri` exposed to the container.
The compose block mounts it automatically; on Synology DSM 7 grant
the SSH user render-group access first:
```bash
sudo synogroup --add videodriver $(whoami)
sudo synogroup --add video $(whoami)
```

**DSM Docker (Synology)** — DSM 7's Container Manager honours
`profiles:`, so the same compose commands work. For DSM 6 (no profile
support in its older docker-compose), copy the desired `tgdl-faces*`
block into its own compose file and start it independently.

**Raspberry Pi / arm64** — only the CPU profile is supported. ARM
wheels for `onnxruntime-gpu` and `onnxruntime-openvino` are not
published. Pi 4 4GB+ runs buffalo_l at ~2 fps on CPU; the Pi Zero /
Pi 3 are too underpowered (insightface needs ~600 MB RSS).

## Configuration

Surface: `config.advanced.ai` (kv['config']). The faces-specific knobs
live under `advanced.ai.faces.*`; every value can also be overridden at
deploy time via a `TGDL_FACES_<KEY>` env var (deployment > config >
default).

Old flat keys (`facesServiceUrl`, `facesEpsilon`, `facesMinPoints`,
`facesDetector`, `facesLabelMatchEps`, `federateFaces`) are migrated
into `advanced.ai.faces.*` on first load and kept as read-only aliases.
Existing operator configs continue to work without changes; new code
should read the nested path.

### Config + env var reference

| Config key | Env var | Default | Description |
|---|---|---|---|
| `backend` | `TGDL_FACES_BACKEND` | `sidecar` | `sidecar` or `disabled` — kill switch for the spawn path |
| `sidecarUrl` | `TGDL_FACES_SIDECAR_URL` | `''` | Operator override URL; empty = compose env or local auto-spawn |
| `autoDownload` | `TGDL_FACES_AUTO_DOWNLOAD` | `true` | `false` refuses to fetch the binary (offline mode) |
| `minDetectionScore` | `TGDL_FACES_MIN_DETECTION_SCORE` | `0.5` | Detector score floor (0–1) |
| `minFaceSizePx` | `TGDL_FACES_MIN_FACE_SIZE_PX` | `80` | Reject boxes smaller than this on the shorter edge |
| `arRange` | `TGDL_FACES_AR_RANGE` | `0.5,2.0` | Aspect-ratio window for valid boxes |
| `detSize` | `TGDL_FACES_DET_SIZE` | `640` | Sidecar input size; smaller = faster, lower recall |
| `embedDim` | `TGDL_FACES_EMBED_DIM` | `512` | buffalo_l native (informational only) |
| `detectorModel` | `TGDL_FACES_DETECTOR_MODEL` | `buffalo_l` | Future-proof; currently only buffalo_l is shipped |
| `providers` | `TGDL_FACES_PROVIDERS` | `auto` | `auto` / `cpu` / `cuda` / `coreml` / `directml` |
| `epsilon` | `TGDL_FACES_EPSILON` | `0.5` | DBSCAN radius |
| `minPoints` | `TGDL_FACES_MIN_POINTS` | `3` | Smallest cluster surfaced as a person |
| `labelMatchEps` | `TGDL_FACES_LABEL_MATCH_EPS` | `null` (derived) | Label-preservation radius across re-clusters |
| `detector` | `TGDL_FACES_DETECTOR` | `tiny` | Legacy face-api hint (sidecar ignores) |
| `batchSize` | `TGDL_FACES_BATCH_SIZE` | `16` | Phase-A rows per tick |
| `fileTypes` | `TGDL_FACES_FILE_TYPES` | `photo` | Comma list of `downloads.file_type` to scan |
| `sidecarMaxConcurrency` | `TGDL_FACES_MAX_CONCURRENCY` | `0` (unlimited) | Cap inflight detect calls Node-side |
| `healthCacheTtlMs` | `TGDL_FACES_HEALTH_CACHE_TTL_MS` | `5000` | /health response cache |
| `requestTimeoutMs` | `TGDL_FACES_REQUEST_TIMEOUT_MS` | `15000` | Per-request hard timeout |
| `maxRetries` | `TGDL_FACES_MAX_RETRIES` | `3` | POST retry count on 5xx / network errors |
| `retryBackoffMs` | `TGDL_FACES_RETRY_BACKOFF_MS` | `300,600,1200` | Linear backoff schedule (ms) |
| `portRange` | `TGDL_FACES_PORT_RANGE` | `41000:49999` | Random localhost port range |
| `portProbeAttempts` | `TGDL_FACES_PORT_PROBE_ATTEMPTS` | `10` | Free-port discovery attempts |
| `firstBootHealthTimeoutMs` | `TGDL_FACES_FIRST_BOOT_HEALTH_TIMEOUT_MS` | `60000` | /health probe ceiling on cold boot |
| `respawnHealthTimeoutMs` | `TGDL_FACES_RESPAWN_HEALTH_TIMEOUT_MS` | `30000` | /health probe ceiling on respawn |
| `healthMonitorIntervalMs` | `TGDL_FACES_HEALTH_MONITOR_INTERVAL_MS` | `60000` | Background health-check cadence |
| `healthFailuresBeforeRelaunch` | `TGDL_FACES_HEALTH_FAILURES_BEFORE_RELAUNCH` | `3` | Probe failures before respawn |
| `downloadRedirectCap` | `TGDL_FACES_DOWNLOAD_REDIRECT_CAP` | `5` | Max HTTP redirects when fetching the binary |
| `downloadMirrors` | `TGDL_FACES_DOWNLOAD_MIRRORS` | `[]` | Alternative tarball URLs / base URLs |
| `federate` | `TGDL_FACES_FEDERATE` | `false` | Cross-peer face centroid propagation |

Env-var precedence is strict: any `TGDL_FACES_*` value wins over the
matching kv-config value, which wins over the legacy flat alias, which
wins over the hardcoded default. Number arrays accept `,` or `:` as
separators (`5000,5999` or `5000:5999` both work).

## How it works

### Face pass

1. **Phase A** — for every photo whose `downloads.ai_indexed_at IS NULL`,
   POST to the sidecar's `/detect`. Persist bounding box + 512-dim
   embedding + landmarks to the `faces` table. Stamp `ai_indexed_at`
   regardless of detected face count, so a re-scan doesn't re-decode
   photos that yielded zero faces.

2. **Phase B** — DBSCAN over every face embedding. Cluster ids are
   rebuilt from scratch on each run; `eps` defaults to 0.5 (matches
   buffalo_l's "definitely the same person" guidance for L2-normalised
   embeddings); `minPts` defaults to 3 so a one-shot stranger stays
   unassigned instead of getting forced into a cluster.

3. **Label preservation across re-cluster** — before wiping the `people`
   table, every labelled centroid is snapshotted in memory. After the
   new DBSCAN finishes, each cluster's centroid is matched against the
   snapshot within `labelMatchEps` (default: `epsilon * 0.9` clamped to
   `[0.2, 0.6]`) and the label carries over. Renames survive re-runs
   even though cluster ids reset.

### Cluster operations

The maintenance page surfaces:

- **Rename** — set a label on a cluster. Survives re-cluster via the
  centroid-match path above.
- **Merge** — fold one cluster into another. Both label histories and
  every linked face come along.
- **Split** — pick faces from a cluster, create a new cluster, link
  those faces to it. The original keeps the rest.
- **Reassign** — move one face between clusters.

### Auto-pregeneration on new downloads

The downloader's `pregenerateAi(downloadId)` hook fires after each
successful download. When `cfg.faceClustering === true` it runs face
detection on the new row and writes the embeddings into `faces`. The
clustering pass is a batch operation — kick it off explicitly from the
maintenance page when you want it.

## Offline install

For air-gapped / corporate-proxy environments:

1. Download the matching tarball from the
   [GitHub release page](https://github.com/botnick/telegram-media-downloader/releases)
   on a machine that has internet access. The asset names match
   `tgdl-faces-<platform>-<arch>.tar.gz`.

2. Extract the binary onto the offline host at:
   ```
   data/faces-service/bin/tgdl-faces-<platform>-<arch>[.exe]
   ```
   On Linux/macOS make it executable: `chmod +x …`.

3. Tell the spawn module not to attempt a download:
   ```bash
   export TGDL_FACES_AUTO_DOWNLOAD=false
   npm start
   ```

   Or, equivalent, pin the URL to a corporate mirror:
   ```bash
   export TGDL_FACES_SIDECAR_BIN_URL=https://mirror.corp/tgdl-faces.tar.gz
   ```

Alternatively use the `downloadMirrors` config knob to list alternative
URLs the spawn module should try before falling back to GitHub:

```json
{
  "advanced": {
    "ai": {
      "faces": {
        "downloadMirrors": [
          "https://mirror.corp/sidecars",
          "https://backup.example/tgdl-faces.tar.gz"
        ]
      }
    }
  }
}
```

URLs ending in `.tar.gz` are taken verbatim; bare base URLs have
`/<slug>.tar.gz` appended.

## GPU acceleration

The sidecar reads `TGDL_FACES_PROVIDERS` and forwards the resolved
chain to onnxruntime. Options:

- **`auto`** (default) — picks the fastest available provider:
  CUDA → CoreML → DirectML → OpenVINO → CPU.
- **`cuda`** — NVIDIA GPU. Requires the `onnxruntime-gpu` wheel inside
  the PyInstaller binary; the standard release ships the CPU build, so
  CUDA users must build the sidecar from source (see
  `faces-service/README.md`) or use a custom Docker image.
- **`coreml`** — Apple Silicon Neural Engine. Works on macOS arm64 with
  the standard release out of the box.
- **`directml`** — Windows GPU compute. Requires the `onnxruntime-directml`
  wheel; standard release ships CPU.
- **`cpu`** — force CPU even when a GPU provider is available.

Boot logs print the resolved provider chain:
```
[tgdl-faces] INFO loading buffalo_l from ... (providers=['CoreMLExecutionProvider','CPUExecutionProvider'] requested=auto det_size=(640, 640))
```

`/health` and `/info` both surface `providers_resolved` so the AI
maintenance card shows the actually-active provider.

## API surface

All endpoints are admin-only.

| Method | Path                                | Notes                                                  |
| ------ | ----------------------------------- | ------------------------------------------------------ |
| GET    | `/api/ai/status`                    | feature flags, scan state, face count                  |
| POST   | `/api/ai/scan/start`                | `{ feature: 'faces' }`                                 |
| POST   | `/api/ai/scan/cancel`               | same body shape                                        |
| GET    | `/api/ai/scan/status?feature=faces` | live state for re-mounted page                         |
| GET    | `/api/ai/people`                    | clusters with cover face + count                       |
| GET    | `/api/ai/people/:id/photos`         | paginated photos in this cluster                       |
| PATCH  | `/api/ai/people/:id`                | `{ label }` — rename                                   |
| DELETE | `/api/ai/people/:id`                | drop cluster (faces become unassigned)                 |
| POST   | `/api/ai/people/:id/merge`          | `{ otherId }` — fold one cluster into another          |
| POST   | `/api/ai/people/:id/split`          | `{ faceIds, newLabel? }` — create a new cluster        |
| POST   | `/api/ai/faces/:id/reassign`        | `{ personId }` — move a single face to another cluster |
| GET    | `/api/ai/faces/by-download/:id`     | face boxes for the gallery viewer overlay              |

## Sidecar wire format

| Method | Path | Body | Response |
|---|---|---|---|
| `GET` | `/health` | — | `{ ok, version, model, dim, ready, providers_resolved, providers_requested, det_size, platform, python }` (always HTTP 200) |
| `GET` | `/info` | — | `{ model, dim, providers, providers_requested, det_size, platform, python, version }` |
| `POST` | `/detect` | `{ path \| image_b64, min_score?, min_box_px?, ar_range? }` | `{ faces[], image_w, image_h }` |
| `POST` | `/detect-embed` | _alias of `/detect`_ | — |

Path mode requires the path to resolve inside `TGDL_FACES_ALLOW_ROOTS`
(set by the spawn module to `data/downloads`). Base64 mode works without
an allow-root and is used automatically when path mode 403s.

## Troubleshooting

**Faces page shows "AI disabled"** — flip
`config.advanced.ai.enabled = true` and
`config.advanced.ai.faceClustering = true` in **Maintenance → AI** or
via `/api/config`.

**Sidecar binary download failed** — check the AI maintenance card for
the error code. Common causes:

- *Corporate proxy blocks GitHub release CDN*: set
  `TGDL_FACES_SIDECAR_BIN_URL` to your internal mirror, or list
  alternatives in `faces.downloadMirrors`.
- *Offline / air-gapped*: see the
  [Offline install](#offline-install) section.
- *AV quarantine*: the spawn module retries 3× on disk-level failures.
  Persistent failures surface as `binary verification failed`. Add the
  binary path to your AV exclusion list.

**Sidecar health probe failing** — the spawn module relaunches after
3 consecutive failed probes. If the relaunch loop persists, the
sidecar's own logs (visible via the dashboard's maintenance logs panel,
source `ai-faces-spawn`) usually pinpoint the cause. Common ones:

- *Port exhaustion*: bump `TGDL_FACES_PORT_RANGE` to a wider window.
- *Long model load on slow disks*: bump
  `TGDL_FACES_FIRST_BOOT_HEALTH_TIMEOUT_MS=120000`.
- *Memory pressure on Pi 4*: drop `TGDL_FACES_DET_SIZE=480` and set
  `TGDL_FACES_MAX_CONCURRENCY=2` to cap inflight detect calls.

**Faces table grows but People grid stays empty** — phase B (clustering)
hasn't run, or every face is below `minPoints`. Confirm by checking
`SELECT COUNT(*) FROM faces` vs `SELECT COUNT(*) FROM people`; if faces
exist but people don't, drop `minPoints` to 2 or click **Detect &
cluster** again to force phase B.

**`Statement::JS_all` OOM** — should never happen for the faces table;
the scan-runner flows through streamed iterators. If you see one, it's
a regression — `scripts/check-oom-patterns.sh` should have caught it.
File a bug with the stack trace.
