"""
Face-tracking / object-tracking zoom for DiviDr.

Pipeline:
  1. YOLO finds the target's bounding box; CSRT tracker is initialised on it.
  2. Per-frame: CSRT is updated every frame (required for lock stability).
     Every N frames YOLO attempts a re-anchor.
  3. When both CSRT and YOLO fail (e.g. ball mid-flight), velocity is
     extrapolated from the rolling position history so the camera keeps moving.
  4. Gaussian-smooth the position path, apply per-frame crop+scale via
     OpenCV piped to FFmpeg.
"""

import argparse
import collections
import json
import os
import subprocess
import sys
import tempfile

import cv2
import numpy as np

try:
    from scipy.ndimage import gaussian_filter1d
    _SCIPY_AVAILABLE = True
except ImportError:
    _SCIPY_AVAILABLE = False


# ---------------------------------------------------------------------------
# YOLO-80 class alias table
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
    'football': 32, 'tennis ball': 32, 'baseball': 32,
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

_BALL_CLASS_IDS = {32}


def resolve_to_yolo_class(target: str) -> int | None:
    t = target.lower().strip()
    if t in YOLO_CLASS_ALIASES:
        return YOLO_CLASS_ALIASES[t]
    for alias, class_id in YOLO_CLASS_ALIASES.items():
        if alias in t or t in alias:
            return class_id
    return None


# ---------------------------------------------------------------------------
# Model / tracker helpers
# ---------------------------------------------------------------------------

def _load_yolo():
    try:
        from ultralytics import YOLO
        return YOLO('yolov8n.pt')
    except Exception:
        return None


def _make_csrt_tracker():
    try:
        return cv2.TrackerCSRT_create()
    except AttributeError:
        return cv2.legacy.TrackerCSRT_create()


# ---------------------------------------------------------------------------
# Detection helpers
# ---------------------------------------------------------------------------

def _detect_yolo_bbox(frame, model, class_id: int,
                      upscale: float = 1.0,
                      conf: float = 0.08,
                      max_aspect: float = 10.0,
                      max_area_frac: float = 1.0):
    """
    Run YOLO for a single class. Returns (x, y, w, h) in original-frame
    pixel coords or None.

    upscale > 1 zooms the frame before detection so tiny objects (e.g. a ball
    in a wide shot) are large enough for YOLO to see. Returned bbox is always
    in original coordinates.
    """
    if upscale > 1.0:
        oh, ow = frame.shape[:2]
        det_frame = cv2.resize(frame, (int(ow * upscale), int(oh * upscale)),
                               interpolation=cv2.INTER_LINEAR)
    else:
        det_frame = frame
        upscale = 1.0

    fh, fw = frame.shape[:2]
    frame_area = fw * fh

    results = model(det_frame, device='cpu', classes=[class_id],
                    verbose=False, conf=conf)
    best, best_conf = None, 0.0
    for r in results:
        for box in r.boxes:
            c = float(box.conf[0])
            if c <= best_conf:
                continue
            x1, y1, x2, y2 = [v / upscale for v in box.xyxy[0].tolist()]
            bw, bh = x2 - x1, y2 - y1
            if bw < 1 or bh < 1:
                continue
            if max(bw / bh, bh / bw) > max_aspect:
                continue
            if (bw * bh) / frame_area > max_area_frac:
                continue
            best_conf = c
            best = (x1, y1, bw, bh)

    if best is None:
        return None
    return (int(best[0]), int(best[1]), int(best[2]), int(best[3]))


def _detect_face_yolo(frame, model, width, height):
    """
    YOLO person detection + Haar cascade face refinement.
    Returns (cx, cy) normalised [0,1] or None.
    """
    results = model(frame, device='cpu', classes=[0], verbose=False, conf=0.35)
    best, best_conf = None, 0.0
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
    x1i, y1i, x2i = int(x1), int(y1), int(x2)

    face_cx_px = (x1 + x2) / 2.0
    face_cy_px = y1 + person_h * 0.10

    head_y2 = min(int(y1 + person_h * 0.30), height)
    head_crop = frame[y1i:head_y2, x1i:x2i]

    if head_crop.size > 0:
        gray = cv2.cvtColor(head_crop, cv2.COLOR_BGR2GRAY)
        cascade_path = cv2.data.haarcascades + 'haarcascade_frontalface_default.xml'
        cascade = cv2.CascadeClassifier(cascade_path)
        faces = cascade.detectMultiScale(gray, scaleFactor=1.05,
                                         minNeighbors=2, minSize=(20, 20),
                                         flags=cv2.CASCADE_SCALE_IMAGE)
        if len(faces) > 0:
            fx, fy, fw, fh = max(faces, key=lambda r: r[2] * r[3])
            face_cx_px = x1i + fx + fw / 2.0
            face_cy_px = y1i + fy + fh / 2.0
            print(f"PROGRESS|face_cascade_hit|cx={face_cx_px/width:.2f}_cy={face_cy_px/height:.2f}", flush=True)

    return (
        max(0.0, min(1.0, face_cx_px / width)),
        max(0.0, min(1.0, face_cy_px / height)),
    )


