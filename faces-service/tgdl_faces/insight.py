"""Thin wrapper around :class:`insightface.app.FaceAnalysis`.

The ``buffalo_l`` model bundle is loaded eagerly at startup and cached
for the lifetime of the process. ``FaceAnalysis.prepare`` is *not* cheap
(~0.5 s on a modern desktop, several seconds on a Pi), so we keep the
singleton alive rather than re-creating it per request.

The module is deliberately small — quality filtering matches the rules
in ``src/core/ai/faces.js:qualityFilter`` on the Node side so the wire
format stays uniform regardless of which backend produced the
detections.

Tunables (environment variables):

``TGDL_FACES_DETECTOR_MODEL``
    Override the insightface model pack name. Defaults to ``buffalo_l``.
    Accepted values (every name supported by ``insightface.app.
    FaceAnalysis(name=…)`` works — these are the documented presets):

    * ``buffalo_l``  — balanced, ResNet50 backbone, 99.5% LFW (default)
    * ``antelopev2`` — best accuracy, ResNet100 + Glint360K, 99.6% LFW
    * ``buffalo_m``  — faster, ResNet50 smaller, 99.3% LFW
    * ``buffalo_s``  — fastest, ResNet34, 99.0% LFW
    * ``buffalo_sc`` — compact specialty preset

    Switching the model triggers an automatic re-cluster on next scan
    (embedding spaces differ across presets — the Node side's dim
    migration purges stale rows when the dim changes; for same-dim
    swaps the operator must click Re-cluster manually).

``TGDL_FACES_PROVIDERS``
    onnxruntime execution-provider hint. Comma-separated provider names
    (e.g. ``CUDAExecutionProvider,CPUExecutionProvider``) or one of the
    shorthand aliases: ``auto`` (default), ``cpu``, ``cuda``,
    ``coreml``, ``directml``, ``openvino``. The sidecar resolves the
    requested chain against whatever providers ``onnxruntime`` reports
    as available on this platform and falls back to CPU if nothing else
    matches.

``TGDL_FACES_DET_SIZE``
    Detector input size (positive int). Default 640; 480 is the Pi 4
    sweet spot at a small recall cost.

``TGDL_FACES_MODEL_DIR``
    Alias for ``TGDL_FACES_MODELS_DIR`` (singular form accepted for
    compatibility with the Node-side env var docs).

``TGDL_FACES_MAX_CONCURRENCY``
    Maximum number of detection requests processed in parallel (default 2).
    Prevents OOM on burst traffic by serialising excess requests.
"""

from __future__ import annotations

import logging
import math
import os
import platform
import sys
import threading
import time
from pathlib import Path
from typing import Any

import numpy as np


_LOG = logging.getLogger(__name__)

# Module-level singleton state — guarded by `_LOCK` so two parallel
# requests on uvicorn's thread pool don't double-initialise the model.
_APP: Any | None = None
_APP_ERROR: Exception | None = None
_LOCK = threading.Lock()
_RESOLVED_PROVIDERS: list[str] | None = None
_REQUESTED_PROVIDERS: str = "auto"
_GPU_PROVIDER: str = "cpu"  # short name reported in /health

# Process start time for uptime_sec calculation.
_START_TIME: float = time.monotonic()

# Stats counters — updated under _STATS_LOCK.
_STATS_LOCK = threading.Lock()
_STATS: dict[str, Any] = {
    "requests": 0,
    "faces_detected": 0,
    "errors": 0,
    "_total_ms": 0.0,  # private accumulator for avg_ms
}

# Semaphore controlling max parallel detections.  Initialised lazily from
# env so test code that never calls get_app() doesn't need a working value.
_CONCURRENCY_SEM: threading.Semaphore | None = None
_CONCURRENCY_LOCK = threading.Lock()

# Defaults that match the values the Node-side defaults pin in
# `manager.js`. The env layer reads `TGDL_FACES_DETECTOR_MODEL` /
# `TGDL_FACES_DET_SIZE` so deployments can flex these without rebuilding
# the PyInstaller binary.
DEFAULT_MODEL_NAME = "buffalo_l"
EMBEDDING_DIM = 512
DEFAULT_DET_SIZE = (640, 640)

# Public re-exports preserved for code that already imports `MODEL_NAME`
# and `DET_SIZE` (the FastAPI layer pulls these into its response models).
# `_resolve_model_name()` / `_resolve_det_size()` are the canonical
# accessors for code paths that need the env-aware value.
MODEL_NAME = os.environ.get("TGDL_FACES_DETECTOR_MODEL", "").strip() or DEFAULT_MODEL_NAME


