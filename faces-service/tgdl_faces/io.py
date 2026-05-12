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
        # File exists but bytes are not a recognisable image format.
        raise ImageDecodeError(f"failed to decode image at {path!r}")
    return _apply_exif_orientation(img, raw)


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
