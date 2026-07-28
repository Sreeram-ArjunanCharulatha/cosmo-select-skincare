"""Experimental visible-feature signals measured with OpenCV/NumPy.

DESIGN PRINCIPLE: SKIN-TONE INVARIANCE
--------------------------------------
Every signal here is measured *relative to the same person's own face*, never
against a fixed colour or brightness constant. Absolute thresholds (for
example "a* above X means red") encode whatever skin tones happened to be in
the data used to pick X, and systematically misread deeper skin as abnormal.

Concretely:

* Redness finds CLUSTERS of pixels that are warmer than the skin surrounding
  them within the same region, in both LAB a* and red-minus-green. Both the
  detection threshold and the baseline come from that region's own skin, so a
  uniformly deep or uniformly fair complexion both score ~0.
* Blemish-like spots use a morphological top-hat, which responds only to
  features that are locally brighter/warmer than their immediate surroundings.
  The detection threshold is derived from the noise level of that person's own
  skin, so overall melanin level cancels out.
* Texture signals are divided by the region's own luminance, making them
  contrast measures rather than brightness measures.

This removes *structural* tone bias. It does NOT make the system validated or
unbiased in a scientific sense: darker skin is often under-exposed by camera
auto-exposure and white balance, which reduces signal-to-noise before this
code ever runs. Nothing here is a medical probability or a diagnosis.

SCALE ANCHORS ARE NOT CALIBRATED
--------------------------------
Each signal is mapped onto 0-1 by `_scale(value, low, high)`. Those low/high
anchors, and the thresholds in concern_mapper.py, are PROVISIONAL. They were
set by eyeballing a handful of ordinary photographs that carry no expert
labels: decorative stock images that happen to ship with this project, plus
one synthetically re-toned portrait.

That is not calibration, and it must not be described as such:

* Stock "condition" photos are staged. A picture captioned "acne" may show a
  few lesions on one cheek, while real presentation is typically spread
  across the face. Anchoring a scale to such an image sets the wrong level.
* None of those images carries a dermatologist label, so "the acne photo
  scores high" only means the algorithm agrees with a caption.
* There is no skin-tone diversity in that handful, so the anchors could be
  systematically wrong for skin they were never checked against.

Anchors should be re-derived from a labelled, skin-tone-diverse dataset (see
evaluation/README.md). Until then the numbers here order images sensibly
relative to each other and nothing more.

Other known confounders:
* redness      - warm lighting, flushing from heat or exercise, makeup.
* blemishes    - freckles, moles, beard hair, shadows, JPEG artefacts and
                 specular highlights all produce local spots.
* dryness      - camera sharpening and facial hair raise texture strongly.
* dehydration  - cannot be separated from normal micro-texture in an ordinary
                 photograph; always requires explicit user confirmation.
"""

import cv2
import numpy as np

# A blemish at the canonical face width (480 px) is roughly this radius.
BLOB_RADIUS_PX = 7
# How many LAB units warmer/brighter than its immediate surroundings a pixel
# must be to count as part of a spot.
#
# This is an absolute delta rather than a multiple of the region's own spread,
# for two reasons. First, the 8-bit LAB channels are so coarsely quantised on
# smooth skin that percentile-based spreads collapse or jump erratically.
# Second, a spread-based threshold is self-defeating here: a face with many
# blemishes has a wider spread, which raises the bar above the very spots it
# should be finding, so heavily affected skin scored zero.
#
# Tone-invariance is preserved because the value is applied to the TOP-HAT
# response, which is already a purely local difference with all large-scale
# skin tone removed, not to the raw colour.
#
# Lowered from 5.0 after a real photograph of visibly acne-prone skin scored
# "lower" on every signal. Severe stock photography has strongly inflamed,
# vividly red lesions; ordinary moderate acne is duller and browner, and sat
# under the old bar. Measured separation at 4.0 is still wide (clear skin
# ~0.3% coverage against ~5.9% for visibly affected skin).
#
# A black top-hat on L* was tried as a way to catch darker, less inflamed
# papules and REJECTED: it responds to pores, stubble and shadow just as
# strongly, scoring clear skin at 10.7% against 12.7% for acne, which is no
# separation at all.
BLOB_DELTA = 4.0
# Discrete compact lesions needed before a blemish reading is considered
# convincing. Coverage alone was not enough: a mole, a single mark or a
# scattering of compression artefacts can reach a small coverage figure on an
# otherwise clear face.
ACNE_MIN_LESIONS = 6

