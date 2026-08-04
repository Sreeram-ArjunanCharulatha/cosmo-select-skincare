"""Facial-landmark detection via MediaPipe Face Mesh.

MediaPipe is used ONLY to locate the face and its landmark geometry so that
skin regions can be masked. It does not classify acne, dryness, redness,
dehydration, or any other skin condition.
"""

import cv2
import mediapipe as mp

# Lazily created singleton — FaceMesh start-up is expensive.
_face_mesh = None

# A compact subset of the 478 landmarks — oval, eyes, eyebrows, lips, nose,
# irises — for the live camera dot overlay. Sending all 478 every ~360ms
# would work but is unnecessary; these ~160 points are enough to read as a
# face mesh on screen at a fraction of the payload.
_MESH_GROUPS = (
    mp.solutions.face_mesh.FACEMESH_FACE_OVAL,
    mp.solutions.face_mesh.FACEMESH_LEFT_EYE,
    mp.solutions.face_mesh.FACEMESH_RIGHT_EYE,
    mp.solutions.face_mesh.FACEMESH_LEFT_EYEBROW,
    mp.solutions.face_mesh.FACEMESH_RIGHT_EYEBROW,
    mp.solutions.face_mesh.FACEMESH_LIPS,
    mp.solutions.face_mesh.FACEMESH_NOSE,
    mp.solutions.face_mesh.FACEMESH_LEFT_IRIS,
    mp.solutions.face_mesh.FACEMESH_RIGHT_IRIS,
)
CONTOUR_LANDMARK_INDICES = sorted({i for group in _MESH_GROUPS for pair in group for i in pair})


def _get_face_mesh():
    global _face_mesh
    if _face_mesh is None:
        _face_mesh = mp.solutions.face_mesh.FaceMesh(
            static_image_mode=True,
            max_num_faces=2,          # 2 so multiple faces can be rejected
            refine_landmarks=True,
            min_detection_confidence=0.45,
        )
    return _face_mesh


def detect_face(image_bgr):
    """Detect facial landmarks in a BGR image.

    Returns a dict:
        {
          "face_count": int,
          "landmarks": [(x, y), ...] in pixel coordinates (first face),
          "bbox": (x, y, w, h),
          "coverage": float,      # face bbox area / image area
          "error": str | None
        }
    """
    height, width = image_bgr.shape[:2]
    rgb = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2RGB)
    results = _get_face_mesh().process(rgb)

    faces = results.multi_face_landmarks or []
    if len(faces) == 0:
        return {"face_count": 0, "landmarks": None, "bbox": None,
                "coverage": 0.0, "error": "no_face"}
    if len(faces) > 1:
        return {"face_count": len(faces), "landmarks": None, "bbox": None,
                "coverage": 0.0, "error": "multiple_faces"}

    # Normalised landmark coordinates -> pixel coordinates.
    landmarks = [
        (min(max(lm.x, 0.0), 1.0) * width, min(max(lm.y, 0.0), 1.0) * height)
        for lm in faces[0].landmark
    ]
    xs = [p[0] for p in landmarks]
    ys = [p[1] for p in landmarks]
    x_min, x_max = min(xs), max(xs)
    y_min, y_max = min(ys), max(ys)
    bbox = (int(x_min), int(y_min), int(x_max - x_min), int(y_max - y_min))
    coverage = (bbox[2] * bbox[3]) / float(width * height)

    return {"face_count": 1, "landmarks": landmarks, "bbox": bbox,
            "coverage": coverage, "error": None}


# Landmarks used for the head-turn estimate.
NOSE_TIP = 1
FACE_EDGE_LEFT = 234    # image-left edge of the face
FACE_EDGE_RIGHT = 454   # image-right edge


def estimate_yaw(landmarks):
    """Rough head-turn estimate in the range roughly -1 (turned one way) to +1.

    Compares how far the nose tip sits from each side of the face. Facing the
    camera the two distances match and the value is near zero; turning the
    head pushes the nose toward one edge and the value moves toward that
    side's sign. This is a proportion, not degrees, and it is only used to
    decide whether the requested pose has been adopted.

    Sign convention: NEGATIVE when the sitter turns to their own left (the
    nose moves toward the image-left in an unmirrored camera frame).
    """
    nose_x = landmarks[NOSE_TIP][0]
    left_x = landmarks[FACE_EDGE_LEFT][0]
    right_x = landmarks[FACE_EDGE_RIGHT][0]
    half_width = max(1.0, (right_x - left_x) / 2.0)
    centre_x = (left_x + right_x) / 2.0
    return float(max(-1.5, min(1.5, (nose_x - centre_x) / half_width)))
