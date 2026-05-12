"""Tests for video face detection infrastructure.

Covers:
* ``_dedupe_video_faces`` — identity deduplication across frames.
* ``extract_video_frames`` — cv2-based frame sampler (cv2 fully mocked).
* ``POST /detect/video`` — FastAPI endpoint validation + soft-error paths.

No real insightface / cv2 / model weights needed — all heavy dependencies
are mocked at the module boundary.
"""

from __future__ import annotations

import os
import tempfile
from pathlib import Path
from typing import Iterator
from unittest.mock import MagicMock, patch

import numpy as np
import pytest


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _face(score: float = 0.8, emb: list[float] | None = None) -> dict:
    if emb is None:
        emb = [1.0] + [0.0] * 511
    return {
        "x": 10,
        "y": 10,
        "w": 60,
        "h": 60,
        "score": score,
        "embedding": list(emb),
        "landmarks": [],
    }


def _unit(idx: int, dim: int = 512) -> list[float]:
    """Return an L2-unit vector with 1.0 at position *idx* and 0.0 elsewhere."""
    v = [0.0] * dim
    v[idx] = 1.0
    return v


def _near(idx: int, noise: float = 0.436, dim: int = 512) -> list[float]:
    """Return a vector near _unit(idx): dot product with _unit(idx) ≈ 0.9 (> 0.50)."""
    v = [0.0] * dim
    v[idx] = 0.9
    v[(idx + 1) % dim] = noise
    return v


# ---------------------------------------------------------------------------
# Tests: _dedupe_video_faces
# ---------------------------------------------------------------------------


class TestDedupeVideoFaces:
    def setup_method(self):
        from tgdl_faces.app import _dedupe_video_faces
        self._fn = _dedupe_video_faces

    def test_empty_input_returns_empty(self):
        assert self._fn([]) == []

    def test_single_face_returns_that_face(self):
        f = _face(score=0.9)
        result = self._fn([f])
        assert result == [f]

    def test_same_person_dedupes_to_one_result(self):
        low = _face(score=0.6, emb=_unit(0))
        high = _face(score=0.95, emb=_near(0))
        result = self._fn([low, high])
        assert len(result) == 1
        assert result[0]["score"] == 0.95

    def test_same_person_keeps_higher_score_regardless_of_order(self):
        high = _face(score=0.95, emb=_unit(0))
        low = _face(score=0.6, emb=_near(0))
        result = self._fn([high, low])
        assert len(result) == 1
        assert result[0]["score"] == 0.95

    def test_different_people_keeps_both(self):
        a = _face(score=0.8, emb=_unit(0))
        b = _face(score=0.8, emb=_unit(1))
        result = self._fn([a, b])
        assert len(result) == 2

    def test_three_unique_people_returns_three(self):
        faces = [
            _face(score=0.8, emb=_unit(0)),
            _face(score=0.8, emb=_unit(1)),
            _face(score=0.8, emb=_unit(2)),
            _face(score=0.9, emb=_near(0)),
            _face(score=0.7, emb=_near(1)),
        ]
        result = self._fn(faces)
        assert len(result) == 3

    def test_below_threshold_not_deduped(self):
        a = _face(score=0.8, emb=_unit(0))
        b = _face(score=0.8, emb=_unit(1))
        result = self._fn([a, b])
        assert len(result) == 2
        scores = {r["score"] for r in result}
        assert scores == {0.8}


# ---------------------------------------------------------------------------
# Tests: extract_video_frames
# ---------------------------------------------------------------------------


