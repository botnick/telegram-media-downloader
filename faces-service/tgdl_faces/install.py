"""
Auto-detect platform and install the correct onnxruntime EP variant.

Run via:
    python -m tgdl_faces.install
    tgdl-faces-install            # console script (after `pip install -e .`)

Detection matrix:
    Apple Silicon (darwin/arm64) → base (CoreML EP ships with onnxruntime)
    macOS Intel (darwin/x86_64)  → base (CPU)
    Windows (any GPU)            → [directml]   (works on NVIDIA/AMD/Intel)
    Linux + NVIDIA (nvidia-smi)  → [gpu]        (CUDA + TensorRT)
    Linux + Intel iGPU (/dev/dri) → [openvino]
    Linux fallback / unknown     → base (CPU)

The three onnxruntime-* wheels share the `onnxruntime` module name and
cannot coexist — this installer uninstalls the conflicting base wheel
before installing the chosen variant. Idempotent: safe to re-run.

Flags:
    --dry-run           Print what would be installed and exit
    --force <variant>   Override detection: cpu | gpu | directml | openvino
    --no-uninstall      Skip the conflict-uninstall step (advanced)
"""

from __future__ import annotations

import argparse
import os
import platform
import shutil
import subprocess
import sys
from pathlib import Path

# onnxruntime wheel names that share the `onnxruntime` Python module.
# Installing one MUST follow uninstalling the others or pip will keep the
# old wheel and the EP list won't update.
_CONFLICTS = ("onnxruntime", "onnxruntime-gpu", "onnxruntime-directml", "onnxruntime-openvino")

_VARIANT_TO_EXTRA = {
    "cpu": None,  # base install — no extra
    "gpu": "gpu",
    "directml": "directml",
    "openvino": "openvino",
}


def _has_nvidia_gpu() -> bool:
    if not shutil.which("nvidia-smi"):
        return False
    try:
        r = subprocess.run(
            ["nvidia-smi", "-L"],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
        return r.returncode == 0 and "GPU" in r.stdout
    except (subprocess.TimeoutExpired, OSError):
        return False


def _has_intel_igpu() -> bool:
    # /dev/dri exists on most Linux distros with any DRM-capable GPU; we
    # then look for `i915` (Intel) or `xe` (Intel newer) kernel modules.
    if not Path("/dev/dri").exists():
        return False
    # `lspci` is the cleanest signal; fall back to /proc/modules.
    if shutil.which("lspci"):
        try:
            r = subprocess.run(
                ["lspci"], capture_output=True, text=True, timeout=5, check=False
            )
            out = r.stdout.lower()
            if "intel" in out and ("vga" in out or "display" in out or "graphics" in out):
                return True
        except (subprocess.TimeoutExpired, OSError):
            pass
    try:
        mods = Path("/proc/modules").read_text(errors="ignore")
        return "\ni915" in mods or "\nxe " in mods
    except OSError:
        return False


def detect_variant() -> tuple[str, str]:
    """Return (variant, reason). variant ∈ {cpu, gpu, directml, openvino}."""
    sysname = platform.system().lower()
    machine = platform.machine().lower()

    if sysname == "darwin":
        return "cpu", f"macOS ({machine}) — CoreML EP ships with the base onnxruntime wheel"

    if sysname == "windows":
        # DirectML on Windows is the universal GPU EP — works on NVIDIA,
        # AMD, Intel and any DX12-capable adapter without a CUDA toolkit.
        return "directml", "Windows — DirectML EP (works on any DX12 GPU)"

    if sysname == "linux":
        if _has_nvidia_gpu():
            return "gpu", "Linux + NVIDIA GPU detected via nvidia-smi"
        if _has_intel_igpu():
            return "openvino", "Linux + Intel GPU detected"
        return "cpu", "Linux — no NVIDIA/Intel GPU detected, falling back to CPU"

    return "cpu", f"unknown platform {sysname}/{machine} — using CPU"


def _project_root() -> Path:
    # tgdl_faces/install.py → faces-service/
    return Path(__file__).resolve().parent.parent


def _pip_install_target(variant: str) -> str:
    root = _project_root()
    extra = _VARIANT_TO_EXTRA.get(variant)
    if extra:
        return f"{root}[{extra}]"
    return str(root)


def _run(cmd: list[str], dry_run: bool) -> int:
    print(f"  $ {' '.join(cmd)}")
    if dry_run:
        return 0
    return subprocess.call(cmd)


def _uninstall_conflicts(dry_run: bool) -> None:
    # `pip uninstall -y` on a missing package returns 1 with a noisy
    # warning — we suppress that by checking with `pip show` first.
    for pkg in _CONFLICTS:
        r = subprocess.run(
            [sys.executable, "-m", "pip", "show", pkg],
            capture_output=True,
            check=False,
        )
        if r.returncode != 0:
            continue
        _run([sys.executable, "-m", "pip", "uninstall", "-y", pkg], dry_run)


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(
        prog="tgdl-faces-install",
        description="Auto-detect platform and install the correct onnxruntime EP.",
    )
    p.add_argument("--dry-run", action="store_true", help="Print plan and exit")
    p.add_argument(
        "--force",
        choices=sorted(_VARIANT_TO_EXTRA.keys()),
        help="Skip detection and install this variant",
    )
    p.add_argument(
        "--no-uninstall",
        action="store_true",
        help="Skip the conflict-uninstall step (advanced)",
    )
    args = p.parse_args(argv)

    if args.force:
        variant, reason = args.force, "forced via --force"
    else:
        variant, reason = detect_variant()

    target = _pip_install_target(variant)

    print("=== tgdl-faces installer ===")
    print(f"  Platform:  {platform.system()} {platform.release()} ({platform.machine()})")
    print(f"  Python:    {sys.version.split()[0]} ({sys.executable})")
    print(f"  Variant:   {variant}  ({reason})")
    print(f"  Target:    pip install -e {target}")
    print("")

    if not args.no_uninstall:
        print("Step 1/2 — removing conflicting onnxruntime wheels (idempotent):")
        _uninstall_conflicts(args.dry_run)
        print("")

    print("Step 2/2 — installing tgdl-faces + EP:")
    rc = _run(
        [sys.executable, "-m", "pip", "install", "-e", target],
        args.dry_run,
    )
    if rc != 0:
        print(f"\n  pip install failed (exit {rc}). See output above.", file=sys.stderr)
        return rc

    print("\n  Done. Start the sidecar with:  python -m tgdl_faces")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
