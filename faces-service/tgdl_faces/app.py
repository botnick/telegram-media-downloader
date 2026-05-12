"""FastAPI app exposing the face detection + embedding HTTP API.

Endpoints (see ``docs/AI.md`` on the Node side for the full contract):

* ``GET /health``         — liveness + readiness; matches seekbar health format.
* ``GET /config``         — effective configuration (model, providers, concurrency).
* ``GET /info``           — model card (name, dim, providers, det_size, version).
* ``GET /providers``      — probe every onnxruntime backend and report usability.
* ``POST /detect``        — detect & embed faces from a path or base64 blob.
* ``POST /detect-embed``  — alias of ``/detect``.
* ``POST /detect/batch``  — batch variant accepting multiple file paths.

Error payload shape (used by every non-2xx response):

    { "error": "<human-readable>", "code": "<stable_machine_code>" }

The Node client switches on ``code``; the human text is for logs.
"""

from __future__ import annotations

import logging
import os
import time
from typing import Annotated, Any

import numpy as np
from fastapi import FastAPI, Request, Response, status
from fastapi.concurrency import run_in_threadpool
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, model_validator

from . import __version__
from .insight import (
    DET_SIZE,
    EMBEDDING_DIM,
    MODEL_NAME,
    arch_tag,
    detect_and_embed,
    get_app,  # returns the FaceAnalysis singleton — used only in /info to read live providers
    get_stats,
    gpu_available,
    gpu_provider,
    is_ready,
    last_error,
    platform_tag,
    python_version,
    requested_providers,
    resolved_providers,
    uptime_sec,
    _resolve_max_concurrency,
    _resolve_models_dir,
)
from .io import (
    Base64DecodeError,
    ImageDecodeError,
    PathNotAllowedError,
    load_image_from_b64,
    load_image_from_path,
)


_LOG = logging.getLogger(__name__)


# --- request / response models ---------------------------------------------


class DetectRequest(BaseModel):
    """Body shared by ``/detect`` and ``/detect-embed``.

    Exactly one of ``path`` and ``image_b64`` must be set. ``min_score``,
    ``min_box_px`` and ``ar_range`` are optional knobs that mirror the
    Node-side ``qualityFilter`` defaults so requests can be tightened
    without redeploying the sidecar.
    """

    path: str | None = Field(
        default=None,
        description=(
            "Absolute path to an image on disk. Must resolve under "
            "TGDL_FACES_ALLOW_ROOTS or the request 403s."
        ),
    )
    image_b64: str | None = Field(
        default=None,
        description=(
            "Base64-encoded image bytes. Tolerates a leading "
            "`data:image/...;base64,` prefix. Mutually exclusive with `path`."
        ),
    )
    min_score: float | None = Field(
        default=None,
        ge=0.0,
        le=1.0,
        description="Detector score floor; defaults to 0.5.",
    )
    min_box_px: int | None = Field(
        default=None,
        ge=1,
        description="Reject boxes smaller than this on the shorter edge; default 80.",
    )
    ar_range: tuple[float, float] | None = Field(
        default=None,
        description="Aspect-ratio window (lo, hi); default (0.5, 2.0).",
    )

    @model_validator(mode="after")
    def _exactly_one_source(self) -> DetectRequest:
        has_path = bool(self.path and self.path.strip())
        has_b64 = bool(self.image_b64 and self.image_b64.strip())
        if has_path == has_b64:
            raise ValueError(
                "exactly one of `path` or `image_b64` is required"
            )
        if self.ar_range is not None:
            lo, hi = float(self.ar_range[0]), float(self.ar_range[1])
            if lo <= 0 or hi <= 0 or lo >= hi:
                raise ValueError("ar_range must be (lo, hi) with 0 < lo < hi")
        return self


class BatchDetectRequest(BaseModel):
    """Body for ``POST /detect/batch``.

    ``files`` is a list of absolute paths on disk. All paths are subject to
    the same ``TGDL_FACES_ALLOW_ROOTS`` allow-list as the single-path
    ``/detect`` endpoint. Invalid or unreadable entries produce per-item
    ``error`` fields rather than aborting the whole batch.
    """

    files: list[str] = Field(
        ...,
        min_length=1,
        description="List of absolute paths to process.",
    )
    min_score: float | None = Field(default=None, ge=0.0, le=1.0)
    min_box_px: int | None = Field(default=None, ge=1)
    ar_range: tuple[float, float] | None = Field(default=None)

    @model_validator(mode="after")
    def _validate_ar_range(self) -> BatchDetectRequest:
        if self.ar_range is not None:
            lo, hi = float(self.ar_range[0]), float(self.ar_range[1])
            if lo <= 0 or hi <= 0 or lo >= hi:
                raise ValueError("ar_range must be (lo, hi) with 0 < lo < hi")
        return self


