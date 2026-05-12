#!/usr/bin/env bash
# build-pyinstaller.sh — Build a standalone tgdl-faces binary with PyInstaller.
#
# The output binary bundles Python + all dependencies + the buffalo_l model
# into a single file so end users never need to install Python or pip.
#
# Usage:
#   cd faces-service
#   bash build-pyinstaller.sh [--variant cpu|gpu|directml|openvino] [--with-model]
#
# Options:
#   --variant <name>   onnxruntime variant to bundle (default: auto-detect)
#   --with-model       Pre-bake the buffalo_l weights into the binary
#                      (~200 MB extra, enables offline first use)
#   --output-dir <dir> Directory for the built binary (default: dist/)
#
# Output filename: tgdl-faces-<platform>-<arch>[.exe]
#   e.g. tgdl-faces-linux-x86_64
#        tgdl-faces-windows-x86_64.exe
#        tgdl-faces-darwin-arm64
#
# Requirements:
#   pip install pyinstaller
#   pip install -e . (or -e .[gpu] etc for the chosen variant)
set -euo pipefail

# ---------------------------------------------------------------------------
# Parse arguments
# ---------------------------------------------------------------------------
VARIANT="auto"
WITH_MODEL=0
OUTPUT_DIR="dist"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --variant)
            VARIANT="$2"; shift 2;;
        --with-model)
            WITH_MODEL=1; shift;;
        --output-dir)
            OUTPUT_DIR="$2"; shift 2;;
        -h|--help)
            sed -n '2,/^set -/p' "$0" | grep '^#' | sed 's/^# \?//'
            exit 0;;
        *)
            echo "Unknown argument: $1" >&2; exit 1;;
    esac
done

# ---------------------------------------------------------------------------
# Detect platform / arch for output filename
# ---------------------------------------------------------------------------
OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"
case "$OS" in
    darwin)  PLATFORM="darwin";;
    linux)   PLATFORM="linux";;
    mingw*|msys*|cygwin*|windows*)
             PLATFORM="windows";;
    *)       PLATFORM="$OS";;
esac

# Normalise common arch aliases.
case "$ARCH" in
    amd64|x86_64)  ARCH="x86_64";;
    arm64|aarch64) ARCH="aarch64";;
esac

EXE_SUFFIX=""
[[ "$PLATFORM" == "windows" ]] && EXE_SUFFIX=".exe"
BINARY_NAME="tgdl-faces-${PLATFORM}-${ARCH}${EXE_SUFFIX}"

# ---------------------------------------------------------------------------
# Auto-detect variant when not forced
# ---------------------------------------------------------------------------
if [[ "$VARIANT" == "auto" ]]; then
    if [[ "$PLATFORM" == "windows" ]]; then
        VARIANT="directml"
    elif [[ "$PLATFORM" == "darwin" ]]; then
        VARIANT="cpu"   # CoreML EP ships with base onnxruntime on macOS
    elif command -v nvidia-smi &>/dev/null && nvidia-smi -L 2>/dev/null | grep -q GPU; then
        VARIANT="gpu"
    else
        VARIANT="cpu"
    fi
    echo "Auto-detected variant: $VARIANT"
fi

# ---------------------------------------------------------------------------
# Install dependencies for the chosen variant
# ---------------------------------------------------------------------------
echo "=== Installing tgdl-faces[$VARIANT] ==="
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ "$VARIANT" == "cpu" ]]; then
    pip install -e "$SCRIPT_DIR"
elif [[ "$VARIANT" == "gpu" ]]; then
    pip install -e "$SCRIPT_DIR[gpu]"
elif [[ "$VARIANT" == "directml" ]]; then
    pip install -e "$SCRIPT_DIR[directml]"
elif [[ "$VARIANT" == "openvino" ]]; then
    pip install -e "$SCRIPT_DIR[openvino]"
else
    echo "Unknown variant: $VARIANT (expected cpu|gpu|directml|openvino)" >&2
    exit 1
fi

pip install pyinstaller

# ---------------------------------------------------------------------------
# Optionally pre-download the model
# ---------------------------------------------------------------------------
MODEL_DIR="${TGDL_FACES_MODELS_DIR:-${HOME}/.cache/tgdl-faces/models}"

if [[ "$WITH_MODEL" -eq 1 ]]; then
    echo "=== Pre-downloading buffalo_l model to $MODEL_DIR ==="
    python -c "
from insightface.app import FaceAnalysis
import os, pathlib
d = pathlib.Path('$MODEL_DIR')
d.mkdir(parents=True, exist_ok=True)
a = FaceAnalysis(name='buffalo_l', root=str(d), providers=['CPUExecutionProvider'])
a.prepare(ctx_id=-1)
print('Model ready at', d)
"
fi

# ---------------------------------------------------------------------------
# Build the binary
# ---------------------------------------------------------------------------
echo "=== Building PyInstaller binary: $BINARY_NAME ==="
mkdir -p "$OUTPUT_DIR"

# Hidden imports that PyInstaller's static analysis misses because they're
# imported dynamically by insightface / onnxruntime.
HIDDEN=(
    --hidden-import tgdl_faces
    --hidden-import tgdl_faces.app
    --hidden-import tgdl_faces.insight
    --hidden-import tgdl_faces.io
    --hidden-import tgdl_faces.install
    --hidden-import insightface
    --hidden-import insightface.app
    --hidden-import insightface.model_zoo
    --hidden-import insightface.utils
    --hidden-import insightface.utils.face_align
    --hidden-import onnxruntime
    --hidden-import onnxruntime.capi
    --hidden-import cv2
    --hidden-import uvicorn
    --hidden-import fastapi
    --hidden-import pydantic
)

# If WITH_MODEL is set, bundle the model weights.
ADD_DATA_FLAGS=()
if [[ "$WITH_MODEL" -eq 1 ]] && [[ -d "$MODEL_DIR/models/buffalo_l" ]]; then
    # PyInstaller --add-data syntax: src:dst (colon on Unix, semicolon on Windows)
    SEP=":"
    [[ "$PLATFORM" == "windows" ]] && SEP=";"
    ADD_DATA_FLAGS=(--add-data "${MODEL_DIR}/models/buffalo_l${SEP}insightface_models/buffalo_l")
    # Tell the sidecar where to look at runtime — relative to sys._MEIPASS.
    export TGDL_FACES_MODELS_DIR="insightface_models"
fi

pyinstaller \
    --onefile \
    --name "$BINARY_NAME" \
    --distpath "$OUTPUT_DIR" \
    --specpath /tmp \
    "${HIDDEN[@]}" \
    "${ADD_DATA_FLAGS[@]}" \
    --collect-all tgdl_faces \
    --collect-all insightface \
    --collect-all onnxruntime \
    -m "$SCRIPT_DIR/tgdl_faces/__main__.py"

echo ""
echo "=== Done ==="
echo "Binary: $OUTPUT_DIR/$BINARY_NAME"
echo ""
echo "Run:  $OUTPUT_DIR/$BINARY_NAME"
echo "Env:  TGDL_FACES_HOST=0.0.0.0 TGDL_FACES_PORT=8011 $OUTPUT_DIR/$BINARY_NAME"
