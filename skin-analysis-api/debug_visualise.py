#!/usr/bin/env python3
"""Visual proof that the analysis really runs on MediaPipe + OpenCV.

This is a DEBUG TOOL, not part of the API. It runs the exact same pipeline
the server uses, then draws what each stage actually produced onto the image
so you can see it with your own eyes:

  1. MediaPipe Face Mesh landmarks   -> small dots (all 478 points)
  2. Face bounding box               -> white rectangle
  3. OpenCV skin-region masks        -> coloured overlays per region
  4. The measured numbers            -> printed to the terminal

If the face outline, cheeks, forehead and chin line up with the actual face,
the geometry is genuinely coming from MediaPipe. If they did not, the masks
would sit in the wrong place and the overlay would obviously be nonsense.

Usage:
    python3 debug_visualise.py ../images/concerns/acne.jpeg
    python3 debug_visualise.py photo.jpg -o /tmp/checked.png
"""

import argparse
import os
import sys

import cv2
import numpy as np

from face_detection import detect_face
from image_quality import assess_quality
from skin_regions import build_skin_masks, normalise_scale, CANONICAL_FACE_WIDTH
from skin_metrics import compute_signals
from concern_mapper import decide, CONCERN_THRESHOLDS

# BGR colours for each region overlay.
REGION_COLOURS = {
    "left_cheek": (120, 200, 255),   # amber
    "right_cheek": (120, 255, 200),  # mint
    "forehead": (255, 190, 120),     # blue-ish
    "chin": (200, 150, 255),         # pink
}


def annotate(image_bgr, landmarks, bbox, masks_at_scale, scale):
    """Draw landmarks, bbox and region masks onto a copy of the image."""
    canvas = image_bgr.copy()

    # 3. Region masks, drawn first so landmarks stay readable on top.
    overlay = canvas.copy()
    for name, mask in masks_at_scale.items():
        # Masks were built at the canonical scale; bring them back to the
        # original image size purely for display.
        full = cv2.resize(mask, (canvas.shape[1], canvas.shape[0]),
                          interpolation=cv2.INTER_NEAREST)
        colour = REGION_COLOURS.get(name, (200, 200, 200))
        overlay[full > 0] = colour
        # Outline each region so its shape is obvious.
        contours, _ = cv2.findContours(full, cv2.RETR_EXTERNAL,
                                       cv2.CHAIN_APPROX_SIMPLE)
        cv2.drawContours(canvas, contours, -1, colour, 2)
    canvas = cv2.addWeighted(overlay, 0.35, canvas, 0.65, 0)

    # 1. Every MediaPipe landmark.
    for (x, y) in landmarks:
        cv2.circle(canvas, (int(x), int(y)), 1, (0, 255, 255), -1)

    # 2. Face bounding box.
    x, y, w, h = bbox
    cv2.rectangle(canvas, (x, y), (x + w, y + h), (255, 255, 255), 2)

    # Legend.
    y0 = 24
    cv2.putText(canvas, f"MediaPipe landmarks: {len(landmarks)}", (12, y0),
                cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 255), 2)
    for i, (name, colour) in enumerate(REGION_COLOURS.items()):
        present = "yes" if name in masks_at_scale else "MISSING"
        cv2.putText(canvas, f"{name}: {present}", (12, y0 + 24 * (i + 1)),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.55, colour, 2)
    return canvas


