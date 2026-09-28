"""Image input helpers for the sidecar.

Two ingress paths:

* :func:`load_image_from_path` — the sidecar reads bytes off disk.
  Cheap on standalone installs where the sidecar shares the host
  filesystem with the Node app, but requires an allow-list to stop
  forged requests from reading arbitrary files. The Node side passes
  the absolute path under ``data/downloads``; the allow-list is
  injected via ``TGDL_FACES_ALLOW_ROOTS``.

* :func:`load_image_from_b64` — Node ships the bytes as base64.
* :func:`load_image_from_bytes` — Node ships the raw bytes (``/detect/upload``).
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
from collections.abc import Iterator
from pathlib import Path
from typing import Any

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


# Decode flags for every cv2 path. ``cv2.imdecode`` has applied the EXIF
# Orientation tag itself since OpenCV 4.x (verified on 4.10 and 4.13, the
# range pinned in pyproject.toml); the sidecar used to rotate the result a
# second time, so a phone portrait (orientation 6/8) reached the detector
# sideways and an orientation-3 shot upside down. Decode the raw pixels
# and apply the tag exactly once, below.
_IMREAD_FLAGS = cv2.IMREAD_COLOR | cv2.IMREAD_IGNORE_ORIENTATION


def _exif_orientation(raw_bytes: bytes) -> int:
    """EXIF Orientation tag (1-8) of an encoded image; 1 when absent."""
    try:
        from PIL import Image  # noqa: PLC0415
        import io as _io  # noqa: PLC0415

        with Image.open(_io.BytesIO(raw_bytes)) as pil_img:
            exif = pil_img.getexif() if hasattr(pil_img, "getexif") else {}
            # Tag 0x0112 is Orientation
            orientation = exif.get(0x0112, 1) if exif else 1
        return int(orientation) if orientation in range(1, 9) else 1
    except Exception:
        # Pillow not importable, image has no EXIF, or EXIF is unreadable.
        return 1


def _apply_exif_orientation(bgr: np.ndarray, raw_bytes: bytes) -> np.ndarray:
    """Rotate/flip raw decoded pixels to match the EXIF orientation tag.

    ``bgr`` must be the *un-oriented* decode (``_IMREAD_FLAGS`` or
    Pillow). Pillow reads EXIF reliably on every platform, so it is the
    authority for the tag. Same transforms as OpenCV / browsers:

      2 mirror · 3 rotate 180° · 4 flip vertical · 5 transpose
      6 rotate 90° CW · 7 transverse · 8 rotate 90° CCW
    """
    orientation = _exif_orientation(raw_bytes)
    if orientation == 2:
        return cv2.flip(bgr, 1)
    if orientation == 3:
        return cv2.rotate(bgr, cv2.ROTATE_180)
    if orientation == 4:
        return cv2.flip(bgr, 0)
    if orientation == 5:
        return cv2.transpose(bgr)
    if orientation == 6:
        return cv2.rotate(bgr, cv2.ROTATE_90_CLOCKWISE)
    if orientation == 7:
        return cv2.rotate(cv2.transpose(bgr), cv2.ROTATE_180)
    if orientation == 8:
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

    # Open with O_NOFOLLOW where available to prevent TOCTOU symlink
    # swap between the realpath() validation above and the actual read.
    _open_flags = os.O_RDONLY
    if hasattr(os, "O_NOFOLLOW"):
        _open_flags |= os.O_NOFOLLOW
    try:
        fd = os.open(target, _open_flags)
        try:
            with open(fd, "rb", closefd=False) as fh:
                raw = fh.read()
        finally:
            os.close(fd)
    except (OSError, FileNotFoundError) as exc:
        raise FileNotFoundError(f"could not read {path!r}: {exc}") from exc

    if not raw:
        raise FileNotFoundError(f"file {path!r} is empty")

    buf = np.frombuffer(raw, dtype=np.uint8)
    img = cv2.imdecode(buf, _IMREAD_FLAGS)
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
    return list(iter_video_frames(path, allow_roots, max_frames=max_frames))


def iter_video_frames(
    path: str,
    allow_roots: list[str],
    max_frames: int = 120,
    with_time: bool = False,
) -> Iterator[Any]:
    """Streaming form of :func:`extract_video_frames`.

    Validation and ``VideoCapture`` open happen eagerly (same exceptions),
    but frames are decoded one at a time as the caller iterates, so a
    120-frame 4K sample never sits in memory at once (~3 GB as a list).
    The capture is released when the iterator is exhausted or closed.

    ``with_time=True`` yields ``(seconds, frame)`` pairs — the position of
    each sampled frame, which the Node side stores so a face crop can seek
    straight back to it.
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
    return _frames_from_capture(cap, max_frames, with_time)


def _frames_from_capture(cap: Any, max_frames: int, with_time: bool = False) -> Iterator[Any]:
    try:
        raw_fps = cap.get(cv2.CAP_PROP_FPS)
        fps = raw_fps if raw_fps and raw_fps > 0 else 25.0
        total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))

        if total_frames <= 0:
            # Some containers don't report frame count — grab one frame.
            ret, frame = cap.read()
            if ret and frame is not None:
                yield (0.0, frame) if with_time else frame
            return

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

        for idx in indices:
            cap.set(cv2.CAP_PROP_POS_FRAMES, float(idx))
            ret, frame = cap.read()
            if ret and frame is not None:
                yield (idx / fps, frame) if with_time else frame
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

    return load_image_from_bytes(raw, what="image_b64 bytes")


def load_image_from_bytes(raw: bytes, what: str = "uploaded bytes") -> np.ndarray:
    """Decode encoded image bytes (JPEG, PNG, WebP, …) into a BGR ndarray.

    Applies the EXIF Orientation tag once, like every other load path.

    Raises
    ------
    ImageDecodeError
        The bytes aren't a recognised image format.
    """
    if not raw:
        raise ImageDecodeError(f"{what}: empty")
    buf = np.frombuffer(raw, dtype=np.uint8)
    img = cv2.imdecode(buf, _IMREAD_FLAGS)
    if img is None:
        raise ImageDecodeError(f"{what} could not be decoded as an image")
    return _apply_exif_orientation(img, raw)
