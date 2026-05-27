"""
Face-tracking zoom for DiviDr.

Pipeline:
  1. Sample every Nth frame in the target range with MediaPipe face detection
  2. Cubic-spline interpolate back to full frame count
  3. Gaussian smooth to mimic a camera operator's hand
  4. Write a per-frame coords file consumed by FFmpeg zoompan
  5. Run FFmpeg zoompan pass → output file

Usage (via main.py):
  dividr-tools face-zoom --input <file> --output <file>
      --start <sec> --end <sec>
      [--zoom 1.5] [--ease 0.4] [--sample-every 6]
"""

import argparse
import json
import math
import os
import subprocess
import sys
import tempfile

import cv2
import numpy as np

try:
    from scipy.interpolate import CubicSpline
    from scipy.ndimage import gaussian_filter1d
    _SCIPY_AVAILABLE = True
except ImportError:
    _SCIPY_AVAILABLE = False


# ---------------------------------------------------------------------------
# YOLO-80 class alias table — maps user-friendly names to COCO class IDs
# ---------------------------------------------------------------------------

YOLO_CLASS_ALIASES: dict[str, int] = {
    'person': 0, 'human': 0, 'man': 0, 'woman': 0, 'people': 0,
    'bicycle': 1, 'bike': 1,
    'car': 2, 'vehicle': 2,
    'motorcycle': 3, 'motorbike': 3,
    'airplane': 4, 'plane': 4,
    'bus': 5,
    'train': 6,
    'truck': 7,
    'boat': 8, 'ship': 8,
    'traffic light': 9,
    'fire hydrant': 10,
    'stop sign': 11,
    'parking meter': 12,
    'bench': 13,
    'bird': 14,
    'cat': 15,
    'dog': 16,
    'horse': 17,
    'sheep': 18,
    'cow': 19,
    'elephant': 20,
    'bear': 21,
    'zebra': 22,
    'giraffe': 23,
    'backpack': 24, 'bag': 24, 'pack': 24,
    'umbrella': 25,
    'handbag': 26, 'purse': 26,
    'tie': 27,
    'suitcase': 28, 'luggage': 28,
    'frisbee': 29,
    'skis': 30, 'ski': 30,
    'snowboard': 31,
    'sports ball': 32, 'ball': 32, 'basketball': 32, 'soccer ball': 32,
    'football': 32, 'tennis ball': 32,
    'kite': 33,
    'baseball bat': 34, 'bat': 34,
    'baseball glove': 35, 'glove': 35,
    'skateboard': 36,
    'surfboard': 37,
    'tennis racket': 38, 'racket': 38,
    'bottle': 39,
    'wine glass': 40, 'glass': 40,
    'cup': 41, 'mug': 41,
    'fork': 42,
    'knife': 43,
    'spoon': 44,
    'bowl': 45,
    'banana': 46,
    'apple': 47,
    'sandwich': 48,
    'orange': 49,
    'broccoli': 50,
    'carrot': 51,
    'hot dog': 52,
    'pizza': 53,
    'donut': 54, 'doughnut': 54,
    'cake': 55,
    'chair': 56,
    'couch': 57, 'sofa': 57,
    'potted plant': 58, 'plant': 58,
    'bed': 59,
    'dining table': 60, 'table': 60, 'desk': 60,
    'toilet': 61,
    'tv': 62, 'television': 62, 'monitor': 62, 'screen': 62,
    'laptop': 63, 'computer': 63, 'notebook': 63,
    'mouse': 64,
    'remote': 65, 'remote control': 65,
    'keyboard': 66,
    'cell phone': 67, 'phone': 67, 'mobile': 67, 'smartphone': 67,
    'microwave': 68,
    'oven': 69,
    'toaster': 70,
    'sink': 71,
    'refrigerator': 72, 'fridge': 72,
    'book': 73,
    'clock': 74,
    'vase': 75,
    'scissors': 76,
    'teddy bear': 77, 'teddy': 77, 'stuffed animal': 77,
    'hair drier': 78, 'hair dryer': 78, 'dryer': 78,
    'toothbrush': 79,
}


def resolve_to_yolo_class(target: str) -> int | None:
    """
    Map a user-supplied target string to a YOLO COCO class ID.
    Returns None if the target is not in the 80-class vocabulary
    (meaning Grounding DINO should be used instead).
    """
    t = target.lower().strip()
    if t in YOLO_CLASS_ALIASES:
        return YOLO_CLASS_ALIASES[t]
    # Substring match — "big ball" → matches "ball"
    for alias, class_id in YOLO_CLASS_ALIASES.items():
        if alias in t or t in alias:
            return class_id
    return None


# ---------------------------------------------------------------------------
# Face detection — OpenCV Haar cascade (no torch/mediapipe dependency)
# ---------------------------------------------------------------------------

