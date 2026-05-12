"""OCR module using pytesseract (Tesseract wrapper)."""

import logging
from pathlib import Path

import pytesseract
from PIL import Image

_LOG = logging.getLogger(__name__)

_TESSERACT_AVAILABLE = False
_TESSERACT_ERROR = None


def _check_tesseract():
    """Check if tesseract is available on the system."""
    global _TESSERACT_AVAILABLE, _TESSERACT_ERROR
    if _TESSERACT_AVAILABLE is not None:
        return _TESSERACT_AVAILABLE
    try:
        pytesseract.pytesseract.get_tesseract_version()
        _TESSERACT_AVAILABLE = True
        return True
    except Exception as e:
        _TESSERACT_ERROR = str(e)
        _LOG.warning(f"Tesseract not available: {e}")
        _TESSERACT_AVAILABLE = False
        return False


def is_ready() -> bool:
    """Check if OCR is ready to use."""
    return _check_tesseract()


def last_error() -> str | None:
    """Get last OCR error."""
    return _TESSERACT_ERROR


def extract_text(img: Image.Image, lang: str = "eng") -> dict:
    """Extract text from image using Tesseract OCR.

    Args:
        img: PIL Image object
        lang: Tesseract language code (default "eng" for English)

    Returns:
        {text, language, confidence}
    """
    if not _check_tesseract():
        raise RuntimeError(f"Tesseract not available: {_TESSERACT_ERROR}")

    try:
        # Extract text with language parameter
        text = pytesseract.image_to_string(img, lang=lang)

        # Get detailed info including confidence
        data = pytesseract.image_to_data(img, lang=lang, output_type=pytesseract.Output.DICT)

        # Calculate average confidence (exclude -1 values which indicate no recognition)
        confidences = [int(conf) for conf in data["conf"] if int(conf) > 0]
        avg_confidence = sum(confidences) / len(confidences) if confidences else 0.0
        confidence = round(avg_confidence / 100.0, 2)

        return {
            "text": text.strip(),
            "language": lang,
            "confidence": confidence if text.strip() else 0.0,
        }
    except Exception as e:
        _LOG.exception("OCR extraction failed")
        raise RuntimeError(f"OCR failed: {type(e).__name__}: {e}")
