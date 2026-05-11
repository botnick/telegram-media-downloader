# tgdl-faces

Face detection + 512-dim embedding HTTP sidecar for **telegram-media-downloader**.

Wraps the [insightface](https://github.com/deepinsight/insightface) `buffalo_l` model
(ArcFace, 512-dim, MIT-licensed) behind a tiny FastAPI service. The Node app talks to it
over HTTP, so the Node side carries no Python / native-binding burden — which means a
fresh `npm install` works uniformly on Windows, Linux, macOS, Raspberry Pi, and Synology
DSM. (The previous in-process stack used `@vladmandic/face-api` + `@tensorflow/tfjs-node`,
which has no prebuilt Node-22 binding for Windows.)

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
| `GET` | `/health` | — | `{ ok, version, model, dim, ready, error? }` (always 200) |
| `GET` | `/info` | — | `{ model, dim, providers, det_size, version }` |
| `GET` | `/providers` | — | `{ candidates[], available[], details[], recommended, current }` — onnxruntime backend probe |
| `POST` | `/detect` | `{ path \| image_b64, min_score?, min_box_px?, ar_range? }` | `{ faces[], image_w, image_h }` |
| `POST` | `/detect-embed` | _alias of `/detect` — same body, same response_ | — |

Errors are returned as `{ "error": "<text>", "code": "<machine_code>" }` with a stable
status code:

| Status | Code | Meaning |
|---|---|---|
| `400` | `bad_request` | Missing/invalid body — e.g. neither `path` nor `image_b64` supplied. |
| `403` | `path_not_allowed` | `path` falls outside `TGDL_FACES_ALLOW_ROOTS`. |
| `404` | `file_not_found` | `path` resolves to a missing or unreadable file. |
| `415` | `image_decode_failed` | The bytes weren't a recognisable image. |
| `500` | `detect_failed` | Unexpected model-side failure. |

`/health` deliberately never returns 5xx — the Node side polls it every 60s and a 5xx
flood is noisier than a `{ ok: false, error: ... }` payload. Consumers must inspect
`ok` rather than relying on the HTTP status alone.

## Environment

| Variable | Default | Purpose |
|---|---|---|
| `TGDL_FACES_HOST` | `127.0.0.1` | Bind address. Docker compose flips this to `0.0.0.0`. |
| `TGDL_FACES_PORT` | `8011` | TCP port. The Node auto-spawn path overrides this with a random high port. |
| `TGDL_FACES_MODELS_DIR` | `~/.cache/tgdl-faces/models` | Where insightface caches the buffalo_l weights. |
| `TGDL_FACES_ALLOW_ROOTS` | _empty_ | Comma-separated absolute paths the sidecar may read from. If empty, path-mode requests are rejected with 403; only base64 requests work. |
| `TGDL_FACES_LOG_LEVEL` | `INFO` | Standard Python `logging` level. |

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
python -m tgdl_faces
```

In a second terminal:

```bash
curl http://127.0.0.1:8011/health
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

## Tests

```bash
pytest
```

The suite covers:

* Validation: missing body fields, both `path` and `image_b64` supplied, etc.
* Path-traversal guard: requests outside `TGDL_FACES_ALLOW_ROOTS` return `403`.
* Image decoding: junk bytes / invalid base64 return `415`.
* `/health` and `/info` happy paths.

The "real face detection" assertion is intentionally **not** in the test suite — we
don't bundle a portrait image, and the heavy `buffalo_l` model weights aren't checked
into git. Tests that need the model to load (`/detect` happy path) are skipped
automatically when the model isn't available. The integration sweep that exercises
real detections lives in `tests/ai/faces-integration.test.js` on the Node side and runs
only when a sidecar URL is configured.

## Production binary

Track D of the rollout produces:

* **PyInstaller one-file binaries** per platform — uploaded as GitHub Release assets
  under tags `faces-v<X>`. The Node spawn module downloads and caches the right
  binary on first use.
* **Multi-arch container image** — `ghcr.io/botnick/tgdl-faces:<tag>` (and `:latest`),
  pulled by `docker compose --profile faces up`.

Neither build is produced from this README; see Track D's workflow at
`.github/workflows/release-faces-service.yml` once that ships.