def _load_yolo():
    try:
        from ultralytics import YOLO
        model = YOLO('yolov8n.pt')
        return model
    except Exception:
        return None


def _detect_face_yolo(frame, model, width, height):
    """
    Use YOLO person detection (class 0) to locate the person bounding box,
    then run Haar cascade face detection inside the head region for precision.
    Falls back to top-10% person estimate if no face is found in the crop.
    Returns (cx, cy) in [0,1] or None.
    """
    results = model(frame, device='cpu', classes=[0], verbose=False, conf=0.35)
    best = None
    best_conf = 0.0
    for r in results:
        for box in r.boxes:
            conf = float(box.conf[0])
            if conf > best_conf:
                best_conf = conf
                best = box.xyxy[0].tolist()

    if best is None:
        return None

    x1, y1, x2, y2 = best
    person_h = y2 - y1
    person_w = x2 - x1
    x1, y1, x2, y2 = int(x1), int(y1), int(x2), int(y2)

    # Search for face in the top 30% of the person crop
    head_y2 = int(y1 + person_h * 0.30)
    head_y2 = min(head_y2, height)
    head_crop = frame[y1:head_y2, x1:x2]

    face_cx_px = (x1 + x2) / 2.0
    face_cy_px = y1 + person_h * 0.10  # default fallback: top 10%

    if head_crop.size > 0:
        gray = cv2.cvtColor(head_crop, cv2.COLOR_BGR2GRAY)
        cascade_path = cv2.data.haarcascades + 'haarcascade_frontalface_default.xml'
        cascade = cv2.CascadeClassifier(cascade_path)
        faces = cascade.detectMultiScale(
            gray,
            scaleFactor=1.05,
            minNeighbors=2,
            minSize=(20, 20),
            flags=cv2.CASCADE_SCALE_IMAGE,
        )
        if len(faces) > 0:
            # Use the largest detected face (most confident)
            fx, fy, fw, fh = max(faces, key=lambda r: r[2] * r[3])
            face_cx_px = x1 + fx + fw / 2.0
            face_cy_px = y1 + fy + fh / 2.0
            print(f"PROGRESS|face_cascade_hit|cx={face_cx_px/width:.2f}_cy={face_cy_px/height:.2f}", flush=True)
        else:
            print(f"PROGRESS|face_cascade_miss|using_estimate", flush=True)

    return (
        max(0.0, min(1.0, face_cx_px / width)),
        max(0.0, min(1.0, face_cy_px / height)),
    )