def _resolve_det_size() -> tuple[int, int]:
    raw = os.environ.get("TGDL_FACES_DET_SIZE", "").strip()
    if not raw:
        return DEFAULT_DET_SIZE
    try:
        n = int(raw)
    except ValueError:
        _LOG.warning(
            "TGDL_FACES_DET_SIZE=%r is not an integer; using %s",
            raw,
            DEFAULT_DET_SIZE,
        )
        return DEFAULT_DET_SIZE
    if n <= 0 or n > 4096:
        _LOG.warning(
            "TGDL_FACES_DET_SIZE=%s is outside 1..4096; using %s",
            n,
            DEFAULT_DET_SIZE,
        )
        return DEFAULT_DET_SIZE
    return (n, n)


# Frozen at import for the FastAPI ``InfoResponse`` default; the
# environment-aware value is reported via the helpers below.
DET_SIZE = _resolve_det_size()


def _resolve_models_dir() -> Path:
    # Accept both singular (TGDL_FACES_MODEL_DIR) and plural forms for
    # compatibility; plural wins when both are set.
    raw = (
        os.environ.get("TGDL_FACES_MODELS_DIR", "").strip()
        or os.environ.get("TGDL_FACES_MODEL_DIR", "").strip()
    )
    if raw:
        return Path(raw).expanduser().resolve()
    return (Path.home() / ".cache" / "tgdl-faces" / "models").resolve()


def _resolve_max_concurrency() -> int:
    raw = os.environ.get("TGDL_FACES_MAX_CONCURRENCY", "2").strip()
    try:
        n = int(raw)
    except ValueError:
        return 2
    return max(1, n)


def _resolve_max_image_dim() -> int:
    """Return the maximum image dimension (longest edge) before downscaling.

    Set ``TGDL_FACES_MAX_IMAGE_DIM=0`` to disable the cap entirely (not
    recommended on memory-constrained devices).  Default is 2048.
    """
    raw = os.environ.get("TGDL_FACES_MAX_IMAGE_DIM", "2048").strip()
    try:
        n = int(raw)
    except ValueError:
        _LOG.warning(
            "TGDL_FACES_MAX_IMAGE_DIM=%r is not an integer; using 2048", raw
        )
        return 2048
    if n < 0:
        return 2048
    return n  # 0 means disabled


def _get_concurrency_sem() -> threading.Semaphore:
    """Return (and lazily create) the concurrency-limiting semaphore."""
    global _CONCURRENCY_SEM
    if _CONCURRENCY_SEM is not None:
        return _CONCURRENCY_SEM
    with _CONCURRENCY_LOCK:
        if _CONCURRENCY_SEM is None:
            _CONCURRENCY_SEM = threading.Semaphore(_resolve_max_concurrency())
    return _CONCURRENCY_SEM


_PROVIDER_CHAINS = {
    "auto": [
        "CUDAExecutionProvider",
        "CoreMLExecutionProvider",
        "DmlExecutionProvider",
        "OpenVINOExecutionProvider",
        "CPUExecutionProvider",
    ],
    "cpu": ["CPUExecutionProvider"],
    "cuda": ["CUDAExecutionProvider", "CPUExecutionProvider"],
    "coreml": ["CoreMLExecutionProvider", "CPUExecutionProvider"],
    "directml": ["DmlExecutionProvider", "CPUExecutionProvider"],
    "openvino": ["OpenVINOExecutionProvider", "CPUExecutionProvider"],
}


def _available_providers() -> list[str]:
    """Return the onnxruntime providers compiled into this binary.

    Imported lazily so the cheap endpoints (``/health`` pre-detect,
    ``/info``) don't pay the onnxruntime import cost when the model hasn't
    loaded yet — they fall back to ``CPUExecutionProvider`` which every
    onnxruntime build ships.
    """
    try:
        import onnxruntime  # noqa: PLC0415

        out = onnxruntime.get_available_providers()
        return list(out) if out else ["CPUExecutionProvider"]
    except Exception:  # pragma: no cover — guards against missing wheels
        return ["CPUExecutionProvider"]


