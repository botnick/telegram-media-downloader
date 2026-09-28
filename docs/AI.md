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

**No profile at all** — the stock compose file sets
`FACES_SERVICE_URL=http://tgdl-faces:8011` either way. When that host
doesn't resolve (no `faces*` profile running), the app ignores the URL and
auto-spawns the sidecar binary inside its own container instead — the
same path bare-metal installs use (downloaded to
`data/faces-service/bin/` once AI + face clustering are on). The check is
repeated when a scan starts, so bringing a profile up later switches to it
(and stopping it falls back again). A custom `FACES_SERVICE_URL` or an
**External sidecar URL** is always used as-is. The AI doctor shows which
mode is active: *compose sidecar*, *auto-spawned in this container*, or
*external URL*.

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
| `sidecarUrl` | `TGDL_FACES_SIDECAR_URL` | `''` | Operator override URL; empty = compose env or local auto-spawn (see [External sidecar](#external-sidecar)) |
| `sidecarToken` | `TGDL_FACES_SIDECAR_TOKEN` | `''` | Sent as `Authorization: Bearer …` to a sidecar started with `TGDL_FACES_API_TOKEN` |
| `autoDownload` | `TGDL_FACES_AUTO_DOWNLOAD` | `true` | `false` refuses to fetch the binary (offline mode) |
| `minDetectionScore` | `TGDL_FACES_MIN_DETECTION_SCORE` | `0.5` | Detector score floor (0–1) |
| `minFaceSizePx` | `TGDL_FACES_MIN_FACE_SIZE_PX` | `80` | Reject boxes smaller than this on the shorter edge |
| `arRange` | `TGDL_FACES_AR_RANGE` | `0.5,2.0` | Aspect-ratio window for valid boxes |
| `detSize` | `TGDL_FACES_DET_SIZE` | `640` | Sidecar input size; smaller = faster, lower recall |
| `embedDim` | `TGDL_FACES_EMBED_DIM` | `512` | buffalo_l native (informational only) |
| `detectorModel` | `TGDL_FACES_DETECTOR_MODEL` | `buffalo_l` | Detector model preset (see [Detector model options](#detector-model-options) below) |
| `scanVideos` | — | `false` | Include videos in face scan (see [Video face scanning](#video-face-scanning)) |
| `cpuThrottleRatio` | `TGDL_FACES_CPU_THROTTLE_RATIO` | `0.5` | Duty-cycle rest ratio after each detection call (0 = off, see [CPU throttle](#cpu-throttle)) |
| `sidecarWaitMs` | `TGDL_FACES_SIDECAR_WAIT_MS` | `300000` | How long a scan waits for the sidecar to come (back) up — at scan start and after an outage — before stopping with an error. Unscanned files stay queued. |
| `sidecarNice` | `TGDL_FACES_SIDECAR_NICE` | `10` | Priority of an **auto-spawned** sidecar (nice 10 / Windows below-normal) so the dashboard wins CPU contention. `0` = same priority as Node. |
| `providers` | `TGDL_FACES_PROVIDERS` | `auto` | `auto` / `cpu` / `cuda` / `coreml` / `directml` |
| `epsilon` | `TGDL_FACES_EPSILON` | `0.5` | DBSCAN radius |
| `minPoints` | `TGDL_FACES_MIN_POINTS` | `3` | Smallest cluster surfaced as a person |
| `labelMatchEps` | `TGDL_FACES_LABEL_MATCH_EPS` | `null` (derived) | Label-preservation radius across re-clusters |
| `detector` | `TGDL_FACES_DETECTOR` | `tiny` | Legacy face-api hint (sidecar ignores) |
| `batchSize` | `TGDL_FACES_BATCH_SIZE` | `16` | Phase-A rows per tick |
| `fileTypes` | `TGDL_FACES_FILE_TYPES` | `photo` | Comma list of `downloads.file_type` to scan |
| `sidecarMaxConcurrency` | `TGDL_FACES_MAX_CONCURRENCY` | `1` | Cap inflight detect calls Node-side (1 = sequential, safe for CPU/GPU) |
| `healthCacheTtlMs` | `TGDL_FACES_HEALTH_CACHE_TTL_MS` | `5000` | /health response cache |
| `requestTimeoutMs` | `TGDL_FACES_REQUEST_TIMEOUT_MS` | `60000` | Per-request hard timeout (CPU buffalo_l can take 5–30 s per image) |
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

1. **Phase A** — for every photo whose `downloads.ai_indexed_at IS NULL`
   (oldest first), POST to the sidecar's `/detect/batch`. Persist bounding
   box + 512-dim embedding + quality score to the `faces` table. Stamp
   `ai_indexed_at` once the sidecar has answered for the file — faces,
   no faces, or a per-file error such as `decode_failed` — so a re-scan
   doesn't re-decode photos that yielded zero faces.

   A sidecar that is down, restarting, still loading its model, or timing
   out is **not** an answer: those rows stay queued, the scan pauses
   (`waitingForSidecar` in the scan state) until `/health` reports the
   model ready, then carries on. The same wait runs before the first
   batch, so an auto-resumed scan after a container restart no longer
   races the sidecar's boot. If the sidecar stays away longer than
   `sidecarWaitMs` the scan stops with an error and the next scan picks
   up exactly where it left off. A file whose request keeps failing is
   retried on its own (so it can't take neighbours down with it) and
   skipped after 3 attempts.

2. **Phase B** — DBSCAN over every face embedding, on a worker thread so a
   long pass never blocks the dashboard (or the container healthcheck).
   Cluster ids are rebuilt on each run; see `epsilon` / `minPoints` in
   the table above. Cancelling during Phase B leaves the previous People
   grid untouched.

3. **Label preservation across re-cluster** — before replacing the
   `people` rows, every labelled centroid is snapshotted in memory. After
   the new DBSCAN finishes, each cluster's centroid is matched against the
   snapshot within `labelMatchEps` (default: `epsilon * 0.9` clamped to
   `[0.2, 0.6]`) and the label carries over. Renames survive re-runs
   even though cluster ids reset. The new generation is written first and
   the old one dropped afterwards, so the grid is never empty mid-swap.

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
maintenance page when you want it. While the sidecar is unreachable (or
face clustering is off) new downloads are left unstamped, so the next
scan covers them.

### When the local sidecar starts

The auto-spawned sidecar (binary download + process) starts only when both
`advanced.ai.enabled` and `advanced.ai.faceClustering` are on. Fresh
installs therefore download nothing until AI is switched on in
**Maintenance → AI**; saving that setting, or starting a scan, starts it.
URL-based sidecars (external URL, a custom or reachable Docker
`FACES_SERVICE_URL`) don't depend on this. The stock compose URL with no
`faces` profile running counts as "no sidecar" and takes this path.

### External sidecar

Point `sidecarUrl` (Maintenance → AI → External sidecar URL, or
`TGDL_FACES_SIDECAR_URL`) at a sidecar on another machine — typically a
GPU box running `ghcr.io/botnick/tgdl-faces:cuda-latest`. It does not need
access to your downloads:

- Photos are sent by path first. If the sidecar answers
  `path_not_allowed` (403) **or** `file_not_found` for a file that exists
  here, the file is re-sent as bytes and the client switches to bytes for
  the rest of the run. (Earlier releases stored `file_not_found` as "no
  faces" — with a remote sidecar whose allow-list matched the path, a whole
  scan finished with zero faces.)
- Videos the sidecar can't open by path are decoded here with ffmpeg and
  sent as frames (`/detect/batch-b64`).
- `https://` URLs and URLs with a path prefix (reverse proxy / tunnel)
  work for every call, including the health and `/info` probes.
- Reachability is probed at start and every `healthMonitorIntervalMs`; an
  unreachable URL shows as failed in the AI doctor instead of "running".
  Scans wait for it (`sidecarWaitMs`) rather than recording outages.
- Exposed beyond localhost, start the sidecar with
  `TGDL_FACES_API_TOKEN=<secret>` and set the same value in
  `sidecarToken` / `TGDL_FACES_SIDECAR_TOKEN` (compose: put
  `TGDL_FACES_API_TOKEN` in `.env` and both services pick it up). Every
  endpoint but `/health` then requires it; a mismatch stops the scan with a
  401 error instead of marking anything scanned. Sidecars before 0.5.0
  ignore the header.
- Reverse proxies have their own limits — Cloudflare, for example, ends
  proxied requests after 100 s and caps bodies at 100 MB. Keep
  `batchSize` modest for CPU-only remotes; a GPU sidecar is well inside
  both.

### Sidecar CPU budget

On the CPU provider the sidecar sizes onnxruntime from the CPU it may
actually use, not from `os.cpu_count()` (which inside a container reports
every host core):

- **effective CPUs** = affinity mask ∩ cgroup quota (`docker --cpus` /
  compose `cpus:`), minus `TGDL_FACES_RESERVE_CPUS`;
- `TGDL_FACES_MAX_CONCURRENCY` requests (default 2, never more than the
  budget) share that budget — each onnxruntime session gets
  `budget / concurrency` intra-op threads;
- idle spinning is off, OpenCV runs single-threaded, and only the three
  models the pipeline uses are loaded (detection, recognition, 3-D
  landmarks for the pose term of the quality score);
- small / low-score / odd-aspect detections are dropped **before** the
  recognition + landmark models run on them — same results, far less work
  on group shots.

When Node auto-spawns the sidecar (same host / container as the
dashboard) it also sets `TGDL_FACES_RESERVE_CPUS=1` and lowers the
child's priority (`sidecarNice`), so the event loop always gets CPU.

| Sidecar env var | Default | Meaning |
|---|---|---|
| `TGDL_FACES_CPU_THREADS` | effective CPUs − reserve | Total inference threads (overrides the detection) |
| `TGDL_FACES_RESERVE_CPUS` | `0` (`1` when auto-spawned) | Cores kept free for co-located processes |
| `TGDL_FACES_INTRA_OP_THREADS` | budget ÷ concurrency | Explicit per-session onnxruntime intra-op threads |
| `TGDL_FACES_ORT_SPIN` | `0` | `1` re-enables onnxruntime busy-wait spinning |

`GET /config` on the sidecar reports `effective_cpus`, `cpu_budget`,
`intra_op_threads` and `max_concurrency`. GPU providers keep
onnxruntime's defaults. These knobs ship with the next sidecar release;
older sidecars ignore them.

### Video face scanning

When `advanced.ai.faces.scanVideos` is `true`, the scan runner includes
`file_type = 'video'` rows in the phase A total alongside photos.
Videos are processed one at a time after the photo batch finishes.

For each video the sidecar's `POST /detect/video` endpoint extracts
evenly-spaced frames via `cv2.VideoCapture` (no temp files written to
disk). Frame count adapts to video duration — short clips get at least
one frame, long videos are capped at `max_frames` (default 120, roughly
1 frame/min for a 2-hour file). Detection runs on every extracted frame;
a deduplication pass then collapses faces with cosine similarity above
0.50 so only one best-score instance per identity is kept.

#### Video b64 fallback (external sidecar)

When the sidecar runs externally without shared filesystem access, the
`/detect/video` path mode returns 403. The Node client automatically
falls back to:

1. Extract frames locally with ffmpeg (same evenly-spaced logic).
2. Send frames in batches of 20 to `POST /detect/batch-b64`.
3. Deduplicate faces client-side (same cosine-sim ≥ 0.50 rule).

The fallback activates transparently — no configuration needed. Once
`_pathRejectedLogged` is set (by any 403 from photos or video), all
subsequent video calls skip the path-mode attempt entirely.

Embeddings from video frames land in the same `faces` table and use the
same 512-dim ArcFace space as photo-sourced faces. Phase B DBSCAN
clusters them together — the same person in a photo and a video ends up
in the same People group automatically.

Off by default; toggle via the AI maintenance page or set
`advanced.ai.faces.scanVideos = true` in the config.

### CPU throttle

The `cpuThrottleRatio` knob controls a duty-cycle rest inserted after
each detection call. The scanner sleeps for `ratio * elapsedMs` after
every sidecar round-trip, giving the CPU proportional breathing room
between work bursts. The sleep is dynamic — slow hardware (longer
elapsed time) gets longer rests; fast GPU inference barely notices it.
Single-call rest is capped at 5 000 ms so a stalled video frame cannot
freeze the entire loop.

| Value | Effect |
|---|---|
| `0` | No throttle — full speed. Recommended for GPU users. |
| `0.5` (default) | Rest for half the detection time. |
| `1.0` | Rest equal to detection time (50 % duty cycle). |
| `2.0` | Sleep 2x the detection time. Keeps CPU cool on Pi / NAS. |

Range is clamped to `[0, 5]`. Set via `advanced.ai.faces.cpuThrottleRatio`
in config or `TGDL_FACES_CPU_THROTTLE_RATIO` env var.

### Detector model options

The `detectorModel` config key selects the insightface model pack loaded
by the sidecar. All presets produce 512-dim L2-normalised ArcFace
embeddings and are clustering-compatible with each other — switching
models does not require a re-scan of already-indexed photos, but a
re-cluster is triggered automatically on the next scan because the
embedding distributions differ slightly across backbones.

| Preset | Backbone | LFW accuracy | Relative CPU speed | Notes |
|---|---|---|---|---|
| `buffalo_l` | ResNet50 | 99.5 % | 1.0x (baseline) | Default. Best balance of speed and accuracy. |
| `antelopev2` | ResNet100 + Glint360K | 99.6 % | ~2.3x slower | Best accuracy. Worth it on GPU; heavy on CPU. |
| `buffalo_m` | ResNet50 (smaller) | 99.3 % | faster | Lighter than `buffalo_l`. |
| `buffalo_s` | ResNet34 | 99.0 % | fastest | Minimal resource footprint. |

Set via `advanced.ai.faces.detectorModel` or
`TGDL_FACES_DETECTOR_MODEL` env var. The AI maintenance page also
exposes a dropdown. Changing the model restarts the sidecar
automatically.

### Model preload

Switching `detectorModel` to a preset that has not been downloaded yet
causes a potentially long delay on the first sidecar boot while
insightface fetches the model pack. The preload endpoints let you
trigger the download in advance without changing the active model:

| Method | Sidecar path | Node proxy | Purpose |
|---|---|---|---|
| `POST` | `/preload/{model}` | `/api/ai/preload-model/:name` | Start background download |
| `GET` | `/preload/{model}/status` | `/api/ai/preload-model/:name/status` | Check download status |

Status values: `downloading`, `ready`, `invalid`, `failed`. The
download runs in a background thread; the sidecar continues serving
detection requests on the current model while the new one downloads.

### Orphan cleanup

A SQLite trigger (`trg_purge_orphan_people`) automatically deletes a
`people` row when all its linked `faces` rows have been cascade-deleted.
This fires on `DELETE FROM faces` when the deleted row's `person_id` is
not null and no other faces reference the same person. The effect is
that deleting a download (which cascade-deletes its faces) transparently
prunes empty people entries — no manual cleanup needed.

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

- **`auto`** (default) — picks the fastest available provider on the
  current platform. On Windows: CUDA → CPU (DirectML is excluded from
  auto because it crashes with uvicorn's asyncio threadpool). On Linux:
  CUDA → OpenVINO → CPU. On macOS: CoreML → CPU.
- **`cuda`** — NVIDIA GPU. Requires `onnxruntime-gpu` wheel + CUDA
  Toolkit 12.x + cuDNN 9 installed on the host (see below).
- **`coreml`** — Apple Silicon Neural Engine. Works on macOS arm64 with
  the standard release out of the box.
- **`directml`** — Windows GPU compute via DirectML. Requires the
  `onnxruntime-directml` wheel. **Note:** has known threading issues with
  uvicorn asyncio worker threads on Windows (STATUS_ACCESS_VIOLATION crash)
  — use CUDA instead if you have an NVIDIA GPU.
- **`cpu`** — force CPU even when a GPU provider is available.

Boot logs print the resolved provider chain:
```
[tgdl-faces] INFO loading buffalo_l from ... (providers=['CUDAExecutionProvider','CPUExecutionProvider'] requested=auto det_size=(640, 640))
```

`/health` and `/info` both surface `providers_resolved` so the AI
maintenance card shows the actually-active provider. If a GPU provider
was requested but onnxruntime fell back to CPU (missing DLLs, etc.) the
sidecar logs a warning and the health endpoint correctly reports CPU.

### NVIDIA CUDA setup (Windows / Linux)

The Python sidecar (`faces-service/`) can run on CUDA when:

1. **`onnxruntime-gpu` is installed** (replaces the default CPU wheel):
   ```bash
   # from the repo root — uninstalls onnxruntime / onnxruntime-directml first
   pip install -e faces-service/[gpu]
   # or: python -m tgdl_faces.install --force gpu
   ```

2. **CUDA Toolkit 12.x** is installed on the host:
   - Download: <https://developer.nvidia.com/cuda-downloads>
   - Choose CUDA 12.6 (latest 12.x). Runtime installer (~300 MB) is enough
     — you do not need the full development toolkit.
   - On Windows: run the `.exe` installer, reboot if prompted.
   - On Linux: follow the distro-specific instructions on the download page.

3. **cuDNN 9** is installed:
   - Download via NVIDIA Developer: <https://developer.nvidia.com/cudnn>
   - On Windows: copy the DLLs from the cuDNN archive into
     `C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v12.x\bin\`.
   - On Linux: install the `libcudnn9-cuda-12` package from the NVIDIA
     repo (same page provides apt/yum commands).

After installing, restart the sidecar. Boot log should show:
```
Applied providers: ['CUDAExecutionProvider'], with options: ...
[tgdl-faces] INFO buffalo_l ready (..., gpu_provider=cuda)
```

If the sidecar still falls back to CPU it will log a warning:
```
WARNING GPU provider was requested ... but onnxruntime fell back to CPUExecutionProvider
        — likely missing runtime libraries.
```
Check that `cublasLt64_12.dll` (Windows) / `libcublasLt.so.12` (Linux)
is in the system library path.

#### TensorRT EP (optional — CUDA EP already gives full GPU speed)

When `onnxruntime-gpu` is installed it also ships a TensorRT execution
provider (`onnxruntime_providers_tensorrt.dll` / `.so`). At startup
onnxruntime probes every available EP; if TensorRT's runtime DLLs are
missing you will see a harmless warning in the log:

```
EP Error ... onnxruntime_providers_tensorrt.dll ... "nvinfer_10.dll" ... missing (Error 126)
```

**This is not a failure.** onnxruntime skips TensorRT EP and uses CUDA EP
instead — inference speed is unaffected for the face models used here.
You can safely ignore the warning.

If you *do* want TensorRT EP (marginal gain for buffalo_l, larger gain for
higher-res models):

1. Download **TensorRT 10.x** from <https://developer.nvidia.com/tensorrt>
   (requires a free NVIDIA developer account).
2. Extract the archive and add its `lib\` folder to the system `PATH`:
   - Windows: `setx PATH "%PATH%;C:\path\to\TensorRT-10.x.x.x\lib"`
     — or copy `nvinfer_10.dll`, `nvinfer_builder_resource_10.dll`,
     `nvonnxparser_10.dll` into the CUDA Toolkit `bin\` folder
     (`C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v12.x\bin\`).
   - Linux: add the lib path to `LD_LIBRARY_PATH` or run
     `ldconfig` after copying the `.so` files to `/usr/local/lib`.
3. Install the Python TensorRT wheel (must match TRT version):
   ```bash
   pip install tensorrt==10.*
   ```
4. Restart the sidecar. Set `providers=tensorrt` (or leave on `auto` —
   onnxruntime will pick TRT first automatically now that the DLLs are
   present). Boot log should show:
   ```
   Applied providers: ['TensorrtExecutionProvider', 'CUDAExecutionProvider']
   ```

The prebuilt binary (`tgdl-faces-*.exe`) ships the CPU onnxruntime and
cannot switch to CUDA or TensorRT. GPU acceleration requires either the
Python fallback path (`pip install -e faces-service/[gpu]`) or a custom
Docker image built with `Dockerfile.cuda`.

## API surface

All endpoints are admin-only.

| Method | Path                                | Notes                                                  |
| ------ | ----------------------------------- | ------------------------------------------------------ |
| GET    | `/api/ai/status`                    | feature flags, scan state, face count                  |
| POST   | `/api/ai/scan/start`                | `{ feature: 'faces' }`                                 |
| POST   | `/api/ai/scan/cancel`               | same body shape                                        |
| GET    | `/api/ai/scan/status?feature=faces` | live state for re-mounted page                         |
| GET    | `/api/ai/people`                    | clusters with cover face + count; `?sort=face_count|avg_quality|name&dir=asc|desc` (server-side, whole library; unnamed first asc / last desc) |
| GET    | `/api/ai/person/:id/face?w=`        | avatar crop (cached on disk under `thumbs/face-crops/`; ≤ `TGDL_FACE_CROP_CONCURRENCY` renders at once, default 4) |
| GET    | `/api/ai/faces/:id/crop?w=`         | crop of one face (photos and video faces)              |
| GET    | `/api/ai/people/:id/photos`         | paginated photos in this cluster                       |
| PATCH  | `/api/ai/people/:id`                | `{ label }` — rename                                   |
| DELETE | `/api/ai/people/:id`                | drop cluster (faces become unassigned)                 |
| POST   | `/api/ai/people/:id/merge`          | `{ otherId }` — fold one cluster into another          |
| POST   | `/api/ai/people/:id/split`          | `{ faceIds, newLabel? }` — create a new cluster (`label` also accepted) |
| POST   | `/api/ai/faces/:id/reassign`        | `{ personId }` — move a single face to another cluster |
| GET    | `/api/ai/faces/by-download/:id`     | face boxes for the gallery viewer overlay              |
| POST   | `/api/ai/preload-model/:name`       | trigger background model download (proxy to sidecar)   |
| GET    | `/api/ai/preload-model/:name/status`| check model download status                            |

## Sidecar wire format

| Method | Path | Body | Response |
|---|---|---|---|
| `GET` | `/health` | — | `{ ok, version, model, dim, ready, providers_resolved, providers_requested, det_size, platform, python }` (always HTTP 200) |
| `GET` | `/info` | — | `{ model, dim, providers, providers_requested, det_size, platform, python, version }` |
| `POST` | `/detect` | `{ path \| image_b64, min_score?, min_box_px?, ar_range? }` | `{ faces[], image_w, image_h }` |
| `POST` | `/detect-embed` | _alias of `/detect`_ | — |
| `POST` | `/detect/batch` | `{ files[] }` | `{ results: [{ file, faces[], image_w, image_h }] }` |
| `POST` | `/detect/batch-b64` | `{ images: [b64…], min_score?, min_box_px?, ar_range? }` | `{ results: [{ faces[], error? }], total_images, total_faces }` — GPU-pipelined parallel detect |
| `POST` | `/detect/video` | `{ path, max_frames? }` | `{ faces[], image_w, image_h }` (deduplicated across frames) |
| `POST` | `/preload/{model}` | — | `{ model, status }` — trigger background model download |
| `GET`  | `/preload/{model}/status` | — | `{ model, status }` — `downloading` / `ready` / `invalid` / `failed` |

Path mode requires the path to resolve inside `TGDL_FACES_ALLOW_ROOTS`
(set by the spawn module to `data/downloads`). Base64 mode works without
an allow-root and is used automatically when path mode 403s.

## Related subsystem knobs

### Thumbs auto-generate toggle

`advanced.thumbs.autoOnDownload` (default `true`) controls whether a
WebP thumbnail is generated immediately after each successful download.
When `true`, the downloader calls `pregenerateThumb(id)` inline so the
first gallery scroll already finds the thumbnail in cache. Set to
`false` to defer generation to the on-demand path (the viewer creates
the thumb lazily on first request). The toggle has no effect on
bulk-regeneration from the Maintenance page.

### GPU scaler probe

The thumbnail and seekbar generators share a runtime probe that tests
whether the active ffmpeg binary supports GPU-resident scaling filters.
On first use the probe runs `ffmpeg -filters` and checks for
`scale_cuda` (NVIDIA), `scale_vaapi` (Intel/AMD on Linux), and
`vpp_qsv` (Intel Quick Sync). The result is cached for the process
lifetime.

When a GPU scaler filter is present, the full pipeline keeps decoded
frames on the GPU through the scale step (`-hwaccel <backend>
-hwaccel_output_format <backend>` + `scale_cuda=w=…` or
`scale_vaapi=w=…`), downloading to CPU only for the final software
WebP/JPEG encode. When the filter is absent — common in minimal ffmpeg
builds (Alpine/musl, Windows static binaries) or decode-only backends
like `videotoolbox` / `d3d11va` — the pipeline falls back to software
`scale=…:flags=fast_bilinear` while still using GPU-accelerated decode
where available.

No configuration is needed; the probe is transparent. The seekbar
module uses a variant pipeline (`hwaccelUploadPipeline`) that uploads
CPU-decoded frames to the GPU for scaling, necessary because fps/tile
filters run in software between decode and scale.

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

**Face scan stops with "face sidecar unavailable"** — the scan waited
`sidecarWaitMs` (default 5 min) for the sidecar and gave up. Nothing was
lost: files it hadn't scanned stay queued. Check the sidecar row of the
AI doctor: an unreachable external / custom URL, or a local sidecar that
couldn't be downloaded or started, shows its error there. Older releases
marked every photo "no faces" in this situation — including every stock
Docker install without the `faces` profile — so if an earlier scan
finished suspiciously fast with zero faces, run **Reindex** once the
sidecar is reachable.

**Sidecar health probe failing** — the spawn module relaunches after
3 consecutive failed probes (and immediately if the auto-spawned process
exits on its own). If the relaunch loop persists, the
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

**`EP Error … nvinfer_10.dll … missing (Error 126)`** — the TensorRT
runtime DLLs are not installed. This is a **non-fatal warning**; inference
continues on CUDA EP or CPU EP. Install TensorRT 10.x only if you
specifically need TRT EP (see [TensorRT EP (optional)](#tensorrt-ep-optional--cuda-ep-already-gives-full-gpu-speed) above). To suppress the
warning entirely, pin the provider explicitly:
```
TGDL_FACES_PROVIDERS=cuda    # or: cpu
```
or via **Maintenance → AI → Inference provider** → select **CUDA** or **CPU**.

**`Statement::JS_all` OOM** — should never happen for the faces table;
the scan-runner flows through streamed iterators. If you see one, it's
a regression — `scripts/check-oom-patterns.sh` should have caught it.
File a bug with the stack trace.

---

## NSFW Built-in Classifier

When no sidecar URL is set, the classifier runs on the app's CPU through onnxruntime-node, inside a worker thread so scans never block the web server. Images are decoded and resized to the model's input size by sharp before inference, and photos are classified in batches.

| Env var | Default | Description |
|---|---|---|
| `TGDL_NSFW_THREADS` | half the CPU threads, max 8 | Inference threads. Lower it to leave more CPU for downloads on small boxes |

The worker (and the model's memory) is released after 5 minutes without NSFW work and reloads from the on-disk cache on the next scan.

## NSFW External Sidecar (v2.20.0+)

The NSFW classifier can be offloaded to a remote GPU server, mirroring the faces sidecar pattern. When no URL is set, the built-in classifier above runs in-process (CPU).

### Setup

```bash
cd nsfw-service
pip install -r requirements.txt
python main.py                        # default: 0.0.0.0:8012
TGDL_NSFW_PORT=9000 python main.py    # custom port
```

Or run a published image (`nsfw-v*` releases):

```bash
# CPU (linux/amd64 + linux/arm64)
docker run -p 8012:8012 -v /path/to/downloads:/downloads:ro \
  -e TGDL_NSFW_ALLOW_ROOTS=/downloads ghcr.io/botnick/tgdl-nsfw:latest
# NVIDIA GPU (linux/amd64)
docker run --gpus all -p 8012:8012 ghcr.io/botnick/tgdl-nsfw:gpu-latest
```

`TGDL_NSFW_ALLOW_ROOTS` is only needed for path mode (the sidecar reading files directly); without it the app sends the images. To build locally instead: `docker build -f Dockerfile.gpu -t nsfw-sidecar .`

Running it on another machine (GPU box, Cloudflare Tunnel, reverse proxy with a path prefix): see [DEPLOY.md → Running a sidecar on another machine](DEPLOY.md#running-a-sidecar-on-another-machine).

### Configuration

| Config key | Env var | Default | Description |
|---|---|---|---|
| `advanced.nsfw.sidecarUrl` | `TGDL_NSFW_SIDECAR_URL` | `''` | External classifier URL (a reverse-proxy path prefix like `https://host/nsfw` is fine); empty = built-in classifier |
| `advanced.nsfw.apiToken` | `TGDL_NSFW_API_TOKEN` | `''` | Sent as `X-API-Token`; must match the sidecar's `TGDL_NSFW_API_TOKEN`. Write-only in the dashboard |
| `advanced.nsfw.pathMap` | `TGDL_NSFW_PATH_MAP` | `''` | `app path=sidecar path` rules (newline or `;`), for a sidecar that mounts the downloads at a different path |
| — (sidecar env) | `TGDL_NSFW_ALLOW_ROOTS` | `''` | Comma-separated directories the sidecar may read in path mode. Empty = path mode off (images are uploaded) |
| — (sidecar env) | `TGDL_NSFW_API_TOKEN` | `''` | Require this token on every route but `/health` (1.2.0+) |
| — (sidecar env) | `TGDL_NSFW_MAX_UPLOAD_MB` | `50` | Cap for `/classify/upload` bodies |

Env vars win over the dashboard values, one by one; the dashboard shows a notice when that happens.

Set via **Maintenance → NSFW → External classifier URL** in the dashboard, or via env var for Docker deployments.

### Endpoints (nsfw-service)

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | `{ok, model, ready, version, device, uptime_sec, features, auth_required, path_mode}` (always open) |
| `POST` | `/classify` | `{path \| image_b64}` → `{score, label}` |
| `POST` | `/classify/upload` | raw image bytes → `{score, label}` (1.2.0+) |
| `POST` | `/classify/batch` | `{files[]}` → `{results[]}` |

The Node client (`src/core/nsfw-client.js`) sends the path first (rewritten through the path map). A 403 (outside `TGDL_NSFW_ALLOW_ROOTS`) switches the session to sending image bytes; a `file_not_found` (the sidecar allows the path but doesn't have the file) sends just that image. Bytes go to `/classify/upload` when the sidecar lists the `upload` feature, as base64 JSON otherwise; images over 1.5 MB are downscaled to 1024 px first (the model looks at 224–384 px), which keeps requests far below proxy limits. Video tiles are always sent as bytes. A 401 is reported once in the log as a token problem.
