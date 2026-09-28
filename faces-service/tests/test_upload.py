"""``POST /detect/upload`` (raw image bytes) and the ``/health`` feature list.

The detector is stubbed, so these run without the model weights.
"""

from __future__ import annotations

import io as io_mod

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from tgdl_faces import app as app_mod

_FACE = {
    "x": 10,
    "y": 20,
    "w": 100,
    "h": 120,
    "score": 0.9,
    "quality_score": 0.5,
    "embedding": [0.0] * 512,
    "landmarks": [[30.0, 40.0]] * 5,
}


def _jpeg(width: int = 64, height: int = 48) -> bytes:
    buf = io_mod.BytesIO()
    Image.new("RGB", (width, height), (120, 90, 60)).save(buf, format="JPEG")
    return buf.getvalue()


@pytest.fixture
def client(monkeypatch):
    calls: list[dict] = []

    def fake_detect(img, **kwargs):
        calls.append({"shape": img.shape, **kwargs})
        return [dict(_FACE)]

    monkeypatch.setattr(app_mod, "detect_and_embed", fake_detect)
    monkeypatch.setattr(app_mod, "is_ready", lambda: True)
    monkeypatch.setattr(app_mod, "last_error", lambda: None)
    monkeypatch.delenv("TGDL_FACES_API_TOKEN", raising=False)
    monkeypatch.delenv("TGDL_FACES_MAX_UPLOAD_MB", raising=False)
    c = TestClient(app_mod.app)
    c.calls = calls
    return c


def test_health_lists_upload_feature(client) -> None:
    body = client.get("/health").json()
    assert "upload" in body["features"]
    assert body["max_upload_bytes"] == 64 * 1024 * 1024


def test_upload_detects_on_raw_bytes_with_query_thresholds(client) -> None:
    r = client.post(
        "/detect/upload?min_score=0.6&min_box_px=30&ar_lo=0.4&ar_hi=2.5",
        content=_jpeg(80, 60),
        headers={"content-type": "application/octet-stream"},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["image_w"] == 80 and body["image_h"] == 60
    assert body["exif_oriented"] is True
    assert body["faces"][0]["x"] == 10
    assert client.calls[-1]["min_score"] == 0.6
    assert client.calls[-1]["min_box_px"] == 30
    assert client.calls[-1]["ar_range"] == (0.4, 2.5)


def test_upload_applies_exif_orientation(client) -> None:
    img = Image.new("RGB", (80, 40), (10, 20, 30))
    exif = Image.Exif()
    exif[0x0112] = 6  # rotate 90° CW: displayed 40 x 80
    buf = io_mod.BytesIO()
    img.save(buf, format="JPEG", exif=exif)
    body = client.post("/detect/upload", content=buf.getvalue()).json()
    assert (body["image_w"], body["image_h"]) == (40, 80)


def test_upload_soft_errors_and_limits(client, monkeypatch) -> None:
    assert client.post("/detect/upload", content=b"").status_code == 400
    bad = client.post("/detect/upload", content=b"not an image")
    assert bad.status_code == 200 and bad.json()["error"] == "decode_failed"
    lopsided = client.post("/detect/upload?ar_lo=0.5", content=_jpeg())
    assert lopsided.status_code == 400
    monkeypatch.setenv("TGDL_FACES_MAX_UPLOAD_MB", "1")
    big = client.post("/detect/upload", content=b"\0" * (1024 * 1024 + 1))
    assert big.status_code == 413 and big.json()["code"] == "too_large"


def test_upload_requires_the_token_when_set(client, monkeypatch) -> None:
    monkeypatch.setenv("TGDL_FACES_API_TOKEN", "s3cret")
    assert client.post("/detect/upload", content=_jpeg()).status_code == 401
    ok = client.post("/detect/upload", content=_jpeg(), headers={"x-api-token": "s3cret"})
    assert ok.status_code == 200
    assert client.get("/health").status_code == 200


def test_upload_waits_for_the_model(client, monkeypatch) -> None:
    monkeypatch.setattr(app_mod, "is_ready", lambda: False)
    r = client.post("/detect/upload", content=_jpeg())
    assert r.status_code == 503 and r.json()["code"] == "model_loading"