def _platform_aware_auto_chain() -> list[str]:
    """Return provider preference order tuned to the current platform.

    - Windows:       DirectML first (works on any DX12 GPU), then CUDA, then CPU.
    - Linux x86_64:  CUDA first, then OpenVINO, then CPU.
    - Linux aarch64: Skip CUDA (no CUDA wheels for ARM64); use OpenVINO or CPU.
    - macOS:         CoreML first, then CPU.
    - Other:         generic order.
    """
    sysname = platform.system().lower()
    machine = platform.machine().lower()
    # Normalise ARM64 aliases so the aarch64 guard below matches everywhere.
    if machine in ("arm64", "aarch64"):
        machine = "aarch64"
    if sysname == "windows":
        return [
            "DmlExecutionProvider",
            "CUDAExecutionProvider",
            "OpenVINOExecutionProvider",
            "CPUExecutionProvider",
        ]
    if sysname == "darwin":
        return [
            "CoreMLExecutionProvider",
            "CPUExecutionProvider",
        ]
    if sysname == "linux" and machine == "aarch64":
        # CUDA is not available on ARM64 Linux (no NVIDIA wheels).
        # OpenVINO ARM plug-in exists but is rare; CPU is the safe fallback.
        return [
            "OpenVINOExecutionProvider",
            "CPUExecutionProvider",
        ]
    # Linux x86_64 / other
    return [
        "CUDAExecutionProvider",
        "OpenVINOExecutionProvider",
        "CoreMLExecutionProvider",
        "DmlExecutionProvider",
        "CPUExecutionProvider",
    ]


def _resolve_providers(requested: str = "auto") -> list[str]:
    """Resolve a requested provider chain against this binary's runtime.

    ``requested`` can be:
    - A shorthand alias (``auto``, ``cpu``, ``cuda``, ``coreml``,
      ``directml``, ``openvino``).
    - A comma-separated list of full onnxruntime provider names
      (e.g. ``CUDAExecutionProvider,CPUExecutionProvider``).
    - ``auto`` (default) — uses a platform-aware heuristic.

    The resolved chain is always non-empty — at minimum
    ``CPUExecutionProvider`` is appended, because every onnxruntime build
    ships it and the sidecar must boot even on the most stripped-down
    runtime.
    """
    raw = (requested or "auto").strip() or "auto"
    available = set(_available_providers())

    # If the value looks like explicit provider names (contains "Provider"),
    # treat it as a direct comma-separated list.
    if "Provider" in raw or "," in raw:
        chain = [p.strip() for p in raw.split(",") if p.strip()]
        resolved = [p for p in chain if p in available]
        if not resolved:
            resolved = ["CPUExecutionProvider"]
        return resolved

    key = raw.lower()
    if key == "auto":
        chain = _platform_aware_auto_chain()
    else:
        chain = _PROVIDER_CHAINS.get(key) or _platform_aware_auto_chain()

    resolved = [p for p in chain if p in available]
    if not resolved:
        resolved = ["CPUExecutionProvider"]
    return resolved


def resolved_providers() -> list[str]:
    """Return the providers actually picked at load time, or a best guess.

    Before ``get_app()`` has been called the model isn't loaded yet and we
    don't know which provider onnxruntime will end up choosing. In that
    pre-load state we report the resolved-but-not-yet-bound chain so the
    Node side can render *some* signal in the AI maintenance card. After
    ``get_app()`` succeeds the live ``FaceAnalysis.providers`` value is
    surfaced.
    """
    if _RESOLVED_PROVIDERS is not None:
        return list(_RESOLVED_PROVIDERS)
    return _resolve_providers(os.environ.get("TGDL_FACES_PROVIDERS", "auto"))


def requested_providers() -> str:
    """Return the raw `TGDL_FACES_PROVIDERS` env value (or 'auto')."""
    return _REQUESTED_PROVIDERS


def gpu_provider() -> str:
    """Return a short lowercase name for the active GPU provider.

    Maps the first non-CPU resolved provider to a compact label:
    ``cuda``, ``coreml``, ``directml``, ``openvino``, or ``cpu``.
    """
    return _GPU_PROVIDER


def gpu_available() -> bool:
    """Return True iff a non-CPU execution provider is active."""
    return _GPU_PROVIDER != "cpu"


def platform_tag() -> str:
    """Short platform string matching seekbar format (e.g. ``linux``)."""
    return platform.system().lower()


def arch_tag() -> str:
    """Machine architecture string (e.g. ``x86_64``, ``aarch64``)."""
    machine = platform.machine().lower()
    # Normalise common aliases.
    if machine in ("amd64",):
        return "x86_64"
    if machine in ("arm64",):
        return "aarch64"
    return machine


