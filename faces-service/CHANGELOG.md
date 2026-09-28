# tgdl-faces sidecar — changelog

Released as `faces-v<version>` tags (PyInstaller binaries on the GitHub
Release, images on `ghcr.io/botnick/tgdl-faces`). The Node app pins the
binary it downloads via `SIDECAR_VERSION` in `src/core/ai/faces-spawn.js`.

## 0.5.1

For sidecars on another host (GPU box, reverse proxy, Cloudflare Tunnel).

### Added
- `POST /detect/upload` takes the image as the raw request body (thresholds
  as query parameters: `min_score`, `min_box_px`, `ar_lo` + `ar_hi`) and
  answers like `/detect`. The app uses it instead of base64 JSON when the
  sidecar can't read its files — a quarter less data per photo and no JSON
  parsing of a multi-megabyte string. Capped by `TGDL_FACES_MAX_UPLOAD_MB`
  (default 64, 413 above it); needs the token like every other route.
- `/health` lists `features` and `max_upload_bytes`, so the app only uses
  what the sidecar supports (0.5.0 and older keep getting base64).

## 0.5.0

Faster and lighter on CPU, no change to the embedding model or its
preprocessing — embeddings stay compatible with rows written by 0.4.x, and
existing People groups keep clustering the same way.

### Performance
- **CPU thread budget.** onnxruntime sessions are sized from the CPU the
  process may actually use — cgroup quota (`docker --cpus`) and affinity,
  not `os.cpu_count()`, which reports every host core inside a container —
  split across the concurrent requests, with idle spinning off and OpenCV
  single-threaded. Pinned to 4 cores, per-image latency went from 22 s to
  0.9 s (Telegram-size group photo) because the old defaults ran ~24
  spinning threads per session on 4 CPUs. New env knobs:
  `TGDL_FACES_CPU_THREADS`, `TGDL_FACES_RESERVE_CPUS`,
  `TGDL_FACES_INTRA_OP_THREADS`, `TGDL_FACES_ORT_SPIN`. `/config` reports
  `effective_cpus`, `cpu_budget`, `intra_op_threads`.
- **Only the models that are used are loaded** (detection, recognition,
  3-D landmarks for the pose term of the quality score). buffalo_l's
  `2d106det` and `genderage` ran on every face and nothing read them.
- **Quality gate before embedding.** Faces below `min_score` /
  `min_box_px` / outside `ar_range` are dropped before the recognition and
  landmark models run, instead of after. Same output; a crowd shot whose
  faces are all too small went from seconds of per-face inference to one
  detector pass.
- **Bounded work in flight.** One process-wide admission gate
  (concurrency + 1 images) replaces a thread pool per batch request, so
  concurrent batches can't decode dozens of full-resolution images at
  once. Batch requests stop working on files once the client has
  disconnected.
- **Video frames are streamed** from the decoder and dropped after
  detection instead of holding the whole 120-frame sample (≈3 GB at 4K).
- `/health`, `/info`, `/config` are served on the event loop, so they
  answer instantly while every worker thread is busy.

### Fixed
- **The PyInstaller binary re-downloaded its own model.** It bundles
  buffalo_l, but the Node app points `TGDL_FACES_MODELS_DIR` at an empty
  `data/faces-service/models`, so the first load fetched ~280 MB again.
  The bundled pack is used while the configured directory has none.
- **EXIF-rotated photos were rotated twice.** `cv2.imdecode` already
  applies the Orientation tag (OpenCV ≥ 4.x, verified 4.10 and 4.13); the
  sidecar rotated again, so phone portraits reached the detector sideways
  and faces were missed. Decoding now ignores the tag and applies it once,
  for all eight orientations.

### Added
- Optional API token: with `TGDL_FACES_API_TOKEN` set, every endpoint
  except `/health` requires `Authorization: Bearer <token>` (or
  `X-API-Token`) and answers 401 otherwise. Unset = no auth, as before.
- Photo results carry `exif_oriented: true` (face boxes are in the
  displayed, EXIF-oriented frame), so the Node app can crop them
  correctly while keeping its old crop path for rows from older sidecars.
- Video faces carry `frame_time_sec`, the position of the frame the face
  was taken from, so face crops can seek to it.

### Images
- CUDA image (`:cuda-latest`, `:cuda-faces-v<version>`, linux/amd64) is
  now built and published by the release workflow. Its Dockerfile
  installs `onnxruntime-gpu` cleanly instead of alongside the CPU
  `onnxruntime` wheel (the two share a module and clobbered each other).
