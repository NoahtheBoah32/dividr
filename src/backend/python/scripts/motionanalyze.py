"""
Motion analysis for DiviDr.

Pipeline:
  1. Sample every Nth frame with MediaPipe Pose (Tasks API)
  2. Track 33 body landmarks per frame
  3. Compute joint velocities
  4. Detect events: punch, jump, high_energy
  5. Build energy timeline (1 value per second)
  6. Build speaker track (torso center per sampled frame)
  7. Output JSON to stdout via RESULT| prefix

Usage (via main.py):
  dividr-tools motion-analyze --input <file> [--detect punch,jump,energy,speaker]
      [--sample-every 3] [--output -]
"""

import json
import math
import os
import sys
import urllib.request

import cv2
import numpy as np


# ---------------------------------------------------------------------------
# MediaPipe landmark indices (Pose 33-point model)
# ---------------------------------------------------------------------------
_L_WRIST    = 15
_R_WRIST    = 16
_L_ELBOW    = 13
_R_ELBOW    = 14
_L_SHOULDER = 11
_R_SHOULDER = 12
_L_HIP      = 23
_R_HIP      = 24
_L_KNEE     = 25
_R_KNEE     = 26
_L_ANKLE    = 27
_R_ANKLE    = 28
_NOSE       = 0

_MODEL_URL = (
    'https://storage.googleapis.com/mediapipe-models/'
    'pose_landmarker/pose_landmarker_full/float16/latest/pose_landmarker_full.task'
)


def _get_model_path():
    script_dir = os.path.dirname(os.path.abspath(__file__))
    model_path = os.path.join(script_dir, 'pose_landmarker_full.task')
    if not os.path.exists(model_path):
        print('PROGRESS|motion_analyze|downloading_model', flush=True)
        urllib.request.urlretrieve(_MODEL_URL, model_path)
        print('PROGRESS|motion_analyze|model_ready', flush=True)
    return model_path


def _create_landmarker(model_path):
    try:
        from mediapipe.tasks import python
        from mediapipe.tasks.python import vision
        base_options = python.BaseOptions(model_asset_path=model_path)
        options = vision.PoseLandmarkerOptions(
            base_options=base_options,
            running_mode=vision.RunningMode.VIDEO,
            num_poses=1,
            min_pose_detection_confidence=0.5,
            min_pose_presence_confidence=0.5,
            min_tracking_confidence=0.5,
        )
        return vision.PoseLandmarker.create_from_options(options)
    except ImportError:
        print('ERROR|mediapipe not installed. Run: pip install mediapipe', file=sys.stderr)
        sys.exit(1)


def _lm(landmarks, idx):
    """Return (x, y, z, visibility) for landmark idx. x/y are 0-1 normalized."""
    lm = landmarks[idx]
    return lm.x, lm.y, lm.z, lm.visibility


def _dist2d(a, b):
    return math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2)


def _midpoint(a, b):
    return ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)


# ---------------------------------------------------------------------------
# Event detectors
# ---------------------------------------------------------------------------

def _detect_punches(frames_data, fps, sample_every):
    """
    Punch = wrist velocity spike (> 0.08 normalized/frame) while wrist is
    extending in front of the body (wrist_x further from center than elbow).
    Returns list of {frame, side, confidence}.
    """
    events = []
    prev = None
    for entry in frames_data:
        if prev is None:
            prev = entry
            continue

        for side, wrist_idx, elbow_idx, shoulder_idx in [
            ('left',  _L_WRIST, _L_ELBOW, _L_SHOULDER),
            ('right', _R_WRIST, _R_ELBOW, _R_SHOULDER),
        ]:
            wx, wy, _, wvis = _lm(entry['landmarks'], wrist_idx)
            ex, ey, _, evis = _lm(entry['landmarks'], elbow_idx)
            sx, sy, _, svis = _lm(entry['landmarks'], shoulder_idx)

            if min(wvis, evis, svis) < 0.5:
                continue

            pwx, pwy, _, _ = _lm(prev['landmarks'], wrist_idx)
            velocity = _dist2d((wx, wy), (pwx, pwy)) * fps / sample_every

            is_extending = _dist2d((wx, wy), (sx, sy)) > _dist2d((ex, ey), (sx, sy))
            if velocity > 0.08 * fps / 30 and is_extending:
                confidence = min(1.0, velocity / (0.20 * fps / 30))
                events.append({
                    'type': 'punch',
                    'frame': entry['frame'],
                    'side': side,
                    'confidence': round(confidence, 2),
                })

        prev = entry

    deduped = []
    last_frame = -9999
    for ev in sorted(events, key=lambda e: e['confidence'], reverse=True):
        if abs(ev['frame'] - last_frame) > fps * 0.5:
            deduped.append(ev)
            last_frame = ev['frame']
    return sorted(deduped, key=lambda e: e['frame'])


