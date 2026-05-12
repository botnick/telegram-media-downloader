"""End-to-end tests for the FastAPI sidecar.

These tests intentionally exercise the *infrastructure* (validation,
path-traversal guard, base64 decoding, error shape) without asserting on
real face detections — we don't bundle a face image in the test data and
the heavy ``buffalo_l`` model isn't checked into git.

* ``/health``, ``/config``, and ``/info`` are exercised end-to-end. They
  both avoid triggering :func:`tgdl_faces.insight.get_app`, so the test
  suite runs even on machines where insightface fails to import / weights
  aren't cached.

* ``/detect`` is exercised with a synthetic solid-grey JPEG drawn at
  module import time with Pillow. The model load *will* happen on first
  ``/detect`` request, so these tests are skipped automatically when
  insightface can't be initialised in the current environment.

The "real face detection" assertion is deliberately out of scope: there
is no face in a solid rectangle and we don't want the test suite to
depend on a downloaded portrait. Track E adds an integration-test job
that runs against a real sidecar with sample imagery.
"""

from __future__ import annotations

import base64
import io as io_mod
import os
import tempfile
from pathlib import Path
from typing import Iterator

import pytest
from PIL import Image, ImageDraw


# ---- synthetic image fixture ---------------------------------------------

# Drawn once at module import so tests share the same bytes.
_IMG_W, _IMG_H = 400, 400


def _make_solid_jpeg(width: int = _IMG_W, height: int = _IMG_H) -> bytes:
    """Return JPEG bytes for a solid grey rectangle.

    Picked solid grey rather than pure white/black so the JPEG quantiser
    has a non-trivial baseline; insightface's detector returns zero
    candidates either way.
    """
    img = Image.new("RGB", (width, height), color=(128, 128, 128))
    draw = ImageDraw.Draw(img)
    # Inner rectangle so the file isn't *literally* one colour band —
    # some decoders short-circuit those.
    draw.rectangle(
        [(50, 50), (width - 50, height - 50)],
        outline=(64, 64, 64),
        width=4,
    )
    buf = io_mod.BytesIO()
    img.save(buf, format="JPEG", quality=85)
    return buf.getvalue()


SOLID_JPEG_BYTES = _make_solid_jpeg()
SOLID_JPEG_B64 = base64.b64encode(SOLID_JPEG_BYTES).decode("ascii")


# ---- helpers --------------------------------------------------------------


def _can_load_insightface() -> bool:
    """Return True iff insightface + the model can be initialised here.

    We probe import-and-prepare lazily so the cheap tests (validation,
    /health, /info, path-traversal guard) still run even when the model
    weights aren't on the machine.
    """
    try:
        from tgdl_faces.insight import get_app  # noqa: PLC0415

        get_app()
        return True
    except Exception:  # noqa: BLE001 — broad on purpose
        return False


@pytest.fixture(scope="module")
def temp_root() -> Iterator[Path]:
    """Allow-root for path-mode requests."""
    with tempfile.TemporaryDirectory(prefix="tgdl-faces-test-") as tmp:
        yield Path(tmp).resolve()


@pytest.fixture(scope="module")
def jpeg_on_disk(temp_root: Path) -> Path:
    """Write the synthetic JPEG inside the allow-root and return its path."""
    target = temp_root / "solid.jpg"
    target.write_bytes(SOLID_JPEG_BYTES)
    return target


@pytest.fixture(scope="module")
def outside_jpeg() -> Iterator[Path]:
    """Write a JPEG in a separate tempdir that's *not* in TGDL_FACES_ALLOW_ROOTS."""
    with tempfile.TemporaryDirectory(prefix="tgdl-faces-outside-") as tmp:
        path = Path(tmp).resolve() / "outside.jpg"
        path.write_bytes(SOLID_JPEG_BYTES)
        yield path


@pytest.fixture(scope="module")
def client(temp_root: Path):
    """FastAPI TestClient with TGDL_FACES_ALLOW_ROOTS pointed at temp_root."""
    # Set env *before* importing app so the allow-list is picked up.
    os.environ["TGDL_FACES_ALLOW_ROOTS"] = str(temp_root)

    # Imported lazily so the env mutation above wins.
    from fastapi.testclient import TestClient  # noqa: PLC0415

    from tgdl_faces.app import app  # noqa: PLC0415

    with TestClient(app) as c:
        yield c


