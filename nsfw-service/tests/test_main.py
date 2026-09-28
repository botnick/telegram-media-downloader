"""nsfw-service HTTP contract tests. The classifier is stubbed, so no model
download is needed (torch + transformers still have to be importable).

    pip install -r requirements.txt pytest httpx
    python -m pytest nsfw-service/tests
"""

from __future__ import annotations

import importlib
import io
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from PIL import Image

SERVICE_DIR = Path(__file__).resolve().parent.parent


def _png_bytes(size=(64, 48)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", size, (200, 120, 80)).save(buf, format="PNG")
    return buf.getvalue()


@pytest.fixture
def load(monkeypatch):
    """Import a fresh `main` with the given env, classifier stubbed."""

    def _load(**env):
        for key in ("TGDL_NSFW_API_TOKEN", "TGDL_NSFW_ALLOW_ROOTS", "TGDL_NSFW_MAX_UPLOAD_MB"):
            monkeypatch.delenv(key, raising=False)
        for key, value in env.items():
            monkeypatch.setenv(key, value)
        monkeypatch.syspath_prepend(str(SERVICE_DIR))
        sys.modules.pop("main", None)
        main = importlib.import_module("main")
        main._classifier = lambda img: [{"label": "nsfw", "score": 0.91}]
        main._model_ready = True
        return main, TestClient(main.app)

    yield _load
    sys.modules.pop("main", None)


def test_health_advertises_features_and_auth(load):
    main, client = load()
    body = client.get("/health").json()
    assert body["version"] == main.__version__
    assert {"path", "b64", "upload", "auth"} <= set(body["features"])
    assert body["auth_required"] is False
    assert body["path_mode"] is False


def test_upload_classifies_raw_bytes(load):
    _, client = load()
    r = client.post(
        "/classify/upload",
        content=_png_bytes(),
        headers={"content-type": "application/octet-stream"},
    )
    assert r.status_code == 200
    assert r.json() == {"score": 0.91, "label": "nsfw"}


def test_upload_rejects_empty_and_oversized_bodies(load):
    _, client = load(TGDL_NSFW_MAX_UPLOAD_MB="1")
    assert client.post("/classify/upload", content=b"").status_code == 400
    r = client.post("/classify/upload", content=b"\0" * (1024 * 1024 + 10))
    assert r.status_code == 413
    assert r.json()["code"] == "too_large"


def test_undecodable_upload_is_a_soft_error(load):
    _, client = load()
    r = client.post("/classify/upload", content=b"not an image")
    assert r.status_code == 200
    assert r.json()["error"] == "decode_failed"


def test_token_gates_everything_but_health(load):
    _, client = load(TGDL_NSFW_API_TOKEN="s3cret")
    assert client.get("/health").status_code == 200
    assert client.get("/health").json()["auth_required"] is True
    assert client.post("/classify", json={}).status_code == 401
    assert client.post("/classify/upload", content=_png_bytes()).status_code == 401
    bad = client.post("/classify/upload", content=_png_bytes(), headers={"x-api-token": "nope"})
    assert bad.status_code == 401
    ok = client.post("/classify/upload", content=_png_bytes(), headers={"x-api-token": "s3cret"})
    assert ok.status_code == 200
    bearer = client.post(
        "/classify/upload",
        content=_png_bytes(),
        headers={"authorization": "Bearer s3cret"},
    )
    assert bearer.status_code == 200
    # A valid token reaching an empty /classify gets the normal 400 —
    # that's what the app's "auth ok?" probe relies on.
    assert client.post("/classify", json={}, headers={"x-api-token": "s3cret"}).status_code == 400


def test_path_mode_sandbox(load, tmp_path):
    root = tmp_path / "media"
    root.mkdir()
    img = root / "a.png"
    img.write_bytes(_png_bytes())
    _, client = load(TGDL_NSFW_ALLOW_ROOTS=str(root))
    assert client.get("/health").json()["path_mode"] is True
    assert client.post("/classify", json={"path": str(img)}).json()["label"] == "nsfw"
    missing = client.post("/classify", json={"path": str(root / "missing.png")}).json()
    assert missing["error"] == "file_not_found"
    outside = client.post("/classify", json={"path": str(tmp_path / "x.png")})
    assert outside.status_code == 403
    batch = client.post("/classify/batch", json={"files": [str(img), str(tmp_path / "x.png")]})
    results = batch.json()["results"]
    assert results[0]["label"] == "nsfw"
    assert results[1]["error"] == "path_not_allowed"