def python_version() -> str:
    return f"{sys.version_info[0]}.{sys.version_info[1]}.{sys.version_info[2]}"


def uptime_sec() -> float:
    """Seconds since the module was first imported (proxy for process age)."""
    return round(time.monotonic() - _START_TIME, 1)


def get_stats() -> dict[str, Any]:
    """Return a snapshot of request counters and average latency."""
    with _STATS_LOCK:
        reqs = _STATS["requests"]
        avg = (
            round(_STATS["_total_ms"] / reqs, 1)
            if reqs > 0
            else 0.0
        )
        return {
            "requests": reqs,
            "faces_detected": _STATS["faces_detected"],
            "errors": _STATS["errors"],
            "avg_ms": avg,
        }


def _record_request(faces_found: int, elapsed_ms: float, *, error: bool = False) -> None:
    """Update stats counters after a detection call."""
    with _STATS_LOCK:
        _STATS["requests"] += 1
        _STATS["faces_detected"] += faces_found
        _STATS["_total_ms"] += elapsed_ms
        if error:
            _STATS["errors"] += 1


def _derive_gpu_provider(providers: list[str]) -> str:
    """Derive the short GPU-provider label from the resolved provider list."""
    _PROVIDER_SHORT: dict[str, str] = {
        "CUDAExecutionProvider": "cuda",
        "CoreMLExecutionProvider": "coreml",
        "DmlExecutionProvider": "directml",
        "OpenVINOExecutionProvider": "openvino",
        "TensorrtExecutionProvider": "tensorrt",
    }
    for p in providers:
        short = _PROVIDER_SHORT.get(p)
        if short:
            return short
    return "cpu"


def get_app() -> Any:
    """Return the (eagerly pre-loaded) :class:`FaceAnalysis` instance.

    Model loading happens at startup via :func:`preload_model` called from
    ``__main__.py``. This function still guards against the lazy-load case
    (e.g. tests that call /detect directly) but in production the model is
    already loaded before the first request arrives.

    Errors during initialisation are cached so callers get a fast 503
    instead of repeatedly retrying a broken load.
    """

    global _APP, _APP_ERROR, _RESOLVED_PROVIDERS, _REQUESTED_PROVIDERS, _GPU_PROVIDER

    if _APP is not None:
        return _APP
    if _APP_ERROR is not None:
        raise _APP_ERROR

    with _LOCK:
        if _APP is not None:
            return _APP
        if _APP_ERROR is not None:
            raise _APP_ERROR

        try:
            # Imported inside the function so test code can run /health
            # without paying the insightface import cost.
            from insightface.app import FaceAnalysis  # noqa: PLC0415

            models_dir = _resolve_models_dir()
            models_dir.mkdir(parents=True, exist_ok=True)

            # insightface's auto-downloader unzips some bundles
            # (notably ``antelopev2``) into a nested directory:
            #
            #   models/<name>/<name>/{*.onnx}     ← wrong (extracted)
            #   models/<name>/{*.onnx}            ← what FaceAnalysis wants
            #
            # FaceAnalysis then throws AssertionError ("detection" not
            # in self.models) because it looks one level too shallow.
            # Detect + flatten before the model loader runs.
            target_dir = models_dir / "models" / MODEL_NAME
            nested = target_dir / MODEL_NAME
            if nested.is_dir():
                _LOG.info(
                    "flattening nested model dir %s -> %s",
                    nested,
                    target_dir,
                )
                for child in nested.iterdir():
                    dst = target_dir / child.name
                    if dst.exists():
                        continue
                    child.rename(dst)
                try:
                    nested.rmdir()
                except OSError:
                    pass

            requested = os.environ.get("TGDL_FACES_PROVIDERS", "auto").strip() or "auto"
            providers = _resolve_providers(requested)
            _REQUESTED_PROVIDERS = requested
            _RESOLVED_PROVIDERS = list(providers)

            det_size = _resolve_det_size()

            _LOG.info(
                "loading %s from %s (providers=%s requested=%s det_size=%s)",
                MODEL_NAME,
                models_dir,
                providers,
                requested,
                det_size,
            )
            app = FaceAnalysis(
                name=MODEL_NAME,
                root=str(models_dir),
                providers=providers,
            )
            # ctx_id picks the GPU index when CUDA is in play (0 = first
            # GPU); -1 forces CPU. We use 0 whenever a GPU provider is in
            # the resolved chain because onnxruntime ignores ctx_id when
            # the provider isn't available, so this is safe on CPU-only.
            gpu_providers = {
                "CUDAExecutionProvider",
                "DmlExecutionProvider",
                "CoreMLExecutionProvider",
                "OpenVINOExecutionProvider",
                "TensorrtExecutionProvider",
            }
            ctx_id = 0 if any(p in gpu_providers for p in providers) else -1
            app.prepare(ctx_id=ctx_id, det_size=det_size)
            _APP = app
            try:
                live = getattr(app, "providers", None)
                if live:
                    _RESOLVED_PROVIDERS = list(live)
            except Exception:  # pragma: no cover — defensive
                pass
            # Derive the short GPU-provider label from the final resolved list.
            _GPU_PROVIDER = _derive_gpu_provider(_RESOLVED_PROVIDERS or providers)
            _LOG.info(
                "%s ready (dim=%d, providers=%s gpu_provider=%s)",
                MODEL_NAME,
                EMBEDDING_DIM,
                _RESOLVED_PROVIDERS,
                _GPU_PROVIDER,
            )
            return _APP
        except Exception as exc:  # pragma: no cover - exercised in prod
            _APP_ERROR = exc
            _LOG.exception("failed to initialise FaceAnalysis")
            raise