class Face(BaseModel):
    """Single-face response record. Coordinates are integer pixel offsets."""

    x: int
    y: int
    w: int
    h: int
    score: float
    embedding: list[float] = Field(
        ...,
        description=f"L2-normalised {EMBEDDING_DIM}-dim float vector",
    )
    landmarks: list[list[float]] = Field(
        default_factory=list,
        description="5-point facial landmarks: [eye_l, eye_r, nose, mouth_l, mouth_r]",
    )


class DetectResponse(BaseModel):
    faces: list[Face]
    image_w: int
    image_h: int


class BatchDetectItem(BaseModel):
    """Single result entry within a ``/detect/batch`` response."""

    file: str
    faces: list[Face] = Field(default_factory=list)
    image_w: int = 0
    image_h: int = 0
    error: str | None = None


class BatchDetectResponse(BaseModel):
    results: list[BatchDetectItem]
    total_files: int
    total_faces: int


# --- FastAPI app ------------------------------------------------------------


app = FastAPI(
    title="tgdl-faces",
    version=__version__,
    description=(
        "Face detection + 512-dim embedding sidecar for "
        "telegram-media-downloader. Backed by insightface buffalo_l."
    ),
)


def _allow_roots() -> list[str]:
    raw = os.environ.get("TGDL_FACES_ALLOW_ROOTS", "")
    return [p.strip() for p in raw.split(",") if p and p.strip()]


def _error(message: str, code: str, status_code: int) -> JSONResponse:
    return JSONResponse(
        status_code=status_code,
        content={"error": message, "code": code},
    )


@app.middleware("http")
async def _request_logging(
    request: Request,
    call_next: Any,
) -> Response:
    start = time.monotonic()
    method = request.method
    path = request.url.path
    try:
        response = await call_next(request)
    except Exception:
        elapsed_ms = (time.monotonic() - start) * 1000
        _LOG.exception(
            "[tgdl-faces] %s %s failed after %.1f ms", method, path, elapsed_ms
        )
        raise
    elapsed_ms = (time.monotonic() - start) * 1000
    _LOG.info(
        "[tgdl-faces] %s %s -> %d (%.1f ms)",
        method,
        path,
        response.status_code,
        elapsed_ms,
    )
    return response


# --- exception handlers -----------------------------------------------------


@app.exception_handler(RequestValidationError)
async def _validation_handler(
    _request: Request, exc: RequestValidationError
) -> JSONResponse:
    # Pydantic turns the model_validator's ValueError into a structured
    # error list; surface the first message so the Node client gets a
    # clean string instead of the full schema dump.
    try:
        first = exc.errors()[0]
        msg = first.get("msg") or "validation error"
    except (IndexError, KeyError, AttributeError):
        msg = "validation error"
    return _error(msg, code="bad_request", status_code=status.HTTP_400_BAD_REQUEST)


@app.exception_handler(Base64DecodeError)
async def _base64_decode_handler(
    _request: Request, exc: Base64DecodeError
) -> JSONResponse:
    """Invalid base64 syntax from the caller — 415 Unsupported Media Type."""
    return _error(str(exc), code="image_decode_failed", status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE)


# --- routes -----------------------------------------------------------------


@app.get("/health")
def health() -> JSONResponse:
    """Liveness + readiness probe matching the seekbar health response format.

    Always returns HTTP 200 — the Node-side polling loop must inspect
    the ``ok`` flag rather than the HTTP status to determine real health.
    The ``stats`` block surfaces request counters and average latency.
    """
    err = last_error()
    if err is not None:
        return JSONResponse(
            status_code=status.HTTP_200_OK,
            content={
                "ok": False,
                "service": "faces-service",
                "version": __version__,
                "platform": platform_tag(),
                "arch": arch_tag(),
                "ready": False,
                "model": MODEL_NAME,
                "gpu_provider": gpu_provider(),
                "gpu_available": gpu_available(),
                "providers": resolved_providers(),
                "uptime_sec": uptime_sec(),
                "error": f"{type(err).__name__}: {err}",
                "stats": get_stats(),
            },
        )
    return JSONResponse(
        status_code=status.HTTP_200_OK,
        content={
            "ok": True,
            "service": "faces-service",
            "version": __version__,
            "platform": platform_tag(),
            "arch": arch_tag(),
            "ready": is_ready(),
            "model": MODEL_NAME,
            "gpu_provider": gpu_provider(),
            "gpu_available": gpu_available(),
            "providers": resolved_providers(),
            "uptime_sec": uptime_sec(),
            "stats": get_stats(),
        },
    )


