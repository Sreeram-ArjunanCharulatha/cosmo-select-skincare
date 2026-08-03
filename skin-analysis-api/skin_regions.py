"""Skin-region masks built from MediaPipe Face Mesh landmark polygons.

Regions cover the left cheek, right cheek, forehead and chin. Eyes, brows,
lips and nostrils fall outside these polygons, so they are excluded by
construction; morphological erosion trims boundary spill (hairline, beard
edges) further. Hair, background and clothing are never inside the
polygons, keeping measurements on facial skin.
"""

import cv2
import numpy as np

# Landmark indices (MediaPipe Face Mesh topology, 468/478 points).
#
# These were corrected after rendering them with debug_visualise.py. The
# earlier set was wrong in ways that silently poisoned every measurement:
# the "forehead" polygon traced the EYEBROWS (indices 63/105/66/107 and
# 293/296/334 are brow points, not forehead), and the "chin" polygon ran
# along the jawline in an order that swept across the LIPS. Measurements
# were therefore being taken from brow hair, lip vermilion and whatever the
# hand happened to be covering, rather than from skin.
#
# Always re-render with debug_visualise.py after changing these.
FOREHEAD = [67, 109, 10, 338, 297, 332, 333, 299, 337, 151, 108, 69, 104, 103]
LEFT_CHEEK = [116, 117, 118, 119, 101, 36, 205, 187, 123]
RIGHT_CHEEK = [345, 346, 347, 348, 330, 266, 425, 411, 352]
CHIN = [17, 200, 199, 175, 152, 148, 176, 377, 400, 421, 201]
# Nose bridge and sides, kept clear of the nostrils (which are dark cavities
# and would otherwise register as shadow or as false spots).
NOSE = [6, 197, 195, 5, 4, 45, 220, 115, 48, 275, 440, 344, 278]

MIN_REGION_PIXELS = 400  # below this a mask is too small to measure

# Texture measurements are per-pixel, so a face photographed at 1200 px wide
# would score very differently from the same face at 400 px. Everything is
# therefore resampled so the face is always this wide before measuring.
CANONICAL_FACE_WIDTH = 480.0


def normalise_scale(image_bgr, landmarks, bbox):
    """Resample so the face bounding box is CANONICAL_FACE_WIDTH pixels wide.

    Returns (image, landmarks) in the canonical scale. This makes the texture
    metrics comparable between a phone selfie and a studio photograph; it does
    not remove differences in lens sharpness or compression.
    """
    face_width = max(1.0, float(bbox[2]))
    scale = CANONICAL_FACE_WIDTH / face_width
    if abs(scale - 1.0) < 0.02:
        return image_bgr, landmarks

    height, width = image_bgr.shape[:2]
    new_size = (max(2, int(width * scale)), max(2, int(height * scale)))
    # INTER_AREA is the correct filter when shrinking; it avoids aliasing that
    # would otherwise show up as fake high-frequency "texture".
    interpolation = cv2.INTER_AREA if scale < 1.0 else cv2.INTER_LINEAR
    resized = cv2.resize(image_bgr, new_size, interpolation=interpolation)
    return resized, [(x * scale, y * scale) for x, y in landmarks]


def _polygon_mask(shape, landmarks, indices):
    """Filled convex mask for the given landmark indices.

    The convex hull is taken rather than filling the points in the order
    given. fillPoly connects vertices in sequence, so any ordering that is
    not a clean perimeter walk produces a self-intersecting, bow-tie shaped
    mask; that is what turned the cheek regions into arrow shapes covering
    the wrong skin. Hulling makes the result independent of vertex order.
    """
    mask = np.zeros(shape[:2], dtype=np.uint8)
    points = np.array(
        [[int(landmarks[i][0]), int(landmarks[i][1])] for i in indices],
        dtype=np.int32,
    )
    cv2.fillPoly(mask, [cv2.convexHull(points)], 255)
    # Erode so the mask stays clear of region borders (hairline, brow edges,
    # lip margin) where a landmark may be a pixel or two out.
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (9, 9))
    mask = cv2.erode(mask, kernel, iterations=1)
    return mask