# Flake detection. A flake is locally brighter than surrounding skin, less
# saturated than it, and a patch rather than a pinpoint.
FLAKE_LIGHT_DELTA = 6.0        # L* units above the local top-hat median
FLAKE_SAT_RATIO = 0.80         # must be at least this much less saturated
FLAKE_MIN_PATCH = 6            # px at canonical scale
FLAKE_MAX_PATCH = 400          # px; larger is a highlight, not a flake
FLAKE_REGION_COVERAGE = 0.004  # a region counts as flaking above this


def _masked_values(channel, mask):
    values = channel[mask > 0]
    return values if values.size else None


def _robust_stats(values):
    """Median and a robust spread estimate for the given values.

    MAD is deliberately NOT used: the LAB channels are 8-bit integers, so on
    smooth skin more than half the pixels share one value, MAD collapses to
    zero and any threshold built on it degenerates. The 50th-to-95th
    percentile gap stays well defined on quantised, skewed data.
    """
    if values is None or values.size == 0:
        return 0.0, 1.0
    values = values.astype(np.float64)
    median = float(np.median(values))
    # For normally distributed data the 50th-to-95th percentile gap spans
    # 1.645 sigma, so divide by that to return a true sigma estimate.
    sigma = float(np.percentile(values, 95) - median) / 1.645
    return median, max(sigma, 0.35)


def _scale(value, low, high):
    """Clamp-map value from [low, high] onto the 0-1 engineering scale."""
    if high <= low:
        return 0.0
    return float(np.clip((value - low) / (high - low), 0.0, 1.0))


def _level(score):
    if score >= 0.66:
        return "higher"
    if score >= 0.40:
        return "moderate"
    return "lower"


def _union_mask(masks, shape):
    union = np.zeros(shape[:2], dtype=np.uint8)
    for mask in masks.values():
        union = cv2.bitwise_or(union, mask)
    return union


# Inflammation detection tuning. A pixel must be warmer than its region's own
# skin in BOTH the LAB a* (green-red) axis and the raw red-minus-green
# contrast before it counts, which rejects shadows and brown pigmentation
# that lift only one of the two.
RED_A_DELTA = 3.0          # minimum a* lift over local skin
RED_RG_DELTA = 5.0         # minimum red-minus-green lift over local skin
RED_SIGMA_MULT = 1.3       # or this many robust SDs, whichever is larger
RED_MIN_CLUSTER = 10       # px at canonical scale; smaller is noise
RED_MAX_CLUSTER = 2500     # px; larger is a whole flushed area, still counted
RED_DARK_PERCENTILE = 8    # ignore the darkest pixels (shadow, nostril edge)
RED_BRIGHT_PERCENTILE = 97  # ignore specular highlights
# A region counts as "affected" once this fraction of it is inflamed.
REGION_AFFECTED_COVERAGE = 0.006
# Below this many discrete clusters across both cheeks, matching left/right
# warmth is treated as even colouring rather than inflammation.
SMOOTH_CLUSTER_MAX = 5