def detect_faces_in_clip(video_path, start_sec, end_sec, sample_every=6):
    """
    Sample every `sample_every` frames in [start_sec, end_sec].
    Uses YOLO person detection → face-top estimate.
    Returns list of (frame_index, cx, cy) — cx/cy in [0,1] relative coords.
    """
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        raise RuntimeError(f"Cannot open video: {video_path}")

    fps          = cap.get(cv2.CAP_PROP_FPS) or 30.0
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    width        = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height       = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))

    start_frame = max(0, int(start_sec * fps))
    end_frame   = min(total_frames - 1, int(end_sec * fps))

    model = _load_yolo()
    if model is None:
        raise RuntimeError("ultralytics not installed — run: pip install ultralytics")

    detections = []
    current_frame = start_frame
    cap.set(cv2.CAP_PROP_POS_FRAMES, start_frame)

    while current_frame <= end_frame:
        ret, frame = cap.read()
        if not ret:
            break

        actual_pos = int(cap.get(cv2.CAP_PROP_POS_FRAMES)) - 1

        if (actual_pos - start_frame) % sample_every == 0:
            result = _detect_face_yolo(frame, model, width, height)
            if result:
                detections.append((actual_pos, result[0], result[1]))
                print(f"PROGRESS|detected_person_at_frame_{actual_pos}|cx={result[0]:.2f}_cy={result[1]:.2f}", flush=True)

        next_target = start_frame + (((actual_pos - start_frame) // sample_every) + 1) * sample_every
        if next_target > actual_pos + 1 and next_target <= end_frame:
            cap.set(cv2.CAP_PROP_POS_FRAMES, next_target)
            current_frame = next_target
        else:
            current_frame = actual_pos + 1

    cap.release()
    return detections, fps, total_frames, width, height


# ---------------------------------------------------------------------------
# Object detection — YOLO arbitrary class + Grounding DINO zero-shot
# ---------------------------------------------------------------------------

def _detect_object_yolo_bbox(frame, model, class_id: int, upscale: float = 1.0,
                              max_area_fraction: float = 1.0,
                              max_aspect_ratio: float = 10.0,
                              conf_threshold: float = 0.08):
    """
    Run YOLO detection for a single class.
    Returns (x, y, w, h) pixel bbox of the best detection, or None.
    Used to initialize the CSRT tracker.

    upscale > 1.0 enlarges the frame before detection so tiny objects
    (e.g. a ball in a wide broadcast shot) appear large enough for YOLO
    to fire. The returned bbox is always in original-frame coordinates.

    max_area_fraction: reject detections whose bbox area exceeds this fraction
      of the total frame area (e.g. 0.04 = reject anything > 4% of the frame).
    max_aspect_ratio: reject detections where w/h or h/w exceeds this value.
      Use ~2.5 for balls to filter out elongated false positives (club heads).
    """
    if upscale > 1.0:
        h, w = frame.shape[:2]
        detect_frame = cv2.resize(frame, (int(w * upscale), int(h * upscale)),
                                  interpolation=cv2.INTER_LINEAR)
    else:
        detect_frame = frame
        upscale = 1.0

    fh, fw = frame.shape[:2]
    frame_area = fw * fh

    results = model(detect_frame, device='cpu', classes=[class_id], verbose=False,
                    conf=conf_threshold)
    best, best_conf = None, 0.0
    for r in results:
        for box in r.boxes:
            conf = float(box.conf[0])
            if conf <= best_conf:
                continue
            x1, y1, x2, y2 = [v / upscale for v in box.xyxy[0].tolist()]
            bw, bh = x2 - x1, y2 - y1
            if bw < 1 or bh < 1:
                continue
            # Reject non-round detections (elongated club heads, etc.)
            aspect = max(bw / bh, bh / bw)
            if aspect > max_aspect_ratio:
                continue
            # Reject detections that are too large relative to the frame
            if (bw * bh) / frame_area > max_area_fraction:
                continue
            best_conf = conf
            best = (x1, y1, bw, bh)

    if best is None:
        return None
    return (int(best[0]), int(best[1]), int(best[2]), int(best[3]))


# Ball class IDs in YOLO COCO
_BALL_CLASS_IDS = {32}  # sports ball


def _make_csrt_tracker():
    """Create a CSRT tracker — works with both contrib and legacy namespaces."""
    try:
        return cv2.TrackerCSRT_create()
    except AttributeError:
        return cv2.legacy.TrackerCSRT_create()


def _csrt_track_clip(cap, model, gdino, yolo_class_id, target,
                     start_frame, end_frame, fps, width, height, sample_every):
    """
    CSRT-based object tracking for the segment [start_frame, end_frame].

    Phase 1 — Initialization: scan up to 5 seconds of the segment with YOLO /
    Grounding DINO to find one reliable bounding box for the object. As soon as
    one is found, initialize the CSRT tracker.

    Phase 2 — Tracking: update CSRT on every frame (not just sampled ones — CSRT
    needs continuous updates to stay locked). Record position at sampled frames.
    If CSRT loses track, immediately try YOLO again to reinitialize.

    Returns list of (frame_idx, cx, cy) with cx/cy in [0,1].
    """
    tracker   = None
    init_done = False
    detections = []
    is_ball    = yolo_class_id in _BALL_CLASS_IDS

    # ── Phase 1: find initial bbox ──
    # Balls in wide shots may be occluded early; give more search window.
    init_search_seconds = 10 if is_ball else 5
    search_end = min(start_frame + int(fps * init_search_seconds), end_frame)
    cap.set(cv2.CAP_PROP_POS_FRAMES, start_frame)

    # Upscale factor for YOLO detection — helps with tiny objects in wide shots
    # (ball in broadcast football, etc.). 1.0 for large objects, 4.0 for balls.
    yolo_upscale = 4.0 if is_ball else 1.0

    # For balls: lock in the initial detected size and use it to reject
    # wildly different detections later (club heads, etc.)
    init_bbox_area: float = 0.0   # area in pixels of the first confirmed detection
    last_cx: float = -1.0         # last confirmed center, for jump guard
    last_cy: float = -1.0

    # For ball tracking: scan a short window and pick the SMALLEST detection
    # (the ball is always smaller than the club head which YOLO often detects first).
    # For non-ball targets: stop at the first confident detection.
    ball_candidates: list = []  # (area, bbox, frame_pos, frame_data)
    ball_scan_end = min(start_frame + int(fps * 2), search_end) if is_ball else search_end

    while not init_done:
        ret, frame = cap.read()
        if not ret:
            break
        pos = int(cap.get(cv2.CAP_PROP_POS_FRAMES)) - 1

        # For balls: collect candidates for 2s then pick smallest; after that fall through normally
        scan_phase = is_ball and pos <= ball_scan_end

        if pos > search_end:
            break

        bbox = None
        if yolo_class_id is not None:
            bbox = _detect_object_yolo_bbox(
                frame, model, yolo_class_id, upscale=yolo_upscale,
                max_aspect_ratio=2.5 if is_ball else 10.0,
                # Lower threshold in Phase 1 so tiny balls register at all
                conf_threshold=0.05 if is_ball else 0.08,
            )
        else:
            # Grounding DINO returns (cx,cy) normalized — convert to bbox estimate
            from PIL import Image
            rgb      = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            pil_img  = Image.fromarray(rgb)
            results  = gdino(pil_img, candidate_labels=[target], threshold=0.25)
            if results:
                best = max(results, key=lambda r: r['score'])
                box  = best['box']
                bbox = (box['xmin'], box['ymin'],
                        box['xmax'] - box['xmin'], box['ymax'] - box['ymin'])

        if bbox is not None and bbox[2] > 4 and bbox[3] > 4:
            if scan_phase:
                # Collect this candidate; don't commit yet
                ball_candidates.append((float(bbox[2] * bbox[3]), bbox, pos, frame.copy()))
                # Once scan window ends, pick the smallest
                if pos >= ball_scan_end and ball_candidates:
                    _, bbox, pos, frame = min(ball_candidates, key=lambda c: c[0])
                    scan_phase = False
                else:
                    continue

            tracker = _make_csrt_tracker()
            tracker.init(frame, bbox)
            init_done = True
            init_bbox_area = float(bbox[2] * bbox[3])
            cx = (bbox[0] + bbox[2] / 2) / width
            cy = (bbox[1] + bbox[3] / 2) / height
            last_cx, last_cy = cx, cy
            detections.append((pos, max(0.0, min(1.0, cx)), max(0.0, min(1.0, cy))))
            print(f"PROGRESS|csrt_init|frame={pos}|cx={cx:.2f}_cy={cy:.2f}", flush=True)

    # If scan window ended with candidates but loop exited without committing, pick smallest now
    if not init_done and ball_candidates:
        _, bbox, pos, frame = min(ball_candidates, key=lambda c: c[0])
        tracker = _make_csrt_tracker()
        tracker.init(frame, bbox)
        init_done = True
        init_bbox_area = float(bbox[2] * bbox[3])
        cx = (bbox[0] + bbox[2] / 2) / width
        cy = (bbox[1] + bbox[3] / 2) / height
        last_cx, last_cy = cx, cy
        detections.append((pos, max(0.0, min(1.0, cx)), max(0.0, min(1.0, cy))))
        print(f"PROGRESS|csrt_init_smallest|frame={pos}|cx={cx:.2f}_cy={cy:.2f}", flush=True)

    if not init_done:
        print("PROGRESS|csrt_init_failed|no_detection_in_first_5s", flush=True)
        return detections

    # ── Phase 2: detector-tracker fusion ──
    # Every sampled frame: try YOLO first. YOLO hit → record + reinit CSRT.
    # YOLO miss → fall back to CSRT output. CSRT miss → skip frame (interpolation fills it).
    # This means CSRT never drifts for more than sample_every frames without a YOLO anchor.
    consecutive_csrt_fails = 0

    while True:
        ret, frame = cap.read()
        if not ret:
            break
        pos = int(cap.get(cv2.CAP_PROP_POS_FRAMES)) - 1
        if pos > end_frame:
            break

        is_sample = (pos - start_frame) % sample_every == 0

        # Always update CSRT to keep it current (even on non-sample frames)
        csrt_success, csrt_bbox = tracker.update(frame)

        if is_sample:
            result_pos = None

            # Tier 1: YOLO — authoritative when it fires
            if yolo_class_id is not None:
                yolo_bbox = _detect_object_yolo_bbox(
                    frame, model, yolo_class_id, upscale=yolo_upscale,
                    max_aspect_ratio=2.5 if is_ball else 10.0,
                    # Phase-2 reinit uses higher confidence to reduce false positives
                    conf_threshold=0.15 if is_ball else 0.08,
                )
                if yolo_bbox is not None and yolo_bbox[2] > 4 and yolo_bbox[3] > 4:
                    cx = (yolo_bbox[0] + yolo_bbox[2] / 2) / width
                    cy = (yolo_bbox[1] + yolo_bbox[3] / 2) / height

                    # Size guard: reject if >6× bigger than initial detection (club heads, etc.)
                    bbox_area = float(yolo_bbox[2] * yolo_bbox[3])
                    size_ok = (not is_ball or init_bbox_area == 0 or
                               bbox_area <= init_bbox_area * 6.0)

                    # Position jump guard: reject if center jumps >35% of frame
                    jump_ok = (last_cx < 0 or
                               (abs(cx - last_cx) < 0.35 and abs(cy - last_cy) < 0.35))

                    if size_ok and jump_ok:
                        result_pos = (max(0.0, min(1.0, cx)), max(0.0, min(1.0, cy)))
                        tracker = _make_csrt_tracker()
                        tracker.init(frame, yolo_bbox)
                        last_cx, last_cy = cx, cy
                        consecutive_csrt_fails = 0
                        print(f"PROGRESS|yolo_anchor|frame={pos}|cx={cx:.2f}_cy={cy:.2f}", flush=True)
                    else:
                        reason = "size" if not size_ok else "jump"
                        print(f"PROGRESS|yolo_rejected|{reason}|frame={pos}|cx={cx:.2f}_cy={cy:.2f}", flush=True)

            # Tier 2: CSRT — fills in between YOLO hits
            if result_pos is None and csrt_success:
                cx = (csrt_bbox[0] + csrt_bbox[2] / 2) / width
                cy = (csrt_bbox[1] + csrt_bbox[3] / 2) / height
                result_pos = (max(0.0, min(1.0, cx)), max(0.0, min(1.0, cy)))
                last_cx, last_cy = cx, cy
                consecutive_csrt_fails = 0
                print(f"PROGRESS|csrt|frame={pos}|cx={cx:.2f}_cy={cy:.2f}", flush=True)
            elif is_sample and not csrt_success:
                consecutive_csrt_fails += 1

            if result_pos is not None:
                detections.append((pos, result_pos[0], result_pos[1]))

    return detections


def _load_grounding_dino():
    """
    Lazy-load the Grounding DINO zero-shot object detection pipeline (CPU).
    Used only when the user's target is outside YOLO's 80-class vocabulary.
    Returns the pipeline or None if transformers is not installed.
    """
    try:
        from transformers import pipeline as hf_pipeline
        print("PROGRESS|loading_grounding_dino|this may take a moment on first run", flush=True)
        gdino = hf_pipeline(
            model="IDEA-Research/grounding-dino-tiny",
            task="zero-shot-object-detection",
            device='cpu',
        )
        return gdino
    except Exception as e:
        print(f"PROGRESS|grounding_dino_unavailable|{e}", flush=True)
        return None


def _detect_object_grounding_dino(frame, gdino, target: str, width: int, height: int):
    """
    Detect an arbitrary object described by `target` text using Grounding DINO.
    Returns (cx, cy) in [0,1] or None if nothing found above threshold.
    """
    from PIL import Image
    rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
    pil_img = Image.fromarray(rgb)

    results = gdino(pil_img, candidate_labels=[target], threshold=0.25)
    if not results:
        return None

    best = max(results, key=lambda r: r['score'])
    box = best['box']  # {'xmin': px, 'ymin': px, 'xmax': px, 'ymax': px}
    cx = (box['xmin'] + box['xmax']) / 2.0 / width
    cy = (box['ymin'] + box['ymax']) / 2.0 / height
    return (max(0.0, min(1.0, cx)), max(0.0, min(1.0, cy)))


def detect_objects_in_clip(video_path, start_sec, end_sec, target: str, sample_every=2):
    """
    Like detect_faces_in_clip but for arbitrary objects.
    - If target maps to a YOLO-80 class → uses YOLO (fast, already installed)
    - Otherwise → uses Grounding DINO zero-shot (slower, handles arbitrary text)

    The face detection path (detect_faces_in_clip) is NOT called here.
    Returns identical signature: (detections, fps, total_frames, width, height)
    """
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        raise RuntimeError(f"Cannot open video: {video_path}")

    fps          = cap.get(cv2.CAP_PROP_FPS) or 30.0
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    width        = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height       = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))

    start_frame = max(0, int(start_sec * fps))
    end_frame   = min(total_frames - 1, int(end_sec * fps))

    yolo_class_id = resolve_to_yolo_class(target)

    if yolo_class_id is not None:
        model = _load_yolo()
        if model is None:
            raise RuntimeError("ultralytics not installed — run: pip install ultralytics")
        gdino = None
        print(f"PROGRESS|object_detect_mode|yolo|class_id={yolo_class_id}|target={target}", flush=True)
    else:
        model = None
        gdino = _load_grounding_dino()
        if gdino is None:
            raise RuntimeError(
                f"'{target}' is not in YOLO-80 classes and Grounding DINO failed to load. "
                "Install with: pip install transformers accelerate pillow"
            )
        print(f"PROGRESS|object_detect_mode|grounding_dino|target={target}", flush=True)

    detections = _csrt_track_clip(
        cap, model, gdino, yolo_class_id, target,
        start_frame, end_frame, fps, width, height, sample_every,
    )

    cap.release()
    return detections, fps, total_frames, width, height


