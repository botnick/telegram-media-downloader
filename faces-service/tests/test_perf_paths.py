"""Tests for the CPU-budget / pre-filter / orientation / streaming changes.

No insightface model needed: detection is faked with objects shaped like
``insightface.app.FaceAnalysis`` (``det_model`` + ``models`` dict) so the
pre-embedding gate can be checked against the upstream ``get()`` path.
"""

from __future__ import annotations

import io as io_mod
from unittest.mock import MagicMock

import cv2
import numpy as np
import pytest
from PIL import Image

from tgdl_faces import insight
from tgdl_faces import io as fio


# ── CPU budget ───────────────────────────────────────────────────────────────


def test_cgroup_v2_quota_caps_effective_cpus(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(insight, "_cgroup_cpu_limit", lambda: 2.5)
    monkeypatch.setattr(insight.os, "cpu_count", lambda: 32)
    if hasattr(insight.os, "sched_getaffinity"):
        monkeypatch.setattr(insight.os, "sched_getaffinity", lambda _pid: set(range(32)))
    assert insight.effective_cpu_count() == 3  # ceil(2.5)


def test_budget_split_across_concurrency(monkeypatch: pytest.MonkeyPatch) -> None:
    for k in ("TGDL_FACES_CPU_THREADS", "TGDL_FACES_RESERVE_CPUS",
              "TGDL_FACES_MAX_CONCURRENCY", "TGDL_FACES_INTRA_OP_THREADS"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setattr(insight, "effective_cpu_count", lambda: 8)
    monkeypatch.setattr(insight, "_GPU_PROVIDER", "cpu")
    assert insight.cpu_budget() == 8
    assert insight._resolve_max_concurrency() == 2
    assert insight.intra_op_threads() == 4
    monkeypatch.setenv("TGDL_FACES_RESERVE_CPUS", "1")
    assert insight.cpu_budget() == 7
    assert insight.intra_op_threads() == 3
    monkeypatch.setenv("TGDL_FACES_CPU_THREADS", "1")
    # A one-core budget never runs two requests side by side.
    assert insight._resolve_max_concurrency() == 1
    assert insight.intra_op_threads() == 1


def test_explicit_env_wins(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("TGDL_FACES_MAX_CONCURRENCY", "3")
    monkeypatch.setenv("TGDL_FACES_INTRA_OP_THREADS", "5")
    assert insight._resolve_max_concurrency() == 3
    assert insight.intra_op_threads() == 5


def test_cpu_session_options(monkeypatch: pytest.MonkeyPatch) -> None:
    ort = pytest.importorskip("onnxruntime")
    monkeypatch.setenv("TGDL_FACES_INTRA_OP_THREADS", "3")
    monkeypatch.delenv("TGDL_FACES_ORT_SPIN", raising=False)
    so = insight._cpu_session_options()
    assert so.intra_op_num_threads == 3
    assert so.inter_op_num_threads == 1
    assert so.execution_mode == ort.ExecutionMode.ORT_SEQUENTIAL
    assert so.get_session_config_entry("session.intra_op.allow_spinning") == "0"


# ── Pre-embedding quality gate ───────────────────────────────────────────────


class _FakeDet:
    def __init__(self, dets: np.ndarray) -> None:
        self.dets = dets

    def detect(self, img, max_num=0, metric="default"):
        kps = np.zeros((len(self.dets), 5, 2), dtype=np.float32)
        return self.dets.copy(), kps


class _CountingModel:
    """Stands in for recognition / landmark models: records calls."""

    def __init__(self, task: str) -> None:
        self.task = task
        self.calls = 0

    def get(self, img, face):
        self.calls += 1
        if self.task == "recognition":
            # insightface derives normed_embedding from embedding.
            face.embedding = np.ones(512, dtype=np.float32)
        else:
            face["pose"] = np.array([1.0, 2.0, 3.0], dtype=np.float32)


def _fake_app(dets):
    pytest.importorskip("insightface")
    rec = _CountingModel("recognition")
    lmk = _CountingModel("landmark_3d_68")
    app = MagicMock(spec=["det_model", "models", "get"])
    app.det_model = _FakeDet(np.asarray(dets, dtype=np.float32))
    app.models = {"detection": app.det_model, "landmark_3d_68": lmk, "recognition": rec}

    def _upstream_get(img, max_num=0):
        # insightface FaceAnalysis.get(): every model on every detection.
        from insightface.app.common import Face

        bboxes, kpss = app.det_model.detect(img)
        out = []
        for i in range(bboxes.shape[0]):
            face = Face(bbox=bboxes[i, 0:4], kps=kpss[i], det_score=bboxes[i, 4])
            for task, model in app.models.items():
                if task != "detection":
                    model.get(img, face)
            out.append(face)
        return out

    app.get.side_effect = _upstream_get
    return app, rec, lmk


DETS = [
    [10, 10, 210, 210, 0.95],  # kept
    [300, 10, 320, 30, 0.90],  # 20 px — below min_box_px
    [10, 250, 150, 390, 0.30],  # score below min_score
    [200, 250, 390, 280, 0.90],  # 190×30 — aspect ratio out of range
    [220, 10, 390, 190, 0.80],  # kept
]


def test_gate_runs_models_only_on_kept_faces(monkeypatch: pytest.MonkeyPatch) -> None:
    app, rec, lmk = _fake_app(DETS)
    monkeypatch.setattr(insight, "_APP", app)
    monkeypatch.setattr(insight, "_APP_ERROR", None)
    img = np.zeros((400, 400, 3), dtype=np.uint8)
    fast = insight.detect_and_embed(img, min_score=0.5, min_box_px=60, _track_stats=False)
    assert rec.calls == 2 and lmk.calls == 2

    # Same output as the upstream every-face path.
    rec.calls = lmk.calls = 0
    monkeypatch.setattr(insight, "_analyse", lambda a, i, keep: a.get(i))
    slow = insight.detect_and_embed(img, min_score=0.5, min_box_px=60, _track_stats=False)
    assert rec.calls == 5
    assert fast == slow
    assert [(f["x"], f["y"], f["w"], f["h"]) for f in fast] == [(10, 10, 200, 200), (220, 10, 170, 180)]


# ── EXIF orientation (decoded exactly once) ──────────────────────────────────


@pytest.mark.parametrize("orientation", range(1, 9))
def test_exif_orientation_applied_once(orientation: int) -> None:
    from PIL import ImageOps

    rng = np.random.default_rng(orientation)
    base = Image.fromarray(rng.integers(0, 255, (60, 90, 3), dtype=np.uint8))
    exif = Image.Exif()
    exif[0x0112] = orientation
    buf = io_mod.BytesIO()
    base.save(buf, "PNG", exif=exif.tobytes())
    raw = buf.getvalue()
    import base64

    got = fio.load_image_from_b64(base64.b64encode(raw).decode())
    want = cv2.cvtColor(
        np.array(ImageOps.exif_transpose(Image.open(io_mod.BytesIO(raw))).convert("RGB")),
        cv2.COLOR_RGB2BGR,
    )
    assert got.shape == want.shape
    assert np.array_equal(got, want)


def test_jpeg_portrait_is_upright(tmp_path) -> None:
    """Phone portrait: raw pixels landscape + Orientation 6. Used to come out
    rotated a second time (cv2 already applies the tag)."""
    upright = np.zeros((120, 80, 3), dtype=np.uint8)
    upright[:40] = (0, 0, 255)  # red band on top when upright
    raw = cv2.rotate(upright, cv2.ROTATE_90_COUNTERCLOCKWISE)
    pil = Image.fromarray(cv2.cvtColor(raw, cv2.COLOR_BGR2RGB))
    exif = Image.Exif()
    exif[0x0112] = 6
    p = tmp_path / "portrait.jpg"
    pil.save(p, "JPEG", quality=95, exif=exif.tobytes())
    img = fio.load_image_from_path(str(p), [str(tmp_path)])
    assert img.shape[:2] == (120, 80)
    assert img[10, 40, 2] > 200 and img[10, 40, 0] < 60  # red at the top


# ── Streaming video frames ───────────────────────────────────────────────────


def test_iter_video_frames_with_time(tmp_path) -> None:
    path = tmp_path / "clip.avi"
    writer = cv2.VideoWriter(str(path), cv2.VideoWriter_fourcc(*"MJPG"), 10.0, (64, 48))
    if not writer.isOpened():
        pytest.skip("no video writer backend")
    for i in range(50):  # 5 s at 10 fps
        writer.write(np.full((48, 64, 3), i * 5, dtype=np.uint8))
    writer.release()
    it = fio.iter_video_frames(str(path), [str(tmp_path)], with_time=True)
    pairs = list(it)
    assert len(pairs) == 3  # < 30 s clip → 3 samples
    times = [t for t, _ in pairs]
    assert times[0] == 0.0 and times[-1] == pytest.approx(4.9, abs=0.01)
    assert all(frame.shape == (48, 64, 3) for _, frame in pairs)
    # Plain mode still yields bare frames (extract_video_frames contract).
    assert len(fio.extract_video_frames(str(path), [str(tmp_path)])) == 3


def test_video_faces_carry_frame_time(monkeypatch: pytest.MonkeyPatch) -> None:
    import json

    from tgdl_faces import app as app_mod

    monkeypatch.setattr(insight, "_APP", MagicMock())
    monkeypatch.setattr(insight, "_APP_ERROR", None)
    monkeypatch.setattr(insight, "_GPU_PROVIDER", "cpu")
    frame = np.zeros((48, 64, 3), dtype=np.uint8)
    monkeypatch.setattr(
        app_mod, "iter_video_frames", lambda *a, **kw: iter([(0.0, frame), (2.5, frame)])
    )
    emb = [1.0] + [0.0] * 511
    faces_per_frame = iter([
        [],
        [{"x": 1, "y": 2, "w": 90, "h": 90, "score": 0.9, "quality_score": 0.0,
          "embedding": emb, "landmarks": []}],
    ])
    monkeypatch.setattr(app_mod, "detect_and_embed", lambda f, **kw: next(faces_per_frame))
    resp = app_mod._do_detect_video_sync(app_mod.VideoDetectRequest(path="/x/clip.mp4"))
    body = json.loads(resp.body)
    assert body["faces"][0]["frame_time_sec"] == 2.5
    assert body["image_w"] == 64 and body["image_h"] == 48
