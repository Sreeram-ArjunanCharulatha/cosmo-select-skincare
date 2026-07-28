#!/usr/bin/env python3
"""Offline fairness-evaluation metrics for the COSMO SELECT screening prototype.

This script is a MEASUREMENT TOOL, not part of the live application. It never
runs during analysis and never touches user images. It reads a JSON file of
evaluation records (see schema.json) and reports per-condition performance
overall and stratified by the skin-tone group supplied by the dataset.

It cannot make the system fair. It can only reveal whether performance
differs across groups, which is the necessary first step. Running it on a
dataset that is small or skewed will produce numbers that look precise and
mean very little, so every group below MIN_GROUP_SAMPLES is flagged loudly.

Usage:
    python3 metrics.py example-results.json
    python3 metrics.py results.json --min-samples 50
"""

import argparse
import json
import sys
from collections import defaultdict

CONDITIONS = ["Acne", "Redness", "Dryness", "Dehydration"]

# Below this, per-group rates are too noisy to support any conclusion. The
# default is deliberately not tiny: with 30 samples a single extra error
# moves a rate by more than three percentage points.
MIN_GROUP_SAMPLES = 30


def _safe_divide(numerator, denominator):
    """Return None rather than 0.0 when a rate is undefined."""
    return (numerator / denominator) if denominator else None


def confusion_for_condition(records, condition):
    """Binary confusion counts for one condition across the given records."""
    tp = fp = tn = fn = 0
    for record in records:
        truth = condition in record.get("ground_truth", [])
        predicted = condition in record.get("predicted", [])
        if truth and predicted:
            tp += 1
        elif not truth and predicted:
            fp += 1
        elif not truth and not predicted:
            tn += 1
        else:
            fn += 1
    return {"tp": tp, "fp": fp, "tn": tn, "fn": fn}


def metrics_from_confusion(counts):
    """Standard binary classification metrics.

    Any metric whose denominator is zero is reported as None, never as 0.0 or
    1.0, so that "we could not measure this" is never mistaken for a result.
    """
    tp, fp, tn, fn = counts["tp"], counts["fp"], counts["tn"], counts["fn"]
    total = tp + fp + tn + fn
    return {
        "samples": total,
        "confusion_matrix": counts,
        "accuracy": _safe_divide(tp + tn, total),
        "sensitivity_recall": _safe_divide(tp, tp + fn),
        "specificity": _safe_divide(tn, tn + fp),
        "precision": _safe_divide(tp, tp + fp),
        "false_positive_rate": _safe_divide(fp, fp + tn),
        "false_negative_rate": _safe_divide(fn, fn + tp),
    }


def evaluate(records, min_samples=MIN_GROUP_SAMPLES):
    """Return overall and per-skin-tone-group metrics for every condition."""
    groups = defaultdict(list)
    for record in records:
        group = record.get("skin_tone_group") or "unlabelled"
        groups[group].append(record)

    report = {
        "total_samples": len(records),
        "algorithm_versions": sorted(
            {r.get("algorithm_version", "unknown") for r in records}),
        "min_samples_for_conclusion": min_samples,
        "overall": {},
        "by_skin_tone_group": {},
        "warnings": [],
    }

    for condition in CONDITIONS:
        report["overall"][condition] = metrics_from_confusion(
            confusion_for_condition(records, condition))

    for group, group_records in sorted(groups.items()):
        entry = {"samples": len(group_records), "conditions": {}}
        if len(group_records) < min_samples:
            entry["reliable"] = False
            report["warnings"].append(
                f"Group '{group}' has only {len(group_records)} samples "
                f"(minimum {min_samples}). Rates for this group are not "
                f"statistically reliable and must not be quoted as evidence "
                f"of fairness or of bias."
            )
        else:
            entry["reliable"] = True
        for condition in CONDITIONS:
            entry["conditions"][condition] = metrics_from_confusion(
                confusion_for_condition(group_records, condition))
        report["by_skin_tone_group"][group] = entry

    if len(groups) < 2 or (len(groups) == 1 and "unlabelled" in groups):
        report["warnings"].append(
            "Fewer than two labelled skin-tone groups are present. No "
            "cross-group comparison is possible, so this run says nothing "
            "about fairness."
        )

    if len(report["algorithm_versions"]) > 1:
        report["warnings"].append(
            "Records come from multiple algorithm versions; results are not "
            "directly comparable. Filter by algorithm_version first."
        )

    return report


def _format_rate(value):
    return "  n/a " if value is None else f"{value * 100:6.1f}%"


def print_report(report):
    print(f"\nSamples: {report['total_samples']}   "
          f"Algorithm(s): {', '.join(report['algorithm_versions'])}")
    print("=" * 78)
    print("OVERALL (all groups pooled)")
    print(f"{'condition':<14}{'n':>6}{'acc':>8}{'sens':>8}{'spec':>8}"
          f"{'prec':>8}{'FPR':>8}{'FNR':>8}")
    for condition, m in report["overall"].items():
        print(f"{condition:<14}{m['samples']:>6}"
              f"{_format_rate(m['accuracy'])}{_format_rate(m['sensitivity_recall'])}"
              f"{_format_rate(m['specificity'])}{_format_rate(m['precision'])}"
              f"{_format_rate(m['false_positive_rate'])}"
              f"{_format_rate(m['false_negative_rate'])}")

    print("\nBY SKIN-TONE GROUP (labels supplied by the dataset)")
    for group, entry in report["by_skin_tone_group"].items():
        flag = "" if entry["reliable"] else "   << TOO FEW SAMPLES"
        print(f"\n  group: {group}  (n={entry['samples']}){flag}")
        print(f"  {'condition':<14}{'acc':>8}{'sens':>8}{'spec':>8}"
              f"{'prec':>8}{'FPR':>8}{'FNR':>8}")
        for condition, m in entry["conditions"].items():
            print(f"  {condition:<14}"
                  f"{_format_rate(m['accuracy'])}{_format_rate(m['sensitivity_recall'])}"
                  f"{_format_rate(m['specificity'])}{_format_rate(m['precision'])}"
                  f"{_format_rate(m['false_positive_rate'])}"
                  f"{_format_rate(m['false_negative_rate'])}")

    if report["warnings"]:
        print("\n" + "!" * 78)
        for warning in report["warnings"]:
            print(f"! {warning}")
        print("!" * 78)

    print("\nThese numbers describe THIS dataset only. They do not establish "
          "that the system\nis fair, safe, or clinically valid.\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("results", help="JSON file of evaluation records")
    parser.add_argument("--min-samples", type=int, default=MIN_GROUP_SAMPLES,
                        help="minimum group size before rates are trusted")
    parser.add_argument("--json", action="store_true",
                        help="print the report as JSON instead of a table")
    args = parser.parse_args()

    with open(args.results, encoding="utf-8") as handle:
        payload = json.load(handle)
    records = payload.get("records", payload) if isinstance(payload, dict) else payload
    if not isinstance(records, list):
        print("Expected a list of records, or an object with a 'records' list.",
              file=sys.stderr)
        return 1

    report = evaluate(records, args.min_samples)
    if args.json:
        print(json.dumps(report, indent=2))
    else:
        print_report(report)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