def _region_redness(image_bgr, mask, channels):
    """Redness evidence inside ONE region, measured against that region.

    Returns (coverage, cluster_count, mean_intensity, cluster_mask).

    The comparison is with the surrounding skin of the same region, so the
    person's own complexion sets the baseline. Nothing here uses a fixed
    colour value that would encode one skin tone.
    """
    a_channel, rg_channel, luminance, saturation = channels
    region = mask > 0
    area = int(np.count_nonzero(region))
    empty = np.zeros(mask.shape, dtype=np.uint8)
    if area < 1:
        return 0.0, 0, 0.0, empty

    a_values = a_channel[region]
    rg_values = rg_channel[region]
    a_median, a_sigma = _robust_stats(a_values)
    rg_median, rg_sigma = _robust_stats(rg_values)

    a_threshold = a_median + max(RED_A_DELTA, RED_SIGMA_MULT * a_sigma)
    rg_threshold = rg_median + max(RED_RG_DELTA, RED_SIGMA_MULT * rg_sigma)

    # Shadows read as "not red" and highlights wash colour out; excluding the
    # extremes of the region's own luminance keeps both from distorting it.
    dark_cut, bright_cut = np.percentile(luminance[region],
                                         [RED_DARK_PERCENTILE, RED_BRIGHT_PERCENTILE])

    inflamed = (
        region
        & (a_channel > a_threshold)
        & (rg_channel > rg_threshold)
        & (luminance > dark_cut)
        & (luminance < bright_cut)
        & (saturation > 25)          # near-grey pixels are not inflammation
    ).astype(np.uint8)

    # Close small gaps so one lesion is a single blob, then drop specks.
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    inflamed = cv2.morphologyEx(inflamed, cv2.MORPH_CLOSE, kernel)
    inflamed = cv2.morphologyEx(inflamed, cv2.MORPH_OPEN, kernel)

    count, labels, stats, _ = cv2.connectedComponentsWithStats(inflamed)
    keep = [i for i in range(1, count)
            if RED_MIN_CLUSTER <= stats[i, cv2.CC_STAT_AREA] <= RED_MAX_CLUSTER]
    if not keep:
        return 0.0, 0, 0.0, empty

    cluster_mask = np.isin(labels, keep).astype(np.uint8) * 255
    cluster_pixels = cluster_mask > 0
    coverage = float(np.count_nonzero(cluster_pixels)) / area
    # How far above local skin the flagged pixels actually sit, in a* units.
    intensity = float(np.mean(a_channel[cluster_pixels] - a_median))
    return coverage, len(keep), intensity, cluster_mask