class TestExtractVideoFrames:
    def _make_frame(self) -> np.ndarray:
        return np.zeros((480, 640, 3), dtype=np.uint8)

    def test_empty_allow_roots_raises_path_not_allowed(self):
        from tgdl_faces.io import PathNotAllowedError, extract_video_frames
        with pytest.raises(PathNotAllowedError):
            extract_video_frames("/some/path/video.mp4", allow_roots=[])

    def test_path_outside_allow_roots_raises_path_not_allowed(self, tmp_path):
        from tgdl_faces.io import PathNotAllowedError, extract_video_frames
        outside = str(tmp_path / "video.mp4")
        with pytest.raises(PathNotAllowedError):
            extract_video_frames(outside, allow_roots=["/not/this/dir"])

    def test_cv2_cannot_open_raises_file_not_found(self, tmp_path):
        from tgdl_faces.io import extract_video_frames

        target = str(tmp_path / "video.mp4")
        Path(target).touch()

        mock_cap = MagicMock()
        mock_cap.isOpened.return_value = False

        mock_cv2 = MagicMock()
        mock_cv2.VideoCapture.return_value = mock_cap
        mock_cv2.CAP_PROP_FPS = 5
        mock_cv2.CAP_PROP_FRAME_COUNT = 7

        with patch("tgdl_faces.io.cv2", mock_cv2):
            with pytest.raises(FileNotFoundError):
                extract_video_frames(target, allow_roots=[str(tmp_path)])

    def test_zero_total_frames_reads_one_frame_and_returns_it(self, tmp_path):
        from tgdl_faces.io import extract_video_frames

        target = str(tmp_path / "video.mp4")
        Path(target).touch()
        frame = self._make_frame()

        mock_cap = MagicMock()
        mock_cap.isOpened.return_value = True
        mock_cap.read.return_value = (True, frame)

        mock_cv2 = MagicMock()
        mock_cv2.VideoCapture.return_value = mock_cap
        mock_cv2.CAP_PROP_FPS = 5
        mock_cv2.CAP_PROP_FRAME_COUNT = 7
        mock_cap.get.side_effect = lambda prop: 0

        with patch("tgdl_faces.io.cv2", mock_cv2):
            result = extract_video_frames(target, allow_roots=[str(tmp_path)])

        assert len(result) == 1
        assert result[0] is frame

    def test_short_clip_under_30s_n_samples_le_3(self, tmp_path):
        from tgdl_faces.io import extract_video_frames

        target = str(tmp_path / "video.mp4")
        Path(target).touch()
        frame = self._make_frame()

        # 5s at 30fps = 150 frames
        fps = 30.0
        total_frames = 150

        mock_cap = MagicMock()
        mock_cap.isOpened.return_value = True
        mock_cap.read.return_value = (True, frame)
        mock_cap.get.side_effect = lambda prop: fps if prop == 5 else float(total_frames)

        mock_cv2 = MagicMock()
        mock_cv2.VideoCapture.return_value = mock_cap
        mock_cv2.CAP_PROP_FPS = 5
        mock_cv2.CAP_PROP_FRAME_COUNT = 7

        with patch("tgdl_faces.io.cv2", mock_cv2):
            result = extract_video_frames(target, allow_roots=[str(tmp_path)])

        assert len(result) <= 3

    def test_medium_clip_30s_to_5min_n_samples_le_30(self, tmp_path):
        from tgdl_faces.io import extract_video_frames

        target = str(tmp_path / "video.mp4")
        Path(target).touch()
        frame = self._make_frame()

        # 3min at 30fps = 5400 frames
        fps = 30.0
        total_frames = 5400

        mock_cap = MagicMock()
        mock_cap.isOpened.return_value = True
        mock_cap.read.return_value = (True, frame)
        mock_cap.get.side_effect = lambda prop: fps if prop == 5 else float(total_frames)

        mock_cv2 = MagicMock()
        mock_cv2.VideoCapture.return_value = mock_cap
        mock_cv2.CAP_PROP_FPS = 5
        mock_cv2.CAP_PROP_FRAME_COUNT = 7

        with patch("tgdl_faces.io.cv2", mock_cv2):
            result = extract_video_frames(target, allow_roots=[str(tmp_path)])

        assert len(result) > 3
        assert len(result) <= 30

    def test_long_clip_5min_to_30min_n_samples_le_60(self, tmp_path):
        from tgdl_faces.io import extract_video_frames

        target = str(tmp_path / "video.mp4")
        Path(target).touch()
        frame = self._make_frame()

        # 15min at 30fps = 27000 frames
        fps = 30.0
        total_frames = 27000

        mock_cap = MagicMock()
        mock_cap.isOpened.return_value = True
        mock_cap.read.return_value = (True, frame)
        mock_cap.get.side_effect = lambda prop: fps if prop == 5 else float(total_frames)

        mock_cv2 = MagicMock()
        mock_cv2.VideoCapture.return_value = mock_cap
        mock_cv2.CAP_PROP_FPS = 5
        mock_cv2.CAP_PROP_FRAME_COUNT = 7

        with patch("tgdl_faces.io.cv2", mock_cv2):
            result = extract_video_frames(target, allow_roots=[str(tmp_path)])

        assert len(result) <= 60

    def test_very_long_clip_over_30min_n_samples_le_max_frames(self, tmp_path):
        from tgdl_faces.io import extract_video_frames

        target = str(tmp_path / "video.mp4")
        Path(target).touch()
        frame = self._make_frame()

        # 1hr at 30fps = 108000 frames
        fps = 30.0
        total_frames = 108000

        mock_cap = MagicMock()
        mock_cap.isOpened.return_value = True
        mock_cap.read.return_value = (True, frame)
        mock_cap.get.side_effect = lambda prop: fps if prop == 5 else float(total_frames)

        mock_cv2 = MagicMock()
        mock_cv2.VideoCapture.return_value = mock_cap
        mock_cv2.CAP_PROP_FPS = 5
        mock_cv2.CAP_PROP_FRAME_COUNT = 7

        with patch("tgdl_faces.io.cv2", mock_cv2):
            result = extract_video_frames(target, allow_roots=[str(tmp_path)], max_frames=120)

        assert len(result) <= 120

    def test_indices_within_bounds(self, tmp_path):
        from tgdl_faces.io import extract_video_frames

        target = str(tmp_path / "video.mp4")
        Path(target).touch()
        frame = self._make_frame()

        fps = 30.0
        total_frames = 5400
        seen_indices = []

        def cap_set(prop, value):
            if prop == 8:
                seen_indices.append(value)

        mock_cap = MagicMock()
        mock_cap.isOpened.return_value = True
        mock_cap.read.return_value = (True, frame)
        mock_cap.get.side_effect = lambda prop: fps if prop == 5 else float(total_frames)
        mock_cap.set.side_effect = cap_set

        mock_cv2 = MagicMock()
        mock_cv2.VideoCapture.return_value = mock_cap
        mock_cv2.CAP_PROP_FPS = 5
        mock_cv2.CAP_PROP_FRAME_COUNT = 7
        mock_cv2.CAP_PROP_POS_FRAMES = 8

        with patch("tgdl_faces.io.cv2", mock_cv2):
            extract_video_frames(target, allow_roots=[str(tmp_path)])

        for idx in seen_indices:
            assert 0 <= idx <= total_frames - 1

    def test_cap_release_called_even_when_empty_frames(self, tmp_path):
        from tgdl_faces.io import extract_video_frames

        target = str(tmp_path / "video.mp4")
        Path(target).touch()

        fps = 30.0
        total_frames = 150

        mock_cap = MagicMock()
        mock_cap.isOpened.return_value = True
        mock_cap.read.return_value = (False, None)
        mock_cap.get.side_effect = lambda prop: fps if prop == 5 else float(total_frames)

        mock_cv2 = MagicMock()
        mock_cv2.VideoCapture.return_value = mock_cap
        mock_cv2.CAP_PROP_FPS = 5
        mock_cv2.CAP_PROP_FRAME_COUNT = 7

        with patch("tgdl_faces.io.cv2", mock_cv2):
            result = extract_video_frames(target, allow_roots=[str(tmp_path)])

        mock_cap.release.assert_called_once()
        assert result == []


