@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul 2>nul
title TGDL Faces Sidecar (GPU)

REM Standalone GPU launcher for the face recognition sidecar.
REM Double-click or run from terminal.
REM
REM First-time setup:
REM   cd faces-service
REM   python -m pip install -e .[gpu]
REM   python -m tgdl_faces.install

REM Configurable defaults
if not defined TGDL_FACES_HOST set TGDL_FACES_HOST=0.0.0.0
if not defined TGDL_FACES_PORT set TGDL_FACES_PORT=8011
if not defined TGDL_FACES_PROVIDERS set TGDL_FACES_PROVIDERS=cuda
if not defined TGDL_FACES_DETECTOR_MODEL set TGDL_FACES_DETECTOR_MODEL=buffalo_l
if not defined TGDL_FACES_DET_SIZE set TGDL_FACES_DET_SIZE=640
if not defined TGDL_FACES_THROTTLE_MS set TGDL_FACES_THROTTLE_MS=0
if not defined TGDL_FACES_MAX_CONCURRENCY set TGDL_FACES_MAX_CONCURRENCY=32
if not defined TGDL_FACES_SKIP_QUALITY set TGDL_FACES_SKIP_QUALITY=1

if not defined TGDL_FACES_ALLOW_ROOTS set TGDL_FACES_ALLOW_ROOTS=%~dp0data\downloads
if not defined TGDL_FACES_MODELS_DIR set TGDL_FACES_MODELS_DIR=%~dp0data\faces-service\models

REM ---- Resolve CUDA 12.x DLLs (mirrors faces-spawn.js) ----
set CUDA_BINS=

REM 1. CUDA_PATH env var
if defined CUDA_PATH (
    if exist "%CUDA_PATH%\bin" set CUDA_BINS=%CUDA_PATH%\bin
)

REM 2. Filesystem scan for CUDA Toolkit v12.x
set CUDA_BASE=C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA
if exist "%CUDA_BASE%" (
    for /d %%D in ("%CUDA_BASE%\v12.*") do (
        if exist "%%D\bin" (
            if defined CUDA_BINS (
                set "CUDA_BINS=%%D\bin;!CUDA_BINS!"
            ) else (
                set "CUDA_BINS=%%D\bin"
            )
        )
    )
)

REM 3. pip-installed nvidia-* packages
for /f "tokens=*" %%P in ('where python 2^>nul') do (
    set "PYTHON_EXE=%%P"
    goto :found_python
)
echo ERROR: python not found in PATH
pause
exit /b 1

:found_python
for %%F in ("!PYTHON_EXE!") do set "PYTHON_HOME=%%~dpF"
set "NVIDIA_PKGS=!PYTHON_HOME!Lib\site-packages\nvidia"
if exist "!NVIDIA_PKGS!" (
    for /d %%N in ("!NVIDIA_PKGS!\*") do (
        if exist "%%N\bin" (
            if defined CUDA_BINS (
                set "CUDA_BINS=%%N\bin;!CUDA_BINS!"
            ) else (
                set "CUDA_BINS=%%N\bin"
            )
        )
    )
)

REM Prepend CUDA dirs to PATH
if defined CUDA_BINS (
    set "PATH=!CUDA_BINS!;!PATH!"
    echo [CUDA] Added to PATH: !CUDA_BINS!
)

REM ---- Verify onnxruntime-gpu ----
"!PYTHON_EXE!" -c "import onnxruntime; eps = onnxruntime.get_available_providers(); print('Available providers:', ', '.join(eps))" 2>nul
if errorlevel 1 (
    echo.
    echo ERROR: onnxruntime not installed. Run:
    echo   cd faces-service
    echo   python -m pip install -e .[gpu]
    echo   python -m tgdl_faces.install
    echo.
    pause
    exit /b 1
)

REM ---- Kill existing process on target port ----
for /f "tokens=5" %%A in ('netstat -aon 2^>nul ^| findstr ":%TGDL_FACES_PORT% " ^| findstr "LISTENING"') do (
    echo [PORT] Killing PID %%A on port %TGDL_FACES_PORT%
    taskkill /F /PID %%A >nul 2>nul
)

REM ---- Launch ----
set PYTHONUNBUFFERED=1
set PYTHONUTF8=1
set PYTHONLEGACYWINDOWSSTDIO=1

echo.
echo ======================================
echo  TGDL Faces Sidecar (GPU Turbo)
echo  Provider:     %TGDL_FACES_PROVIDERS%
echo  Listen:       %TGDL_FACES_HOST%:%TGDL_FACES_PORT%
echo  Model:        %TGDL_FACES_DETECTOR_MODEL%
echo  Concurrency:  %TGDL_FACES_MAX_CONCURRENCY%
echo  Skip quality: %TGDL_FACES_SKIP_QUALITY%
echo  Models at:    %TGDL_FACES_MODELS_DIR%
echo ======================================
echo.
echo Point your dashboard at: http://localhost:%TGDL_FACES_PORT%
echo   Settings ^> AI ^> Face Recognition ^> Sidecar URL
echo.
echo Press Ctrl+C to stop.
echo.

cd /d "%~dp0faces-service"
"!PYTHON_EXE!" -m tgdl_faces

if errorlevel 1 (
    echo.
    echo Sidecar exited with error. Check output above.
    pause
)