def _redness_signal(image_bgr, masks, debug=None):
    """Localised inflammation across every measured facial region.

    WHY THIS IS NOT A REGION AVERAGE
    --------------------------------
    The previous version compared the MEDIAN colour of the cheeks with the
    median of the other regions. Two faults made it blind to acne
    inflammation:

    * A median describes the typical pixel and is designed to ignore
      outliers. Inflammation around pimples affects only a few per cent of a
      region, so it was averaged away by construction.
    * The baseline was the rest of the face, so when acne covered forehead,
      cheeks and chin together the baseline rose with it and the difference
      cancelled to nothing.

    Measured on the reference photographs, that metric returned an identical
    +5.0 for a face of red pimples and for a uniformly flushed face: it could
    not tell them apart.

    This version instead finds CLUSTERS of pixels that are warmer than the
    surrounding skin of their own region, and scores by how much of each
    region they cover, how many separate clusters there are, and how far
    above local skin they sit. Several inflamed areas therefore raise the
    score even when the rest of the face is a normal colour.
    """
    lab = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2LAB)
    hsv = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2HSV)
    blue, green, red = cv2.split(image_bgr.astype(np.float32))
    channels = (
        lab[:, :, 1].astype(np.float32),   # a*: green-red axis
        red - green,                        # raw red-green contrast
        lab[:, :, 0].astype(np.float32),   # L*: brightness control
        hsv[:, :, 1].astype(np.float32),   # saturation
    )

    per_region, combined = {}, np.zeros(image_bgr.shape[:2], dtype=np.uint8)
    for name, mask in masks.items():
        coverage, clusters, intensity, cluster_mask = _region_redness(
            image_bgr, mask, channels)
        per_region[name] = {"coverage": round(coverage, 4),
                            "clusters": clusters,
                            "intensity": round(intensity, 2)}
        combined = cv2.bitwise_or(combined, cluster_mask)

    if not per_region:
        return 0.0, {}

    # Two independent pieces of evidence are combined.
    #
    # 1. HOW MUCH of the worst-affected skin is inflamed (mean of the worst
    #    two regions, so a single shadow artefact cannot dominate).
    # 2. HOW MANY regions are affected at all. This is what makes scattered
    #    acne register: a face with inflamed spots on forehead, both cheeks
    #    and chin is meaningfully red even though no single region is more
    #    than a few per cent covered, whereas one warm patch on an otherwise
    #    even face is usually shadow or lighting.
    ranked = sorted((r["coverage"] for r in per_region.values()), reverse=True)
    headline = float(np.mean(ranked[:2])) if len(ranked) >= 2 else ranked[0]
    regions_affected = sum(1 for r in per_region.values()
                           if r["coverage"] >= REGION_AFFECTED_COVERAGE)
    spread = _scale(float(regions_affected), 1.0, 4.0)

    # Intensity tempers the result: faint warmth should not score like
    # strongly inflamed lesions.
    intensities = [r["intensity"] for r in per_region.values() if r["clusters"]]
    intensity_factor = _scale(float(np.mean(intensities)), 3.0, 9.0) if intensities else 0.0
    extent = _scale(headline, 0.005, 0.09)
    score = (0.6 * extent + 0.4 * spread) * (0.75 + 0.25 * intensity_factor)

    # ---- Evidence and confidence -------------------------------------------
    #
    # SYMMETRY. Matching warmth on both cheeks with few discrete clusters is
    # far more likely to be complexion, blush, makeup, colour grading or
    # studio lighting than inflammation. Inflammation is irregular: it
    # clusters unevenly and rarely mirrors itself. Symmetry therefore lowers
    # CONFIDENCE rather than vetoing the signal, so genuine bilateral redness
    # is still reported, just more cautiously.
    left = per_region.get("left_cheek", {})
    right = per_region.get("right_cheek", {})
    left_cov = left.get("coverage", 0.0)
    right_cov = right.get("coverage", 0.0)
    cheek_clusters = left.get("clusters", 0) + right.get("clusters", 0)
    if max(left_cov, right_cov) > 0:
        symmetry = 1.0 - abs(left_cov - right_cov) / max(left_cov, right_cov)
    else:
        symmetry = 0.0
    smooth_bilateral = symmetry > 0.75 and cheek_clusters < SMOOTH_CLUSTER_MAX

    total_clusters = sum(r["clusters"] for r in per_region.values())
    confidence = 1.0
    if smooth_bilateral:
        confidence *= 0.45          # looks like even warmth, not inflammation
    if total_clusters < 4:
        confidence *= 0.6           # too few discrete areas to be convincing
    if regions_affected < 2:
        confidence *= 0.7           # confined to one region: often shading
    confidence *= (0.55 + 0.45 * intensity_factor)

    # Independent features. Each is a genuinely different kind of evidence, so
    # requiring agreement between two is a real constraint rather than the
    # same measurement counted twice.
    supporting = []
    if headline >= 0.012:
        supporting.append("cluster_extent")
    if regions_affected >= 2:
        supporting.append("multi_region")
    if total_clusters >= 6:
        supporting.append("multiple_clusters")
    if intensity_factor >= 0.35:
        supporting.append("colour_intensity")
    if not smooth_bilateral and max(left_cov, right_cov) > 0:
        supporting.append("irregular_distribution")

    evidence = {
        "confidence": round(float(np.clip(confidence, 0.0, 1.0)), 3),
        "affected_area": round(headline, 4),
        "regional_consistency": regions_affected,
        "cluster_count": total_clusters,
        "symmetry": round(symmetry, 3),
        "smooth_bilateral": smooth_bilateral,
        "supporting": supporting,
    }

    if debug is not None:
        debug["redness_regions"] = per_region
        debug["redness_mask"] = combined
        debug["redness_headline_coverage"] = round(headline, 4)
        debug["redness_regions_affected"] = regions_affected
        debug["redness_intensity_factor"] = round(intensity_factor, 2)
        debug["redness_evidence"] = evidence

    return float(np.clip(score, 0.0, 1.0)), combined, evidence


