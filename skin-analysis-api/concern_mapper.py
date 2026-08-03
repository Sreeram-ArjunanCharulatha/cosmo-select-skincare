"""Decides which experimental signals are strong enough to show as concerns.

SIGNALS ARE NOT CONCERNS
------------------------
The earlier version was a single test: `score >= threshold` produced a concern
card. That is why a moderate technical reading on a clear studio photograph
became a confident "you have redness". A raw score alone cannot support that
claim: it says how much of something was measured, not how much of it can be
trusted, nor whether independent evidence agrees.

Three separate quantities are now kept apart:

    raw_score      what was measured, 0-1, always shown in the technical list
    confidence     how much the capture and the evidence support that number
    decision       whether it clears the bar to be presented as a concern

A concern card requires ALL of:

    1. raw_score        at or above the concern threshold
    2. confidence       at or above the confidence floor
    3. affected_area    a minimum fraction of valid skin actually involved
    4. supporting       at least two INDEPENDENT features agreeing

Failing any one of these leaves the signal visible in the technical list and
produces no card. When nothing clears the bar the honest answer is "no strong
visible concerns detected", and that is what is returned: no concern is ever
forced to appear.

Dehydration is deliberately excluded from photographic detection entirely.
"""

# Raw-score bar for a card. Higher than the level bands used for display,
# because being shown a concern is a stronger statement than being shown a
# measurement.
CONCERN_THRESHOLDS = {
    "acne": 0.55,
    "redness": 0.55,
    "dryness": 0.68,
}

# Minimum confidence. Poor exposure, colour cast, heavy smoothing or a small
# valid-skin area all reduce confidence, so a degraded photograph cannot
# produce a card however high the raw number happens to be.
MIN_CONFIDENCE = {
    "acne": 0.55,
    "redness": 0.60,   # colour is the most fragile signal, so it asks for more
    "dryness": 0.60,
}

# Minimum fraction of the measured skin that must actually be involved. This
# is what stops a handful of compression artefacts from becoming "acne".
MIN_AFFECTED_AREA = {
    "acne": 0.004,     # 0.4% of measured skin
    "redness": 0.008,  # 0.8%
    # Measured against the AFFECTED regions themselves (area-weighted), not
    # diluted by unaffected regions - see the dryness aggregation fix in
    # skin_metrics.py. Re-anchored from a real photograph with visible,
    # repeated forehead/nose flaking, which measured ~1.75% by this metric.
    "dryness": 0.012,
}

# Independent features that must agree before a card is shown. Requiring two
# means no single measurement can carry a decision on its own.
MIN_SUPPORTING_FEATURES = 2

# CORROBORATED NEAR MISS.
# A signal a little under the bar may still qualify when the evidence behind
# it is unusually strong. Without this, a face of clearly inflamed acne with
# five independent features agreeing and high confidence was refused a redness
# card for being 0.02 short, which is a threshold artefact rather than a
# judgement. The extra evidence required is deliberately steep, so this widens
# the gate only for cases that are already well supported.
NEAR_MISS_MARGIN = 0.08
NEAR_MISS_CONFIDENCE = 0.75
NEAR_MISS_SUPPORTING = 4

# Signal key -> concern value used by the existing COSMO SELECT selector.
CONCERN_MAP = {
    "acne": "Acne",
    "redness": "Redness",
    "dryness": "Dryness",
}

# Dehydration is measured and reported as a technical signal, but never
# becomes a concern from a photograph: fine lines, shine, pores and image
# contrast are indistinguishable from it in a single still image.
PHOTOGRAPHIC_CONCERNS = ("acne", "redness", "dryness")

DEHYDRATION_NOTE = ("Dehydration cannot be reliably assessed from a "
                    "photograph. Answer a few questions about how your skin "
                    "feels to consider it.")

REASONS = {
    "acne": "Several separate blemish-like lesions were measured across more "
            "than one area of skin. This is an experimental visible-feature "
            "signal, not a diagnosis.",
    "redness": "Irregular red-toned clusters were measured against nearby "
               "skin of similar brightness. This is an experimental "
               "visible-feature signal, not a diagnosis.",
    "dryness": "Pale flake-like structures were measured alongside raised "
               "surface roughness. This is an experimental visible-feature "
               "signal, not a diagnosis.",
}