# ---------------------------------------------------------------------------
# Fixtures for endpoint tests (mirror test_app.py patterns)
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def temp_root() -> Iterator[Path]:
    with tempfile.TemporaryDirectory(prefix="tgdl-video-test-") as tmp:
        yield Path(tmp).resolve()


@pytest.fixture(scope="module")
def outside_dir() -> Iterator[Path]:
    with tempfile.TemporaryDirectory(prefix="tgdl-video-outside-") as tmp:
        yield Path(tmp).resolve()


@pytest.fixture(scope="module")
def client(temp_root: Path):
    os.environ["TGDL_FACES_ALLOW_ROOTS"] = str(temp_root)
    from fastapi.testclient import TestClient
    from tgdl_faces.app import app
    with TestClient(app) as c:
        yield c


# ---------------------------------------------------------------------------
# Tests: POST /detect/video endpoint
# ---------------------------------------------------------------------------


def test_video_missing_path_returns_422(client) -> None:
    resp = client.post("/detect/video", json={})
    assert resp.status_code in (400, 422)


def test_video_ar_range_lo_ge_hi_returns_422(client, temp_root: Path) -> None:
    resp = client.post(
        "/detect/video",
        json={"path": str(temp_root / "x.mp4"), "ar_range": [1.0, 0.5]},
    )
    assert resp.status_code in (400, 422)


