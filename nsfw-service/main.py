"""Standalone NSFW classification sidecar — FastAPI + transformers.

Run on a GPU server behind a Cloudflare Tunnel (or any reverse proxy)
so the main Telegram Media Downloader app can offload NSFW scoring
to faster hardware.

Usage:
    pip install -r requirements.txt
    python main.py                        # defaults: 0.0.0.0:8012
    TGDL_NSFW_PORT=9000 python main.py    # custom port

The Node client (nsfw-client.js) talks to this via:
    GET  /health         -> { ok, model, ready, version }
    POST /classify       -> { path | image_b64 } -> { score, label }
    POST /classify/batch -> { files[] }          -> { results[] }
"""

from __future__ import annotations

import base64
import io
import logging
import os
import re
import time
from pathlib import Path
from typing import Optional

import torch
import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from PIL import Image
from pydantic import BaseModel, Field
from transformers import pipeline

__version__ = "1.1.0"

_LOG = logging.getLogger("nsfw-service")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

# Config from env
MODEL_ID = os.environ.get("TGDL_NSFW_MODEL", "AdamCodd/vit-base-nsfw-detector")
HOST = os.environ.get("TGDL_NSFW_HOST", "0.0.0.0")
PORT = int(os.environ.get("TGDL_NSFW_PORT", "8012"))
ALLOW_ROOTS = os.environ.get("TGDL_NSFW_ALLOW_ROOTS", "").strip()

_NSFW_PATTERN = re.compile(r"(nsfw|porn|hentai|sexy|explicit|adult)", re.I)

# Lazy-loaded classifier
_classifier = None
_model_ready = False
_boot_time = time.monotonic()
_stats = {"requests": 0, "errors": 0}

# Path sandbox. Default-deny, like the faces sidecar: without
# TGDL_NSFW_ALLOW_ROOTS, path mode is off and the Node client falls back to
# sending image_b64 — so an unauthenticated sidecar on 0.0.0.0 can't be used
# to read or probe arbitrary files on its host.
_allowed_roots: list[str] = []
if ALLOW_ROOTS:
    _allowed_roots = [os.path.realpath(r.strip()) for r in ALLOW_ROOTS.split(",") if r.strip()]


def _allowed_path(p: str) -> Optional[Path]:
    """Resolved path when it falls under an allowed root, else None."""
    if not _allowed_roots:
        return None
    try:
        resolved = os.path.realpath(p)
    except (OSError, ValueError):
        return None
    for root in _allowed_roots:
        if resolved == root or resolved.startswith(root.rstrip(os.sep) + os.sep):
            return Path(resolved)
    return None


def _open_rgb(source) -> Image.Image:
    return Image.open(source).convert("RGB")


def _decode_failed(where: str, exc: Exception) -> dict:
    # Log the decoder's message instead of echoing it to the caller.
    _LOG.warning("decode failed for %s: %s", where, exc)
    return {"error": "decode_failed", "score": None, "label": None}


def _load_classifier():
    global _classifier, _model_ready
    if _classifier is not None:
        return _classifier
    _LOG.info("Loading model %s ...", MODEL_ID)
    device = "cuda" if torch.cuda.is_available() else "cpu"
    _LOG.info("Device: %s (CUDA available: %s)", device, torch.cuda.is_available())
    _classifier = pipeline(
        "image-classification",
        model=MODEL_ID,
        device=device,
    )
    _model_ready = True
    _LOG.info("Model loaded on %s", device)
    return _classifier


def _score_result(output: list[dict]) -> dict:
    nsfw_score = 0.0
    for r in output:
        label = str(r.get("label", "")).lower()
        score = float(r.get("score", 0))
        if _NSFW_PATTERN.search(label) and score > nsfw_score:
            nsfw_score = score
    return {
        "score": round(nsfw_score, 6),
        "label": "nsfw" if nsfw_score >= 0.5 else "normal",
    }


def _classify_image(image: Image.Image) -> dict:
    clf = _load_classifier()
    result = clf(image)
    return _score_result(result if isinstance(result, list) else [])


app = FastAPI(title="NSFW Classification Sidecar", version=__version__)


@app.exception_handler(Exception)
async def _global_error(_request: Request, exc: Exception):
    _stats["errors"] += 1
    _LOG.error("Unhandled: %s", exc, exc_info=True)
    return JSONResponse(
        status_code=500,
        content={"error": "internal error — see sidecar log", "code": "internal_error"},
    )


@app.get("/health")
async def health():
    return {
        "ok": _model_ready or _classifier is not None,
        "service": "nsfw-service",
        "version": __version__,
        "model": MODEL_ID,
        "ready": _model_ready,
        "device": "cuda" if torch.cuda.is_available() else "cpu",
        "uptime_sec": round(time.monotonic() - _boot_time, 1),
        "stats": {**_stats},
    }


class ClassifyRequest(BaseModel):
    path: Optional[str] = None
    image_b64: Optional[str] = None
    threshold: Optional[float] = None


@app.post("/classify")
async def classify(req: ClassifyRequest):
    _stats["requests"] += 1
    if req.path:
        path = _allowed_path(req.path)
        if path is None:
            return JSONResponse(
                status_code=403,
                content={"error": "path_not_allowed", "code": "path_not_allowed"},
            )
        if not path.is_file():
            return JSONResponse(
                status_code=200,
                content={"error": "file_not_found", "score": None, "label": None},
            )
        try:
            img = _open_rgb(path)
        except Exception as e:
            return _decode_failed(str(path), e)
    elif req.image_b64:
        try:
            img = _open_rgb(io.BytesIO(base64.b64decode(req.image_b64)))
        except Exception as e:
            return _decode_failed("image_b64", e)
    else:
        return JSONResponse(
            status_code=400,
            content={"error": "provide path or image_b64", "code": "missing_input"},
        )
    result = _classify_image(img)
    return result


class BatchRequest(BaseModel):
    files: list[str] = Field(default_factory=list)
    threshold: Optional[float] = None


@app.post("/classify/batch")
async def classify_batch(req: BatchRequest):
    _stats["requests"] += 1
    results = []
    for fpath in req.files:
        # Results stay keyed by the caller's original string — the Node
        # client maps them back by exact match.
        path = _allowed_path(fpath)
        if path is None:
            results.append({"file": fpath, "error": "path_not_allowed"})
            continue
        if not path.is_file():
            results.append({"file": fpath, "error": "file_not_found", "score": None, "label": None})
            continue
        try:
            r = _classify_image(_open_rgb(path))
        except Exception as e:
            r = _decode_failed(str(path), e)
        results.append({"file": fpath, **r})
    return {"results": results, "total_files": len(req.files)}


if __name__ == "__main__":
    _LOG.info("Starting NSFW sidecar — model=%s host=%s port=%d", MODEL_ID, HOST, PORT)
    if not _allowed_roots:
        _LOG.warning(
            "TGDL_NSFW_ALLOW_ROOTS is not set: path mode is off and the app sends images "
            "as base64 (works, but slower). Set it to the downloads directory the app "
            "shares with this sidecar to re-enable path mode."
        )
    _load_classifier()
    uvicorn.run(app, host=HOST, port=PORT, log_level="info")
