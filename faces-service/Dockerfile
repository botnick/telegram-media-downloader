# syntax=docker/dockerfile:1.7
#
# Multi-stage build for the tgdl-faces sidecar.
#
# Stage 1 ("builder") installs all Python deps + pre-downloads the
# buffalo_l weights into the per-user pip + insightface caches.
# Stage 2 ("runtime") copies the resolved /root/.local + model cache
# from the builder, drops the C/C++ toolchain, and ships only the
# runtime libraries.
#
# Target final image size: <=350 MB compressed (CPU variant).
#
# Build arg `FACES_EP_VARIANT` selects the onnxruntime variant:
#   "cpu"      → onnxruntime (default, ~350 MB image)
#   "gpu"      → onnxruntime-gpu (CUDA; ~700 MB; linux/amd64 only)
#   "openvino" → onnxruntime-openvino (Intel iGPU/dGPU; ~400 MB; linux/amd64)
#
# The DirectML variant is not built into a Linux image (DirectML is a
# Windows-only EP — operators on Windows use `pip install -e
# faces-service/[directml]` in a Python venv on the host). The CUDA
# variant requires the NVIDIA container runtime AND a host with
# nvidia-smi for GPU passthrough; without those it falls back to CPU
# at runtime with a warning.

ARG FACES_EP_VARIANT=cpu

# ---------------------------------------------------------------------------
# Stage 1 — builder
# ---------------------------------------------------------------------------
FROM python:3.12-slim-bookworm AS builder
ARG FACES_EP_VARIANT

# gcc / g++       — needed by transitive wheels that fall back to source
#                   builds on architectures without prebuilts (notably
#                   arm64 insightface helpers).
# libgl1          — OpenCV (opencv-python-headless still links libGL.so.1).
# libglib2.0-0    — GLib runtime, also pulled by OpenCV.
# ca-certificates — HTTPS to the insightface model mirror.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        gcc g++ \
        libgl1 libglib2.0-0 \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build

# Install Python deps first (separate from the source copy) so layer
# caching kicks in when only tgdl_faces/*.py changes. README.md must
# come along because pyproject.toml's `readme = "README.md"` is
# validated by hatchling at metadata-prep time.
COPY pyproject.toml README.md ./
COPY tgdl_faces ./tgdl_faces

# `--user` lays everything under /root/.local — the runtime stage just
# copies that directory verbatim instead of recreating a virtualenv.
# The variant arg picks which onnxruntime wheel pip resolves; the extras
# auto-uninstall the conflicting base `onnxruntime` package.
RUN if [ "$FACES_EP_VARIANT" = "gpu" ]; then \
        pip install --user --no-cache-dir ".[gpu]"; \
    elif [ "$FACES_EP_VARIANT" = "openvino" ]; then \
        pip install --user --no-cache-dir ".[openvino]"; \
    else \
        pip install --user --no-cache-dir .; \
    fi

# Pre-download buffalo_l (10MB-ish ONNX bundle, ~280 MB on disk after
# extraction) so the runtime image boots offline. Models land under
# /root/.cache/tgdl-faces/models/<model-name>/...; insightface auto-
# extracts the bundled .zip when `prepare()` runs.
ENV TGDL_FACES_MODELS_DIR=/root/.cache/tgdl-faces/models
RUN python -c "from insightface.app import FaceAnalysis; a = FaceAnalysis(name='buffalo_l', root='/root/.cache/tgdl-faces/models'); a.prepare(ctx_id=-1)"

# ---------------------------------------------------------------------------
# Stage 2 — runtime
# ---------------------------------------------------------------------------
FROM python:3.12-slim-bookworm AS runtime

# libgl1 + libglib2.0-0 stay (OpenCV runtime). gcc/g++ are deliberately
# dropped — runtime never compiles. wget powers the healthcheck.
# tini is PID 1, matches the main app's signal-handling posture.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        libgl1 libglib2.0-0 \
        ca-certificates \
        tini \
        wget \
    && rm -rf /var/lib/apt/lists/*

# Copy the resolved Python user-site + model cache from the builder.
COPY --from=builder /root/.local /root/.local
COPY --from=builder /root/.cache/tgdl-faces/models /root/.cache/tgdl-faces/models

WORKDIR /app
COPY tgdl_faces /app/tgdl_faces

ENV PATH="/root/.local/bin:${PATH}" \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    TGDL_FACES_HOST=0.0.0.0 \
    TGDL_FACES_PORT=8011 \
    TGDL_FACES_MODELS_DIR=/root/.cache/tgdl-faces/models

EXPOSE 8011

# 90s start_period leaves room for the first /detect to lazy-init
# insightface — /health itself is cheap, but the prepare() call inside
# get_app() on first detect can take a few seconds on arm64 / Pi.
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
    CMD wget -qO- http://localhost:8011/health || exit 1

LABEL org.opencontainers.image.title="tgdl-faces" \
      org.opencontainers.image.description="Face detection + 512-dim embedding sidecar for telegram-media-downloader" \
      org.opencontainers.image.source="https://github.com/botnick/telegram-media-downloader" \
      org.opencontainers.image.licenses="MIT" \
      com.centurylinklabs.watchtower.enable="true"

ENTRYPOINT ["/usr/bin/tini", "--", "python", "-m", "tgdl_faces"]
