"""COSMO SELECT — experimental visual skin-screening API.

An experimental browser-assisted cosmetic screening prototype using
MediaPipe facial landmarks and OpenCV-based visible-feature measurements
to suggest concerns for user confirmation before knowledge-graph product
retrieval. It is NOT a medical device and produces no diagnosis.

Images are processed entirely in memory and are never written to disk.
"""

import os

import cv2
import numpy as np
from flask import Flask, jsonify, request
from flask_cors import CORS

from face_detection import detect_face, estimate_yaw
from image_quality import assess_quality
from skin_regions import (build_skin_masks, normalise_scale, region_luma_ratio,
                          MAX_REGION_LUMA_RATIO)
from skin_metrics import compute_signals
from concern_mapper import decide

# Two usable regions (typically the two cheeks) are enough to measure. An
# earlier value of 3 rejected too many ordinary selfies, where hair covers
# the forehead or a hand rests near the chin.
MIN_VALID_REGIONS = 2

MAX_CONTENT_LENGTH = 8 * 1024 * 1024  # 8 MB
ALLOWED_MIME_TYPES = {"image/jpeg", "image/png", "image/webp"}

# Front view plus a left- and right-turned view.
MAX_CAPTURES = 3

# Bump whenever the measurement logic changes. Recorded with user feedback so
# that later evaluation can be grouped by the algorithm that produced it.
ALGORITHM_VERSION = "0.4.0-relative-baseline"

DISCLAIMER = ("Experimental image-based cosmetic screening only. "
              "Not a medical diagnosis.")

QUALITY_HINT = ("Image quality may reduce the reliability of this result. "
                "Retake the photo in soft, even front-facing light.")

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = MAX_CONTENT_LENGTH

allowed_origins = os.getenv(
    "ALLOWED_ORIGINS",
    "http://localhost:8080,http://127.0.0.1:8080,"
    "http://localhost:8765,http://127.0.0.1:8765,null",
).split(",")
CORS(app, origins=allowed_origins)


def _error(status, code, message):
    return jsonify({"success": False, "error": code, "message": message}), status


@app.get("/api/health")
def health():
    return jsonify({"status": "ok"})


@app.errorhandler(413)
def too_large(_):
    return _error(413, "file_too_large", "The image exceeds the 8 MB limit.")


def _analyse_one(image):
    """Run the pipeline on a single decoded image.

    Returns (payload_parts, None) on success, or (None, (status, body)) with a
    ready-to-return error.
    """
    face = detect_face(image)
    if face["error"] == "no_face":
        return None, ("no_face",
                      "No face was detected. Try a clear, front-facing photograph.")
    if face["error"] == "multiple_faces":
        return None, ("multiple_faces",
                      "More than one face was detected. Use an image containing one person.")

    quality = assess_quality(image, face["bbox"], face["coverage"])
    quality_out = {
        "acceptable": quality["acceptable"],
        "reliable": quality["reliable"],
        "codes": quality["warnings"],
        "warnings": quality["messages"],
        "brightness": quality["brightness"],
        "sharpness": quality["sharpness"],
        "lighting_score": quality["lighting_score"],
    }
    if not quality["acceptable"]:
        # A serious capture problem: refuse to present a confident reading.
        return None, ("poor_quality",
                      quality["messages"][0] if quality["messages"]
                      else "The image quality is too low for a visual screening.",
                      quality_out)

    # Quality is judged on the original image; measurements are taken at a
    # canonical face scale so texture is comparable across resolutions.
    measure_image, measure_landmarks = normalise_scale(
        image, face["landmarks"], face["bbox"])
    masks = build_skin_masks(measure_image, measure_landmarks)
    if not masks:
        return None, ("insufficient_skin_area",
                      "Not enough visible facial skin could be measured. "
                      "Try a closer, front-facing photograph.", quality_out)

    # MediaPipe locates a face even when it is partly hidden, so a mask can
    # land on hair, a hand, spectacles or a held object. Only refuse when too
    # little usable skin is left to measure at all.
    if len(masks) < MIN_VALID_REGIONS:
        return None, ("face_obstructed",
                      "Too much of the face is covered to measure. Move hair, "
                      "hands, glasses and objects away from your face, then "
                      "try again.", quality_out)

    # Uneven light across the face degrades reliability but does not make
    # measurement impossible, so it is reported rather than refused.
    if region_luma_ratio(measure_image, masks) > MAX_REGION_LUMA_RATIO:
        quality_out["reliable"] = False
        quality_out["codes"] = quality_out["codes"] + ["uneven_face_lighting"]
        quality_out["warnings"] = quality_out["warnings"] + [
            "One side of the face is much brighter than the other, which "
            "reduces reliability. Face a soft, even light source."]

    # Fewer regions than the full four also lowers confidence.
    if len(masks) < 4:
        quality_out["reliable"] = False
        quality_out["warnings"] = quality_out["warnings"] + [
            f"Only {len(masks)} of 4 facial areas could be measured; the rest "
            f"were covered or unevenly lit."]

    # Colour-dependent signals must not report a confident "low" when the
    # white balance or exposure makes colour untrustworthy.
    # Only conditions that DESTROY colour information make the colour-based
    # signals uncertain. A uniform colour cast largely cancels, because every
    # measurement here compares a pixel with the surrounding skin in the same
    # frame; clipping from over- or under-exposure genuinely loses the data,
    # and uneven lighting breaks the local-baseline assumption.
    colour_reliable = not any(
        code in ("too_bright", "too_dark", "uneven_face_lighting")
        for code in quality_out["codes"])

    return ({
        "signals": compute_signals(measure_image, masks,
                                   colour_reliable=colour_reliable),
        "quality": quality_out,
        "regions": sorted(masks.keys()),
    }, None)


