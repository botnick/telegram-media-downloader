"""tgdl_faces — Telegram Media Downloader face detection + embedding sidecar.

This package exposes a FastAPI service that wraps the
[insightface](https://github.com/deepinsight/insightface) `buffalo_l`
model (10MB, 512-dim ArcFace embeddings) behind a small HTTP API:

    GET  /health        — liveness + readiness
    GET  /info          — model card
    POST /detect        — detect & embed faces from a path or base64 blob
    POST /detect-embed  — alias of /detect (ergonomic name for the Node side)

The sidecar runs co-located with the Node app:

    * Standalone bare-metal — Node auto-spawns a PyInstaller binary
      on `127.0.0.1:<random port>` and shuttles JSON over HTTP.
    * Docker compose — a separate `tgdl-faces` container, with the Node
      app pointed at it via `FACES_SERVICE_URL`.

In both modes the sidecar replaces the in-process
`@vladmandic/face-api` + `@tensorflow/tfjs-node` stack, which has no
prebuilt wheels for Node 22 on Windows. Python wheels are uniformly
available across win_amd64, manylinux_x86_64/aarch64, macosx_x86_64,
and macosx_arm64.

The model upgrade (FaceNet 128-dim → buffalo_l 512-dim) is intentional
and lands as part of the rewrite; the Node clustering code is
dimension-agnostic, so callers see a `512`-element `embedding` instead
of `128` and otherwise behave identically.
"""

__version__ = "0.2.0"

__all__ = ["__version__"]
