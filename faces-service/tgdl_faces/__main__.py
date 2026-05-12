"""Entrypoint for `python -m tgdl_faces` / the `tgdl-faces` console script.

Reads configuration from environment variables and starts uvicorn against
the FastAPI app in :mod:`tgdl_faces.app`.

Environment
-----------

``TGDL_FACES_HOST``
    Bind host. Defaults to ``127.0.0.1`` (loopback). Docker compose flips
    this to ``0.0.0.0`` so the Node container can reach it.

``TGDL_FACES_PORT``
    TCP port. Defaults to ``8011``. The Node auto-spawn path overrides
    this with a random high port to avoid clashes on shared dev hosts.

``TGDL_FACES_MODEL_DIR`` / ``TGDL_FACES_MODELS_DIR``
    Directory under which insightface downloads / caches ``buffalo_l``.
    Both forms are accepted; the plural form wins when both are set.
    Defaults to ``~/.cache/tgdl-faces/models``. The PyInstaller binary
    pre-bakes the model into this layout so the first ``/detect`` call
    doesn't touch the network.

``TGDL_FACES_ALLOW_ROOTS``
    Comma-separated list of absolute paths the sidecar is allowed to
    read images from (``POST /detect`` path mode). If empty, path-mode
    requests are rejected with ``403`` and callers must use the
    base64 mode. This is a defence-in-depth guard against the sidecar
    being coerced into reading arbitrary files via a forged request.

``TGDL_FACES_PROVIDERS``
    Comma-separated onnxruntime provider names or a shorthand alias
    (``auto``, ``cpu``, ``cuda``, ``coreml``, ``directml``, ``openvino``).
    Defaults to ``auto``, which picks the best provider for the current
    platform: DirectML on Windows, CUDA on Linux, CoreML on macOS.

``TGDL_FACES_MAX_CONCURRENCY``
    Maximum number of detect requests processed in parallel. Defaults to
    ``2``. Increase for multi-GPU hosts; decrease on memory-constrained
    devices.

``TGDL_FACES_DETECTOR_MODEL``
    insightface model pack name. Defaults to ``buffalo_l``.

``TGDL_FACES_DET_SIZE``
    Detector input resolution (positive int). Defaults to ``640``.

``TGDL_FACES_LOG_LEVEL``
    Standard Python logging level (``DEBUG``, ``INFO``, ``WARNING``, …).
    Defaults to ``INFO``.
"""

from __future__ import annotations

import logging
import os
import sys
import warnings
from pathlib import Path

# insightface 0.7's `utils.face_align.estimate_norm` calls scikit-image's
# deprecated `SimilarityTransform.estimate` which emits a FutureWarning
# on every detect. Two-step fix:
#   1. Monkey-patch `estimate_norm` to use `SimilarityTransform.from_estimate`
#      (the recommended API since skimage 0.26) — root-cause fix that also
#      future-proofs us against skimage 2.2 removing `estimate` entirely.
#   2. Fall back to a narrow warning filter if from_estimate is missing
#      (older skimage on a stripped-down host that we still want to support).
def _patch_insightface_face_align() -> bool:
    try:
        import insightface.utils.face_align as fa  # noqa: PLC0415
        from skimage import transform as _trans  # noqa: PLC0415
    except ImportError:
        return False
    if not hasattr(_trans.SimilarityTransform, "from_estimate"):
        return False
    arcface_dst = fa.arcface_dst

    def estimate_norm(lmk, image_size=112, mode="arcface"):  # noqa: ARG001
        assert lmk.shape == (5, 2)
        assert image_size % 112 == 0 or image_size % 128 == 0
        if image_size % 112 == 0:
            ratio = float(image_size) / 112.0
            diff_x = 0.0
        else:
            ratio = float(image_size) / 128.0
            diff_x = 8.0 * ratio
        dst = arcface_dst * ratio
        dst[:, 0] += diff_x
        tform = _trans.SimilarityTransform.from_estimate(lmk, dst)
        return tform.params[0:2, :]

    fa.estimate_norm = estimate_norm
    return True