# ---- tests: /health (seekbar format) ------------------------------------


def test_health_returns_200(client) -> None:
    resp = client.get("/health")
    assert resp.status_code == 200


def test_health_seekbar_format(client) -> None:
    """Health response must match the seekbar format exactly."""
    resp = client.get("/health")
    assert resp.status_code == 200
    payload = resp.json()

    # Required top-level keys from the seekbar contract.
    required = {
        "ok", "service", "version", "platform", "arch",
        "ready", "model", "gpu_provider", "gpu_available",
        "providers", "uptime_sec", "stats",
    }
    assert required.issubset(payload.keys()), (
        f"Missing health keys: {required - payload.keys()}"
    )

    # Stable value assertions.
    assert payload["service"] == "faces-service"
    assert payload["model"] == "buffalo_l"
    assert isinstance(payload["version"], str)
    assert isinstance(payload["platform"], str)
    assert isinstance(payload["arch"], str)
    assert isinstance(payload["ready"], bool)
    assert isinstance(payload["gpu_provider"], str)
    assert isinstance(payload["gpu_available"], bool)
    assert isinstance(payload["providers"], list)
    assert len(payload["providers"]) >= 1
    assert isinstance(payload["uptime_sec"], (int, float))
    assert payload["uptime_sec"] >= 0

    # Stats sub-object.
    stats = payload["stats"]
    assert isinstance(stats, dict)
    for key in ("requests", "faces_detected", "errors", "avg_ms"):
        assert key in stats, f"Missing stats key: {key}"


def test_health_not_ok_when_model_failed(monkeypatch, client) -> None:
    """When last_error() is set, ok=False and error field is present."""
    from tgdl_faces import app as app_mod
    from tgdl_faces import insight

    fake_err = RuntimeError("test error")
    monkeypatch.setattr(insight, "_APP_ERROR", fake_err)
    # Also ensure _APP is None so is_ready() returns False.
    monkeypatch.setattr(insight, "_APP", None)

    resp = client.get("/health")
    assert resp.status_code == 200
    payload = resp.json()
    assert payload["ok"] is False
    assert "error" in payload
    assert "test error" in payload["error"]
    assert payload["ready"] is False


# ---- tests: /config -------------------------------------------------------


def test_config_returns_200(client) -> None:
    resp = client.get("/config")
    assert resp.status_code == 200


def test_config_shape(client) -> None:
    resp = client.get("/config")
    payload = resp.json()
    required = {
        "model", "det_size", "providers_requested", "providers_resolved",
        "gpu_provider", "gpu_available", "max_concurrency",
        "model_dir", "allow_roots", "host", "port",
        "log_level", "version", "python", "platform", "arch",
    }
    assert required.issubset(payload.keys()), (
        f"Missing config keys: {required - payload.keys()}"
    )
    assert payload["model"] == "buffalo_l"
    assert payload["det_size"] == 640
    assert isinstance(payload["max_concurrency"], int)
    assert payload["max_concurrency"] >= 1


# ---- tests: /info ----------------------------------------------------------


def test_info_returns_model_and_dim(client) -> None:
    resp = client.get("/info")
    assert resp.status_code == 200
    payload = resp.json()
    assert payload["model"] == "buffalo_l"
    assert payload["dim"] == 512
    assert payload["det_size"] == 640
    assert isinstance(payload["providers"], list)
    assert len(payload["providers"]) >= 1
    assert "version" in payload
    assert "platform" in payload
    assert "arch" in payload


# ---- tests: /detect input validation -------------------------------------


def test_detect_rejects_missing_body_fields(client) -> None:
    """Neither path nor image_b64 supplied => 400."""
    resp = client.post("/detect", json={})
    assert resp.status_code == 400
    body = resp.json()
    assert body["code"] == "bad_request"
    assert "path" in body["error"] or "image_b64" in body["error"]


def test_detect_rejects_both_path_and_b64(client) -> None:
    """Both fields supplied => 400 (exactly-one rule)."""
    resp = client.post(
        "/detect",
        json={"path": "/whatever", "image_b64": "abc"},
    )
    assert resp.status_code == 400
    assert resp.json()["code"] == "bad_request"