def _detect_jumps(frames_data, fps):
    """
    Jump = hip midpoint Y rises significantly above baseline then returns.
    (Y increases downward in normalized coords, so a jump = Y decreases.)
    """
    if len(frames_data) < 10:
        return []

    hip_ys = []
    for entry in frames_data:
        lhx, lhy, _, lhvis = _lm(entry['landmarks'], _L_HIP)
        rhx, rhy, _, rhvis = _lm(entry['landmarks'], _R_HIP)
        if min(lhvis, rhvis) > 0.4:
            hip_ys.append((lhy + rhy) / 2)

    if not hip_ys:
        return []

    baseline = float(np.median(hip_ys))
    threshold = 0.06

    events = []
    in_jump = False
    jump_start = 0
    min_y_val = baseline
    min_y_frame = 0

    for entry in frames_data:
        lhx, lhy, _, lhvis = _lm(entry['landmarks'], _L_HIP)
        rhx, rhy, _, rhvis = _lm(entry['landmarks'], _R_HIP)
        if min(lhvis, rhvis) < 0.4:
            continue

        hip_y = (lhy + rhy) / 2
        frame = entry['frame']

        if not in_jump and (baseline - hip_y) > threshold:
            in_jump = True
            jump_start = frame
            min_y_val = hip_y
            min_y_frame = frame
        elif in_jump:
            if hip_y < min_y_val:
                min_y_val = hip_y
                min_y_frame = frame
            if hip_y > baseline - threshold / 2:
                height = baseline - min_y_val
                confidence = min(1.0, height / 0.15)
                events.append({
                    'type': 'jump_peak',
                    'frame': min_y_frame,
                    'startFrame': jump_start,
                    'endFrame': frame,
                    'confidence': round(confidence, 2),
                })
                in_jump = False

    return events


def _energy_timeline(frames_data, fps, total_frames, sample_every):
    """
    Returns (timeline, events) where timeline is list of {second, score} (0-1).
    Computed from wrist + elbow velocity per second bucket.
    """
    ENERGY_JOINTS = [_L_WRIST, _R_WRIST, _L_ELBOW, _R_ELBOW]

    buckets: dict = {}
    prev = None

    for entry in frames_data:
        if prev is None:
            prev = entry
            continue

        second = int(entry['frame'] / fps)
        velocities = []
        for idx in ENERGY_JOINTS:
            cx, cy, _, cvis = _lm(entry['landmarks'], idx)
            px, py, _, pvis = _lm(prev['landmarks'], idx)
            if min(cvis, pvis) > 0.4:
                v = _dist2d((cx, cy), (px, py)) * fps / sample_every
                velocities.append(v)

        if velocities:
            buckets.setdefault(second, []).append(float(np.mean(velocities)))
        prev = entry

    if not buckets:
        return [], []

    scores = {sec: float(np.mean(vals)) for sec, vals in buckets.items()}
    max_score = max(scores.values()) if scores else 1.0
    if max_score == 0:
        max_score = 1.0

    total_seconds = int(total_frames / fps) + 1
    timeline = []
    for sec in range(total_seconds):
        raw = scores.get(sec, 0.0)
        timeline.append({'second': sec, 'score': round(raw / max_score, 3)})

    events = []
    run_start = None
    for item in timeline:
        if item['score'] >= 0.7:
            if run_start is None:
                run_start = item['second']
        else:
            if run_start is not None and item['second'] - run_start >= 2:
                events.append({
                    'type': 'high_energy',
                    'startFrame': int(run_start * fps),
                    'endFrame': int(item['second'] * fps),
                    'score': round(
                        float(np.mean([t['score'] for t in timeline
                                       if run_start <= t['second'] < item['second']])), 2
                    ),
                })
            run_start = None

    return timeline, events