@app.get("/config")
def config() -> JSONResponse:
    """Return the effective runtime configuration.

    Useful for operators to verify env vars are applied correctly without
    digging into the process environment. The ``model_dir`` field shows
    where the buffalo_l weights are cached.
    """
    return JSONResponse(
        status_code=status.HTTP_200_OK,
        content={
            "model": MODEL_NAME,
            "det_size": int(DET_SIZE[0]),
            "providers_requested": requested_providers(),
            "providers_resolved": resolved_providers(),
            "gpu_provider": gpu_provider(),
            "gpu_available": gpu_available(),
            "max_concurrency": _resolve_max_concurrency(),
            "model_dir": str(_resolve_models_dir()),
            "allow_roots": _allow_roots(),
            "host": os.environ.get("TGDL_FACES_HOST", "127.0.0.1"),
            "port": int(os.environ.get("TGDL_FACES_PORT", "8011")),
            "log_level": os.environ.get("TGDL_FACES_LOG_LEVEL", "INFO").upper(),
            "version": __version__,
            "python": python_version(),
            "platform": platform_tag(),
            "arch": arch_tag(),
        },
    )


@app.get("/info")
def info() -> JSONResponse:
    """Static model card. Cheap; used by the Node side at boot."""
    providers = resolved_providers()
    # If the model has already been loaded, prefer the live FaceAnalysis
    # providers (buffalo_l can downgrade from CUDA to CPU mid-init if a
    # driver mismatch surfaces).
    if is_ready():
        try:
            inner = get_app()
            real = getattr(inner, "providers", None)
            if real:
                providers = list(real)
        except Exception:  # pragma: no cover — defensive
            pass
    return JSONResponse(
        status_code=status.HTTP_200_OK,
        content={
            "model": MODEL_NAME,
            "dim": EMBEDDING_DIM,
            "providers": providers,
            "providers_requested": requested_providers(),
            "det_size": int(DET_SIZE[0]),
            "version": __version__,
            "platform": platform_tag(),
            "arch": arch_tag(),
            "python": python_version(),
        },
    )


@app.get("/providers")
def providers() -> JSONResponse:
    """List every onnxruntime provider available on the host, plus a
    ``verified`` flag for each one.

    Mirrors the ``ffmpeg -init_hw_device <name>=hw`` probe in
    ``src/core/thumbs.js`` on the Node side: ``onnxruntime`` will happily
    list a provider that's compiled in but unusable on this host (missing
    driver, CUDA toolkit not visible, etc.), so each candidate gets a
    standalone session-creation test before it's reported as usable.

    Each provider probe is wrapped in its own ``try`` so one failing
    backend doesn't crash the entire response — the UI needs ``CPU`` to
    surface even when CUDA blows up.
    """
    try:
        import onnxruntime as ort
    except Exception as exc:  # pragma: no cover — onnxruntime is required
        return JSONResponse(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            content={"error": f"onnxruntime not importable: {exc}",
                     "code": "onnxruntime_missing"},
        )

    try:
        candidates = list(ort.get_available_providers())
    except Exception as exc:  # pragma: no cover — defensive
        return JSONResponse(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            content={"error": f"get_available_providers failed: {exc}",
                     "code": "providers_query_failed"},
        )

    # Build a tiny one-op model in-memory so each provider gets a real
    # session-creation test. Compiling once outside the loop keeps the
    # probe cheap (under 100 ms total on a 4-backend Windows host).
    probe_model: bytes | None = None
    try:
        import onnx
        from onnx import helper, TensorProto

        graph = helper.make_graph(
            [helper.make_node("Identity", ["x"], ["y"])],
            "probe",
            [helper.make_tensor_value_info("x", TensorProto.FLOAT, [1])],
            [helper.make_tensor_value_info("y", TensorProto.FLOAT, [1])],
        )
        model = helper.make_model(graph)
        # ir_version 9 + opset 17 are broadly compatible with every
        # onnxruntime build we ship.
        model.ir_version = 9
        opset = onnx.OperatorSetIdProto()
        opset.version = 17
        del model.opset_import[:]
        model.opset_import.append(opset)
        probe_model = model.SerializeToString()
    except Exception as exc:  # pragma: no cover — onnx ships with onnxruntime today
        _LOG.warning("onnx model builder unavailable: %s", exc)

    details: list[dict[str, Any]] = []
    for name in candidates:
        verified = False
        error: str | None = None
        if probe_model is None:
            # Fall back to a session-creation-only test on the resolver
            # — better than nothing if `onnx` isn't importable.
            try:
                ort.SessionOptions()
                verified = True
            except Exception as exc:
                error = f"{type(exc).__name__}: {exc}"[:200]
        else:
            try:
                sess = ort.InferenceSession(
                    probe_model,
                    sess_options=ort.SessionOptions(),
                    providers=[name],
                )
                # Confirm the chosen provider was actually accepted —
                # onnxruntime silently downgrades to CPU when the
                # requested provider can't be allocated.
                live = list(sess.get_providers()) if sess else []
                if name in live:
                    sess.run(None, {"x": np.array([1.0], dtype=np.float32)})
                    verified = True
                else:
                    error = (
                        f"requested {name} but onnxruntime allocated "
                        f"{live[:3]}"
                    )[:200]
            except Exception as exc:
                error = f"{type(exc).__name__}: {exc}"[:200]
        details.append({"name": name, "verified": verified, "error": error})

    # Recommended provider — first verified GPU backend, else CPU.
    gpu_order = (
        "CUDAExecutionProvider",
        "CoreMLExecutionProvider",
        "DmlExecutionProvider",
        "OpenVINOExecutionProvider",
    )
    recommended: str | None = next(
        (p["name"] for p in details if p["verified"] and p["name"] in gpu_order),
        None,
    )
    if not recommended:
        recommended = next(
            (p["name"] for p in details
             if p["verified"] and p["name"] == "CPUExecutionProvider"),
            None,
        )

    return JSONResponse(
        status_code=status.HTTP_200_OK,
        content={
            "candidates": [p["name"] for p in details],
            "available": [p["name"] for p in details if p["verified"]],
            "details": details,
            "recommended": recommended,
            "current": resolved_providers(),
            "requested": requested_providers(),
        },
    )


