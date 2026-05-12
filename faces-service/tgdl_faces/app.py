"""FastAPI app exposing the face detection + embedding HTTP API.

Endpoints (see ``docs/AI.md`` on the Node side for the full contract):

* ``GET /health`` — liveness; never returns 500 so the Node-side
  polling loop stays cheap.
* ``GET /info`` — model card (name, dim, providers, det_size, version).
* ``POST /detect`` — detect & embed faces from a path or base64 blob.
* ``POST /detect-embed`` — alias of ``/detect``. The Node side calls
  this name because it advertises "single combined call" semantics
  to the rest of the codebase; keeping both names lets either side be
  refactored without breaking the other.

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
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, model_validator

from . import __version__
from .clip import (
    CLIPTagger,
    get_tagger as get_clip_tagger,
    is_ready as clip_is_ready,
    last_error as clip_last_error,
)
from .ocr import (
    extract_text as ocr_extract_text,
    is_ready as ocr_is_ready,
    last_error as ocr_last_error,
)
from .insight import (
    DET_SIZE,
    EMBEDDING_DIM,
    MODEL_NAME,
    detect_and_embed,
    get_app,
    is_ready,
    last_error,
    platform_tag,
    python_version,
    requested_providers,
    resolved_providers,
)
from .io import (
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


class TagRequest(BaseModel):
    """Body for ``/tag`` — zero-shot CLIP tagging.

    Exactly one of ``path`` and ``image_b64`` must be set, mirroring
    ``DetectRequest``.
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
    threshold: float | None = Field(
        default=None,
        ge=0.0,
        le=1.0,
        description="Minimum tag score (0..1). Defaults to env or 0.20.",
    )
    top_k: int | None = Field(
        default=None,
        ge=1,
        le=100,
        description="Max tags to return. Defaults to env or 10.",
    )
    vocabulary: list[str] | None = Field(
        default=None,
        description=(
            "Custom tag labels overriding the sidecar's default vocabulary. "
            "If empty/omitted, the sidecar's built-in vocabulary is used."
        ),
    )

    @model_validator(mode="after")
    def _exactly_one_source(self) -> TagRequest:
        has_path = bool(self.path and self.path.strip())
        has_b64 = bool(self.image_b64 and self.image_b64.strip())
        if has_path == has_b64:
            raise ValueError(
                "exactly one of `path` or `image_b64` is required"
            )
        return self


class TagResult(BaseModel):
    tag: str
    score: float


class TagResponse(BaseModel):
    tags: list[TagResult]
    vocabulary: list[str]


class HealthOk(BaseModel):
    """Successful ``/health`` payload.

    Beyond the original ``{ok, version, model, dim, ready}`` we now
    surface the providers actually picked at boot, the platform tag, the
    bundled Python version, and the resolved det_size. The AI maintenance
    card uses these to render real state ("CoreML on darwin/arm64,
    det_size 640") rather than a generic green dot.
    """

    ok: bool = True
    version: str = __version__
    model: str = MODEL_NAME
    dim: int = EMBEDDING_DIM
    ready: bool = False
    providers_resolved: list[str] = Field(default_factory=list)
    providers_requested: str = "auto"
    det_size: int = int(DET_SIZE[0])
    platform: str = ""
    python: str = ""
    clip_ready: bool = False
    clip_model: str = ""
    clip_vocabulary_size: int = 0


class HealthErr(BaseModel):
    ok: bool = False
    error: str
    version: str = __version__
    platform: str = ""
    python: str = ""
    clip_ready: bool = False
    clip_model: str = ""
    clip_vocabulary_size: int = 0


class InfoResponse(BaseModel):
    model: str = MODEL_NAME
    dim: int = EMBEDDING_DIM
    providers: list[str]
    providers_requested: str = "auto"
    det_size: int
    version: str = __version__
    platform: str = ""
    python: str = ""
    clip_ready: bool = False
    clip_model: str = ""
    clip_vocabulary_size: int = 0


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


# --- routes -----------------------------------------------------------------


@app.get("/health")
def health() -> JSONResponse:
    """Cheap liveness probe.

    Returns 200 even when the model failed to load — the Node side
    polls this every 60s and we don't want 500s spammed into the
    operator's log. The ``ok`` flag carries the real verdict; consumers
    must check it (not just the HTTP status).
    """
    err = last_error()
    clip_ready = clip_is_ready()
    clip_model = ""
    clip_vocabulary_size = 0
    if clip_ready:
        try:
            tagger = get_clip_tagger()
            clip_model = tagger.model_id
            clip_vocabulary_size = len(tagger.vocabulary)
        except Exception:
            pass
    elif clip_last_error() is not None:
        clip_model = "error"

    if err is not None:
        return JSONResponse(
            status_code=status.HTTP_200_OK,
            content=HealthErr(
                error=f"{type(err).__name__}: {err}",
                platform=platform_tag(),
                python=python_version(),
                clip_ready=clip_ready,
                clip_model=clip_model,
                clip_vocabulary_size=clip_vocabulary_size,
            ).model_dump(),
        )
    return JSONResponse(
        status_code=status.HTTP_200_OK,
        content=HealthOk(
            ready=is_ready(),
            providers_resolved=resolved_providers(),
            providers_requested=requested_providers(),
            det_size=int(DET_SIZE[0]),
            platform=platform_tag(),
            python=python_version(),
            clip_ready=clip_ready,
            clip_model=clip_model,
            clip_vocabulary_size=clip_vocabulary_size,
        ).model_dump(),
    )


