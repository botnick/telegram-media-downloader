"""
Real-image smoke test for tgdl_faces v0.2.0.

Scans up to 1000 images from data/downloads, calls detect_and_embed()
directly (no HTTP), and prints a detailed detection report.
"""
import os
import sys
import time
import random
import traceback
from pathlib import Path

_HERE = Path(__file__).parent
sys.path.insert(0, str(_HERE))

_PROJECT = _HERE.parent
_MODELS_DIR = _PROJECT / "data" / "faces-service" / "models"
os.environ.setdefault("TGDL_FACES_MODELS_DIR", str(_MODELS_DIR))
os.environ.setdefault("TGDL_FACES_LOG_LEVEL", "WARNING")
os.environ.setdefault("TGDL_FACES_DET_SIZE", "640")

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

# Suppress onnxruntime C++ provider-probe noise before any session is created.
try:
    import onnxruntime as _ort_early
    _ort_early.set_default_logger_severity(4)  # FATAL only
    import logging as _lg
    _lg.getLogger("onnxruntime").setLevel(_lg.CRITICAL)
except Exception:
    pass

# ── Collect images ────────────────────────────────────────────────────────────
DOWNLOADS = _PROJECT / "data" / "downloads"
ALLOW_ROOTS = [str(DOWNLOADS)]
EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"}
TARGET = 1000

print(f"Scanning {DOWNLOADS} for images ...", flush=True)
all_images = [
    p for p in DOWNLOADS.rglob("*")
    if p.is_file() and p.suffix.lower() in EXTENSIONS
]
print(f"Found {len(all_images):,} images total.", flush=True)

random.seed(42)
sample = random.sample(all_images, min(TARGET, len(all_images)))
print(f"Testing {len(sample)} images (random sample, seed=42).\n", flush=True)

# ── Load model synchronously ──────────────────────────────────────────────────
print("Loading model ... (may take 5-30 s)", flush=True)
t0 = time.perf_counter()

from tgdl_faces import insight as _ins
try:
    _app = _ins.get_app()
    load_ms = (time.perf_counter() - t0) * 1000
    print(f"Model ready: {type(_app).__name__}", flush=True)
    print(f"  Providers : {_ins.resolved_providers()}", flush=True)
    print(f"  GPU       : {_ins.gpu_provider()}", flush=True)
    print(f"  Embedding : {_ins.EMBEDDING_DIM} dim", flush=True)
    print(f"  Load time : {load_ms:.0f} ms\n", flush=True)
except Exception as exc:
    print(f"\n[FATAL] Model failed to load: {exc}", flush=True)
    traceback.print_exc()
    sys.exit(1)

from tgdl_faces.insight import detect_and_embed
from tgdl_faces.io import load_image_from_path, ImageDecodeError

# ── Sanity check on first image ───────────────────────────────────────────────
print("Sanity check on first image ...", flush=True)
test_img = sample[0]
try:
    bgr = load_image_from_path(str(test_img), ALLOW_ROOTS)
    faces = detect_and_embed(bgr)
    print(f"  Image : {test_img.name}  shape={bgr.shape}", flush=True)
    print(f"  Faces : {len(faces)}", flush=True)
    if faces:
        f0 = faces[0]
        print(f"  Face0 : bbox=({f0['x']},{f0['y']},{f0['w']},{f0['h']}) "
              f"score={f0['score']:.3f} emb_len={len(f0['embedding'])}", flush=True)
    print("Sanity check OK.\n", flush=True)
except Exception as exc:
    print(f"  [WARN] {exc}\n", flush=True)
    traceback.print_exc()
    print("", flush=True)

# ── Full scan ─────────────────────────────────────────────────────────────────
print(f"Running full scan of {len(sample)} images ...\n", flush=True)

results = []
errors = []
face_counts = {}
REPORT_EVERY = 100
t_batch = time.perf_counter()