def test_detect_path_outside_allow_roots_returns_403(
    client, outside_jpeg: Path
) -> None:
    resp = client.post("/detect", json={"path": str(outside_jpeg)})
    assert resp.status_code == 403
    body = resp.json()
    assert body["code"] == "path_not_allowed"
    assert "outside" in body["error"].lower() or "allow" in body["error"].lower()


def test_detect_b64_undecodable_returns_200_with_error(client) -> None:
    """Valid base64 alphabet but not an image — returns 200 + error field."""
    junk = base64.b64encode(b"definitely not an image").decode("ascii")
    resp = client.post("/detect", json={"image_b64": junk})
    # The new contract: decode errors return 200 + {"faces": [], "error": "decode_failed"}
    # to avoid crashing the Node retry loop.
    assert resp.status_code == 200
    body = resp.json()
    assert body.get("error") == "decode_failed"
    assert body.get("faces") == []


def test_detect_b64_invalid_base64_returns_415(client) -> None:
    # Not even valid base64 — Pydantic / the b64 decoder rejects before
    # image decode, so this still 415s.
    resp = client.post("/detect", json={"image_b64": "not!!!valid$$$base64"})
    assert resp.status_code == 415
    assert resp.json()["code"] == "image_decode_failed"


def test_detect_missing_file_returns_200_with_error(
    client, temp_root: Path
) -> None:
    """Path inside allow-roots but file absent => 200 + error: file_not_found."""
    ghost = str(temp_root / "does_not_exist.jpg")
    resp = client.post("/detect", json={"path": ghost})
    assert resp.status_code == 200
    body = resp.json()
    assert body.get("error") == "file_not_found"
    assert body.get("faces") == []


# ---- tests: /detect happy path (skipped without insightface) -------------


@pytest.fixture(scope="module")
def insightface_available() -> bool:
    return _can_load_insightface()


def _skip_if_no_model(insightface_available: bool) -> None:
    if not insightface_available:
        pytest.skip(
            "insightface / buffalo_l not available in this environment — "
            "the path/b64 happy-path tests need a working model load. "
            "Documented in faces-service/README.md."
        )


def test_detect_path_under_allow_roots_returns_empty_faces(
    client, jpeg_on_disk: Path, insightface_available: bool
) -> None:
    """Solid rectangle => no faces detected, 200 with empty list."""
    _skip_if_no_model(insightface_available)
    resp = client.post("/detect", json={"path": str(jpeg_on_disk)})
    assert resp.status_code == 200
    body = resp.json()
    assert body["faces"] == []
    assert body["image_w"] == _IMG_W
    assert body["image_h"] == _IMG_H


def test_detect_b64_returns_empty_faces(client, insightface_available: bool) -> None:
    _skip_if_no_model(insightface_available)
    resp = client.post("/detect", json={"image_b64": SOLID_JPEG_B64})
    assert resp.status_code == 200
    body = resp.json()
    assert body["faces"] == []
    assert body["image_w"] == _IMG_W
    assert body["image_h"] == _IMG_H


def test_detect_embed_alias_matches_detect(
    client, jpeg_on_disk: Path, insightface_available: bool
) -> None:
    """``/detect-embed`` and ``/detect`` accept the same body shape."""
    _skip_if_no_model(insightface_available)
    a = client.post("/detect", json={"path": str(jpeg_on_disk)})
    b = client.post("/detect-embed", json={"path": str(jpeg_on_disk)})
    assert a.status_code == 200
    assert b.status_code == 200
    # Both call into the same code path, so the structure is identical.
    assert set(a.json().keys()) == set(b.json().keys())


# ---- tests: /detect/batch -------------------------------------------------


def test_batch_rejects_empty_files(client) -> None:
    resp = client.post("/detect/batch", json={"files": []})
    assert resp.status_code == 400


def test_batch_outside_allow_roots_per_item_error(
    client, outside_jpeg: Path, insightface_available: bool
) -> None:
    """Paths outside allow-roots get per-item error, not a top-level 403."""
    _skip_if_no_model(insightface_available)
    resp = client.post("/detect/batch", json={"files": [str(outside_jpeg)]})
    assert resp.status_code == 200
    body = resp.json()
    assert body["total_files"] == 1
    assert body["results"][0]["error"] == "path_not_allowed"


