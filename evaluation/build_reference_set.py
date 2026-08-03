#!/usr/bin/env python3
"""Turn a labelled dermatology dataset into evaluation records.

This runs the real analysis pipeline over every image in a labelled dataset
and writes records matching schema.json, ready for metrics.py.

WHY THIS SCRIPT EXISTS
----------------------
The scale anchors in skin_metrics.py and the thresholds in concern_mapper.py
were set by eyeballing a few unlabelled stock photographs. That is not
calibration. This script is the route to replacing those guesses with numbers
derived from expert-labelled images, and to measuring performance separately
by skin-tone group.

It deliberately does NOT download anything. You supply a dataset you are
licensed to use, with its own labels. Scraping condition photos from a web
search would reproduce exactly the problem it appears to solve: no expert
labels, no skin-tone metadata, no consent from the people depicted, and
unclear copyright.

EXPECTED INPUT
--------------
A CSV manifest describing the dataset:

    image_path,ground_truth,skin_tone_group,skin_tone_scale,lighting_condition
    images/0001.jpg,Acne,monk-3,monk-10,even-daylight
    images/0002.jpg,Redness|Dryness,fitzpatrick-5,fitzpatrick-6,directional
    images/0003.jpg,,monk-8,monk-10,low-light

* `ground_truth` uses "|" to separate multiple labels, empty for none.
* `skin_tone_group` must come FROM THE DATASET. Never estimate it here.

Usage:
    python3 build_reference_set.py manifest.csv --root /path/to/dataset \\
        --output results.json
    python3 metrics.py results.json
"""

import argparse
import csv
import json
import os
import sys

# The analysis pipeline lives in the sibling API package.
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "..", "skin-analysis-api"))

try:
    import cv2
    from face_detection import detect_face
    from image_quality import assess_quality
    from skin_regions import (build_skin_masks, normalise_scale,
                              region_luma_ratio, MAX_REGION_LUMA_RATIO)
    from skin_metrics import compute_signals
    from concern_mapper import decide
except ImportError as error:  # pragma: no cover
    print(f"Could not import the analysis pipeline: {error}\n"
          f"Activate the API virtualenv first:\n"
          f"  cd ../skin-analysis-api && source .venv/bin/activate",
          file=sys.stderr)
    raise SystemExit(1)

VALID_LABELS = {"Acne", "Redness", "Dryness", "Dehydration"}
MIN_VALID_REGIONS = 3


def analyse(path):
    """Run the pipeline. Returns (signals, suggestions, quality) or a reason."""
    image = cv2.imread(path, cv2.IMREAD_COLOR)
    if image is None:
        return None, "unreadable"

    face = detect_face(image)
    if face["error"]:
        return None, face["error"]

    quality = assess_quality(image, face["bbox"], face["coverage"])
    if not quality["acceptable"]:
        return None, "poor_quality:" + ",".join(quality["warnings"])

    measure_image, measure_landmarks = normalise_scale(
        image, face["landmarks"], face["bbox"])
    masks = build_skin_masks(measure_image, measure_landmarks)
    if len(masks) < MIN_VALID_REGIONS:
        return None, "insufficient_regions"
    if region_luma_ratio(measure_image, masks) > MAX_REGION_LUMA_RATIO:
        return None, "face_obstructed"

    signals = compute_signals(measure_image, masks)
    # Evaluate against the concern DECISIONS, not the raw signals: the cards a
    # user actually sees are what a fairness audit must measure.
    return (signals, decide(signals)["concerns"], quality), None


def main():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("manifest", help="CSV manifest of the labelled dataset")
    parser.add_argument("--root", default=".",
                        help="directory that image_path values are relative to")
    parser.add_argument("--output", default="results.json")
    args = parser.parse_args()

    records, skipped = [], {}
    with open(args.manifest, newline="", encoding="utf-8") as handle:
        for index, row in enumerate(csv.DictReader(handle), start=1):
            path = os.path.join(args.root, row["image_path"])
            outcome, reason = analyse(path)
            if outcome is None:
                # Track WHY images drop out. A pipeline that silently discards
                # most of one skin-tone group is itself a fairness problem, so
                # the exclusions matter as much as the scores.
                key = reason.split(":")[0]
                skipped.setdefault(key, []).append(
                    row.get("skin_tone_group") or "unlabelled")
                continue

            signals, suggestions, quality = outcome
            truth = [label for label in (row.get("ground_truth") or "").split("|")
                     if label in VALID_LABELS]
            records.append({
                "sample_id": row.get("sample_id") or f"sample-{index:05d}",
                "ground_truth": truth,
                "predicted": [s["concern"] for s in suggestions],
                "confidence_scores": {k: v["score"] for k, v in signals.items()},
                "skin_tone_group": row.get("skin_tone_group") or None,
                "skin_tone_scale": row.get("skin_tone_scale") or None,
                "lighting_condition": row.get("lighting_condition") or None,
                "lighting_score": quality["lighting_score"],
                "image_source": "dataset",
                "device": row.get("device") or None,
                "algorithm_version": os.getenv("ALGORITHM_VERSION",
                                               "0.4.0-relative-baseline"),
                "notes": None,
            })

    with open(args.output, "w", encoding="utf-8") as handle:
        json.dump({"records": records}, handle, indent=2)

    print(f"Analysed successfully : {len(records)}")
    if skipped:
        print("Excluded before analysis:")
        for reason, groups in sorted(skipped.items()):
            by_group = {}
            for group in groups:
                by_group[group] = by_group.get(group, 0) + 1
            spread = ", ".join(f"{g}={n}" for g, n in sorted(by_group.items()))
            print(f"  {reason:<22} {len(groups):>5}   ({spread})")
        print("\nCheck the per-group exclusion spread above. If one skin-tone\n"
              "group is dropped far more often, that is a fairness finding in\n"
              "its own right, even before any score is compared.")
    print(f"\nWrote {args.output}. Next: python3 metrics.py {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