def _load_image(body_path: str | None, body_b64: str | None) -> tuple[Any, str | None]:
    """Load an image from path or base64, returning (img, error_code).

    Returns ``(None, error_code)`` on any load failure so callers can
    produce well-typed error responses without catching exceptions.
    ``error_code`` is one of ``file_not_found``, ``decode_failed``,
    ``path_not_allowed``.

    ``Base64DecodeError`` is intentionally *not* caught here — it
    propagates to the global exception handler which returns 415, matching
    the test contract: invalid base64 syntax is a client error (415),
    while valid-bytes-but-not-an-image is a soft error (200 + decode_failed).
    """
    try:
        if body_path:
            img = load_image_from_path(body_path, _allow_roots())
        else:
            assert body_b64 is not None
            img = load_image_from_b64(body_b64)
        return img, None
    except PathNotAllowedError:
        return None, "path_not_allowed"
    except FileNotFoundError:
        return None, "file_not_found"
    except Base64DecodeError:
        raise  # let the global 415 handler deal with it
    except ImageDecodeError:
        return None, "decode_failed"


def _do_detect_sync(body: DetectRequest) -> JSONResponse:
    """Synchronous inner implementation — called via run_in_threadpool.

    Separated from the async route handler so the CPU-bound work runs in
    uvicorn's thread pool instead of blocking the event loop.
    """
    # Guard: model must be loaded (or at least attempted). Return 503
    # during the brief window while preload_model() is still running.
    if last_error() is not None:
        return _error(
            f"model failed to load: {last_error()}",
            code="model_load_failed",
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        )
    if not is_ready():
        # Still loading in the background.
        return _error(
            "model is still loading, retry shortly",
            code="model_loading",
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        )

    img, err_code = _load_image(body.path, body.image_b64)
    if img is None:
        assert err_code is not None
        if err_code == "path_not_allowed":
            return _error(
                "path falls outside TGDL_FACES_ALLOW_ROOTS",
                code="path_not_allowed",
                status_code=status.HTTP_403_FORBIDDEN,
            )
        if err_code == "file_not_found":
            return JSONResponse(
                status_code=status.HTTP_200_OK,
                content={"faces": [], "error": "file_not_found"},
            )
        # decode_failed
        return JSONResponse(
            status_code=status.HTTP_200_OK,
            content={"faces": [], "error": "decode_failed"},
        )

    # Build the filter kwargs without overwriting defaults when the
    # caller didn't supply them — keeps the wire format compact for the
    # common case (Node defers everything to the sidecar defaults).
    kwargs: dict[str, Any] = {}
    if body.min_score is not None:
        kwargs["min_score"] = float(body.min_score)
    if body.min_box_px is not None:
        kwargs["min_box_px"] = int(body.min_box_px)
    if body.ar_range is not None:
        kwargs["ar_range"] = (float(body.ar_range[0]), float(body.ar_range[1]))

    try:
        faces = detect_and_embed(img, **kwargs)
    except Exception as exc:  # pragma: no cover — guarded for prod
        _LOG.exception("detect_and_embed failed")
        return _error(
            f"detect failed: {type(exc).__name__}: {exc}",
            code="detect_failed",
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        )

    h_img, w_img = int(img.shape[0]), int(img.shape[1])
    return JSONResponse(
        status_code=status.HTTP_200_OK,
        content=DetectResponse(
            faces=[Face(**f) for f in faces],
            image_w=w_img,
            image_h=h_img,
        ).model_dump(),
    )


