# tgdl-faces sidecar — changelog

Released as `faces-v<version>` tags (PyInstaller binaries on the GitHub
Release, images on `ghcr.io/botnick/tgdl-faces`). The Node app pins the
binary it downloads via `SIDECAR_VERSION` in `src/core/ai/faces-spawn.js`.

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
- **EXIF-rotated photos were rotated twice.** `cv2.imdecode` already
  applies the Orientation tag (OpenCV ≥ 4.x, verified 4.10 and 4.13); the
  sidecar rotated again, so phone portraits reached the detector sideways
  and faces were missed. Decoding now ignores the tag and applies it once,
  for all eight orientations.

### Added
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