# ---------------------------------------------------------------------------
# Face detection path
# ---------------------------------------------------------------------------

def detect_faces_in_clip(video_path, start_sec, end_sec, sample_every=6):
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        raise RuntimeError(f"Cannot open video: {video_path}")

    fps          = cap.get(cv2.CAP_PROP_FPS) or 30.0
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    width        = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height       = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    start_frame  = max(0, int(start_sec * fps))
    end_frame    = min(total_frames - 1, int(end_sec * fps))

    model = _load_yolo()
    if model is None:
        raise RuntimeError("ultralytics not installed — run: pip install ultralytics")

    detections = []
    cap.set(cv2.CAP_PROP_POS_FRAMES, start_frame)
    current_frame = start_frame

    while current_frame <= end_frame:
        ret, frame = cap.read()
        if not ret:
            break
        actual_pos = int(cap.get(cv2.CAP_PROP_POS_FRAMES)) - 1

        if (actual_pos - start_frame) % sample_every == 0:
            result = _detect_face_yolo(frame, model, width, height)
            if result:
                detections.append((actual_pos, result[0], result[1]))
                print(f"PROGRESS|face_detected|frame={actual_pos}|cx={result[0]:.2f}_cy={result[1]:.2f}", flush=True)

        next_target = start_frame + (((actual_pos - start_frame) // sample_every) + 1) * sample_every
        if next_target > actual_pos + 1 and next_target <= end_frame:
            cap.set(cv2.CAP_PROP_POS_FRAMES, next_target)
            current_frame = next_target
        else:
            current_frame = actual_pos + 1

    cap.release()
    return detections, fps, total_frames, width, height


# ---------------------------------------------------------------------------
# Object tracking — CSRT + YOLO + velocity extrapolation
# ---------------------------------------------------------------------------

def _track_object(cap, model, yolo_class_id, width, height, fps,
                  start_frame, end_frame, sample_every=2):
    """
    Track yolo_class_id from start_frame to end_frame.

    Phase 1  Scan the first 5 s of the clip with YOLO to find the object.
             For balls: collect all candidates in the first 2 s, then pick
             the smallest (the ball is always smaller than the bat/club head
             that YOLO tends to detect first).
             Init CSRT on the winning bbox.

    Phase 2  Read every frame:
             - Update CSRT (must happen every frame to maintain lock).
             - Every sample_every frames, run YOLO as a re-anchor.
             - Priority: YOLO > CSRT > velocity extrapolation.
             - Velocity extrapolation: when both CSRT and YOLO fail, compute
               the average velocity over the last 8 positions and project
               forward. This prevents the camera from freezing mid-flight.

    Returns [(frame_idx, cx, cy)] with cx/cy normalised [0, 1].
    """
    is_ball     = yolo_class_id in _BALL_CLASS_IDS
    upscale     = 4.0 if is_ball else 1.0
    init_window = min(start_frame + int(fps * 5), end_frame)

    # ── Phase 1: find initial bbox ────────────────────────────────────────
    cap.set(cv2.CAP_PROP_POS_FRAMES, start_frame)
    candidates = []  # (area, bbox, frame_idx, frame_copy)
    ball_scan_end = min(start_frame + int(fps * 2), init_window)

    while True:
        ret, frame = cap.read()
        if not ret:
            break
        pos = int(cap.get(cv2.CAP_PROP_POS_FRAMES)) - 1
        if pos > init_window:
            break

        bbox = _detect_yolo_bbox(frame, model, yolo_class_id,
                                  upscale=upscale,
                                  conf=0.25 if is_ball else 0.08,
                                  max_aspect=2.5 if is_ball else 10.0,
                                  max_area_frac=0.015 if is_ball else 1.0)

        if bbox and bbox[2] > 4 and bbox[3] > 4:
            area = float(bbox[2] * bbox[3])
            candidates.append((area, bbox, pos, frame.copy()))
            if is_ball and pos < ball_scan_end:
                continue  # keep scanning for a smaller (truer) ball candidate
            break  # non-ball or past scan window: first confident hit is enough

    # If ball scan window ended without a break, we may still have candidates
    if not candidates:
        print("PROGRESS|csrt_init_failed|no_detection_in_search_window", flush=True)
        return []

    if is_ball:
        _, init_bbox, init_pos, init_frame = min(candidates, key=lambda c: c[0])
    else:
        _, init_bbox, init_pos, init_frame = candidates[0]

    tracker = _make_csrt_tracker()
    tracker.init(init_frame, init_bbox)

    cx0 = max(0.0, min(1.0, (init_bbox[0] + init_bbox[2] / 2) / width))
    cy0 = max(0.0, min(1.0, (init_bbox[1] + init_bbox[3] / 2) / height))
    print(f"PROGRESS|csrt_init|frame={init_pos}|cx={cx0:.2f}_cy={cy0:.2f}", flush=True)

    detections          = [(init_pos, cx0, cy0)]
    pos_history         = collections.deque([(cx0, cy0)], maxlen=8)
    last_confirmed_frame = init_pos  # last frame with a real YOLO/CSRT hit

    # ── Phase 2: per-frame tracking ───────────────────────────────────────
    LOST_LIMIT      = int(fps * 2.0)  # extrapolate up to 2 s before giving up
    REANCHOR_LIMIT  = int(fps * 0.5)  # stop YOLO re-anchoring after 0.5 s of loss
    frames_lost     = 0
    frames_since_yolo = 0

    cap.set(cv2.CAP_PROP_POS_FRAMES, init_pos + 1)

    while True:
        ret, frame = cap.read()
        if not ret:
            break
        pos = int(cap.get(cv2.CAP_PROP_POS_FRAMES)) - 1
        if pos > end_frame:
            break

        # Always update CSRT — needs every frame to keep its appearance model current
        csrt_ok, csrt_bbox = tracker.update(frame)

        found = None

        # Pre-compute expected position from velocity for use in the YOLO gate below.
        # Also detect if velocity projects the ball outside the frame — if so, the ball
        # has exited and CSRT is silently tracking background drift. Block both CSRT
        # and YOLO to prevent the camera jumping to a wrong object (water bottles, etc.).
        expected_pos = None
        ball_exited  = False
        if len(pos_history) >= 2:
            hist = list(pos_history)
            n    = len(hist)
            vx   = (hist[-1][0] - hist[0][0]) / max(1, n - 1)
            vy   = (hist[-1][1] - hist[0][1]) / max(1, n - 1)
            raw_x = hist[-1][0] + vx
            raw_y = hist[-1][1] + vy
            ball_exited = raw_x < -0.05 or raw_x > 1.05 or raw_y < -0.05 or raw_y > 1.05
            expected_pos = (
                max(0.02, min(0.98, raw_x)),
                max(0.02, min(0.98, raw_y)),
            )
        elif pos_history:
            expected_pos = pos_history[-1]

        if ball_exited:
            csrt_ok = False  # ball left the frame; CSRT is tracking background drift

        # YOLO re-anchor on a fixed cadence (skip entirely if ball has exited)
        frames_since_yolo += 1
        if not ball_exited and frames_since_yolo >= sample_every:
            frames_since_yolo = 0
            yolo_bbox = _detect_yolo_bbox(frame, model, yolo_class_id,
                                           upscale=upscale,
                                           conf=0.25 if is_ball else 0.08,
                                           max_aspect=2.5 if is_ball else 10.0,
                                           max_area_frac=0.015 if is_ball else 1.0)
            if yolo_bbox and yolo_bbox[2] > 4 and yolo_bbox[3] > 4:
                cx = (yolo_bbox[0] + yolo_bbox[2] / 2) / width
                cy = (yolo_bbox[1] + yolo_bbox[3] / 2) / height
                # Agreement gate:
                # - CSRT active: YOLO must land within 15% of CSRT's position.
                # - CSRT lost, short gap (<0.5 s): YOLO must land within 20% of
                #   the velocity-extrapolated expected position. Prevents latching
                #   onto a different visible object (club head, bystander, etc.).
                # - CSRT lost, long gap (>0.5 s): object has likely left the frame;
                #   refuse all re-anchors so velocity extrapolation runs to completion
                #   and interpolate_positions eases the camera back to centre.
                if csrt_ok:
                    csrt_cx = (csrt_bbox[0] + csrt_bbox[2] / 2) / width
                    csrt_cy = (csrt_bbox[1] + csrt_bbox[3] / 2) / height
                    agree = abs(cx - csrt_cx) < 0.15 and abs(cy - csrt_cy) < 0.15
                elif frames_lost < REANCHOR_LIMIT and expected_pos is not None:
                    agree = (abs(cx - expected_pos[0]) < 0.20 and
                             abs(cy - expected_pos[1]) < 0.20)
                else:
                    agree = False  # object gone; ignore YOLO entirely
                if agree:
                    found = (cx, cy)
                    tracker = _make_csrt_tracker()
                    tracker.init(frame, yolo_bbox)
                    frames_lost = 0
                    last_confirmed_frame = pos
                    print(f"PROGRESS|yolo_anchor|frame={pos}|cx={cx:.2f}_cy={cy:.2f}", flush=True)
                else:
                    print(f"PROGRESS|yolo_rejected|disagreement|frame={pos}", flush=True)

        # CSRT fallback
        if found is None and csrt_ok:
            cx = (csrt_bbox[0] + csrt_bbox[2] / 2) / width
            cy = (csrt_bbox[1] + csrt_bbox[3] / 2) / height
            found = (max(0.0, min(1.0, cx)), max(0.0, min(1.0, cy)))
            frames_lost = 0
            last_confirmed_frame = pos

        # Velocity extrapolation — keeps the camera moving when both fail.
        # Extrapolated positions are NOT added to pos_history so the velocity
        # estimate doesn't decay to zero when the ball hits the frame boundary.
        is_extrapolated = False
        if found is None:
            frames_lost += 1
            if frames_lost <= LOST_LIMIT and expected_pos is not None:
                found = expected_pos
                is_extrapolated = True
                print(f"PROGRESS|extrapolate|frame={pos}|lost={frames_lost}|cx={expected_pos[0]:.2f}_cy={expected_pos[1]:.2f}", flush=True)

        if found:
            cx, cy = found
            detections.append((pos, max(0.0, min(1.0, cx)), max(0.0, min(1.0, cy))))
            if not is_extrapolated:
                pos_history.append(found)

    return detections, last_confirmed_frame


def detect_objects_in_clip(video_path, start_sec, end_sec, target: str, sample_every=2):
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        raise RuntimeError(f"Cannot open video: {video_path}")

    fps          = cap.get(cv2.CAP_PROP_FPS) or 30.0
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    width        = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height       = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    start_frame  = max(0, int(start_sec * fps))
    end_frame    = min(total_frames - 1, int(end_sec * fps))

    yolo_class_id = resolve_to_yolo_class(target)
    if yolo_class_id is None:
        raise RuntimeError(
            f"'{target}' is not in the YOLO-80 vocabulary. "
            "Supported targets include: ball, person, bat, glove, etc."
        )

    model = _load_yolo()
    if model is None:
        raise RuntimeError("ultralytics not installed — run: pip install ultralytics")

    print(f"PROGRESS|object_detect_mode|yolo|class={yolo_class_id}|target={target}", flush=True)

    detections, last_confirmed_frame = _track_object(
        cap, model, yolo_class_id, width, height, fps,
        start_frame, end_frame, sample_every,
    )
    cap.release()
    return detections, fps, total_frames, width, height, last_confirmed_frame


# ---------------------------------------------------------------------------
# Interpolation + smoothing
# ---------------------------------------------------------------------------

def interpolate_positions(detections, start_frame, end_frame, fps: float = 30.0):
    """
    Fill every frame in [start_frame, end_frame] from sparse detections.
    Uses linear interpolation between known positions. When the object exits
    the frame early (last detection >= 1.5 s before end), holds for 0.5 s
    then eases back to centre.
    """
    n = end_frame - start_frame + 1

    if not detections:
        return np.full(n, 0.5), np.full(n, 0.5)

    idxs = np.array([d[0] for d in detections], dtype=float)
    cxs  = np.array([d[1] for d in detections], dtype=float)
    cys  = np.array([d[2] for d in detections], dtype=float)

    all_frames = np.arange(start_frame, end_frame + 1, dtype=float)
    xs = np.interp(all_frames, idxs, cxs, left=float(cxs[0]), right=float(cxs[-1]))
    ys = np.interp(all_frames, idxs, cys, left=float(cys[0]), right=float(cys[-1]))

    # Exit recovery: ease to centre when object has left the frame
    hold_frames   = int(fps * 0.5)
    ease_frames   = max(1, int(fps * 1.0))
    gap_threshold = hold_frames + ease_frames

    last_det_frame    = int(idxs[-1])
    frames_after_last = end_frame - last_det_frame

    if frames_after_last >= gap_threshold:
        ease_start = last_det_frame + hold_frames
        ease_end   = ease_start + ease_frames
        last_cx    = float(cxs[-1])
        last_cy    = float(cys[-1])
        print(f"PROGRESS|object_exited|last_det={last_det_frame}|easing_to_centre", flush=True)

        for abs_f in range(ease_start, end_frame + 1):
            i = abs_f - start_frame
            if i < 0 or i >= n:
                continue
            if abs_f <= ease_end:
                t = (abs_f - ease_start) / ease_frames
                t = t * t * (3.0 - 2.0 * t)  # smooth-step
                xs[i] = last_cx * (1.0 - t) + 0.5 * t
                ys[i] = last_cy * (1.0 - t) + 0.5 * t
            else:
                xs[i] = 0.5
                ys[i] = 0.5

    return np.clip(xs, 0.0, 1.0), np.clip(ys, 0.0, 1.0)


def smooth_positions(xs, ys, sigma=8.0):
    if _SCIPY_AVAILABLE:
        xs = gaussian_filter1d(xs, sigma=sigma)
        ys = gaussian_filter1d(ys, sigma=sigma)
    return np.clip(xs, 0.0, 1.0), np.clip(ys, 0.0, 1.0)


# ---------------------------------------------------------------------------
# Zoom curve
# ---------------------------------------------------------------------------

def ease_in_out(t):
    return t * t * (3.0 - 2.0 * t)


def build_zoom_curve(n_frames, zoom_target, ease_frames):
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
# FFmpeg helpers
# ---------------------------------------------------------------------------

def find_ffmpeg():
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
    raise RuntimeError("ffmpeg not found — make sure it is on PATH.")


def apply_zoom_opencv(input_path, output_path, start_sec, end_sec,
                      zoom_curve, xs, ys, width, height, fps, total_frames):
    """
    Per-frame face-tracked zoom via OpenCV + FFmpeg pipe.

    1. FFmpeg re-encodes the middle segment to a reliable temp file.
    2. OpenCV reads frames; per-frame crop+scale is piped into FFmpeg stdin
       which encodes video-only.
    3. FFmpeg muxes the encoded video with audio from the original.
    4. Before / after segments are copied and concatenated.
    """
    ffmpeg   = find_ffmpeg()
    tmpdir   = tempfile.mkdtemp()
    orig_dur = total_frames / fps

    seg_before     = os.path.join(tmpdir, 'before.mp4')
    seg_raw_mid    = os.path.join(tmpdir, 'mid_raw.mp4')
    seg_vid_only   = os.path.join(tmpdir, 'mid_vid.mp4')
    seg_middle     = os.path.join(tmpdir, 'mid.mp4')
    seg_after      = os.path.join(tmpdir, 'after.mp4')
    concat_list    = os.path.join(tmpdir, 'concat.txt')

    enc = ['-c:v', 'libx264', '-preset', 'fast', '-crf', '18',
           '-c:a', 'aac', '-b:a', '192k', '-ar', '44100']

    def run_ff(args):
        r = subprocess.run([ffmpeg] + args, capture_output=True, text=True)
        if r.returncode != 0:
            raise RuntimeError(f"FFmpeg failed:\n{r.stderr[-800:]}")

    # Step 1: extract middle segment video (re-encode for reliable seek)
    run_ff(['-y',
            '-ss', str(start_sec), '-to', str(end_sec),
            '-i', input_path,
            '-map', '0:v',
            '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18',
            seg_raw_mid])

    # Step 2: OpenCV per-frame crop+scale → pipe to FFmpeg stdin
    cap = cv2.VideoCapture(seg_raw_mid)
    seg_fps = cap.get(cv2.CAP_PROP_FPS) or fps
    n_zoom  = len(zoom_curve)

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

        fh, fw = frame.shape[:2]
        if fw != width or fh != height:
            frame = cv2.resize(frame, (width, height))

        idx = min(i, n_zoom - 1)
        z   = max(1.0, float(zoom_curve[idx]))
        cx  = float(xs[idx])
        cy  = float(ys[idx])

        crop_w = max(1, int(width  / z))
        crop_h = max(1, int(height / z))
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

    # Step 3: mux encoded video + audio from original
    run_ff(['-y',
            '-i', seg_vid_only,
            '-ss', str(start_sec), '-to', str(end_sec), '-i', input_path,
            '-map', '0:v', '-map', '1:a?',
            '-c:v', 'copy',
            '-c:a', 'aac', '-b:a', '192k', '-ar', '44100',
            seg_middle])

    # Step 4: before / after segments
    if start_sec > 0.05:
        run_ff(['-y', '-t', str(start_sec), '-i', input_path,
                '-map', '0:v', '-map', '0:a?'] + enc + [seg_before])

    if end_sec < orig_dur - 0.05:
        run_ff(['-y', '-ss', str(end_sec), '-i', input_path,
                '-map', '0:v', '-map', '0:a?'] + enc + [seg_after])

    # Step 5: concatenate
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

    if not os.path.exists(output_path) or os.path.getsize(output_path) < 1000:
        raise RuntimeError(f"Output file missing or empty: {output_path}")

    for f in [seg_before, seg_raw_mid, seg_vid_only, seg_middle, seg_after, concat_list]:
        try:
            if os.path.exists(f):
                os.unlink(f)
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

    _target = (target or 'face').lower().strip()
    is_face = _target in ('face', 'person', 'head', '')

    last_confirmed_frame = None

    if is_face:
        print("PROGRESS|detecting_faces|0", flush=True)
        detections, fps, total_frames, width, height = detect_faces_in_clip(
            input_path, start_sec, end_sec, sample_every=sample_every
        )
    else:
        print(f"PROGRESS|detecting_object|target={_target}", flush=True)
        detections, fps, total_frames, width, height, last_confirmed_frame = \
            detect_objects_in_clip(
                input_path, start_sec, end_sec, target=_target,
                sample_every=2  # objects always use dense sampling
            )

    print(f"PROGRESS|interpolating|30", flush=True)
    print(f"INFO|detections={len(detections)}", flush=True)

    start_frame = int(start_sec * fps)
    end_frame   = min(total_frames - 1, int(end_sec * fps))
    n_frames    = end_frame - start_frame + 1

    xs, ys = interpolate_positions(detections, start_frame, end_frame, fps=fps)

    # Light smoothing for objects (fast trajectory); heavier for faces
    smooth_sigma = fps * 0.05 if not is_face else fps * 0.25
    xs, ys = smooth_positions(xs, ys, sigma=smooth_sigma)

    ease_frames = int(ease_sec * fps)
    zoom_curve  = build_zoom_curve(n_frames, zoom_level, ease_frames)

    # For object tracking: if the object left the frame before the clip ends,
    # release the zoom back to 1.0x starting from that point.
    # This prevents the camera from staying zoomed in on whatever else is visible.
    if last_confirmed_frame is not None:
        release_start_abs = last_confirmed_frame + int(fps * 0.2)  # 0.2 s grace
        release_start     = release_start_abs - start_frame
        release_dur       = max(1, int(fps * 0.5))                 # 0.5 s ease-out
        if release_start < n_frames - 1:
            print(f"PROGRESS|zoom_release|at_frame={release_start_abs}", flush=True)
            for i in range(release_start, n_frames):
                local = i - release_start
                if local < release_dur:
                    t = local / release_dur
                    t = t * t * (3.0 - 2.0 * t)  # smooth-step
                    zoom_curve[i] = zoom_level * (1.0 - t) + 1.0 * t
                else:
                    zoom_curve[i] = 1.0

    print("PROGRESS|applying_zoom|60", flush=True)

    apply_zoom_opencv(
        input_path, output_path,
        start_sec, end_sec,
        zoom_curve, xs, ys,
        width, height, fps, total_frames
    )

    print("PROGRESS|done|100", flush=True)
    result = {
        "success": True,
        "output": output_path,
        "detections": len(detections),
        "zoom_level": zoom_level,
        "duration_sec": end_sec - start_sec,
    }
    print(f"RESULT|{json.dumps(result)}", flush=True)


def add_subparser(subparsers):
    p = subparsers.add_parser('face-zoom', help='Face / object tracking smooth zoom')
    p.add_argument('--input',        required=True)
    p.add_argument('--output',       required=True)
    p.add_argument('--start',        type=float, required=True)
    p.add_argument('--end',          type=float, required=True)
    p.add_argument('--zoom',         type=float, default=2.5)
    p.add_argument('--ease',         type=float, default=0.4)
    p.add_argument('--sample-every', type=int,   default=6)
    p.add_argument('--target',       type=str,   default='face',
                   help='What to zoom: face (default), ball, bat, bottle, etc.')
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