# ---------------------------------------------------------------------------
# Interpolation + smoothing
# ---------------------------------------------------------------------------

def interpolate_positions(detections, start_frame, end_frame, fps: float = 30.0):
    """
    Given sparse (frame_idx, cx, cy) samples, fill every frame in
    [start_frame, end_frame] using:
      - Linear interp between known detections
      - Forward-fill before first detection
      - When object exits frame early (last detection >=1.5s before end_frame),
        hold the last position for 0.5s then ease smoothly back to center.
    Returns arrays (xs, ys) of length (end_frame - start_frame + 1).
    """
    n = end_frame - start_frame + 1

    if not detections:
        return np.full(n, 0.5), np.full(n, 0.5)

    idxs = np.array([d[0] for d in detections], dtype=float)
    cxs  = np.array([d[1] for d in detections], dtype=float)
    cys  = np.array([d[2] for d in detections], dtype=float)

    all_frames = np.arange(start_frame, end_frame + 1, dtype=float)

    # Linear interpolation; clamp to first/last for out-of-range frames
    xs = np.interp(all_frames, idxs, cxs,
                   left=float(cxs[0]), right=float(cxs[-1]))
    ys = np.interp(all_frames, idxs, cys,
                   left=float(cys[0]), right=float(cys[-1]))

    # ── Object-exit recovery ──────────────────────────────────────────────────
    # When the last detection is >=1.5s before clip end, the subject likely exited
    # the frame. Hold last position for 0.5s, then ease smoothly back to center.
    hold_frames   = int(fps * 0.5)
    ease_frames   = max(1, int(fps * 1.0))
    gap_threshold = hold_frames + ease_frames  # ~1.5s total

    last_det_frame    = int(idxs[-1])
    frames_after_last = end_frame - last_det_frame

    if frames_after_last >= gap_threshold:
        ease_start_abs = last_det_frame + hold_frames
        ease_end_abs   = ease_start_abs + ease_frames
        last_cx = float(cxs[-1])
        last_cy = float(cys[-1])

        print(f"PROGRESS|object_exited_frame|last_det={last_det_frame}|easing_to_center", flush=True)

        for abs_f in range(ease_start_abs, end_frame + 1):
            i = abs_f - start_frame
            if i < 0 or i >= n:
                continue
            if abs_f <= ease_end_abs:
                t = (abs_f - ease_start_abs) / ease_frames
                t = t * t * (3.0 - 2.0 * t)  # smooth-step
                xs[i] = last_cx * (1.0 - t) + 0.5 * t
                ys[i] = last_cy * (1.0 - t) + 0.5 * t
            else:
                xs[i] = 0.5
                ys[i] = 0.5

    return np.clip(xs, 0.0, 1.0), np.clip(ys, 0.0, 1.0)


