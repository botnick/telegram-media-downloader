"""Zero-shot image tagging via CLIP (ONNX Runtime).

Provides a singleton :class:`CLIPTagger` that downloads the ONNX vision
encoder + text encoder from HuggingFace (``Xenova/clip-vit-base-patch32``),
pre-computes text embeddings for a fixed tag vocabulary at load time,
and scores every image against every tag at inference.

Designed to mirror the lazy-init / singleton pattern in ``insight.py``:

* First call to :func:`get_tagger()` pays the download + init cost.
* Subsequent calls reuse the same in-memory instance.
* Errors during initialisation are cached so callers get a fast 500
  instead of repeatedly retrying a broken model load.

Dependencies
------------
* ``onnxruntime`` (already required by the sidecar)
* ``numpy`` (already required)
* ``Pillow`` (already required)
* ``tokenizers`` (lightweight Rust-based BPE tokenizer from HuggingFace)
* ``huggingface_hub`` (for downloading model files)

Environment
-----------
``TGDL_FACES_CLIP_MODEL``
    HuggingFace repo id for the ONNX CLIP model. Defaults to
    ``Xenova/clip-vit-base-patch32``. The repo must contain at least
    ``vision_encoder/model.onnx``, ``text_encoder/model.onnx``, and
    ``tokenizer.json``.

``TGDL_FACES_CLIP_THRESHOLD``
    Minimum tag score (0..1). Default ``0.2``.

``TGDL_FACES_CLIP_TOP_K``
    Max tags returned per image. Default ``10``.
"""

from __future__ import annotations

import json
import logging
import math
import os
import threading
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image

try:
    from huggingface_hub import hf_hub_download
except ImportError:
    hf_hub_download = None

try:
    from tokenizers import Tokenizer as HFTokenizer
except ImportError:
    HFTokenizer = None


