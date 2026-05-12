"""Image input helpers for the sidecar.

Two ingress paths:

* :func:`load_image_from_path` — the sidecar reads bytes off disk.
  Cheap on standalone installs where the sidecar shares the host
  filesystem with the Node app, but requires an allow-list to stop
  forged requests from reading arbitrary files. The Node side passes
  the absolute path under ``data/downloads``; the allow-list is
  injected via ``TGDL_FACES_ALLOW_ROOTS``.

* :func:`load_image_from_b64` — Node ships the bytes as base64.
  Used in the Docker compose deployment where the sidecar container
  doesn't share a volume with the Node container, and as a fallback
  whenever path mode trips the allow-list.

Both helpers return an ``H×W×3`` ``uint8`` BGR ndarray (the layout
:mod:`cv2` produces and :mod:`insightface` expects).
"""

from __future__ import annotations

import base64
import binascii
import logging
import os
from pathlib import Path

import cv2
import numpy as np


_LOG = logging.getLogger(__name__)


class PathNotAllowedError(PermissionError):
    """Raised when ``path`` falls outside any allowed root.

    The FastAPI layer maps this to a ``403`` response.
    """


class ImageDecodeError(ValueError):
    """Raised when bytes are valid but can't be decoded as an image format.

    The FastAPI layer maps this to a soft 200 with ``{"error": "decode_failed"}``
    so the Node retry loop doesn't crash on a single corrupt frame.
    """


class Base64DecodeError(ImageDecodeError):
    """Raised when the ``image_b64`` string is not valid base64.

    Distinct from :class:`ImageDecodeError` so the FastAPI layer can
    return ``415 Unsupported Media Type`` (the client sent garbage, not an
    image in an unexpected format).
    """


def _norm(p: str | os.PathLike[str]) -> str:
    """Resolve, normalise and casefold a path for prefix comparison.

    Windows is case-insensitive on the filesystem, so the allow-list
    check needs to be too — otherwise ``C:\\Data\\downloads`` and
    ``c:\\data\\downloads`` would be treated as different roots and a
    legitimate request from the Node side would 403.
    """
    return os.path.normcase(os.path.realpath(str(p)))


def _is_under(path: str, root: str) -> bool:
    """Return True iff ``path`` lives at or below ``root``.

    Uses ``os.path.commonpath`` over normalised, real-path-resolved
    inputs so symlink trickery can't escape the allow-list. Both inputs
    must already be absolute — callers pass realpath output.
    """
    if not path or not root:
        return False
    try:
        common = os.path.commonpath([path, root])
    except ValueError:
        # Different drives on Windows raise ValueError — treat as
        # "not under".
        return False
    return common == root


def _apply_exif_orientation(bgr: np.ndarray, raw_bytes: bytes) -> np.ndarray:
    """Rotate/flip ``bgr`` to match the EXIF orientation tag in ``raw_bytes``.

    ``cv2.imdecode`` ignores EXIF rotation tags (orientations 3, 6, 8),
    which causes portrait photos taken on phones to appear sideways or
    upside-down when fed directly to the face detector.  Pillow reads EXIF
    reliably on all platforms (including Windows where libjpeg-turbo can
    behave differently), so we use it as the authority for the rotation.

    Orientations:
      1 — normal (no-op)
      3 — 180° rotation
      6 — 90° clockwise (270° counter-clockwise)
      8 — 90° counter-clockwise (270° clockwise)

    All other values are treated as no-op to avoid breaking unusual EXIF
    data.
    """
    try:
        from PIL import Image  # noqa: PLC0415
        import io as _io  # noqa: PLC0415

        with Image.open(_io.BytesIO(raw_bytes)) as pil_img:
            exif = pil_img.getexif() if hasattr(pil_img, "getexif") else {}
            # Tag 0x0112 is Orientation
            orientation = exif.get(0x0112, 1) if exif else 1
    except Exception:
        # Pillow not importable, image has no EXIF, or EXIF is unreadable —
        # return the image as-is so we don't silently break non-JPEG inputs.
        return bgr

    if orientation == 3:
        # 180° rotation
        return cv2.rotate(bgr, cv2.ROTATE_180)
    if orientation == 6:
        # 90° clockwise
        return cv2.rotate(bgr, cv2.ROTATE_90_CLOCKWISE)
    if orientation == 8:
        # 90° counter-clockwise
        return cv2.rotate(bgr, cv2.ROTATE_90_COUNTERCLOCKWISE)
    return bgr