def _speaker_track(frames_data, fps):
    """Returns list of {frame, cx, cy} — torso center per sampled frame."""
    track = []
    for entry in frames_data:
        lsx, lsy, _, lsvis = _lm(entry['landmarks'], _L_SHOULDER)
        rsx, rsy, _, rsvis = _lm(entry['landmarks'], _R_SHOULDER)
        lhx, lhy, _, lhvis = _lm(entry['landmarks'], _L_HIP)
        rhx, rhy, _, rhvis = _lm(entry['landmarks'], _R_HIP)

        visible = [v > 0.5 for v in [lsvis, rsvis, lhvis, rhvis]]
        if sum(visible) < 2:
            continue

        points = []
        if lsvis > 0.5: points.append((lsx, lsy))
        if rsvis > 0.5: points.append((rsx, rsy))
        if lhvis > 0.5: points.append((lhx, lhy))
        if rhvis > 0.5: points.append((rhx, rhy))

        cx = float(np.mean([p[0] for p in points]))
        cy = float(np.mean([p[1] for p in points]))
        track.append({'frame': entry['frame'], 'cx': round(cx, 3), 'cy': round(cy, 3)})

    return track


# ---------------------------------------------------------------------------
# Main runner
# ---------------------------------------------------------------------------

def run(input_path: str, detect: list, sample_every: int = 3):
    import mediapipe as mp

    model_path = _get_model_path()

    cap = cv2.VideoCapture(input_path)
    if not cap.isOpened():
        print(f'ERROR|Cannot open video: {input_path}', file=sys.stderr)
        sys.exit(1)

    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))

    print(f'PROGRESS|motion_analyze|fps={fps:.1f}|total_frames={total_frames}', flush=True)

    frames_data = []

    with _create_landmarker(model_path) as landmarker:
        frame_idx = 0
        while True:
            ret, frame = cap.read()
            if not ret:
                break

            if frame_idx % sample_every == 0:
                rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
                timestamp_ms = int(frame_idx * 1000 / fps)
                result = landmarker.detect_for_video(mp_image, timestamp_ms)

                if result.pose_landmarks:
                    frames_data.append({
                        'frame': frame_idx,
                        'landmarks': result.pose_landmarks[0],
                    })

                if frame_idx % (sample_every * 30) == 0:
                    pct = int(frame_idx / total_frames * 100) if total_frames > 0 else 0
                    print(f'PROGRESS|motion_analyze|frame={frame_idx}|pct={pct}', flush=True)

            frame_idx += 1

    cap.release()

    if not frames_data:
        print('PROGRESS|motion_analyze|no_pose_detected', flush=True)
        output = {'events': [], 'energyTimeline': [], 'speakerTrack': []}
        print(f'RESULT|{json.dumps(output)}', flush=True)
        return

    all_events = []

    if 'punch' in detect:
        punches = _detect_punches(frames_data, fps, sample_every)
        all_events.extend(punches)
        print(f'PROGRESS|motion_analyze|punches={len(punches)}', flush=True)

    if 'jump' in detect:
        jumps = _detect_jumps(frames_data, fps)
        all_events.extend(jumps)
        print(f'PROGRESS|motion_analyze|jumps={len(jumps)}', flush=True)

    energy_timeline = []
    if 'energy' in detect:
        energy_timeline, energy_events = _energy_timeline(frames_data, fps, total_frames, sample_every)
        all_events.extend(energy_events)
        print(f'PROGRESS|motion_analyze|energy_events={len(energy_events)}', flush=True)

    speaker_track = []
    if 'speaker' in detect:
        speaker_track = _speaker_track(frames_data, fps)
        print(f'PROGRESS|motion_analyze|speaker_track_points={len(speaker_track)}', flush=True)

    all_events.sort(key=lambda e: e.get('frame', e.get('startFrame', 0)))

    def _sanitize(obj):
        """Recursively replace NaN/Inf with 0 so json.dumps never emits invalid tokens."""
        if isinstance(obj, float):
            return 0.0 if not math.isfinite(obj) else obj
        if isinstance(obj, dict):
            return {k: _sanitize(v) for k, v in obj.items()}
        if isinstance(obj, list):
            return [_sanitize(v) for v in obj]
        return obj

    # Compact per-frame landmark array for real-time overlay visualization
    pose_landmarks_output = [
        {
            'frame': entry['frame'],
            'lm': [
                [round(lm.x, 4), round(lm.y, 4), round(lm.visibility, 2)]
                for lm in entry['landmarks']
            ],
        }
        for entry in frames_data
    ]

    output = _sanitize({
        'events': all_events,
        'energyTimeline': energy_timeline,
        'speakerTrack': speaker_track,
        'fps': fps,
        'totalFrames': total_frames,
        'poseLandmarks': pose_landmarks_output,
    })

    print(f'RESULT|{json.dumps(output)}', flush=True)


def handle_args(args):
    detect = [d.strip() for d in (args.detect or 'punch,jump,energy,speaker').split(',')]
    run(args.input, detect=detect, sample_every=args.sample_every)