_LOG = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Default tag vocabulary — curated for Telegram media (documents, screenshots,
# receipts, etc.) plus common photographic subjects. The model scores every
# image against every tag and returns those above threshold.
# ---------------------------------------------------------------------------
DEFAULT_VOCABULARY = [
    # People
    "person", "portrait", "group photo", "selfie", "child", "baby",
    "couple", "family", "friends", "crowd",
    # Animals
    "animal", "cat", "dog", "bird", "fish", "horse", "insect",
    # Nature / outdoors
    "nature", "landscape", "sunset", "sunrise", "mountain", "beach",
    "ocean", "sea", "forest", "tree", "flower", "plant", "sky",
    "cloud", "night", "moon", "star", "snow", "ice", "rain",
    "rainbow", "river", "lake", "waterfall", "field", "garden", "park",
    # Food & drink
    "food", "drink", "coffee", "tea", "meal", "fruit", "vegetable",
    "dessert", "cake", "bread", "wine", "beer", "cocktail",
    # Urban & architecture
    "city", "building", "house", "road", "street", "car", "vehicle",
    "truck", "bicycle", "motorcycle", "airplane", "boat", "train",
    "architecture", "bridge", "tower", "church", "castle",
    "stadium", "museum", "store", "restaurant", "cafe",
    # Interiors
    "interior", "room", "kitchen", "bedroom", "living room",
    "bathroom", "office", "stairs", "door", "window",
    # Objects
    "book", "phone", "smartphone", "computer", "laptop", "screen",
    "clock", "watch", "jewelry", "camera", "shoe", "bag", "bottle",
    "toy", "gift", "key", "umbrella", "glasses", "hat",
    # Art & media
    "art", "drawing", "painting", "illustration", "cartoon", "meme",
    "screenshot", "document", "text", "letter", "newspaper",
    "magazine", "receipt", "invoice", "form", "id card",
    "passport", "book page", "slide", "presentation",
    # Graphic design
    "logo", "poster", "flyer", "sign", "billboard", "chart",
    "graph", "map", "infographic", "pattern", "abstract",
    # Style
    "black and white", "colorful", "vintage", "retro", "minimalist",
    "dark", "bright", "blurry", "sharp",
    # Events & activities
    "concert", "party", "wedding", "birthday", "celebration",
    "festival", "parade", "sport", "game", "travel",
    # Specifics
    "flag", "statue", "monument", "sculpture", "graffiti",
    "street art", "underwater", "aerial view", "macro",
    "panorama", "reflection", "shadow", "silhouette",
    "fireworks", "light", "neon", "candle",
    # Emotions / abstract
    "smile", "fun", "romantic", "sad", "surprise",
    "fashion", "makeup", "tattoo", "piercing",
]

# ONNX model file names inside the HuggingFace repo.
_VISION_MODEL_PATH = "vision_encoder/model.onnx"
_TEXT_MODEL_PATH = "text_encoder/model.onnx"
_TOKENIZER_FILE = "tokenizer.json"
_CONFIG_FILE = "config.json"

# CLIP normalisation constants (ImageNet mean/std — same as ViT).
_CLIP_MEAN = np.array([0.48145466, 0.4578275, 0.40821073], dtype=np.float32)
_CLIP_STD = np.array([0.26862954, 0.26130258, 0.27577711], dtype=np.float32)
_CLIP_SIZE = 224  # ViT-B/32 input resolution

# ---------------------------------------------------------------------------
# Module-level singleton — guarded by _LOCK so two parallel requests don't
# double-initialise.
# ---------------------------------------------------------------------------
_TAGGER: CLIPTagger | None = None
_TAGGER_ERROR: Exception | None = None
_LOCK = threading.Lock()


def _resolve_model_id() -> str:
    return os.environ.get("TGDL_FACES_CLIP_MODEL", "").strip() or "Xenova/clip-vit-base-patch32"


def _resolve_threshold() -> float:
    raw = os.environ.get("TGDL_FACES_CLIP_THRESHOLD", "").strip()
    if raw:
        try:
            val = float(raw)
            if 0.0 <= val <= 1.0:
                return val
        except ValueError:
            pass
    return 0.20


def _resolve_top_k() -> int:
    raw = os.environ.get("TGDL_FACES_CLIP_TOP_K", "").strip()
    if raw:
        try:
            val = int(raw)
            if 1 <= val <= 100:
                return val
        except ValueError:
            pass
    return 10


def _resolve_models_dir() -> Path:
    """Return the CLIP-specific model cache directory.

    Shares the same root as the insightface models dir so both live
    under ``~/.cache/tgdl-faces/``.
    """
    raw = os.environ.get("TGDL_FACES_MODELS_DIR", "").strip()
    if raw:
        base = Path(raw).expanduser().resolve()
    else:
        base = (Path.home() / ".cache" / "tgdl-faces" / "models").resolve()
    return base / "clip"


def is_ready() -> bool:
    """Return True iff the tagger has been initialised at least once."""
    return _TAGGER is not None


def last_error() -> Exception | None:
    """Return the cached init error, if any. ``None`` once loaded."""
    return _TAGGER_ERROR


def get_tagger() -> CLIPTagger:
    """Return the lazily-initialised singleton :class:`CLIPTagger`.

    First call pays the model-download + tokenizer + embedding precompute
    cost. Subsequent calls reuse the same instance. Errors are cached so
    repeated calls return fast instead of retrying a broken load.
    """
    global _TAGGER, _TAGGER_ERROR

    if _TAGGER is not None:
        return _TAGGER
    if _TAGGER_ERROR is not None:
        raise _TAGGER_ERROR

    with _LOCK:
        if _TAGGER is not None:
            return _TAGGER
        if _TAGGER_ERROR is not None:
            raise _TAGGER_ERROR

        try:
            _TAGGER = CLIPTagger()
            return _TAGGER
        except Exception as exc:
            _TAGGER_ERROR = exc
            _LOG.exception("failed to initialise CLIPTagger")
            raise


# ---------------------------------------------------------------------------
# Pre-computed text embeddings wrapper — caches the result so we only pay
# the text-encoder forward pass once.
# ---------------------------------------------------------------------------
class CLIPTagger:
    """Zero-shot image tagger backed by ONNX CLIP.

    Usage::

        tagger = get_tagger()
        tags = tagger.tag_image(bgr_ndarray)
        # -> [{"tag": "sunset", "score": 0.42}, ...]
    """

    def __init__(self) -> None:
        model_id = _resolve_model_id()
        models_dir = _resolve_models_dir()
        models_dir.mkdir(parents=True, exist_ok=True)

        if hf_hub_download is None:
            raise ImportError(
                "huggingface_hub is required for CLIP tagging. "
                "Install it with: pip install huggingface_hub"
            )
        if HFTokenizer is None:
            raise ImportError(
                "tokenizers is required for CLIP tagging. "
                "Install it with: pip install tokenizers"
            )

        _LOG.info("downloading CLIP model %s to %s", model_id, models_dir)

        # Download model files
        self._vision_path = hf_hub_download(
            repo_id=model_id,
            filename=_VISION_MODEL_PATH,
            cache_dir=str(models_dir),
        )
        self._text_path = hf_hub_download(
            repo_id=model_id,
            filename=_TEXT_MODEL_PATH,
            cache_dir=str(models_dir),
        )
        tokenizer_path = hf_hub_download(
            repo_id=model_id,
            filename=_TOKENIZER_FILE,
            cache_dir=str(models_dir),
        )
        config_path = hf_hub_download(
            repo_id=model_id,
            filename=_CONFIG_FILE,
            cache_dir=str(models_dir),
        )

        _LOG.info("loading vision encoder from %s", self._vision_path)
        import onnxruntime  # noqa: PLC0415

        # Prefer CPU for tagging — it's fast enough and avoids GPU OOM.
        so = onnxruntime.SessionOptions()
        so.graph_optimization_level = onnxruntime.GraphOptimizationLevel.ORT_ENABLE_ALL
        self._vision_session = onnxruntime.InferenceSession(
            self._vision_path, so, providers=["CPUExecutionProvider"],
        )
        self._vision_input_name = self._vision_session.get_inputs()[0].name

        _LOG.info("loading text encoder from %s", self._text_path)
        self._text_session = onnxruntime.InferenceSession(
            self._text_path, so, providers=["CPUExecutionProvider"],
        )
        self._text_input_names = [inp.name for inp in self._text_session.get_inputs()]

        # Load tokenizer
        self._tokenizer = HFTokenizer.from_file(tokenizer_path)
        self._tokenizer.add_special_tokens(["[CLS]", "[SEP]", "[PAD]", "[UNK]"])
        if self._tokenizer.token_to_id("[CLS]") is None:
            self._tokenizer.add_tokens(["[CLS]"])
        if self._tokenizer.token_to_id("[SEP]") is None:
            self._tokenizer.add_tokens(["[SEP]"])
        if self._tokenizer.token_to_id("[PAD]") is None:
            self._tokenizer.add_tokens(["[PAD]"])
        if self._tokenizer.token_to_id("[UNK]") is None:
            self._tokenizer.add_tokens(["[UNK]"])

        # Load config for model-specific parameters
        with open(config_path) as f:
            self._config = json.load(f)
        self._context_length = self._config.get("max_position_embeddings", 77)

        # Resolve tag vocabulary
        vocab_raw = os.environ.get("TGDL_FACES_CLIP_VOCABULARY", "").strip()
        if vocab_raw:
            self._vocabulary = [v.strip() for v in vocab_raw.split(",") if v.strip()]
        else:
            self._vocabulary = list(DEFAULT_VOCABULARY)

        _LOG.info(
            "tag vocabulary: %d labels, context_length=%d",
            len(self._vocabulary),
            self._context_length,
        )

        # Pre-compute text embeddings once
        self._text_embeddings = self._encode_texts(self._vocabulary)
        _LOG.info(
            "CLIP tagger ready — %d text embeddings pre-computed (dim=%d)",
            len(self._vocabulary),
            self._text_embeddings.shape[1],
        )

        self._threshold = _resolve_threshold()
        self._top_k = _resolve_top_k()

    # ---- public API -------------------------------------------------------

    def tag_image(
        self,
        image_bgr: np.ndarray,
        *,
        threshold: float | None = None,
        top_k: int | None = None,
        vocabulary: list[str] | None = None,
    ) -> list[dict[str, Any]]:
        """Score ``image_bgr`` against the tag vocabulary.

        Parameters
        ----------
        image_bgr
            H×W×3 ``uint8`` BGR ndarray (the same format ``cv2`` and
            :func:`~tgdl_faces.io.load_image_from_path` produce).
        threshold
            Minimum score (0..1). Defaults to the env var or 0.20.
        top_k
            Max tags to return. Defaults to the env var or 10.
        vocabulary
            Custom tag list. If provided, text embeddings are computed
            on the fly for these tags. If omitted, the tagger's default
            vocabulary is used.

        Returns
        -------
        list[dict]
            ``[{"tag": str, "score": float}, ...]`` sorted by score
            descending, filtered by threshold.
        """
        threshold = threshold if threshold is not None else self._threshold
        top_k = top_k if top_k is not None else self._top_k

        # Resolve vocabulary — custom or default
        if vocabulary is not None and len(vocabulary) > 0:
            vocab = vocabulary
            text_embeddings = self._encode_texts(vocab)
        else:
            vocab = self._vocabulary
            text_embeddings = self._text_embeddings

        # Preprocess image
        image = self._preprocess(image_bgr)

        # Vision encoder forward pass
        emb = self._vision_session.run(None, {self._vision_input_name: image})[0]
        emb = emb.flatten()
        emb = emb / max(float(np.linalg.norm(emb)), 1e-9)

        # Cosine similarity against every tag embedding
        scores = np.dot(text_embeddings, emb)
        # Softmax over the vocabulary to get probability-like scores
        scores = np.exp(scores - scores.max())
        scores = scores / scores.sum()

        # Build result list
        results: list[dict[str, Any]] = []
        for i in range(len(vocab)):
            s = float(scores[i])
            if s >= threshold:
                results.append({"tag": vocab[i], "score": round(s, 4)})

        results.sort(key=lambda x: x["score"], reverse=True)
        return results[:top_k]

    @property
    def vocabulary(self) -> list[str]:
        return list(self._vocabulary)

    @property
    def model_id(self) -> str:
        return _resolve_model_id()

    @property
    def dim(self) -> int:
        return self._text_embeddings.shape[1] if self._text_embeddings is not None else 512

    # ---- internals --------------------------------------------------------

    def _preprocess(self, image_bgr: np.ndarray) -> np.ndarray:
        """Convert BGR HWC uint8 to CLIP-ready NCHW float32 tensor."""
        # BGR → RGB
        rgb = image_bgr[..., ::-1].copy()
        h, w = rgb.shape[:2]

        # Resize maintaining aspect ratio, centre-crop to 224×224
        scale = _CLIP_SIZE / max(h, w)
        new_h, new_w = int(round(h * scale)), int(round(w * scale))
        pil_img = Image.fromarray(rgb).resize((new_w, new_h), Image.BICUBIC)

        # Centre crop
        left = (new_w - _CLIP_SIZE) // 2
        top = (new_h - _CLIP_SIZE) // 2
        pil_img = pil_img.crop((left, top, left + _CLIP_SIZE, top + _CLIP_SIZE))

        img_array = np.asarray(pil_img, dtype=np.float32) / 255.0
        img_array = (img_array - _CLIP_MEAN) / _CLIP_STD

        # HWC → NCHW
        return np.expand_dims(np.transpose(img_array, (2, 0, 1)), axis=0).astype(np.float32)

    def _tokenize(self, texts: list[str]) -> dict[str, np.ndarray]:
        """Tokenize a list of strings for CLIP text encoder.

        Returns a dict of ``{input_name: ndarray}`` suitable for
        ``self._text_session.run()``.
        """
        n = len(texts)
        # CLIP uses a fixed context length; pad/truncate each sequence
        # to self._context_length.
        input_ids = np.full((n, self._context_length), 0, dtype=np.int64)
        attention_mask = np.zeros((n, self._context_length), dtype=np.int64)

        cls_id = self._tokenizer.token_to_id("[CLS]") or 0
        sep_id = self._tokenizer.token_to_id("[SEP]") or 0
        pad_id = self._tokenizer.token_to_id("[PAD]") or 0

        for i, text in enumerate(texts):
            encoded = self._tokenizer.encode(text)
            ids = encoded.ids
            # Truncate to context_length - 2 (one [CLS] at start, one [SEP] at end)
            max_len = self._context_length - 2
            if len(ids) > max_len:
                ids = ids[:max_len]
            # Build sequence: [CLS] ... ids ... [SEP] [PAD]...
            seq = [cls_id] + ids + [sep_id]
            seq_len = len(seq)
            input_ids[i, :seq_len] = seq
            attention_mask[i, :seq_len] = 1

        return {
            "input_ids": input_ids,
            "attention_mask": attention_mask,
        }

    def _encode_texts(self, texts: list[str]) -> np.ndarray:
        """Compute L2-normalised text embeddings for a list of strings.

        Results are cached in-memory (computed once per tagger init).
        """
        tokens = self._tokenize(texts)
        # Build feed dict — ONNX CLIP text encoder expects input_ids,
        # attention_mask, and optionally token_type_ids.
        feed: dict[str, np.ndarray] = {}
        for name in self._text_input_names:
            if name == "input_ids":
                feed[name] = tokens["input_ids"]
            elif name == "attention_mask":
                feed[name] = tokens["attention_mask"]
            else:
                # token_type_ids or any other input — zero-fill
                feed[name] = np.zeros(
                    (len(texts), self._context_length), dtype=np.int64
                )

        embeddings = self._text_session.run(None, feed)[0]
        # L2-normalise each row
        norms = np.linalg.norm(embeddings, axis=-1, keepdims=True)
        norms = np.maximum(norms, 1e-9)
        return embeddings / norms