UNRELIABLE_NOTES = {
    "redness": "Redness could not be assessed reliably from this image.",
    "acne": "Blemish-like features could not be assessed reliably from this image.",
    "dryness": "Flake-like texture could not be assessed reliably from this image.",
}


def _evaluate(key, signal):
    """Decide one signal. Returns (passed, decision_record)."""
    evidence = signal.get("evidence") or {}
    raw_score = float(signal.get("score", 0.0))
    confidence = float(evidence.get("confidence", 0.0))
    affected_area = float(evidence.get("affected_area", 0.0))
    supporting = list(evidence.get("supporting", []))

    threshold = CONCERN_THRESHOLDS[key]
    # Strongly corroborated signals may clear a slightly lower bar; see
    # NEAR_MISS_* above. Everything else still has to meet the full bar.
    corroborated = (confidence >= NEAR_MISS_CONFIDENCE
                    and len(supporting) >= NEAR_MISS_SUPPORTING)
    effective_threshold = (threshold - NEAR_MISS_MARGIN) if corroborated else threshold

    checks = {
        "signal": raw_score >= effective_threshold,
        "confidence": confidence >= MIN_CONFIDENCE[key],
        "area": affected_area >= MIN_AFFECTED_AREA[key],
        "agreement": len(supporting) >= MIN_SUPPORTING_FEATURES,
    }
    failed = [name for name, ok in checks.items() if not ok]
    near_miss = corroborated and raw_score < threshold and not failed

    record = {
        "signal": key,
        "raw_score": round(raw_score, 3),
        "confidence": round(confidence, 3),
        "affected_area": round(affected_area, 4),
        "regional_consistency": evidence.get("regional_consistency"),
        "supporting_features": supporting,
        "thresholds": {
            "signal": threshold,
            "effective_signal": round(effective_threshold, 3),
            "confidence": MIN_CONFIDENCE[key],
            "area": MIN_AFFECTED_AREA[key],
            "supporting": MIN_SUPPORTING_FEATURES,
        },
        "passed": not failed,
        # Every decision records WHY, so the debug view and any later audit
        # can explain a result rather than just assert it.
        "decision_reason": (
            "below the usual bar but corroborated by "
            f"{len(supporting)} agreeing features at confidence {confidence:.2f}"
            if near_miss else
            "all criteria met" if not failed
            else "did not meet: " + ", ".join(failed)),
    }
    return record["passed"], record


def map_concerns(signals):
    """Return concern cards that clear every bar. May be empty."""
    return decide(signals)["concerns"]


def decide(signals):
    """Full decision result.

    {
      "concerns":  [{concern, score, reason}, ...]   # may be empty
      "decisions": {signal: decision_record, ...}    # why, for every signal
      "notes":     [str, ...]                        # user-facing caveats
      "clear":     bool                              # nothing crossed the bar
    }
    """
    concerns, decisions, notes = [], {}, []

    for key in PHOTOGRAPHIC_CONCERNS:
        signal = signals.get(key)
        if signal is None:
            continue

        # An "uncertain" level means the capture could not support a colour or
        # texture reading at all; say so rather than reporting a confident low.
        if signal.get("level") == "uncertain":
            decisions[key] = {
                "signal": key,
                "raw_score": round(float(signal.get("score", 0.0)), 3),
                "passed": False,
                "decision_reason": "capture quality insufficient to assess",
            }
            notes.append(UNRELIABLE_NOTES[key])
            continue

        passed, record = _evaluate(key, signal)
        decisions[key] = record
        if passed:
            concerns.append({
                "concern": CONCERN_MAP[key],
                "score": record["raw_score"],
                "reason": REASONS[key],
            })

    if "dehydration" in signals:
        decisions["dehydration"] = {
            "signal": "dehydration",
            "raw_score": round(float(signals["dehydration"].get("score", 0.0)), 3),
            "passed": False,
            "decision_reason": "not photographically assessable by design",
        }
        notes.append(DEHYDRATION_NOTE)

    concerns.sort(key=lambda item: item["score"], reverse=True)
    return {
        "concerns": concerns[:3],
        "decisions": decisions,
        "notes": notes,
        "clear": not concerns,
    }