def load_image_from_path(path: str, allow_roots: list[str]) -> np.ndarray:
    """Read ``path`` off disk after checking the allow-list.

    Parameters
    ----------
    path
        Absolute path supplied by the caller (the Node side).
    allow_roots
        Whitelist of absolute roots — ``path`` must resolve inside
        one of them. If empty, every request is rejected: that's the
        opt-in stance the README documents.

    Raises
    ------
    PathNotAllowedError
        ``path`` doesn't resolve under any allow_root.
    FileNotFoundError
        The file is missing or unreadable as an image.
    """
    if not path:
        raise FileNotFoundError("empty path")
    if not allow_roots:
        raise PathNotAllowedError(
            "path mode is disabled (TGDL_FACES_ALLOW_ROOTS is empty)"
        )

    target = _norm(path)
    roots = [_norm(r) for r in allow_roots if r]
    if not any(_is_under(target, r) for r in roots):
        raise PathNotAllowedError(f"path {path!r} is outside TGDL_FACES_ALLOW_ROOTS")

    # cv2.imread silently returns None on missing/unreadable files
    # *and* on un-decodable bytes. Read+imdecode so we can tell those
    # cases apart cleanly.
    try:
        with open(target, "rb") as fh:
            raw = fh.read()
    except (OSError, FileNotFoundError) as exc:
        raise FileNotFoundError(f"could not read {path!r}: {exc}") from exc

    if not raw:
        raise FileNotFoundError(f"file {path!r} is empty")

    buf = np.frombuffer(raw, dtype=np.uint8)
    img = cv2.imdecode(buf, cv2.IMREAD_COLOR)
    if img is None:
        # cv2 fails on animated WebP and some uncommon encodings — try Pillow.
        # For animated images (animated WebP, APNG, GIF) the image object
        # starts at frame 0 but some Pillow builds reject convert("RGB") until
        # seek(0) is called explicitly to materialise a concrete frame.
        try:
            from PIL import Image as _PilImage  # noqa: PLC0415
            import io as _bio  # noqa: PLC0415
            with _PilImage.open(_bio.BytesIO(raw)) as pil:
                try:
                    pil.seek(0)
                except (AttributeError, EOFError):
                    pass
                frame = pil.convert("RGB")
                img = cv2.cvtColor(np.array(frame, dtype=np.uint8), cv2.COLOR_RGB2BGR)
        except Exception:
            img = None
    if img is None:
        raise ImageDecodeError(f"failed to decode image at {path!r}")
    return _apply_exif_orientation(img, raw)


def extract_video_frames(
    path: str,
    allow_roots: list[str],
    max_frames: int = 120,
) -> list[np.ndarray]:
    """Extract evenly-spaced frames from a video using cv2.VideoCapture.

    Frames are returned as in-memory BGR ndarrays — no temp files written.
    Sample count adapts to video duration so short clips get at least one
    frame and very long videos stay under ``max_frames``.

    Raises
    ------
    PathNotAllowedError
        ``path`` falls outside TGDL_FACES_ALLOW_ROOTS.
    FileNotFoundError
        ``path`` is missing or cv2 cannot open it as a video.
    """
    if not allow_roots:
        raise PathNotAllowedError(
            "path mode is disabled (TGDL_FACES_ALLOW_ROOTS is empty)"
        )
    target = _norm(path)
    roots = [_norm(r) for r in allow_roots if r]
    if not any(_is_under(target, r) for r in roots):
        raise PathNotAllowedError(f"path {path!r} is outside TGDL_FACES_ALLOW_ROOTS")

    cap = cv2.VideoCapture(target)
    if not cap.isOpened():
        raise FileNotFoundError(f"cv2 cannot open video {path!r}")

    try:
        raw_fps = cap.get(cv2.CAP_PROP_FPS)
        fps = raw_fps if raw_fps and raw_fps > 0 else 25.0
        total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))

        if total_frames <= 0:
            # Some containers don't report frame count — grab one frame.
            ret, frame = cap.read()
            return [frame] if (ret and frame is not None) else []

        duration = total_frames / fps

        # Adaptive sample count: more frames for short clips, fewer for long.
        if duration < 30:
            n_samples = min(3, total_frames)
        elif duration < 300:       # < 5 min
            n_samples = min(30, max_frames)
        elif duration < 1800:      # < 30 min
            n_samples = min(60, max_frames)
        else:
            n_samples = max_frames

        n_samples = max(1, min(n_samples, total_frames))

        if n_samples == 1:
            indices = [total_frames // 2]
        else:
            step = (total_frames - 1) / (n_samples - 1)
            indices = [
                min(int(round(i * step)), total_frames - 1)
                for i in range(n_samples)
            ]

        frames: list[np.ndarray] = []
        for idx in indices:
            cap.set(cv2.CAP_PROP_POS_FRAMES, float(idx))
            ret, frame = cap.read()
            if ret and frame is not None:
                frames.append(frame)
        return frames
    finally:
        cap.release()


def load_image_from_b64(data: str) -> np.ndarray:
    """Decode a base64-encoded image into a BGR ndarray.

    Strips an optional ``data:image/...;base64,`` prefix to be tolerant
    of Web-platform pasting habits.

    Raises
    ------
    ImageDecodeError
        The bytes can't be base64-decoded or aren't a recognised image
        format.
    """
    if not data or not isinstance(data, str):
        raise Base64DecodeError("image_b64 must be a non-empty string")

    payload = data.strip()
    if payload.startswith("data:") and ";base64," in payload:
        payload = payload.split(";base64,", 1)[1]

    try:
        raw = base64.b64decode(payload, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise Base64DecodeError(f"image_b64 is not valid base64: {exc}") from exc

    if not raw:
        raise Base64DecodeError("image_b64 decoded to zero bytes")

    buf = np.frombuffer(raw, dtype=np.uint8)
    img = cv2.imdecode(buf, cv2.IMREAD_COLOR)
    if img is None:
        raise ImageDecodeError("image_b64 bytes could not be decoded as an image")
    return _apply_exif_orientation(img, raw)