def test_batch_missing_file_per_item_error(
    client, temp_root: Path, insightface_available: bool
) -> None:
    """Missing files get per-item error, not a top-level 404."""
    _skip_if_no_model(insightface_available)
    ghost = str(temp_root / "ghost.jpg")
    resp = client.post("/detect/batch", json={"files": [ghost]})
    assert resp.status_code == 200
    body = resp.json()
    assert body["results"][0]["error"] == "file_not_found"


def test_batch_valid_file_returns_results(
    client, jpeg_on_disk: Path, insightface_available: bool
) -> None:
    _skip_if_no_model(insightface_available)
    resp = client.post("/detect/batch", json={"files": [str(jpeg_on_disk)]})
    assert resp.status_code == 200
    body = resp.json()
    assert body["total_files"] == 1
    assert body["total_faces"] == 0  # solid rectangle has no faces
    result = body["results"][0]
    assert result["faces"] == []
    assert result["image_w"] == _IMG_W
    assert result["image_h"] == _IMG_H
    assert result["error"] is None


# ---- tests: Track I provider auto-detect ----------------------------------


def test_resolve_providers_falls_back_to_cpu_when_only_cpu_available(
    monkeypatch,
) -> None:
    """`_resolve_providers` always returns at least CPU."""
    from tgdl_faces import insight  # noqa: PLC0415

    monkeypatch.setattr(insight, "_available_providers", lambda: ["CPUExecutionProvider"])
    # Even when the operator asks for CUDA, we fall through to CPU rather
    # than crash on a binary that wasn't built with the GPU EP.
    assert insight._resolve_providers("cuda") == ["CPUExecutionProvider"]
    # Unknown name → auto chain → CPU.
    assert insight._resolve_providers("nonsense") == ["CPUExecutionProvider"]


def test_resolve_providers_picks_cuda_first_on_linux(monkeypatch) -> None:
    from tgdl_faces import insight  # noqa: PLC0415
    import platform

    monkeypatch.setattr(platform, "system", lambda: "Linux")
    monkeypatch.setattr(
        insight,
        "_available_providers",
        lambda: [
            "CPUExecutionProvider",
            "CUDAExecutionProvider",
            "TensorrtExecutionProvider",
        ],
    )
    resolved = insight._resolve_providers("auto")
    # CUDA comes first in the Linux auto chain.
    assert resolved[0] == "CUDAExecutionProvider"
    assert resolved[-1] == "CPUExecutionProvider"


def test_resolve_providers_respects_explicit_cpu(monkeypatch) -> None:
    from tgdl_faces import insight  # noqa: PLC0415

    monkeypatch.setattr(
        insight,
        "_available_providers",
        lambda: ["CUDAExecutionProvider", "CPUExecutionProvider"],
    )
    # Even with CUDA available, an operator who pinned "cpu" must get CPU.
    assert insight._resolve_providers("cpu") == ["CPUExecutionProvider"]


def test_resolve_providers_handles_coreml_on_mac(monkeypatch) -> None:
    from tgdl_faces import insight  # noqa: PLC0415

    monkeypatch.setattr(
        insight,
        "_available_providers",
        lambda: ["CoreMLExecutionProvider", "CPUExecutionProvider"],
    )
    resolved = insight._resolve_providers("coreml")
    assert resolved == ["CoreMLExecutionProvider", "CPUExecutionProvider"]


def test_resolve_providers_handles_directml_on_windows(monkeypatch) -> None:
    from tgdl_faces import insight  # noqa: PLC0415

    monkeypatch.setattr(
        insight,
        "_available_providers",
        lambda: ["DmlExecutionProvider", "CPUExecutionProvider"],
    )
    resolved = insight._resolve_providers("directml")
    assert resolved == ["DmlExecutionProvider", "CPUExecutionProvider"]