def preload_model() -> None:
    """Eagerly load the model in a background thread at startup.

    Called from ``__main__.py`` so the first ``/detect`` request doesn't
    pay the 0.5–5 s model-load cost. Errors are captured to ``_APP_ERROR``
    and surfaced via ``/health`` — they do not crash the process.
    """
    def _load() -> None:
        try:
            get_app()
        except Exception:
            # Already logged + stored in _APP_ERROR inside get_app().
            pass

    t = threading.Thread(target=_load, name="faces-preload", daemon=True)
    t.start()


def is_ready() -> bool:
    """Return True iff :func:`get_app` has succeeded at least once.

    Used by ``GET /health`` so the Node side can show "warming up"
    instead of "broken" while the model is still loading.
    """
    return _APP is not None


def last_error() -> Exception | None:
    """Return the cached init error, if any. ``None`` once loaded."""
    return _APP_ERROR


def _l2_normalise(vec: np.ndarray) -> np.ndarray:
    """Return ``vec`` rescaled to unit L2 norm.

    The insightface `normed_embedding` attribute is already
    L2-normalised, but we recompute defensively — a zero vector would
    otherwise produce NaNs that poison the DBSCAN distance metric on
    the Node side.
    """
    arr = np.asarray(vec, dtype=np.float32).reshape(-1)
    norm = float(np.linalg.norm(arr))
    if norm <= 1e-9 or not math.isfinite(norm):
        return arr
    return (arr / norm).astype(np.float32, copy=False)