def _merge(results):
    """Combine several captures of the same face into one reading.

    Turning the head left and right exposes skin that a single front-on frame
    foreshortens or hides, so more of the face actually gets measured. Per
    signal the MEDIAN across captures is taken rather than the maximum: a
    single frame spoiled by a highlight, a shadow or motion blur then cannot
    drive the whole result on its own.
    """
    merged_signals = {}
    keys = results[0]["signals"].keys()
    for key in keys:
        scores = sorted(r["signals"][key]["score"] for r in results)
        middle = len(scores) // 2
        score = (scores[middle] if len(scores) % 2
                 else (scores[middle - 1] + scores[middle]) / 2)
        score = round(float(score), 2)
        # Preserve an "uncertain" verdict from any capture: if colour was
        # untrustworthy in one frame, or the signal is one that cannot be
        # established from a photograph, the merged result must say so too
        # rather than being recomputed into a confident band.
        levels = [r["signals"][key]["level"] for r in results]
        if "not_assessable" in levels:
            level = "not_assessable"
        elif "uncertain" in levels:
            level = "uncertain"
        else:
            level = _level_for(score)

        # Evidence is carried through from the capture with the strongest
        # confidence, and its confidence is averaged across captures so a
        # single lucky frame cannot license a concern on its own.
        evidences = [r["signals"][key].get("evidence") or {} for r in results]
        best_evidence = max(
            evidences, key=lambda e: float(e.get("confidence", 0.0)))
        merged_evidence = dict(best_evidence)
        merged_evidence["confidence"] = round(
            sum(float(e.get("confidence", 0.0)) for e in evidences)
            / max(1, len(evidences)), 3)

        merged_signals[key] = {
            "score": score,
            "level": level,
            "region": results[0]["signals"][key]["region"],
            "evidence": merged_evidence,
        }

    regions = sorted({region for r in results for region in r["regions"]})
    warnings, codes = [], []
    for r in results:
        for message in r["quality"]["warnings"]:
            if message not in warnings:
                warnings.append(message)
        for code in r["quality"]["codes"]:
            if code not in codes:
                codes.append(code)

    quality = {
        "acceptable": True,
        "reliable": all(r["quality"]["reliable"] for r in results),
        "codes": codes,
        "warnings": warnings,
        "brightness": results[0]["quality"]["brightness"],
        "sharpness": results[0]["quality"]["sharpness"],
        "lighting_score": round(
            sum(r["quality"]["lighting_score"] for r in results) / len(results), 2),
    }
    return merged_signals, quality, regions


def _level_for(score):
    """Mirrors _confidence_level in skin_metrics for merged multi-capture."""
    if score >= 0.70:
        return "high"
    if score >= 0.45:
        return "moderate"
    if score >= 0.20:
        return "mild"
    return "low"