def _acne_signal(image_bgr, masks):
    """Coverage of small spots that stand out from their LOCAL surroundings.

    Uses a morphological white top-hat: `image - opening(image)`. The opening
    erases anything smaller than the structuring element, so subtracting it
    leaves exactly the small local peaks and removes all large-scale
    variation, including overall skin tone and slow lighting gradients.

    The significance threshold is derived per region from that region's own
    top-hat noise level, so a deeper complexion is not penalised for having a
    different absolute colour.
    """
    lab = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2LAB)
    # a* (green-red) ONLY. The L* brightness channel was tried and removed:
    # it responds strongly to specular highlights and pores, so clear skin
    # scored as high as visibly blemished skin. Restricting to colour makes
    # the measurement specific to the inflamed, redder character of a spot.
    channels = [lab[:, :, 1].astype(np.float32)]
    kernel = cv2.getStructuringElement(
        cv2.MORPH_ELLIPSE, (BLOB_RADIUS_PX * 2 + 1, BLOB_RADIUS_PX * 2 + 1))
    open_kernel = np.ones((3, 3), np.uint8)

    best = 0.0
    total_lesions = 0        # discrete lesions across the whole face
    regions_with_lesions = 0
    rejected = {"too_small": 0, "too_large": 0, "not_compact": 0}

    for mask in masks.values():
        region_area = int(cv2.countNonZero(mask))
        if region_area < 1:
            continue
        region_lesions = 0
        for channel in channels:
            tophat = cv2.morphologyEx(channel, cv2.MORPH_TOPHAT, kernel)
            values = _masked_values(tophat, mask)
            if values is None:
                continue
            median = float(np.median(values.astype(np.float64)))
            spots = ((tophat > median + BLOB_DELTA) & (mask > 0)).astype(np.uint8)
            spots = cv2.morphologyEx(spots, cv2.MORPH_OPEN, open_kernel)

            count, _, stats, _ = cv2.connectedComponentsWithStats(spots)
            blob_area = 0
            for i in range(1, count):
                area = int(stats[i, cv2.CC_STAT_AREA])
                width = int(stats[i, cv2.CC_STAT_WIDTH])
                height = int(stats[i, cv2.CC_STAT_HEIGHT])
                if area < 8:
                    rejected["too_small"] += 1
                    continue
                if area > 600:
                    rejected["too_large"] += 1
                    continue
                # A lesion is roughly round. Long thin components are hair,
                # eyebrow edges, creases or mask boundaries, not papules.
                longer, shorter = max(width, height), max(1, min(width, height))
                if longer / shorter > 3.0:
                    rejected["not_compact"] += 1
                    continue
                blob_area += area
                region_lesions += 1
            best = max(best, blob_area / region_area)
        if region_lesions:
            regions_with_lesions += 1
            total_lesions += region_lesions

    # PROVISIONAL ANCHOR - see the "Scale anchors are not calibrated" note in
    # this module's docstring. Set from a handful of non-clinical photographs,
    # not from labelled data.
    score = _scale(best, 0.002, 0.02)

    # A count matters as much as an area: a single mark, a mole or a few
    # compression artefacts can reach a small coverage figure, but only real
    # breakouts produce many separate compact lesions.
    confidence = 1.0
    if total_lesions < ACNE_MIN_LESIONS:
        confidence *= 0.4
    if regions_with_lesions < 2:
        confidence *= 0.7

    supporting = []
    if total_lesions >= ACNE_MIN_LESIONS:
        supporting.append("lesion_count")
    if regions_with_lesions >= 2:
        supporting.append("multi_region")
    if best >= 0.006:
        supporting.append("lesion_area")

    evidence = {
        "confidence": round(float(np.clip(confidence, 0.0, 1.0)), 3),
        "affected_area": round(best, 4),
        "regional_consistency": regions_with_lesions,
        "lesion_count": total_lesions,
        "rejected_candidates": rejected,
        "supporting": supporting,
    }
    return score, evidence


def _band_ratio(gray, mask, fine_sigma, coarse_sigma):
    """Ratio of fine-scale to coarse-scale detail energy inside a mask.

    Both bands are obtained by subtracting a Gaussian blur, so both scale
    linearly with image contrast. Their ratio therefore cancels brightness
    AND contrast entirely, which is what makes it usable across skin tones:
    an under-exposed deep-skin photo and a bright fair-skin photo of equally
    smooth skin land on the same number.

    Dividing by a mean brightness (the previous approach) does NOT have this
    property: darker skin has a smaller mean, which inflated the result.
    """
    fine = gray - cv2.GaussianBlur(gray, (0, 0), fine_sigma)
    coarse = gray - cv2.GaussianBlur(gray, (0, 0), coarse_sigma)
    fine_values = _masked_values(fine, mask)
    coarse_values = _masked_values(coarse, mask)
    if fine_values is None or coarse_values is None:
        return 0.0
    coarse_energy = float(coarse_values.std())
    if coarse_energy < 1e-6:
        return 0.0
    return float(fine_values.std()) / coarse_energy