_PATCHED = _patch_insightface_face_align()
if not _PATCHED:
    # Couldn't swap the implementation (insightface not yet importable, or
    # older skimage without from_estimate). Keep the deprecation noise off
    # the dashboard log feed via a narrow filter so operators don't see
    # an upstream-library line they can't act on.
    warnings.filterwarnings(
        "ignore",
        message=r".*estimate.*is deprecated.*",
        category=FutureWarning,
    )


_LOG = logging.getLogger("tgdl-faces")


def _resolve_host() -> str:
    return os.environ.get("TGDL_FACES_HOST", "127.0.0.1").strip() or "127.0.0.1"


def _resolve_port() -> int:
    raw = os.environ.get("TGDL_FACES_PORT", "8011").strip() or "8011"
    try:
        port = int(raw)
    except ValueError:
        _LOG.warning(
            "TGDL_FACES_PORT=%r is not a valid integer; falling back to 8011", raw
        )
        return 8011
    if not (1 <= port <= 65535):
        _LOG.warning(
            "TGDL_FACES_PORT=%r is outside 1..65535; falling back to 8011", raw
        )
        return 8011
    return port


def _resolve_models_dir() -> Path:
    raw = os.environ.get("TGDL_FACES_MODELS_DIR", "").strip()
    if raw:
        return Path(raw).expanduser().resolve()
    return (Path.home() / ".cache" / "tgdl-faces" / "models").resolve()


def _resolve_allow_roots() -> list[str]:
    raw = os.environ.get("TGDL_FACES_ALLOW_ROOTS", "")
    parts = [p.strip() for p in raw.split(",") if p and p.strip()]
    resolved: list[str] = []
    for part in parts:
        try:
            resolved.append(str(Path(part).expanduser().resolve()))
        except OSError:
            # If the path can't be resolved (e.g. unreachable network mount)
            # we keep the raw string — io.load_image_from_path will still
            # reject it.
            resolved.append(part)
    return resolved


def _configure_logging() -> None:
    level = os.environ.get("TGDL_FACES_LOG_LEVEL", "INFO").upper()
    logging.basicConfig(
        level=getattr(logging, level, logging.INFO),
        format="[tgdl-faces] %(asctime)s %(levelname)s %(name)s — %(message)s",
        datefmt="%Y-%m-%dT%H:%M:%S",
        stream=sys.stderr,
    )


def main() -> None:
    _configure_logging()

    host = _resolve_host()
    port = _resolve_port()
    models_dir = _resolve_models_dir()
    allow_roots = _resolve_allow_roots()

    # Make sure the models dir exists; insightface will populate it on
    # first /detect when running outside the prebaked binary.
    try:
        models_dir.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        _LOG.warning("could not create models dir %s: %s", models_dir, exc)

    # Stash the resolved config in env so the FastAPI app (loaded by
    # uvicorn as a string import) can read it back. We export the
    # *resolved* values so app code never has to re-parse env defaults.
    os.environ["TGDL_FACES_MODELS_DIR"] = str(models_dir)
    os.environ["TGDL_FACES_ALLOW_ROOTS"] = ",".join(allow_roots)

    _LOG.info("starting on %s:%s", host, port)
    _LOG.info("models_dir=%s", models_dir)
    _LOG.info(
        "allow_roots=%s",
        allow_roots if allow_roots else "[] (path mode disabled — base64 only)",
    )

    # Pre-load the model in a background thread so the first /detect
    # request doesn't pay the 0.5–5 s model-load cost. The sidecar
    # becomes "ready" a few seconds after boot rather than on first use.
    # Importing here (not at the top of the module) avoids paying the
    # insightface import cost for `--help` / dry-run style invocations.
    from tgdl_faces.insight import preload_model  # noqa: PLC0415

    preload_model()

    # Import lazily so `python -m tgdl_faces --help` style commands that
    # uvicorn might add in future don't pay the heavy insightface import.
    import uvicorn  # noqa: PLC0415

    uvicorn.run(
        "tgdl_faces.app:app",
        host=host,
        port=port,
        log_level="info",
        # Disable uvicorn's reloader — the sidecar is a long-running
        # service supervised by the Node app, not a dev playground.
        reload=False,
    )


if __name__ == "__main__":  # pragma: no cover
    main()
