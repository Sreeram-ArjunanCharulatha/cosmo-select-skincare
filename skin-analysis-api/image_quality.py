"""Input-quality assessment for the visual screening prototype.

WHY THIS MODULE MATTERS FOR FAIRNESS
------------------------------------
A camera has already made irreversible decisions before a single pixel
reaches this code. Auto-exposure meters, auto white balance and vendor
"beautification" pipelines are tuned on the manufacturer's own test data and
routinely under-expose deeper skin, shift its colour balance, and apply
noise reduction that erases genuine texture. None of that can be reliably
undone afterwards: information destroyed by clipping or denoising is simply
gone, and "brightening" an under-exposed frame amplifies noise rather than
recovering detail.

The honest response is therefore to DETECT poor capture conditions and ask
for a better photograph, rather than to silently analyse a degraded image
and report a confident-looking result. That is what this module does.

Thresholds here are practical capture-quality limits (is there enough signal
to measure anything at all), not skin-condition thresholds. They are applied
identically to every image.
"""

import cv2
import numpy as np

MIN_SIDE = 360                 # smallest acceptable image side, pixels
COVERAGE_RANGE = (0.08, 0.94)  # face bbox area / image area
BRIGHTNESS_RANGE = (48, 225)   # mean grey level of the face region, 0-255
SHARPNESS_MIN = 28.0           # Laplacian variance; lower means blurrier
SHADOW_STD_MAX = 62.0          # luminance spread across the face
UNEVEN_RATIO_MAX = 1.85        # brighter half / darker half of the face
# Deviation of mean a*/b* from neutral grey (128). Skin is inherently warm,
# so a face measures 20-25 even under perfect white balance; an earlier value
# of 18 fired on every photograph and made colour look permanently unreliable.
# This is set to catch only a genuinely strong cast.
COLOUR_CAST_MAX = 34.0
EDGE_MARGIN_PX = 2             # bbox this close to the border counts as clipped

# Problems that make any measurement untrustworthy. These block analysis.
#
# "face_clipped" is deliberately NOT blocking. MediaPipe clamps landmarks to
# the image bounds, so a face that merely touches the border is
# indistinguishable from one cropped slightly, and tightly framed portraits
# touch the border routinely. Blocking on it would reject many perfectly
# usable photographs, so it warns instead.
BLOCKING = {
    "image_too_small",
    "face_too_small",
    "face_cropped",
    "too_dark",
    "blurry",
}

MESSAGES = {
    "image_too_small": "The image resolution is too low for a reliable visual screening.",
    "face_too_small": "The face is too small. Move closer or crop the photograph.",
    "face_cropped": "The face fills almost the whole frame. Move back slightly.",
    "face_clipped": "Part of the face is outside the frame. Fit your whole face inside the guide.",
    "too_dark": "The photograph is under-exposed, which reduces reliability. Try softer, brighter front-facing light.",
    "too_bright": "The photograph is over-exposed, so some skin detail is lost.",
    "blurry": "The photograph appears blurry. Hold the camera steady or choose another image.",
    "strong_shadows": "Strong shadows across the face can affect the reading.",
    "uneven_lighting": "The light is much stronger on one side of the face.",
    "colour_cast": "The photograph has a strong colour cast, which can affect colour signals.",
}


def _face_region(image_bgr, bbox):
    """Crop to the face bounding box when it is usable, else the whole frame."""
    height, width = image_bgr.shape[:2]
    if bbox is None:
        return image_bgr
    x, y, w, h = bbox
    x0, y0 = max(0, x), max(0, y)
    x1, y1 = min(width, x + w), min(height, y + h)
    if (x1 - x0) > 20 and (y1 - y0) > 20:
        return image_bgr[y0:y1, x0:x1]
    return image_bgr


def _is_clipped(bbox, shape):
    """True when the detected face runs into the frame border."""
    if bbox is None:
        return False
    height, width = shape[:2]
    x, y, w, h = bbox
    return (
        x <= EDGE_MARGIN_PX
        or y <= EDGE_MARGIN_PX
        or (x + w) >= (width - EDGE_MARGIN_PX)
        or (y + h) >= (height - EDGE_MARGIN_PX)
    )


