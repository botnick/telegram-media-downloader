"""Thin wrapper around :class:`insightface.app.FaceAnalysis`.

The ``buffalo_l`` model bundle is loaded lazily on first use and cached
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
    onnxruntime execution-provider hint. One of ``auto`` (default),
    ``cpu``, ``cuda``, ``coreml``, ``directml``. The sidecar resolves
    the requested chain against whatever providers ``onnxruntime``
    reports as available on this platform and falls back to CPU if
    nothing else matches.

``TGDL_FACES_DET_SIZE``
    Detector input size (positive int). Default 640; 480 is the Pi 4
    sweet spot at a small recall cost.
"""

from __future__ import annotations

import logging
import math
import os
import platform
import sys
import threading
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
    raw = os.environ.get("TGDL_FACES_MODELS_DIR", "").strip()
    if raw:
        return Path(raw).expanduser().resolve()
    return (Path.home() / ".cache" / "tgdl-faces" / "models").resolve()


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


def _resolve_providers(requested: str = "auto") -> list[str]:
    """Resolve a requested provider chain against this binary's runtime.

    ``requested`` is case-insensitive. Unknown values are treated as
    ``auto``. The resolved chain is always non-empty — at minimum
    ``CPUExecutionProvider`` is appended, because every onnxruntime build
    ships it and the sidecar must boot even on the most stripped-down
    runtime.
    """
    key = (requested or "auto").strip().lower() or "auto"
    chain = _PROVIDER_CHAINS.get(key) or _PROVIDER_CHAINS["auto"]
    available = set(_available_providers())
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


def platform_tag() -> str:
    """Short ``<sys>/<arch>`` tag for the `/health` payload."""
    return f"{platform.system().lower()}/{platform.machine().lower()}"


def python_version() -> str:
    return f"{sys.version_info[0]}.{sys.version_info[1]}.{sys.version_info[2]}"


def get_app() -> Any:
    """Return the lazily-initialised :class:`FaceAnalysis` instance.

    First call pays the model-load cost. Subsequent calls reuse the
    same instance. Errors during initialisation are cached so callers
    get a fast 500 instead of repeatedly retrying a broken load.
    """

    global _APP, _APP_ERROR, _RESOLVED_PROVIDERS, _REQUESTED_PROVIDERS

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
            # GPU); -1 forces CPU. We use 0 whenever CUDA is in the
            # resolved chain because onnxruntime ignores ctx_id when the
            # provider isn't available, so this is safe on CPU-only too.
            ctx_id = 0 if "CUDAExecutionProvider" in providers else -1
            app.prepare(ctx_id=ctx_id, det_size=det_size)
            _APP = app
            try:
                live = getattr(app, "providers", None)
                if live:
                    _RESOLVED_PROVIDERS = list(live)
            except Exception:  # pragma: no cover — defensive
                pass
            _LOG.info(
                "%s ready (dim=%d, providers=%s)",
                MODEL_NAME,
                EMBEDDING_DIM,
                _RESOLVED_PROVIDERS,
            )
            return _APP
        except Exception as exc:  # pragma: no cover - exercised in prod
            _APP_ERROR = exc
            _LOG.exception("failed to initialise FaceAnalysis")
            raise


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

    app = get_app()
    raw = app.get(image_bgr)  # list[insightface.app.common.Face]

    h_img, w_img = int(image_bgr.shape[0]), int(image_bgr.shape[1])
    ar_lo, ar_hi = float(ar_range[0]), float(ar_range[1])
    out: list[dict[str, Any]] = []

    for face in raw or []:
        # `bbox` is [x1, y1, x2, y2] in float32.
        bbox = getattr(face, "bbox", None)
        if bbox is None or len(bbox) < 4:
            continue
        x1, y1, x2, y2 = (float(v) for v in bbox[:4])
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
        kps = getattr(face, "kps", None)
        if kps is None:
            kps = getattr(face, "landmark_2d_106", None)  # fallback
        landmarks: list[list[float]] = []
        if kps is not None:
            try:
                kps_arr = np.asarray(kps, dtype=np.float32).reshape(-1, 2)
                landmarks = [[float(p[0]), float(p[1])] for p in kps_arr]
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

    return out
