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

__version__ = "1.0.0"

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

# Path sandbox
_allowed_roots: list[Path] = []
if ALLOW_ROOTS:
    _allowed_roots = [Path(r.strip()).resolve() for r in ALLOW_ROOTS.split(",") if r.strip()]


def _is_path_allowed(p: str) -> bool:
    if not _allowed_roots:
        return True
    resolved = Path(p).resolve()
    return any(resolved.is_relative_to(root) for root in _allowed_roots)


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
        content={"error": str(exc), "code": "internal_error"},
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
        if not _is_path_allowed(req.path):
            return JSONResponse(
                status_code=403,
                content={"error": "path_not_allowed", "code": "path_not_allowed"},
            )
        if not Path(req.path).is_file():
            return JSONResponse(
                status_code=200,
                content={"error": "file_not_found", "score": None, "label": None},
            )
        try:
            img = Image.open(req.path).convert("RGB")
        except Exception as e:
            return {"error": "decode_failed", "detail": str(e), "score": None, "label": None}
    elif req.image_b64:
        try:
            raw = base64.b64decode(req.image_b64)
            img = Image.open(io.BytesIO(raw)).convert("RGB")
        except Exception as e:
            return {"error": "decode_failed", "detail": str(e), "score": None, "label": None}
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
        if not _is_path_allowed(fpath):
            results.append({"file": fpath, "error": "path_not_allowed"})
            continue
        if not Path(fpath).is_file():
            results.append({"file": fpath, "error": "file_not_found", "score": None, "label": None})
            continue
        try:
            img = Image.open(fpath).convert("RGB")
            r = _classify_image(img)
            results.append({"file": fpath, **r})
        except Exception as e:
            results.append({"file": fpath, "error": "decode_failed", "detail": str(e), "score": None, "label": None})
    return {"results": results, "total_files": len(req.files)}


if __name__ == "__main__":
    _LOG.info("Starting NSFW sidecar — model=%s host=%s port=%d", MODEL_ID, HOST, PORT)
    _load_classifier()
    uvicorn.run(app, host=HOST, port=PORT, log_level="info")