def detect_and_embed(
    image_bgr: np.ndarray,
    *,
    min_score: float = 0.5,
    min_box_px: int = 80,
    ar_range: tuple[float, float] = (0.5, 2.0),
    _track_stats: bool = True,
) -> list[dict[str, Any]]:
    """Detect every face in ``image_bgr`` and return cleaned-up records.

    Parameters
    ----------
    image_bgr
        H×W×3 ``uint8`` numpy array in BGR order (the layout cv2
        produces). Pre-normalised colour shifts will degrade
        detector recall, so callers should pass the raw decoder
        output untouched.
    min_score
        Detector confidence floor. Matches the Node-side default
        in ``faces.js:FACE_DEFAULTS.minDetectionScore`` (0.5).
    min_box_px
        Reject faces whose smaller edge is below this pixel count.
        Matches ``faces.js:qualityFilter`` (80 px).
    ar_range
        ``(lo, hi)`` aspect-ratio window. Real faces hover around
        1.0; extreme ratios are almost always false positives on
        non-face textures (window frames, chair legs).

    Returns
    -------
    list of dict
        Each entry has the shape consumed by the Node client:

        ``{ "x": int, "y": int, "w": int, "h": int,
            "score": float, "embedding": list[float] (len=512),
            "landmarks": list[list[float, float]] (len=5) }``

        Coordinates are integer pixel offsets clamped to the image
        bounds; the embedding is L2-normalised and serialised as a
        plain Python list (JSON-friendly).
    """

    if not isinstance(image_bgr, np.ndarray):
        raise TypeError("image_bgr must be a numpy.ndarray")
    if image_bgr.ndim != 3 or image_bgr.shape[2] != 3:
        raise ValueError("image_bgr must be H×W×3 (BGR)")

    _t0 = time.monotonic()
    _sem = _get_concurrency_sem()
    _sem.acquire()
    _error_flag = False
    out: list[dict[str, Any]] = []
    try:
        app = get_app()

        # --- Dimension cap: resize large images before detection to prevent OOM ---
        # When TGDL_FACES_MAX_IMAGE_DIM > 0, images with a longest edge exceeding
        # the cap are downscaled proportionally. Bboxes and landmarks are scaled
        # back to the original image coordinates before being returned, so callers
        # always receive pixel offsets relative to the original image.
        h_orig, w_orig = int(image_bgr.shape[0]), int(image_bgr.shape[1])
        max_dim = _resolve_max_image_dim()
        scale: float = 1.0
        detect_img = image_bgr
        if max_dim > 0 and max(h_orig, w_orig) > max_dim:
            scale = max_dim / max(h_orig, w_orig)
            new_w = max(1, int(round(w_orig * scale)))
            new_h = max(1, int(round(h_orig * scale)))
            import cv2 as _cv2  # noqa: PLC0415
            detect_img = _cv2.resize(image_bgr, (new_w, new_h), interpolation=_cv2.INTER_AREA)
            _LOG.debug(
                "resized %dx%d → %dx%d (scale=%.4f) for detection",
                w_orig, h_orig, new_w, new_h, scale,
            )

        raw = app.get(detect_img)  # list[insightface.app.common.Face]

        h_img, w_img = h_orig, w_orig  # report original dimensions
        ar_lo, ar_hi = float(ar_range[0]), float(ar_range[1])

        for face in raw or []:
            # `bbox` is [x1, y1, x2, y2] in float32 (in detect_img coords).
            bbox = getattr(face, "bbox", None)
            if bbox is None or len(bbox) < 4:
                continue
            # Scale bbox back to original image coordinates when a resize occurred.
            x1 = float(bbox[0]) / scale
            y1 = float(bbox[1]) / scale
            x2 = float(bbox[2]) / scale
            y2 = float(bbox[3]) / scale
            x = max(0, int(round(x1)))
            y = max(0, int(round(y1)))
            w = max(0, int(round(x2 - x1)))
            h = max(0, int(round(y2 - y1)))
            # Clamp to image so downstream crop code can't read out of bounds.
            if x + w > w_img:
                w = max(0, w_img - x)
            if y + h > h_img:
                h = max(0, h_img - y)

            score = float(getattr(face, "det_score", 0.0) or 0.0)
            if score < float(min_score):
                continue
            if min(w, h) < int(min_box_px):
                continue
            ratio = (w / h) if h > 0 else 0.0
            if ratio < ar_lo or ratio > ar_hi:
                continue

            # Prefer the pre-normalised embedding when insightface provides
            # it; otherwise fall back to the raw `embedding` field.
            emb_raw = getattr(face, "normed_embedding", None)
            if emb_raw is None:
                emb_raw = getattr(face, "embedding", None)
            if emb_raw is None:
                # No descriptor — useless for clustering; skip.
                continue
            emb = _l2_normalise(np.asarray(emb_raw, dtype=np.float32))
            if emb.shape[0] != EMBEDDING_DIM:
                # Defensive: if a future model swap returns a different
                # dim, refuse rather than silently mixing dimensions in the
                # downstream DBSCAN.
                raise RuntimeError(
                    f"embedding dim mismatch: got {emb.shape[0]}, expected {EMBEDDING_DIM}"
                )

            # 5-point landmarks (eye-L, eye-R, nose, mouth-L, mouth-R).
            # Scale back to original image coordinates when a resize occurred.
            kps = getattr(face, "kps", None)
            if kps is None:
                kps = getattr(face, "landmark_2d_106", None)  # fallback
            landmarks: list[list[float]] = []
            if kps is not None:
                try:
                    kps_arr = np.asarray(kps, dtype=np.float32).reshape(-1, 2)
                    landmarks = [
                        [float(p[0]) / scale, float(p[1]) / scale]
                        for p in kps_arr
                    ]
                except (ValueError, TypeError):
                    landmarks = []

            out.append(
                {
                    "x": x,
                    "y": y,
                    "w": w,
                    "h": h,
                    "score": score,
                    "embedding": emb.tolist(),
                    "landmarks": landmarks,
                }
            )

    except Exception:
        _error_flag = True
        raise
    finally:
        _sem.release()
        if _track_stats:
            _record_request(
                0 if _error_flag else len(out),
                (time.monotonic() - _t0) * 1000,
                error=_error_flag,
            )

    return out