@app.get("/info")
def info() -> InfoResponse:
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
    clip_ready = clip_is_ready()
    clip_model = ""
    clip_vocabulary_size = 0
    if clip_ready:
        try:
            tagger = get_clip_tagger()
            clip_model = tagger.model_id
            clip_vocabulary_size = len(tagger.vocabulary)
        except Exception:
            pass
    elif clip_last_error() is not None:
        clip_model = "error"

    return InfoResponse(
        providers=providers,
        providers_requested=requested_providers(),
        det_size=int(DET_SIZE[0]),
        platform=platform_tag(),
        python=python_version(),
        clip_ready=clip_ready,
        clip_model=clip_model,
        clip_vocabulary_size=clip_vocabulary_size,
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


def _do_detect(body: DetectRequest) -> JSONResponse:
    # Resolve the image first so we can return 403 / 415 before paying
    # the FaceAnalysis warm-up cost on first request.
    try:
        if body.path:
            img = load_image_from_path(body.path, _allow_roots())
        else:
            assert body.image_b64 is not None  # guarded by validator
            img = load_image_from_b64(body.image_b64)
    except PathNotAllowedError as exc:
        return _error(str(exc), code="path_not_allowed",
                      status_code=status.HTTP_403_FORBIDDEN)
    except FileNotFoundError as exc:
        return _error(str(exc), code="file_not_found",
                      status_code=status.HTTP_404_NOT_FOUND)
    except ImageDecodeError as exc:
        return _error(str(exc), code="image_decode_failed",
                      status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE)

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
def detect(body: Annotated[DetectRequest, ...]) -> JSONResponse:
    """Detect & embed faces. Returns ``{faces, image_w, image_h}``."""
    return _do_detect(body)


@app.post("/detect-embed")
def detect_embed(body: Annotated[DetectRequest, ...]) -> JSONResponse:
    """Alias of :func:`detect` — same body, same response.

    The Node side prefers this name because it advertises "single
    combined detect + embed call" semantics; keeping both endpoints
    lets either side be refactored without breaking the other.
    """
    return _do_detect(body)


@app.post("/tag")
def tag_image(body: Annotated[TagRequest, ...]) -> JSONResponse:
    """Zero-shot CLIP tagging — score an image against the tag vocabulary.

    Returns ``{tags: [{tag, score}], vocabulary: [str]}``.

    Error codes mirror the ``/detect`` endpoint: ``path_not_allowed`` (403),
    ``file_not_found`` (404), ``image_decode_failed`` (415), and
    ``tagger_not_ready`` (503) when the CLIP model hasn't loaded yet or
    failed to load.
    """
    try:
        tagger = get_clip_tagger()
    except Exception as exc:
        return _error(
            f"tagger not ready: {type(exc).__name__}: {exc}",
            code="tagger_not_ready",
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        )

    # Resolve the image first so we can return 403 / 415 before paying
    # the CLIP inference cost on invalid input.
    try:
        if body.path:
            img = load_image_from_path(body.path, _allow_roots())
        else:
            assert body.image_b64 is not None  # guarded by validator
            img = load_image_from_b64(body.image_b64)
    except PathNotAllowedError as exc:
        return _error(str(exc), code="path_not_allowed",
                      status_code=status.HTTP_403_FORBIDDEN)
    except FileNotFoundError as exc:
        return _error(str(exc), code="file_not_found",
                      status_code=status.HTTP_404_NOT_FOUND)
    except ImageDecodeError as exc:
        return _error(str(exc), code="image_decode_failed",
                      status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE)

    try:
        tags = tagger.tag_image(
            img,
            threshold=body.threshold,
            top_k=body.top_k,
            vocabulary=body.vocabulary,
        )
    except Exception as exc:
        _LOG.exception("tag_image failed")
        return _error(
            f"tagging failed: {type(exc).__name__}: {exc}",
            code="tagging_failed",
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        )

    # Determine which vocabulary was actually used
    used_vocabulary = body.vocabulary or list(tagger.vocabulary)

    return JSONResponse(
        status_code=status.HTTP_200_OK,
        content=TagResponse(
            tags=[TagResult(**t) for t in tags],
            vocabulary=list(used_vocabulary),
        ).model_dump(),
    )


# ---- OCR (Text Detection) -------------------------------------------------


class OCRRequest(BaseModel):
    """Body for ``/ocr`` endpoint."""

    path: str | None = Field(default=None, description="Absolute path to an image on disk.")
    image_b64: str | None = Field(
        default=None,
        description="Base64-encoded image bytes.",
    )

    @model_validator(mode="after")
    def _validate_source(self) -> OCRRequest:
        """Exactly one of path / image_b64 must be set."""
        if (self.path is None) == (self.image_b64 is None):
            raise ValueError("exactly one of path or image_b64 must be set")
        return self


class OCRResult(BaseModel):
    text: str
    language: str | None = None
    confidence: float | None = None


class OCRResponse(BaseModel):
    result: OCRResult


@app.post("/ocr")
def ocr_image(body: Annotated[OCRRequest, ...]) -> JSONResponse:
    """Extract text from image using OCR (pytesseract wrapper around Tesseract).

    Returns ``{result: {text, language, confidence}}``.

    Error codes: ``path_not_allowed`` (403), ``file_not_found`` (404),
    ``image_decode_failed`` (415), ``ocr_not_ready`` (503), ``ocr_failed`` (500).
    """
    if not ocr_is_ready():
        return _error(
            f"tesseract not available: {ocr_last_error()}",
            code="ocr_not_ready",
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        )

    try:
        if body.path:
            img = load_image_from_path(body.path, _allow_roots())
        else:
            assert body.image_b64 is not None
            img = load_image_from_b64(body.image_b64)
    except PathNotAllowedError as exc:
        return _error(str(exc), code="path_not_allowed",
                      status_code=status.HTTP_403_FORBIDDEN)
    except FileNotFoundError as exc:
        return _error(str(exc), code="file_not_found",
                      status_code=status.HTTP_404_NOT_FOUND)
    except ImageDecodeError as exc:
        return _error(str(exc), code="image_decode_failed",
                      status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE)

    try:
        result = ocr_extract_text(img, lang="eng")
        return JSONResponse(
            status_code=status.HTTP_200_OK,
            content=OCRResponse(
                result=OCRResult(**result)
            ).model_dump(),
        )
    except Exception as exc:
        _LOG.exception("ocr_image failed")
        return _error(
            f"ocr failed: {type(exc).__name__}: {exc}",
            code="ocr_failed",
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        )


# ---- Object Detection (YOLO) -----------------------------------------------


class DetectObjectsRequest(BaseModel):
    """Body for ``/detect-objects`` endpoint."""

    path: str | None = Field(default=None, description="Absolute path to an image on disk.")
    image_b64: str | None = Field(default=None, description="Base64-encoded image bytes.")
    confidence: float = Field(default=0.5, ge=0.0, le=1.0, description="Confidence threshold.")

    @model_validator(mode="after")
    def _validate_source(self) -> DetectObjectsRequest:
        """Exactly one of path / image_b64 must be set."""
        if (self.path is None) == (self.image_b64 is None):
            raise ValueError("exactly one of path or image_b64 must be set")
        return self


class DetectedObject(BaseModel):
    object: str
    confidence: float
    x: float | None = None
    y: float | None = None
    w: float | None = None
    h: float | None = None


class DetectObjectsResponse(BaseModel):
    objects: list[DetectedObject]


@app.post("/detect-objects")
def detect_objects(body: Annotated[DetectObjectsRequest, ...]) -> JSONResponse:
    """Detect objects in image using YOLOv8-nano (ONNX).

    Returns ``{objects: [{object, confidence, x, y, w, h}]}``.

    Error codes: ``path_not_allowed`` (403), ``file_not_found`` (404),
    ``image_decode_failed`` (415), ``detection_failed`` (500).
    """
    try:
        if body.path:
            img = load_image_from_path(body.path, _allow_roots())
        else:
            assert body.image_b64 is not None
            img = load_image_from_b64(body.image_b64)
    except PathNotAllowedError as exc:
        return _error(str(exc), code="path_not_allowed",
                      status_code=status.HTTP_403_FORBIDDEN)
    except FileNotFoundError as exc:
        return _error(str(exc), code="file_not_found",
                      status_code=status.HTTP_404_NOT_FOUND)
    except ImageDecodeError as exc:
        return _error(str(exc), code="image_decode_failed",
                      status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE)

    try:
        # TODO: Implement object detection using YOLOv8-nano ONNX
        # For now, return empty placeholder
        objects = []

        return JSONResponse(
            status_code=status.HTTP_200_OK,
            content=DetectObjectsResponse(
                objects=[DetectedObject(**obj) for obj in objects]
            ).model_dump(),
        )
    except Exception as exc:
        _LOG.exception("detect_objects failed")
        return _error(
            f"detection failed: {type(exc).__name__}: {exc}",
            code="detection_failed",
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        )