def main():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("image", help="path to a photograph containing one face")
    parser.add_argument("-o", "--output", default=None,
                        help="where to write the annotated image "
                             "(default: <image>-debug.png)")
    args = parser.parse_args()

    image = cv2.imread(args.image, cv2.IMREAD_COLOR)
    if image is None:
        print(f"Could not read {args.image}", file=sys.stderr)
        return 1
    print(f"\nImage: {args.image}  ({image.shape[1]}x{image.shape[0]})")

    # --- Stage 1: MediaPipe -------------------------------------------------
    face = detect_face(image)
    if face["error"]:
        print(f"MediaPipe result: {face['error']} "
              f"(faces found: {face['face_count']})")
        return 2
    print(f"MediaPipe Face Mesh : 1 face, {len(face['landmarks'])} landmarks")
    print(f"  bounding box      : {face['bbox']}")
    print(f"  face coverage     : {face['coverage']*100:.1f}% of the frame")

    # --- Stage 2: capture quality ------------------------------------------
    quality = assess_quality(image, face["bbox"], face["coverage"])
    print(f"OpenCV quality      : brightness={quality['brightness']} "
          f"sharpness={quality['sharpness']} "
          f"lighting_score={quality['lighting_score']}")
    if quality["warnings"]:
        print(f"  warnings          : {', '.join(quality['warnings'])}")

    # --- Stage 3: scale normalisation + masks ------------------------------
    measure_image, measure_landmarks = normalise_scale(
        image, face["landmarks"], face["bbox"])
    scale = CANONICAL_FACE_WIDTH / max(1.0, float(face["bbox"][2]))
    masks = build_skin_masks(measure_image, measure_landmarks)
    print(f"Canonical rescale   : face width -> {int(CANONICAL_FACE_WIDTH)}px "
          f"(factor {scale:.3f})")
    if not masks:
        print("  NO usable skin regions were built.")
        return 3
    for name, mask in masks.items():
        print(f"  mask {name:<12}: {int(cv2.countNonZero(mask)):>6} px")

    # --- Stage 4: measurements ---------------------------------------------
    debug = {}
    signals = compute_signals(measure_image, masks, debug=debug)

    # Per-region redness evidence: where the clusters were and how strong.
    print("\nRedness evidence per region (baseline = that region's own skin):")
    for name, info in sorted(debug.get("redness_regions", {}).items(),
                             key=lambda kv: -kv[1]["coverage"]):
        print(f"  {name:<12} coverage={info['coverage']*100:5.2f}%  "
              f"clusters={info['clusters']:<4} intensity={info['intensity']:+.1f} a*")
    print(f"  regions affected : {debug.get('redness_regions_affected', 0)} of {len(masks)}")
    print(f"  headline coverage: {debug.get('redness_headline_coverage', 0)*100:.2f}%")

    print("\nRAW SIGNALS (0-1 engineering scale, NOT probabilities):")
    for key, data in signals.items():
        evidence = data.get("evidence") or {}
        print(f"  {key:<12} score={data['score']:.2f}  level={data['level']:<14} "
              f"confidence={evidence.get('confidence', 0):.2f}  "
              f"area={evidence.get('affected_area', 0)*100:5.2f}%")
        supporting = evidence.get("supporting") or []
        print(f"  {'':<12} supporting: {', '.join(supporting) or 'none'}")

    # Signals are measurements; concerns are decisions taken against stricter
    # multi-criteria rules. Print WHY each decision went the way it did.
    outcome = decide(signals)
    print("\nCONCERN DECISIONS (a card needs signal + confidence + area + "
          "2 agreeing features):")
    for key, record in outcome["decisions"].items():
        bar = CONCERN_THRESHOLDS.get(key)
        mark = "SHOWN " if record.get("passed") else "hidden"
        print(f"  {mark} {key:<12} "
              f"{'concern-threshold ' + str(bar) if bar else '':<24}"
              f"{record.get('decision_reason', '')}")

    print("\nFinal concerns      : "
          + (", ".join(s["concern"] for s in outcome["concerns"])
             or "NONE - no strong visible concerns detected"))
    for note in outcome["notes"]:
        print(f"  note: {note}")

    # --- Write the annotated proof image -----------------------------------
    output = args.output or (os.path.splitext(args.image)[0] + "-debug.png")
    canvas = annotate(image, face["landmarks"], face["bbox"], masks, scale)

    # Redness heatmap: detected inflammation clusters, drawn in red at the
    # original image scale so they line up with the face.
    red_mask = debug.get("redness_mask")
    if red_mask is not None and red_mask.any():
        full = cv2.resize(red_mask, (canvas.shape[1], canvas.shape[0]),
                          interpolation=cv2.INTER_NEAREST)
        heat = canvas.copy()
        heat[full > 0] = (0, 0, 255)
        canvas = cv2.addWeighted(heat, 0.55, canvas, 0.45, 0)
        contours, _ = cv2.findContours(full, cv2.RETR_EXTERNAL,
                                       cv2.CHAIN_APPROX_SIMPLE)
        cv2.drawContours(canvas, contours, -1, (0, 0, 255), 1)
        cv2.putText(canvas, "red = detected inflammation clusters",
                    (12, canvas.shape[0] - 16), cv2.FONT_HERSHEY_SIMPLEX,
                    0.55, (0, 0, 255), 2)
    cv2.imwrite(output, canvas)
    print(f"\nAnnotated overlay written to: {output}")
    print("Open it: the yellow dots are MediaPipe landmarks and the coloured\n"
          "patches are the OpenCV masks the measurements were taken from.\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