def test_video_ar_range_lo_equals_hi_returns_422(client, temp_root: Path) -> None:
    resp = client.post(
        "/detect/video",
        json={"path": str(temp_root / "x.mp4"), "ar_range": [1.0, 1.0]},
    )
    assert resp.status_code in (400, 422)


def test_video_max_frames_zero_returns_422(client, temp_root: Path) -> None:
    resp = client.post(
        "/detect/video",
        json={"path": str(temp_root / "x.mp4"), "max_frames": 0},
    )
    assert resp.status_code in (400, 422)


def test_video_max_frames_501_returns_422(client, temp_root: Path) -> None:
    resp = client.post(
        "/detect/video",
        json={"path": str(temp_root / "x.mp4"), "max_frames": 501},
    )
    assert resp.status_code in (400, 422)


def test_video_model_not_ready_returns_503(monkeypatch, client, temp_root: Path) -> None:
    from tgdl_faces import insight
    monkeypatch.setattr(insight, "_APP", None)
    monkeypatch.setattr(insight, "_APP_ERROR", None)
    resp = client.post(
        "/detect/video",
        json={"path": str(temp_root / "x.mp4")},
    )
    assert resp.status_code == 503


def test_video_path_outside_allow_roots_returns_403(
    monkeypatch, client, outside_dir: Path
) -> None:
    from tgdl_faces import insight
    monkeypatch.setattr(insight, "_APP", MagicMock())
    monkeypatch.setattr(insight, "_APP_ERROR", None)
    target = str(outside_dir / "outside.mp4")
    resp = client.post("/detect/video", json={"path": target})
    assert resp.status_code == 403
    assert resp.json()["code"] == "path_not_allowed"


def test_video_file_not_found_returns_200_with_error(
    monkeypatch, client, temp_root: Path
) -> None:
    from tgdl_faces import insight
    from tgdl_faces import app as app_mod
    monkeypatch.setattr(insight, "_APP", MagicMock())
    monkeypatch.setattr(insight, "_APP_ERROR", None)

    def _raise_fnf(path, allow_roots, **kwargs):
        raise FileNotFoundError("cv2 cannot open")

    monkeypatch.setattr(app_mod, "extract_video_frames", _raise_fnf)
    resp = client.post(
        "/detect/video",
        json={"path": str(temp_root / "missing.mp4")},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["error"] == "file_not_found"
    assert body["faces"] == []


def test_video_no_frames_extracted_returns_200_with_error(
    monkeypatch, client, temp_root: Path
) -> None:
    from tgdl_faces import insight
    from tgdl_faces import app as app_mod
    monkeypatch.setattr(insight, "_APP", MagicMock())
    monkeypatch.setattr(insight, "_APP_ERROR", None)

    monkeypatch.setattr(app_mod, "extract_video_frames", lambda *a, **kw: [])
    resp = client.post(
        "/detect/video",
        json={"path": str(temp_root / "empty.mp4")},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["error"] == "no_frames"
    assert body["faces"] == []