def _region_median(values):
    """Median across regions: ignores a single contaminated mask.

    One region can pick up a hairline, beard edge or hard shadow; taking the
    median rather than the maximum stops that single region from dominating.
    """
    values = [v for v in values if v > 0]
    if not values:
        return 0.0
    return float(np.median(values))


def _without_inflammation(masks, inflamed_mask):
    """Region masks with any inflamed pixels removed.

    Raised, inflamed lesions carry strong edges, so a texture measure that
    includes them reports acne as "dryness". Flaking is a separate, paler
    phenomenon and should be measured on skin that is not currently inflamed.
    """
    if inflamed_mask is None:
        return masks
    # Dilate so the rim around each lesion is excluded too, not just its core.
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (7, 7))
    spread = cv2.dilate(inflamed_mask, kernel, iterations=1)
    keep = cv2.bitwise_not(spread)
    cleaned = {}
    for name, mask in masks.items():
        trimmed = cv2.bitwise_and(mask, keep)
        # Only use the trimmed mask if enough skin survives to measure.
        if int(cv2.countNonZero(trimmed)) >= 0.4 * int(cv2.countNonZero(mask)):
            cleaned[name] = trimmed
    return cleaned or masks


def _pale_texture_weight(image_bgr, mask):
    """How pale the TEXTURED pixels are compared with the surrounding skin.

    Flaking scatters light, so flaked pixels read paler and less saturated
    than the skin around them. Inflamed texture reads more saturated. The
    comparison must therefore be between the textured pixels and the region,
    not a statistic of the region against itself: an earlier version compared
    saturation with its own median, which returns ~0.5 by definition and
    carried no information at all.

    Returns a multiplier: near 1.0 for pale flake-like texture, falling
    toward 0.45 when the texture is markedly more saturated than the skin.
    """
    hsv = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2HSV)
    saturation = hsv[:, :, 1].astype(np.float32)
    gray = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2GRAY).astype(np.float32)
    detail = np.abs(gray - cv2.GaussianBlur(gray, (0, 0), 1.6))

    region = mask > 0
    if int(np.count_nonzero(region)) < 200:
        return 1.0
    cutoff = float(np.percentile(detail[region], 85))
    textured = region & (detail > cutoff)
    if int(np.count_nonzero(textured)) < 50:
        return 1.0

    textured_saturation = float(np.median(saturation[textured]))
    skin_saturation = max(1.0, float(np.median(saturation[region])))
    ratio = textured_saturation / skin_saturation
    return float(np.clip(1.30 - 0.50 * ratio, 0.45, 1.10))


def _flake_evidence(image_bgr, mask):
    """Look for actual pale scale-like structures, not merely fine texture.

    This is the piece that was missing. Dryness was previously a fine-to-
    coarse texture ratio alone, which responds identically to pores, image
    sharpening, sensor noise, fine facial hair and makeup, so any textured
    photograph produced a dryness reading.

    A flake is: locally BRIGHTER than the surrounding skin (it scatters light
    rather than absorbing it), LESS saturated (it is dead surface cells, not
    pigment or inflammation), and small but not pinpoint. All three must hold.

    Returns (coverage, patch_count).
    """
    lab = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2LAB)
    hsv = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2HSV)
    lightness = lab[:, :, 0].astype(np.float32)
    saturation = hsv[:, :, 1].astype(np.float32)

    region = mask > 0
    area = int(np.count_nonzero(region))
    if area < 400:
        return 0.0, 0

    # White top-hat: what is locally brighter than its surroundings.
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (9, 9))
    tophat = cv2.morphologyEx(lightness, cv2.MORPH_TOPHAT, kernel)
    bright_cut = float(np.median(tophat[region])) + FLAKE_LIGHT_DELTA
    sat_cut = float(np.median(saturation[region])) * FLAKE_SAT_RATIO

    candidates = (region
                  & (tophat > bright_cut)
                  & (saturation < sat_cut)).astype(np.uint8)
    # No morphological opening here: fine flaking is often only 1-2px wide,
    # and an opening step requires a feature to fill a 2x2 block to survive,
    # which was silently erasing most real flake pixels before they even
    # reached the size filter below. The FLAKE_MIN_PATCH bound already
    # rejects lone-pixel sensor noise, so it does this job instead.
    count, _, stats, _ = cv2.connectedComponentsWithStats(candidates)
    flake_area, patches = 0, 0
    for i in range(1, count):
        size = int(stats[i, cv2.CC_STAT_AREA])
        if FLAKE_MIN_PATCH <= size <= FLAKE_MAX_PATCH:
            flake_area += size
            patches += 1
    return flake_area / area, patches


