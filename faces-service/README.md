# tgdl-faces

Face detection + 512-dim embedding HTTP sidecar for **telegram-media-downloader**.

Wraps the [insightface](https://github.com/deepinsight/insightface) `buffalo_l` model
(ArcFace, 512-dim, MIT-licensed) behind a tiny FastAPI service. The Node app talks to it
over HTTP, so the Node side carries no Python / native-binding burden — which means a
fresh `npm install` works uniformly on Windows, Linux, macOS, Raspberry Pi, and Synology
DSM.

End users never touch this directory directly. Two delivery paths cover every install:

1. **Standalone bare-metal** — the Node app downloads a prebuilt PyInstaller binary on
   first use and caches it under `data/faces-service/`. Each binary already bundles
   Python + onnxruntime + insightface + the buffalo_l weights.
2. **Docker compose** — `docker-compose.yml` adds a `tgdl-faces` sidecar service from
   the prebuilt multi-arch image `ghcr.io/botnick/tgdl-faces:<version>`.

This README is for contributors who want to run the sidecar from source.

## Endpoints

| Method | Path | Body | Response |
|---|---|---|---|
| `GET` | `/health` | — | seekbar-format health payload (always 200) |
| `GET` | `/config` | — | effective runtime configuration |
| `GET` | `/info` | — | `{ model, dim, providers, det_size, version, platform, arch }` |
| `GET` | `/providers` | — | onnxruntime backend probe with verified flags |
| `POST` | `/detect` | `{ path \| image_b64, min_score?, min_box_px?, ar_range? }` | `{ faces[], image_w, image_h }` |
| `POST` | `/detect-embed` | _alias of `/detect` — same body, same response_ | — |
| `POST` | `/detect/batch` | `{ files: string[], min_score?, min_box_px?, ar_range? }` | `{ results[], total_files, total_faces }` |

### `/health` response format

Matches the seekbar health response shape:

```json
{
  "ok": true,
  "service": "faces-service",
  "version": "0.1.0",
  "platform": "linux",
  "arch": "x86_64",
  "ready": true,
  "model": "buffalo_l",
  "gpu_provider": "cuda",
  "gpu_available": true,
  "providers": ["CUDAExecutionProvider", "CPUExecutionProvider"],
  "uptime_sec": 142.5,
  "stats": {
    "requests": 1234,
    "faces_detected": 5678,
    "errors": 2,
    "avg_ms": 45.2
  }
}
```

`ok` is `false` when the model failed to load; `ready` is `false` while the model is
still loading at startup. Consumers must check `ok`, not just the HTTP status — `/health`
always returns HTTP 200.

### Error payload shape

Non-2xx responses (and per-item batch errors) use:

```json
{ "error": "<human-readable>", "code": "<stable_machine_code>" }
```

| Status | Code | Meaning |
|---|---|---|
| `400` | `bad_request` | Missing/invalid body. |
| `403` | `path_not_allowed` | `path` falls outside `TGDL_FACES_ALLOW_ROOTS`. |
| `503` | `model_loading` | Model is still loading at startup — retry shortly. |
| `503` | `model_load_failed` | Model failed to load permanently. |
| `500` | `detect_failed` | Unexpected model-side failure. |

Certain errors return **HTTP 200** with an `error` field so the Node retry loop stays
cheap and doesn't log spurious 4xx/5xx entries:

| `error` value | Meaning |
|---|---|
| `file_not_found` | Path inside allow-roots but file is absent. |
| `decode_failed` | File exists but bytes aren't a recognisable image. |
| `path_not_allowed` | (batch only) path outside allow-roots, per-item. |

### `/detect/batch` example

```bash
curl -X POST http://127.0.0.1:8011/detect/batch \
    -H 'content-type: application/json' \
    -d '{"files": ["/abs/path/img1.jpg", "/abs/path/img2.jpg"]}'
```

```json
{
  "results": [
    {"file": "/abs/path/img1.jpg", "faces": [...], "image_w": 640, "image_h": 480, "error": null},
    {"file": "/abs/path/img2.jpg", "faces": [], "image_w": 0, "image_h": 0, "error": "file_not_found"}
  ],
  "total_files": 2,
  "total_faces": 3
}
```

## Environment

| Variable | Default | Purpose |
|---|---|---|
| `TGDL_FACES_HOST` | `127.0.0.1` | Bind address. Docker compose flips this to `0.0.0.0`. |
| `TGDL_FACES_PORT` | `8011` | TCP port. The Node auto-spawn path overrides with a random high port. |
| `TGDL_FACES_MODEL_DIR` / `TGDL_FACES_MODELS_DIR` | `~/.cache/tgdl-faces/models` | Where insightface caches the buffalo_l weights. Plural form wins when both are set. |
| `TGDL_FACES_ALLOW_ROOTS` | _empty_ | Comma-separated absolute paths the sidecar may read from. If empty, path-mode is rejected (403); only base64 works. |
| `TGDL_FACES_PROVIDERS` | `auto` | onnxruntime provider hint. Shorthand aliases: `auto`, `cpu`, `cuda`, `coreml`, `directml`, `openvino`. Or a comma-separated list of full provider names: `CUDAExecutionProvider,CPUExecutionProvider`. |
| `TGDL_FACES_DETECTOR_MODEL` | `buffalo_l` | insightface model pack name. |
| `TGDL_FACES_DET_SIZE` | `640` | Detector input size. `480` is the Pi 4 sweet spot. |
| `TGDL_FACES_MAX_CONCURRENCY` | `2` | Max parallel detection requests. Prevents OOM on burst traffic. |
| `TGDL_FACES_LOG_LEVEL` | `INFO` | Standard Python `logging` level. |

### GPU provider auto-detection (`TGDL_FACES_PROVIDERS=auto`)

| Platform | First-choice provider |
|---|---|
| Windows | `DmlExecutionProvider` (DirectML — works on any DX12 GPU) |
| Linux | `CUDAExecutionProvider` (falls back to CPU if no `nvidia-smi`) |
| macOS | `CoreMLExecutionProvider` |
| Other | `CPUExecutionProvider` |

## Dev setup

```bash
cd faces-service
python -m venv .venv
# Windows
.venv\Scripts\activate
# Unix / macOS
source .venv/bin/activate

pip install -e ".[test]"

# Auto-detect platform and install the matching onnxruntime EP
# (DirectML on Windows, CUDA on NVIDIA Linux, OpenVINO on Intel Linux,
# CoreML on macOS — uninstalls any conflicting wheel first).
python -m tgdl_faces.install        # or: tgdl-faces-install
# Flags: --dry-run | --force {cpu,gpu,directml,openvino} | --no-uninstall

# Run the sidecar on 127.0.0.1:8011
# The model pre-loads in a background thread — /health.ready becomes true
# a few seconds after startup.
python -m tgdl_faces
```

In a second terminal:

```bash
curl http://127.0.0.1:8011/health
curl http://127.0.0.1:8011/config
curl http://127.0.0.1:8011/info
```

For a path-mode `/detect`, first export an allow-root that contains the image:

```bash
# Linux/macOS
TGDL_FACES_ALLOW_ROOTS=/abs/path/to/test/images python -m tgdl_faces

# In another terminal
curl -X POST http://127.0.0.1:8011/detect \
    -H 'content-type: application/json' \
    -d '{"path": "/abs/path/to/test/images/portrait.jpg"}'
```

Base64 mode works without an allow-root (useful in Docker / when the Node and sidecar
processes don't share a filesystem):

```bash
B64=$(base64 -w0 < portrait.jpg)
curl -X POST http://127.0.0.1:8011/detect \
    -H 'content-type: application/json' \
    -d "{\"image_b64\": \"$B64\"}"
```

## Requirements files

| File | Use |
|---|---|
| `requirements.txt` | CPU-only (default) |
| `requirements-cuda.txt` | NVIDIA CUDA (Linux/Windows) |
| `requirements-directml.txt` | DirectML (Windows, any DX12 GPU) |

The onnxruntime variants share the `onnxruntime` module name and cannot coexist — install
only one per environment.

## Docker

### CPU variant (default)

```bash
docker build -t tgdl-faces .
docker run -p 8011:8011 tgdl-faces
```

### CUDA variant

```bash
docker build -f Dockerfile.cuda -t tgdl-faces:cuda .
docker run --runtime=nvidia --gpus all -p 8011:8011 tgdl-faces:cuda
```

### Pre-baked model cache

Both Dockerfiles download the buffalo_l weights at build time so the runtime image boots
offline. The model is stored at `/root/.cache/tgdl-faces/models` inside the container.

## Standalone binary (PyInstaller)

```bash
cd faces-service
bash build-pyinstaller.sh              # auto-detects variant
bash build-pyinstaller.sh --variant gpu --with-model   # CUDA + bundled weights
bash build-pyinstaller.sh --output-dir /tmp/out
```

Output: `dist/tgdl-faces-<platform>-<arch>[.exe]`

## Tests

```bash
pytest
```

The suite covers:

* Validation: missing body fields, both `path` and `image_b64` supplied, etc.
* Path-traversal guard: requests outside `TGDL_FACES_ALLOW_ROOTS` return 403.
* Image decoding: junk bytes / invalid base64 return the correct error.
* `/health` seekbar format: all required keys, correct types, stats shape.
* `/config` shape and required keys.
* `/detect/batch` per-item error handling.
* Provider resolution: platform-aware auto, explicit aliases, full provider names.
* Env var aliases: `TGDL_FACES_MODEL_DIR` (singular) accepted alongside plural form.

The "real face detection" assertion is intentionally **not** in the test suite — we
don't bundle a portrait image, and the heavy `buffalo_l` model weights aren't checked
into git. Tests that need the model to load (`/detect` happy path) are skipped
automatically when the model isn't available.