# A region whose internal colour varies this much is not uniform skin: it
# straddles an edge between skin and something else (hair, a hand, a product).
# Loosened from 8.0 after real webcam selfies were being rejected: ordinary
# shading across a cheek carries more variation than a studio photograph.
MAX_REGION_CHROMA_SD = 11.0
# Ratio of brightest to darkest region median. Landmarks are placed on the
# face whether or not the face is visible, so a mask can land on hair, a
# hand, spectacles or a held product.
#
# This is a RELIABILITY signal, not a hard gate. Sitting beside a window puts
# one cheek well over 1.8x the other, and refusing those photographs made the
# feature unusable. Above this ratio the result is still produced, flagged as
# less reliable.
MAX_REGION_LUMA_RATIO = 2.4


# How far a region's own colour may sit from the median of the other regions
# before it is treated as something other than this person's skin.
MAX_CHROMA_DEVIATION = 9.0
# Allowed brightness ratio between a region and the face's median region.
MAX_LUMA_DEVIATION = 1.7


def build_skin_masks(image_bgr, landmarks):
    """Return {region_name: mask} for regions that look like the same skin.

    MediaPipe reports where a face *is*, not whether it is actually visible,
    so a mask can land on hair, a hand, glasses or a held object. Rather than
    testing each region against fixed "skin colour" limits (which encode
    whichever skin tones the limits were derived from), each region is
    compared with the MEDIAN OF THE OTHER REGIONS on the same face. The
    reference therefore moves with the individual, and an occluder stands out
    because it does not match the rest of that person, not because it fails
    to match an absolute reference.
    """
    shape = image_bgr.shape
    candidates = {
        "left_cheek": _polygon_mask(shape, landmarks, LEFT_CHEEK),
        "right_cheek": _polygon_mask(shape, landmarks, RIGHT_CHEEK),
        "forehead": _polygon_mask(shape, landmarks, FOREHEAD),
        "chin": _polygon_mask(shape, landmarks, CHIN),
        "nose": _polygon_mask(shape, landmarks, NOSE),
    }
    ycc = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2YCrCb)
    luma, chroma = ycc[:, :, 0], ycc[:, :, 1]

    # Keep regions that are large enough and internally uniform.
    stats = {}
    for name, mask in candidates.items():
        if int(cv2.countNonZero(mask)) < MIN_REGION_PIXELS:
            continue
        values = chroma[mask > 0]
        if float(values.std()) > MAX_REGION_CHROMA_SD:
            continue  # straddles a skin / non-skin edge
        stats[name] = (float(np.median(values)),
                       float(np.median(luma[mask > 0])))
    if len(stats) < 3:
        # Too few to judge an outlier against; return what survived.
        return {name: candidates[name] for name in stats}

    masks = {}
    for name, (region_chroma, region_luma) in stats.items():
        others = [v for key, v in stats.items() if key != name]
        ref_chroma = float(np.median([v[0] for v in others]))
        ref_luma = max(1.0, float(np.median([v[1] for v in others])))
        luma_ratio = max(region_luma, ref_luma) / max(1.0, min(region_luma, ref_luma))
        if abs(region_chroma - ref_chroma) > MAX_CHROMA_DEVIATION:
            continue
        if luma_ratio > MAX_LUMA_DEVIATION:
            continue
        masks[name] = candidates[name]
    return masks


def region_luma_ratio(image_bgr, masks):
    """Brightest-to-darkest ratio of the region median luminances.

    Used as an occlusion / uneven-lighting indicator. Returns 1.0 when there
    is nothing to compare.
    """
    if len(masks) < 2:
        return 1.0
    gray = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2GRAY)
    medians = [float(np.median(gray[mask > 0])) for mask in masks.values()]
    medians = [m for m in medians if m > 1.0]
    if len(medians) < 2:
        return 1.0
    return max(medians) / min(medians)