def _dryness_signal(image_bgr, masks, inflamed_mask=None):
    """Flaking evidence combined with surface roughness.

    Two independent measurements must agree: visible pale scale-like patches
    AND raised fine-scale roughness. Roughness alone is ordinary skin texture;
    flakes alone could be lint or a highlight. Requiring both is what stops
    pores, sharpening and noise from reading as dry skin.

    Inflamed pixels are excluded first, so acne texture is not counted here.
    """
    usable = _without_inflammation(masks, inflamed_mask)
    gray = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2GRAY).astype(np.float64)

    ratios = [_band_ratio(gray, mask, 1.6, 6.0) for mask in usable.values()]
    roughness = _scale(_region_median(ratios), 0.34, 0.62)

    region_areas = {name: int(cv2.countNonZero(mask)) for name, mask in usable.items()}
    flake_results = {name: _flake_evidence(image_bgr, mask) for name, mask in usable.items()}
    patches = sum(p for _, p in flake_results.values())
    regions_flaking = sum(1 for c, _ in flake_results.values() if c >= FLAKE_REGION_COVERAGE)

    # Flaking is rarely one continuous patch: real dry skin often shows up as
    # forehead-and-nose flaking with the cheeks clear. Taking the MEDIAN
    # across every region (including the unaffected ones) washed that real,
    # scattered evidence down to whatever the least-affected region read.
    # Instead, average only the regions that actually show flaking, weighted
    # by how much skin each one covers, so a large flaking forehead counts
    # for more than a small flaking patch of chin - and clear cheeks no
    # longer dilute evidence from regions that really are affected.
    affected = {name: c for name, (c, _) in flake_results.items()
                if c >= FLAKE_REGION_COVERAGE}
    if affected:
        total_flake_px = sum(affected[name] * region_areas[name] for name in affected)
        total_area = sum(region_areas[name] for name in affected)
        flake_coverage = total_flake_px / total_area if total_area else 0.0
    else:
        # Nothing clears the per-region bar; keep the strongest single
        # region so a genuine near-miss is still visible in the raw score
        # rather than being silently zeroed.
        flake_coverage = max((c for c, _ in flake_results.values()), default=0.0)

    flake_score = _scale(flake_coverage, 0.004, 0.035)
    # The SAME pattern of flaking repeating across several independent
    # regions is itself corroborating evidence, not just a confidence
    # adjustment: it means what was found is a real, spread condition rather
    # than one artefact, so it lifts the score directly.
    if regions_flaking >= 2:
        flake_score = min(1.0, flake_score * 1.35)

    # Roughness is capped by flaking: without visible scale-like structures
    # the score cannot rise far, whatever the texture ratio says.
    score = float(np.clip(0.45 * roughness + 0.55 * flake_score, 0.0, 1.0))
    if regions_flaking == 0:
        score = min(score, 0.35)

    confidence = 1.0
    if regions_flaking == 0:
        confidence *= 0.35          # no visible flaking at all
    if regions_flaking < 2:
        confidence *= 0.7
    if patches < 8:
        confidence *= 0.7

    supporting = []
    if flake_coverage >= FLAKE_REGION_COVERAGE:
        supporting.append("flake_patches")
    if roughness >= 0.5:
        supporting.append("surface_roughness")
    if regions_flaking >= 2:
        supporting.append("multi_region")

    evidence = {
        "confidence": round(float(np.clip(confidence, 0.0, 1.0)), 3),
        "affected_area": round(flake_coverage, 4),
        "regional_consistency": regions_flaking,
        "flake_patches": patches,
        "roughness": round(roughness, 3),
        "supporting": supporting,
    }
    return score, evidence