def smooth_positions(xs, ys, sigma=8.0):
    """Gaussian smooth the position curves to remove jitter."""
    if _SCIPY_AVAILABLE:
        xs = gaussian_filter1d(xs, sigma=sigma)
        ys = gaussian_filter1d(ys, sigma=sigma)
    # If scipy unavailable we just return as-is (already interpolated)
    return np.clip(xs, 0.0, 1.0), np.clip(ys, 0.0, 1.0)


# ---------------------------------------------------------------------------
# Ease curve
# ---------------------------------------------------------------------------

def ease_in_out(t):
    """Smooth step: 3t²-2t³"""
    return t * t * (3.0 - 2.0 * t)


def build_zoom_curve(n_frames, zoom_target, ease_frames):
    """
    Returns array of zoom values (1.0 → zoom_target → 1.0 or hold).
    ease_frames: number of frames to ramp in/out.
    We ease in for ease_frames, hold at zoom_target, ease out for ease_frames.
    """
    curve = np.ones(n_frames)
    ease_frames = min(ease_frames, n_frames // 2)

    for i in range(n_frames):
        if i < ease_frames:
            t = ease_in_out(i / ease_frames)
            curve[i] = 1.0 + (zoom_target - 1.0) * t
        elif i >= n_frames - ease_frames:
            t = ease_in_out((n_frames - 1 - i) / ease_frames)
            curve[i] = 1.0 + (zoom_target - 1.0) * t
        else:
            curve[i] = zoom_target

    return curve


# ---------------------------------------------------------------------------
# FFmpeg zoompan
# ---------------------------------------------------------------------------

def find_ffmpeg():
    """Find ffmpeg binary — check common locations."""
    import shutil
    ffmpeg = shutil.which('ffmpeg')
    if ffmpeg:
        return ffmpeg
    candidates = [
        r'C:\ffmpeg\bin\ffmpeg.exe',
        r'C:\Program Files\ffmpeg\bin\ffmpeg.exe',
        '/usr/bin/ffmpeg',
        '/usr/local/bin/ffmpeg',
    ]
    for c in candidates:
        if os.path.exists(c):
            return c
    raise RuntimeError("ffmpeg not found. Make sure it is on PATH.")



def apply_zoom_opencv(input_path, output_path, start_sec, end_sec,
                      zoom_curve, xs, ys, width, height, fps, total_frames):
    """
    Apply per-frame face-tracked zoom using OpenCV + FFmpeg.

    Strategy:
      1. FFmpeg extracts middle segment (video-only, stream copy — fast)
      2. OpenCV reads frames, applies crop+scale, pipes raw BGR24 to FFmpeg stdin
         → FFmpeg encodes to h264 video-only temp file (no codec install needed)
      3. FFmpeg muxes encoded video + audio from original → seg_middle.mp4
      4. FFmpeg concats before / seg_middle / after
    """
    ffmpeg   = find_ffmpeg()
    tmpdir   = tempfile.mkdtemp()
    orig_dur = total_frames / fps

    seg_before      = os.path.join(tmpdir, 'seg_before.mp4')
    seg_raw_middle  = os.path.join(tmpdir, 'seg_mid_raw.mp4')
    seg_vid_only    = os.path.join(tmpdir, 'seg_mid_vid.mp4')
    seg_middle      = os.path.join(tmpdir, 'seg_mid.mp4')
    seg_after       = os.path.join(tmpdir, 'seg_after.mp4')
    concat_list     = os.path.join(tmpdir, 'concat.txt')

    enc = ['-c:v', 'libx264', '-preset', 'fast', '-crf', '18',
           '-c:a', 'aac', '-b:a', '192k', '-ar', '44100']

    def run_ff(args):
        r = subprocess.run([ffmpeg] + args, capture_output=True, text=True)
        if r.returncode != 0:
            raise RuntimeError(f"FFmpeg failed:\n{r.stderr[-800:]}")

    # ── Step 1: Extract raw middle segment video (re-encode for reliable seek) ──
    run_ff(['-y',
            '-ss', str(start_sec), '-to', str(end_sec),
            '-i', input_path,
            '-map', '0:v',
            '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18',
            seg_raw_middle])

    # ── Step 2: OpenCV reads segment, pipes processed frames to FFmpeg stdin ──
    cap = cv2.VideoCapture(seg_raw_middle)
    seg_fps = cap.get(cv2.CAP_PROP_FPS) or fps
    n_zoom  = len(zoom_curve)

    # FFmpeg reads raw BGR24 from stdin, encodes to h264 mp4 (video only)
    pipe_cmd = [
        ffmpeg, '-y',
        '-f', 'rawvideo', '-vcodec', 'rawvideo',
        '-s', f'{width}x{height}',
        '-pix_fmt', 'bgr24',
        '-r', str(seg_fps),
        '-i', 'pipe:0',
        '-c:v', 'libx264', '-preset', 'fast', '-crf', '18',
        '-movflags', '+faststart',
        seg_vid_only,
    ]
    pipe_proc = subprocess.Popen(pipe_cmd, stdin=subprocess.PIPE,
                                 stdout=subprocess.DEVNULL,
                                 stderr=subprocess.PIPE)

    i = 0
    while True:
        ret, frame = cap.read()
        if not ret:
            break

        # Resize frame to exact output dimensions if needed
        fh, fw = frame.shape[:2]
        if fw != width or fh != height:
            frame = cv2.resize(frame, (width, height))

        local_idx = min(i, n_zoom - 1)
        z  = float(zoom_curve[local_idx])
        cx = float(xs[local_idx])
        cy = float(ys[local_idx])

        # No adaptive zoom reduction — keep full zoom, just clamp crop to edges
        z = max(1.0, z)

        crop_w = max(1, int(width  / z))
        crop_h = max(1, int(height / z))
        # Center crop on face, clamp so crop stays within frame
        x = int(max(0, min(width  - crop_w, cx * width  - crop_w / 2)))
        y = int(max(0, min(height - crop_h, cy * height - crop_h / 2)))

        cropped = frame[y:y + crop_h, x:x + crop_w]
        if cropped.size > 0:
            out_frame = cv2.resize(cropped, (width, height),
                                   interpolation=cv2.INTER_LANCZOS4)
        else:
            out_frame = frame

        pipe_proc.stdin.write(out_frame.tobytes())
        i += 1

    cap.release()
    pipe_proc.stdin.close()
    _, pipe_err = pipe_proc.communicate()
    if pipe_proc.returncode != 0:
        raise RuntimeError(f"FFmpeg pipe encode failed:\n{pipe_err.decode()[-500:]}")

    # ── Step 3: Mux encoded video + audio from original ──
    run_ff(['-y',
            '-i', seg_vid_only,
            '-ss', str(start_sec), '-to', str(end_sec), '-i', input_path,
            '-map', '0:v', '-map', '1:a?',
            '-c:v', 'copy',
            '-c:a', 'aac', '-b:a', '192k', '-ar', '44100',
            seg_middle])

    # ── Step 4: Before / after segments ──
    if start_sec > 0.05:
        run_ff(['-y', '-t', str(start_sec), '-i', input_path,
                '-map', '0:v', '-map', '0:a?'] + enc + [seg_before])

    if end_sec < orig_dur - 0.05:
        run_ff(['-y', '-ss', str(end_sec), '-i', input_path,
                '-map', '0:v', '-map', '0:a?'] + enc + [seg_after])

    # ── Step 5: Concat ──
    parts = []
    if start_sec > 0.05 and os.path.exists(seg_before):
        parts.append(seg_before)
    if os.path.exists(seg_middle):
        parts.append(seg_middle)
    if end_sec < orig_dur - 0.05 and os.path.exists(seg_after):
        parts.append(seg_after)

    if len(parts) == 1:
        import shutil
        shutil.copy(parts[0], output_path)
    else:
        with open(concat_list, 'w') as f:
            for p in parts:
                f.write(f"file '{p.replace(os.sep, '/')}'\n")
        run_ff(['-y', '-f', 'concat', '-safe', '0', '-i', concat_list,
                '-map', '0:v', '-map', '0:a?'] + enc +
               ['-movflags', '+faststart', output_path])

    # ── Verify output exists and has content ──
    if not os.path.exists(output_path) or os.path.getsize(output_path) < 1000:
        raise RuntimeError(f"Output file missing or empty: {output_path}")

    # ── Cleanup ──
    for f in [seg_before, seg_raw_middle, seg_vid_only, seg_middle,
              seg_after, concat_list]:
        try:
            if os.path.exists(f): os.unlink(f)
        except Exception:
            pass
    try:
        os.rmdir(tmpdir)
    except Exception:
        pass


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def run(input_path, output_path, start_sec, end_sec,
        zoom_level=2.5, ease_sec=0.4, sample_every=6, target=None):

    if not os.path.exists(input_path):
        raise FileNotFoundError(f"Input not found: {input_path}")

    # Determine whether this is a face zoom or an object zoom.
    # Face path is completely unchanged — object path is additive.
    _target = (target or 'face').lower().strip()
    is_face = _target in ('face', 'person', 'head', '')

    if is_face:
        print(f"PROGRESS|detecting_faces|0", flush=True)
        detections, fps, total_frames, width, height = detect_faces_in_clip(
            input_path, start_sec, end_sec, sample_every=sample_every
        )
    else:
        print(f"PROGRESS|detecting_object|target={_target}", flush=True)
        detections, fps, total_frames, width, height = detect_objects_in_clip(
            input_path, start_sec, end_sec, target=_target, sample_every=sample_every
        )

    print(f"PROGRESS|interpolating|30", flush=True)
    print(f"INFO|detections={len(detections)}", flush=True)

    start_frame = int(start_sec * fps)
    end_frame   = min(total_frames - 1, int(end_sec * fps))
    n_frames    = end_frame - start_frame + 1

    xs, ys = interpolate_positions(detections, start_frame, end_frame, fps=fps)
    # For objects (non-face), use lighter smoothing so fast trajectories aren't flattened
    smooth_sigma = fps * 0.10 if not is_face else fps * 0.25
    xs, ys = smooth_positions(xs, ys, sigma=smooth_sigma)

    ease_frames = int(ease_sec * fps)
    zoom_curve  = build_zoom_curve(n_frames, zoom_level, ease_frames)

    print(f"PROGRESS|applying_zoom|60", flush=True)

    apply_zoom_opencv(
        input_path, output_path,
        start_sec, end_sec,
        zoom_curve, xs, ys,
        width, height, fps, total_frames
    )

    print(f"PROGRESS|done|100", flush=True)
    result = {
        "success": True,
        "output": output_path,
        "detections": len(detections),
        "zoom_level": zoom_level,
        "duration_sec": end_sec - start_sec,
    }
    print(f"RESULT|{json.dumps(result)}", flush=True)


def add_subparser(subparsers):
    p = subparsers.add_parser('face-zoom', help='Face-tracking smooth zoom')
    p.add_argument('--input',        required=True)
    p.add_argument('--output',       required=True)
    p.add_argument('--start',        type=float, required=True)
    p.add_argument('--end',          type=float, required=True)
    p.add_argument('--zoom',         type=float, default=2.5)
    p.add_argument('--ease',         type=float, default=0.4)
    p.add_argument('--sample-every', type=int,   default=6)
    p.add_argument('--target',       type=str,   default='face',
                   help='Subject to zoom: face (default), ball, vase, bottle, money, etc.')
    return p


def handle_args(args):
    run(
        input_path=args.input,
        output_path=args.output,
        start_sec=args.start,
        end_sec=args.end,
        zoom_level=args.zoom,
        ease_sec=args.ease,
        sample_every=args.sample_every,
        target=getattr(args, 'target', 'face'),
    )
