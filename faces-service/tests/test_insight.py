"""Unit tests for tgdl_faces.insight — dimension cap, bbox scaling, provider chain.

These tests do NOT require insightface / buffalo_l to be installed.
They exercise the helper functions and the image-resize logic in isolation
by monkey-patching the model-loading functions.
"""

from __future__ import annotations

import platform
from unittest.mock import MagicMock, patch

import numpy as np
import pytest

from tgdl_faces import insight


# ── _resolve_max_image_dim ────────────────────────────────────────────────────


def test_max_dim_default(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("TGDL_FACES_MAX_IMAGE_DIM", raising=False)
    assert insight._resolve_max_image_dim() == 2048


def test_max_dim_custom(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("TGDL_FACES_MAX_IMAGE_DIM", "1280")
    assert insight._resolve_max_image_dim() == 1280


def test_max_dim_zero_disables(monkeypatch: pytest.MonkeyPatch) -> None:
    """Setting MAX_IMAGE_DIM=0 disables the cap."""
    monkeypatch.setenv("TGDL_FACES_MAX_IMAGE_DIM", "0")
    assert insight._resolve_max_image_dim() == 0


def test_max_dim_invalid_falls_back(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("TGDL_FACES_MAX_IMAGE_DIM", "not-a-number")
    assert insight._resolve_max_image_dim() == 2048


def test_max_dim_negative_falls_back(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("TGDL_FACES_MAX_IMAGE_DIM", "-100")
    assert insight._resolve_max_image_dim() == 2048


# ── Tiny 1×1 image (no face) ─────────────────────────────────────────────────


def _fake_app_no_faces() -> MagicMock:
    """Return a mock FaceAnalysis that always reports no detections."""
    mock = MagicMock()
    mock.get.return_value = []
    return mock


def test_detect_1x1_image_no_crash(monkeypatch: pytest.MonkeyPatch) -> None:
    """A 1×1 image is valid input and must not crash the pipeline."""
    mock_app = _fake_app_no_faces()
    monkeypatch.setattr(insight, "_APP", mock_app)
    monkeypatch.setattr(insight, "_APP_ERROR", None)
    monkeypatch.delenv("TGDL_FACES_MAX_IMAGE_DIM", raising=False)

    img = np.zeros((1, 1, 3), dtype=np.uint8)
    result = insight.detect_and_embed(img, _track_stats=False)
    assert result == []


def test_detect_no_face_image_returns_empty(monkeypatch: pytest.MonkeyPatch) -> None:
    """Solid grey 400×400 image (no face) must return an empty list."""
    mock_app = _fake_app_no_faces()
    monkeypatch.setattr(insight, "_APP", mock_app)
    monkeypatch.setattr(insight, "_APP_ERROR", None)

    img = np.full((400, 400, 3), 128, dtype=np.uint8)
    result = insight.detect_and_embed(img, _track_stats=False)
    assert result == []


# ── Large image resize + bbox coordinate scaling ─────────────────────────────


def _make_mock_face(
    x1: float, y1: float, x2: float, y2: float, score: float = 0.9
) -> MagicMock:
    """Build a mock insightface Face object with controlled bbox + embedding."""
    face = MagicMock()
    face.bbox = np.array([x1, y1, x2, y2], dtype=np.float32)
    face.det_score = score
    # 512-dim unit vector (all equal, normalised)
    emb = np.ones(512, dtype=np.float32)
    emb /= np.linalg.norm(emb)
    face.normed_embedding = emb
    face.kps = np.zeros((5, 2), dtype=np.float32)
    return face


def test_large_image_is_resized_and_bbox_scaled_back(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A 4096×4096 image with MAX_IMAGE_DIM=2048 must scale bbox back to 4096 coords."""
    monkeypatch.setenv("TGDL_FACES_MAX_IMAGE_DIM", "2048")

    # Fake face at (100, 100, 300, 300) in the *resized* (2048×2048) space.
    # After scaling back by 2× the expected original coords are (200, 200, 400, 400).
    mock_face = _make_mock_face(100.0, 100.0, 300.0, 300.0)
    mock_app = MagicMock()
    mock_app.get.return_value = [mock_face]

    monkeypatch.setattr(insight, "_APP", mock_app)
    monkeypatch.setattr(insight, "_APP_ERROR", None)

    img = np.zeros((4096, 4096, 3), dtype=np.uint8)
    result = insight.detect_and_embed(
        img, min_score=0.5, min_box_px=10, _track_stats=False
    )

    assert len(result) == 1
    face_out = result[0]
    # Scale factor = 2048/4096 = 0.5, so original coords = detected / 0.5 = ×2
    assert face_out["x"] == pytest.approx(200, abs=2)
    assert face_out["y"] == pytest.approx(200, abs=2)
    assert face_out["w"] == pytest.approx(400, abs=2)
    assert face_out["h"] == pytest.approx(400, abs=2)
    # Landmarks must also be scaled back.
    assert len(face_out["landmarks"]) == 5
    for lm in face_out["landmarks"]:
        # Original landmarks are zero in detect space → still 0 after scaling
        assert lm[0] == pytest.approx(0.0, abs=0.01)
        assert lm[1] == pytest.approx(0.0, abs=0.01)


def test_max_dim_zero_disables_resize(monkeypatch: pytest.MonkeyPatch) -> None:
    """When MAX_IMAGE_DIM=0 the image is passed to the model unchanged."""
    monkeypatch.setenv("TGDL_FACES_MAX_IMAGE_DIM", "0")

    # Face bbox at (50, 50, 150, 150) in the *original* image space (2000×2000).
    mock_face = _make_mock_face(50.0, 50.0, 150.0, 150.0)
    mock_app = MagicMock()
    mock_app.get.return_value = [mock_face]

    monkeypatch.setattr(insight, "_APP", mock_app)
    monkeypatch.setattr(insight, "_APP_ERROR", None)

    img = np.zeros((2000, 2000, 3), dtype=np.uint8)
    result = insight.detect_and_embed(
        img, min_score=0.5, min_box_px=10, _track_stats=False
    )

    assert len(result) == 1
    face_out = result[0]
    # No resize means coords are returned as-is (scale=1.0).
    assert face_out["x"] == 50
    assert face_out["y"] == 50
    assert face_out["w"] == 100
    assert face_out["h"] == 100


def test_small_image_not_resized(monkeypatch: pytest.MonkeyPatch) -> None:
    """Images smaller than MAX_IMAGE_DIM must not be upscaled."""
    monkeypatch.setenv("TGDL_FACES_MAX_IMAGE_DIM", "2048")

    mock_face = _make_mock_face(10.0, 10.0, 110.0, 110.0)
    mock_app = MagicMock()
    mock_app.get.return_value = [mock_face]

    monkeypatch.setattr(insight, "_APP", mock_app)
    monkeypatch.setattr(insight, "_APP_ERROR", None)

    # 400×400 < 2048 → no resize → scale stays 1.0
    img = np.zeros((400, 400, 3), dtype=np.uint8)
    result = insight.detect_and_embed(
        img, min_score=0.5, min_box_px=10, _track_stats=False
    )

    assert len(result) == 1
    assert result[0]["x"] == 10
    assert result[0]["y"] == 10
    assert result[0]["w"] == 100
    assert result[0]["h"] == 100


# ── ARM64 provider chain ──────────────────────────────────────────────────────


def test_arm64_linux_skips_cuda(monkeypatch: pytest.MonkeyPatch) -> None:
    """On Linux aarch64, CUDA must not appear in the auto chain."""
    monkeypatch.setattr(platform, "system", lambda: "Linux")
    monkeypatch.setattr(platform, "machine", lambda: "aarch64")

    chain = insight._platform_aware_auto_chain()
    assert "CUDAExecutionProvider" not in chain
    assert "CPUExecutionProvider" in chain


def test_arm64_linux_prefers_openvino_over_cpu(monkeypatch: pytest.MonkeyPatch) -> None:
    """OpenVINO must be preferred over bare CPU on Linux aarch64."""
    monkeypatch.setattr(platform, "system", lambda: "Linux")
    monkeypatch.setattr(platform, "machine", lambda: "aarch64")

    chain = insight._platform_aware_auto_chain()
    if "OpenVINOExecutionProvider" in chain:
        ov_idx = chain.index("OpenVINOExecutionProvider")
        cpu_idx = chain.index("CPUExecutionProvider")
        assert ov_idx < cpu_idx


def test_arm64_arm64_alias_also_handled(monkeypatch: pytest.MonkeyPatch) -> None:
    """The 'arm64' machine alias (macOS/Windows ARM) must also skip CUDA on Linux."""
    monkeypatch.setattr(platform, "system", lambda: "Linux")
    monkeypatch.setattr(platform, "machine", lambda: "arm64")

    chain = insight._platform_aware_auto_chain()
    assert "CUDAExecutionProvider" not in chain


def test_x86_linux_includes_cuda(monkeypatch: pytest.MonkeyPatch) -> None:
    """CUDA must appear first in the auto chain on Linux x86_64."""
    monkeypatch.setattr(platform, "system", lambda: "Linux")
    monkeypatch.setattr(platform, "machine", lambda: "x86_64")

    chain = insight._platform_aware_auto_chain()
    assert chain[0] == "CUDAExecutionProvider"


def test_windows_auto_chain_prefers_directml(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(platform, "system", lambda: "Windows")
    monkeypatch.setattr(platform, "machine", lambda: "AMD64")

    chain = insight._platform_aware_auto_chain()
    assert chain[0] == "DmlExecutionProvider"


# ── Quality filter correctness ────────────────────────────────────────────────


def test_quality_filter_min_score(monkeypatch: pytest.MonkeyPatch) -> None:
    """Faces with score < min_score must be dropped."""
    mock_face = _make_mock_face(0.0, 0.0, 100.0, 100.0, score=0.3)
    mock_app = MagicMock()
    mock_app.get.return_value = [mock_face]

    monkeypatch.setattr(insight, "_APP", mock_app)
    monkeypatch.setattr(insight, "_APP_ERROR", None)
    monkeypatch.delenv("TGDL_FACES_MAX_IMAGE_DIM", raising=False)

    img = np.zeros((400, 400, 3), dtype=np.uint8)
    result = insight.detect_and_embed(img, min_score=0.5, _track_stats=False)
    assert result == []


def test_quality_filter_min_box_px(monkeypatch: pytest.MonkeyPatch) -> None:
    """Faces with shorter edge < min_box_px must be dropped."""
    # 40×40 box — shorter edge is 40, below default min_box_px=80
    mock_face = _make_mock_face(0.0, 0.0, 40.0, 40.0, score=0.9)
    mock_app = MagicMock()
    mock_app.get.return_value = [mock_face]

    monkeypatch.setattr(insight, "_APP", mock_app)
    monkeypatch.setattr(insight, "_APP_ERROR", None)
    monkeypatch.delenv("TGDL_FACES_MAX_IMAGE_DIM", raising=False)

    img = np.zeros((400, 400, 3), dtype=np.uint8)
    result = insight.detect_and_embed(img, min_box_px=80, _track_stats=False)
    assert result == []


def test_quality_filter_ar_range(monkeypatch: pytest.MonkeyPatch) -> None:
    """Faces with aspect ratio outside ar_range must be dropped."""
    # 10×100 box → ratio = 0.1, below the default lo=0.5
    mock_face = _make_mock_face(0.0, 0.0, 10.0, 100.0, score=0.9)
    mock_app = MagicMock()
    mock_app.get.return_value = [mock_face]

    monkeypatch.setattr(insight, "_APP", mock_app)
    monkeypatch.setattr(insight, "_APP_ERROR", None)
    monkeypatch.delenv("TGDL_FACES_MAX_IMAGE_DIM", raising=False)

    img = np.zeros((400, 400, 3), dtype=np.uint8)
    result = insight.detect_and_embed(
        img, min_box_px=5, ar_range=(0.5, 2.0), _track_stats=False
    )
    assert result == []


# ── Embedding dimension guard ─────────────────────────────────────────────────


def test_wrong_embedding_dim_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    """An embedding with the wrong dimension must raise RuntimeError."""
    face = MagicMock()
    face.bbox = np.array([0.0, 0.0, 100.0, 100.0], dtype=np.float32)
    face.det_score = 0.9
    face.normed_embedding = np.ones(128, dtype=np.float32)  # wrong dim
    face.kps = np.zeros((5, 2), dtype=np.float32)

    mock_app = MagicMock()
    mock_app.get.return_value = [face]

    monkeypatch.setattr(insight, "_APP", mock_app)
    monkeypatch.setattr(insight, "_APP_ERROR", None)
    monkeypatch.delenv("TGDL_FACES_MAX_IMAGE_DIM", raising=False)

    img = np.zeros((400, 400, 3), dtype=np.uint8)
    with pytest.raises(RuntimeError, match="embedding dim mismatch"):
        insight.detect_and_embed(img, min_box_px=1, _track_stats=False)