def _dehydration_signal(image_bgr, masks, inflamed_mask=None):
    """Fine luminance variation (fine-line-like), contrast-invariant.

    Same construction as dryness at a finer spatial scale. It cannot
    distinguish fine lines from normal micro-texture, which is why it is
    always presented as requiring user confirmation.
    """
    usable = _without_inflammation(masks, inflamed_mask)
    gray = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2GRAY).astype(np.float64)
    ratios = [_band_ratio(gray, mask, 1.0, 4.0) for mask in usable.values()]
    return _scale(_region_median(ratios), 0.26, 0.52)


def _confidence_level(score, reliable=True):
    """Calibrated wording for a 0-1 signal.

    "uncertain" is returned whenever colour cannot be trusted, so a washed-out
    or colour-cast photograph never yields a confident "low".
    """
    if not reliable:
        return "uncertain"
    if score >= 0.70:
        return "high"
    if score >= 0.45:
        return "moderate"
    if score >= 0.20:
        return "mild"
    return "low"


def compute_signals(image_bgr, masks, colour_reliable=True, debug=None):
    """Return the experimental signals with calibrated levels.

    `colour_reliable` comes from the capture-quality checks. When it is False
    the colour-dependent signals report "uncertain" rather than a confident
    low, because a colour cast or bad exposure can hide real redness.
    """
    redness, inflamed_mask, redness_evidence = _redness_signal(
        image_bgr, masks, debug)
    acne, acne_evidence = _acne_signal(image_bgr, masks)
    dryness, dryness_evidence = _dryness_signal(image_bgr, masks, inflamed_mask)
    dehydration = _dehydration_signal(image_bgr, masks, inflamed_mask)
    measured = ", ".join(sorted(masks.keys())) or "none"

    # Capture quality caps confidence for every signal. A degraded photograph
    # must not be able to produce a confident concern, and sensitivity is
    # never raised to compensate for a poor image.
    quality_factor = 1.0 if colour_reliable else 0.45
    for evidence in (redness_evidence, acne_evidence):
        evidence["confidence"] = round(evidence["confidence"] * quality_factor, 3)
    # Texture is less colour-dependent, so it is penalised more gently.
    dryness_evidence["confidence"] = round(
        dryness_evidence["confidence"] * (1.0 if colour_reliable else 0.7), 3)

    if debug is not None:
        debug["scores"] = {"redness": redness, "acne": acne,
                           "dryness": dryness, "dehydration": dehydration}
        debug["evidence"] = {"redness": redness_evidence,
                             "acne": acne_evidence,
                             "dryness": dryness_evidence}

    return {
        # Colour-dependent, so it defers to colour reliability.
        "redness": {"score": round(redness, 2),
                    "level": _confidence_level(redness, colour_reliable),
                    "region": measured,
                    "evidence": redness_evidence},
        "acne": {"score": round(acne, 2),
                 "level": _confidence_level(acne, colour_reliable),
                 "region": measured,
                 "evidence": acne_evidence},
        # Texture-based, so a colour cast matters less; still reported
        # cautiously because photographs cannot establish the condition.
        "dryness": {"score": round(dryness, 2),
                    "level": _confidence_level(dryness),
                    "region": measured,
                    "evidence": dryness_evidence},
        # Reported as a measurement only. It is never converted into a
        # concern: fine lines, shine, pores and image contrast are not
        # separable from dehydration in a single still photograph, so the
        # decision layer excludes it by design.
        "dehydration": {"score": round(dehydration, 2),
                        "level": "not_assessable",
                        "region": measured,
                        "evidence": {"confidence": 0.0, "affected_area": 0.0,
                                     "supporting": [],
                                     "note": "not photographically assessable"}},
    }