def test_resolve_providers_accepts_full_provider_names(monkeypatch) -> None:
    """Comma-separated full provider names are passed through directly."""
    from tgdl_faces import insight  # noqa: PLC0415

    monkeypatch.setattr(
        insight,
        "_available_providers",
        lambda: ["CUDAExecutionProvider", "CPUExecutionProvider"],
    )
    resolved = insight._resolve_providers("CUDAExecutionProvider,CPUExecutionProvider")
    assert resolved == ["CUDAExecutionProvider", "CPUExecutionProvider"]


def test_health_seekbar_keys_present(client) -> None:
    """Health endpoint includes all seekbar-required keys."""
    resp = client.get("/health")
    assert resp.status_code == 200
    body = resp.json()
    for key in ("ok", "service", "version", "platform", "arch",
                "ready", "model", "gpu_provider", "gpu_available",
                "providers", "uptime_sec", "stats"):
        assert key in body, f"Missing key in /health: {key}"


def test_health_stats_shape(client) -> None:
    resp = client.get("/health")
    stats = resp.json()["stats"]
    for key in ("requests", "faces_detected", "errors", "avg_ms"):
        assert key in stats, f"Missing stats key: {key}"
    assert isinstance(stats["avg_ms"], (int, float))


def test_health_gpu_fields_types(client) -> None:
    resp = client.get("/health")
    body = resp.json()
    assert isinstance(body["gpu_provider"], str)
    assert isinstance(body["gpu_available"], bool)
    # gpu_available must be consistent with gpu_provider.
    if body["gpu_provider"] == "cpu":
        assert body["gpu_available"] is False
    else:
        assert body["gpu_available"] is True


def test_info_includes_arch(client) -> None:
    resp = client.get("/info")
    assert resp.status_code == 200
    body = resp.json()
    assert "arch" in body
    assert isinstance(body["arch"], str)


def test_det_size_env_override(monkeypatch) -> None:
    """`TGDL_FACES_DET_SIZE` overrides the default 640."""
    from tgdl_faces import insight  # noqa: PLC0415

    monkeypatch.setenv("TGDL_FACES_DET_SIZE", "480")
    assert insight._resolve_det_size() == (480, 480)
    # Garbage value falls back to the default.
    monkeypatch.setenv("TGDL_FACES_DET_SIZE", "not-a-number")
    assert insight._resolve_det_size() == insight.DEFAULT_DET_SIZE
    # Out-of-range value falls back to the default.
    monkeypatch.setenv("TGDL_FACES_DET_SIZE", "999999")
    assert insight._resolve_det_size() == insight.DEFAULT_DET_SIZE


def test_model_dir_singular_env_alias(monkeypatch) -> None:
    """TGDL_FACES_MODEL_DIR (singular) is accepted as an alias."""
    from tgdl_faces import insight  # noqa: PLC0415

    monkeypatch.delenv("TGDL_FACES_MODELS_DIR", raising=False)
    monkeypatch.setenv("TGDL_FACES_MODEL_DIR", "/tmp/test-model-dir")
    result = insight._resolve_models_dir()
    assert "test-model-dir" in str(result)


def test_max_concurrency_env(monkeypatch) -> None:
    from tgdl_faces import insight  # noqa: PLC0415

    monkeypatch.setenv("TGDL_FACES_MAX_CONCURRENCY", "4")
    assert insight._resolve_max_concurrency() == 4
    monkeypatch.setenv("TGDL_FACES_MAX_CONCURRENCY", "bad")
    assert insight._resolve_max_concurrency() == 2  # default fallback


def test_uptime_sec_is_positive(client) -> None:
    resp = client.get("/health")
    assert resp.json()["uptime_sec"] >= 0.0


def test_gpu_provider_derives_correctly(monkeypatch) -> None:
    from tgdl_faces import insight  # noqa: PLC0415

    assert insight._derive_gpu_provider(["CUDAExecutionProvider", "CPUExecutionProvider"]) == "cuda"
    assert insight._derive_gpu_provider(["DmlExecutionProvider", "CPUExecutionProvider"]) == "directml"
    assert insight._derive_gpu_provider(["CoreMLExecutionProvider", "CPUExecutionProvider"]) == "coreml"
    assert insight._derive_gpu_provider(["OpenVINOExecutionProvider", "CPUExecutionProvider"]) == "openvino"
    assert insight._derive_gpu_provider(["CPUExecutionProvider"]) == "cpu"