@app.post("/api/face-position")
def face_position():
    """Lightweight live tracking for the guided camera capture.

    The browser's own FaceDetector API is behind a flag in Chrome and absent
    elsewhere, so relying on it meant auto-capture silently never ran and
    every user had to press the shutter. This endpoint gives the same
    guidance everywhere, using the MediaPipe landmarks already in the stack,
    and additionally reports head turn, which the browser API cannot do.

    Deliberately minimal: landmarks and geometry only, no quality checks and
    no measurement. Frames are small, processed in memory and discarded.
    """
    if "frame" not in request.files:
        return _error(400, "missing_frame", "No frame was provided.")

    data = request.files["frame"].read()
    if not data:
        return _error(400, "empty_frame", "The frame was empty.")

    image = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
    if image is None:
        return _error(400, "decode_failed", "The frame could not be decoded.")

    face = detect_face(image)
    if face["error"]:
        return jsonify({"face_count": face["face_count"], "found": False,
                        "reason": face["error"]})

    height, width = image.shape[:2]
    x, y, w, h = face["bbox"]
    return jsonify({
        "found": True,
        "face_count": 1,
        # Normalised so the client can compare against its own guide box
        # without knowing the frame size it sent.
        "box": {"x": x / width, "y": y / height,
                "width": w / width, "height": h / height},
        "yaw": round(estimate_yaw(face["landmarks"]), 3),
        "coverage": round(face["coverage"], 4),
    })


@app.post("/api/analyse-skin")
def analyse_skin():
    """Analyse one or more captures of the same face.

    Accepts up to MAX_CAPTURES files under the field name "image". The
    frontend sends a front view plus optional left- and right-turned views so
    that more of the face is actually measured than a single frame allows.
    """
    uploads = request.files.getlist("image")
    if not uploads:
        return _error(400, "missing_image", "No image file was provided.")

    results, failures = [], []
    for upload in uploads[:MAX_CAPTURES]:
        if upload.mimetype not in ALLOWED_MIME_TYPES:
            return _error(400, "invalid_type",
                          "Only JPEG, PNG and WebP images are accepted.")
        data = upload.read()
        if not data:
            return _error(400, "empty_file", "The uploaded image is empty.")
        image = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
        if image is None:
            return _error(400, "decode_failed", "The image could not be decoded.")

        outcome, failure = _analyse_one(image)
        if outcome is not None:
            results.append(outcome)
        else:
            failures.append(failure)

    # Every capture failed: report the first reason so the guidance is specific.
    if not results:
        code, message = failures[0][0], failures[0][1]
        quality = failures[0][2] if len(failures[0]) > 2 else None
        body = {"success": False, "error": code, "message": message,
                "hint": QUALITY_HINT, "algorithm_version": ALGORITHM_VERSION}
        if quality is not None:
            body["quality"] = quality
        return jsonify(body), 422

    signals, quality, regions = _merge(results)
    if failures:
        quality["reliable"] = False
        quality["warnings"] = quality["warnings"] + [
            f"{len(failures)} of {len(uploads)} captures could not be used."]

    # Signals are measurements; concerns are decisions. The decision layer
    # applies stricter, multi-criteria rules and may legitimately return none.
    outcome = decide(signals)

    return jsonify({
        "success": True,
        "face_detected": True,
        "quality": quality,
        "signals": signals,
        "suggestions": outcome["concerns"],
        # True when nothing cleared the concern bar. The interface shows a
        # positive "no strong visible concerns" result rather than an empty
        # list, and never invents a concern to fill the space.
        "no_strong_concerns": outcome["clear"],
        "assessment_notes": outcome["notes"],
        "decisions": outcome["decisions"],
        "disclaimer": DISCLAIMER,
        "quality_hint": None if quality["reliable"] else QUALITY_HINT,
        "regions_measured": regions,
        "captures_used": len(results),
        "algorithm_version": ALGORITHM_VERSION,
    })


@app.errorhandler(500)
def internal_error(error):
    app.logger.exception("Internal error: %s", error)
    return _error(500, "internal_error",
                  "The analysis failed unexpectedly. Please try again.")


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=False)