def _lighting_quality(brightness, shadow_std, uneven_ratio, cast, sharpness):
    """Combine capture conditions into a single 0-1 lighting-quality score.

    This describes the PHOTOGRAPH, never the person. It is recorded with
    feedback so that later evaluation can separate "the algorithm was wrong"
    from "the input was poor".
    """
    # Each term is 1.0 when ideal and falls toward 0 as conditions worsen.
    ideal_brightness = 1.0 - min(1.0, abs(brightness - 135.0) / 105.0)
    shadow_term = 1.0 - min(1.0, max(0.0, shadow_std - 30.0) / SHADOW_STD_MAX)
    even_term = 1.0 - min(1.0, max(0.0, uneven_ratio - 1.15) / (UNEVEN_RATIO_MAX - 1.15))
    cast_term = 1.0 - min(1.0, cast / (COLOUR_CAST_MAX * 1.6))
    sharp_term = min(1.0, sharpness / 90.0)
    score = (ideal_brightness * 0.3 + shadow_term * 0.2 + even_term * 0.2
             + cast_term * 0.15 + sharp_term * 0.15)
    return round(float(np.clip(score, 0.0, 1.0)), 2)


def assess_quality(image_bgr, bbox, coverage):
    """Return a structured capture-quality assessment.

    {
      "acceptable": bool,        # False means do not report a result
      "reliable": bool,          # False means report, but flag reduced reliability
      "warnings": [code, ...],
      "messages": [human text, ...],
      "brightness": float,
      "sharpness": float,
      "lighting_score": float    # 0-1, quality of the PHOTOGRAPH only
    }
    """
    warnings = []
    height, width = image_bgr.shape[:2]

    if min(width, height) < MIN_SIDE:
        warnings.append("image_too_small")

    if coverage < COVERAGE_RANGE[0]:
        warnings.append("face_too_small")
    elif coverage > COVERAGE_RANGE[1]:
        warnings.append("face_cropped")

    if _is_clipped(bbox, image_bgr.shape):
        warnings.append("face_clipped")

    region = _face_region(image_bgr, bbox)
    gray = cv2.cvtColor(region, cv2.COLOR_BGR2GRAY)
    brightness = float(gray.mean())
    sharpness = float(cv2.Laplacian(gray, cv2.CV_64F).var())
    shadow_std = float(gray.std())

    # Left/right balance: a large difference means strong directional light.
    mid = max(1, gray.shape[1] // 2)
    left_mean = float(gray[:, :mid].mean()) or 1.0
    right_mean = float(gray[:, mid:].mean()) or 1.0
    uneven_ratio = max(left_mean, right_mean) / max(1e-6, min(left_mean, right_mean))

    # Colour cast: how far the average a*/b* sit from the neutral point (128).
    lab = cv2.cvtColor(region, cv2.COLOR_BGR2LAB)
    cast = float(np.hypot(lab[:, :, 1].mean() - 128.0, lab[:, :, 2].mean() - 128.0))

    if brightness < BRIGHTNESS_RANGE[0]:
        warnings.append("too_dark")
    elif brightness > BRIGHTNESS_RANGE[1]:
        warnings.append("too_bright")

    if sharpness < SHARPNESS_MIN:
        warnings.append("blurry")
    if shadow_std > SHADOW_STD_MAX:
        warnings.append("strong_shadows")
    if uneven_ratio > UNEVEN_RATIO_MAX:
        warnings.append("uneven_lighting")
    if cast > COLOUR_CAST_MAX:
        warnings.append("colour_cast")

    acceptable = not any(code in BLOCKING for code in warnings)
    return {
        "acceptable": acceptable,
        # Any warning at all means the result should be presented with a
        # visible reliability caveat rather than as a confident reading.
        "reliable": acceptable and not warnings,
        "warnings": warnings,
        "messages": [MESSAGES.get(code, code) for code in warnings],
        "brightness": round(brightness, 1),
        "sharpness": round(sharpness, 1),
        "lighting_score": _lighting_quality(
            brightness, shadow_std, uneven_ratio, cast, sharpness),
    }