for idx, img_path in enumerate(sample, 1):
    t1 = time.perf_counter()
    try:
        bgr = load_image_from_path(str(img_path), ALLOW_ROOTS)
        faces = detect_and_embed(bgr)
        n = len(faces)
        lat = (time.perf_counter() - t1) * 1000
        results.append((img_path, n, lat, None))
        face_counts[n] = face_counts.get(n, 0) + 1
    except ImageDecodeError as exc:
        lat = (time.perf_counter() - t1) * 1000
        results.append((img_path, 0, lat, "decode_error"))
        errors.append((img_path, f"ImageDecodeError: {exc}"))
    except Exception as exc:
        lat = (time.perf_counter() - t1) * 1000
        results.append((img_path, 0, lat, type(exc).__name__))
        errors.append((img_path, f"{type(exc).__name__}: {exc}"))
        if len(errors) <= 3:
            print(f"  [ERROR #{len(errors)}] {img_path.name}:", flush=True)
            traceback.print_exc()
            print("", flush=True)

    if idx % REPORT_EVERY == 0:
        elapsed = time.perf_counter() - t_batch
        faces_so_far = sum(r[1] for r in results)
        errs_so_far = sum(1 for r in results if r[3] is not None)
        rate = idx / elapsed if elapsed > 0 else 0
        print(
            f"  [{idx:>4}/{len(sample)}]  {elapsed:>5.1f}s  "
            f"{rate:>5.1f} img/s  "
            f"faces={faces_so_far:,}  errors={errs_so_far}",
            flush=True,
        )

total_s = time.perf_counter() - t_batch

# ── Report ────────────────────────────────────────────────────────────────────
ok       = [r for r in results if r[3] is None]
detected = [r for r in ok if r[1] > 0]
no_face  = [r for r in ok if r[1] == 0]
err_list = [r for r in results if r[3] is not None]

total_faces  = sum(r[1] for r in ok)
avg_lat      = sum(r[2] for r in ok) / max(1, len(ok))
detect_rate  = len(detected) / max(1, len(ok)) * 100

sep = "=" * 62
print(f"\n{sep}")
print("  DETECTION REPORT  --  tgdl_faces v0.2.0")
print(sep)
print(f"  Images tested        : {len(sample):>6,}")
print(f"  Load / decode errors : {len(err_list):>6,}  ({len(err_list)/len(sample)*100:.1f}%)")
print(f"  Images WITH faces    : {len(detected):>6,}  ({len(detected)/max(1,len(sample))*100:.1f}%)")
print(f"  Images without faces : {len(no_face):>6,}  ({len(no_face)/max(1,len(sample))*100:.1f}%)")
print(f"  Total faces found    : {total_faces:>6,}")
print(f"  Avg faces / detected : {total_faces/max(1,len(detected)):.2f}")
print(f"  Avg latency          : {avg_lat:.0f} ms / image")
print(f"  Throughput           : {len(ok)/max(0.001,total_s):.1f} img/s (successful only)")
print(f"  Total wall time      : {total_s:.1f} s")
print()

print("  Face count distribution:")
for n in sorted(face_counts):
    bar = "#" * min(40, max(1, face_counts[n] * 40 // max(1, len(sample))))
    print(f"    {n:>3} face(s) : {face_counts[n]:>5,}  {bar}")

if detected:
    print("\n  Top 10 images by face count:")
    for path, n, lat, _ in sorted(detected, key=lambda r: -r[1])[:10]:
        rel = path.relative_to(DOWNLOADS) if path.is_relative_to(DOWNLOADS) else path
        print(f"    {n:>2} face(s)  {lat:>6.0f} ms  {rel}")

if detected:
    print("\n  Random sample (10) of images where faces were found:")
    for path, n, lat, _ in random.sample(detected, min(10, len(detected))):
        rel = path.relative_to(DOWNLOADS) if path.is_relative_to(DOWNLOADS) else path
        print(f"    {n:>2} face(s)  {lat:>6.0f} ms  {rel}")

if errors:
    print(f"\n  Errors (first 20 of {len(errors)}):")
    for path, msg in errors[:20]:
        print(f"    {msg[:80]}")

print(f"\n{sep}")
if len(err_list) > len(sample) * 0.5:
    verdict = "FAIL -- majority of images errored"
elif detect_rate >= 10.0:
    verdict = "PASS"
else:
    verdict = "LOW -- detection rate below 10% (may be non-person dataset)"
print(f"  Verdict       : {verdict}")
print(f"  Detection rate: {detect_rate:.1f}%  (faces found / successful images)")
print(sep + "\n")