@app.post("/detect")
async def detect(body: Annotated[DetectRequest, ...]) -> JSONResponse:
    """Detect & embed faces. Returns ``{faces, image_w, image_h}``.

    Offloads the CPU-bound detection work to uvicorn's thread pool via
    ``run_in_threadpool`` so the async event loop remains unblocked and
    other requests (``/health``, concurrent ``/detect``) are served
    promptly while a detection is in flight.
    """
    return await run_in_threadpool(_do_detect_sync, body)


@app.post("/detect-embed")
async def detect_embed(body: Annotated[DetectRequest, ...]) -> JSONResponse:
    """Alias of :func:`detect` — same body, same response.

    The Node side prefers this name because it advertises "single
    combined detect + embed call" semantics; keeping both endpoints
    lets either side be refactored without breaking the other.
    """
    return await run_in_threadpool(_do_detect_sync, body)


def _do_batch_sync(body: BatchDetectRequest) -> JSONResponse:
    """Synchronous inner implementation for batch detection."""
    if last_error() is not None:
        return _error(
            f"model failed to load: {last_error()}",
            code="model_load_failed",
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        )
    if not is_ready():
        return _error(
            "model is still loading, retry shortly",
            code="model_loading",
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        )

    kwargs: dict[str, Any] = {}
    if body.min_score is not None:
        kwargs["min_score"] = float(body.min_score)
    if body.min_box_px is not None:
        kwargs["min_box_px"] = int(body.min_box_px)
    if body.ar_range is not None:
        kwargs["ar_range"] = (float(body.ar_range[0]), float(body.ar_range[1]))

    results: list[dict[str, Any]] = []
    total_faces = 0

    for file_path in body.files:
        img, err_code = _load_image(file_path, None)
        if img is None:
            results.append({
                "file": file_path,
                "faces": [],
                "image_w": 0,
                "image_h": 0,
                "error": err_code,
            })
            continue

        try:
            faces = detect_and_embed(img, **kwargs)
        except Exception as exc:
            _LOG.exception("detect_and_embed failed for %s", file_path)
            results.append({
                "file": file_path,
                "faces": [],
                "image_w": 0,
                "image_h": 0,
                "error": f"detect_failed: {type(exc).__name__}",
            })
            continue

        h_img, w_img = int(img.shape[0]), int(img.shape[1])
        face_objs = [Face(**f).model_dump() for f in faces]
        total_faces += len(face_objs)
        results.append({
            "file": file_path,
            "faces": face_objs,
            "image_w": w_img,
            "image_h": h_img,
            "error": None,
        })

    return JSONResponse(
        status_code=status.HTTP_200_OK,
        content={
            "results": results,
            "total_files": len(results),
            "total_faces": total_faces,
        },
    )


@app.post("/detect/batch")
async def detect_batch(body: BatchDetectRequest) -> JSONResponse:
    """Detect faces in multiple files in a single HTTP round-trip.

    Accepts ``{"files": ["/abs/path/img1.jpg", ...]}`` and returns a
    ``results`` list with one entry per input file. Per-file errors
    (file not found, decode failure, path outside allow-roots) are
    surfaced in the ``error`` field rather than aborting the batch.

    Model-not-ready and model-load-failed conditions are still returned
    as top-level 503 errors because no results can be produced.

    The entire batch runs in a single threadpool slot so the semaphore
    in :func:`detect_and_embed` governs concurrency across simultaneous
    batch requests — no separate locking is needed here.
    """
    return await run_in_threadpool(_do_batch_sync, body)
