"""
Skeleton overlay renderer for DiviDr.
Draws MediaPipe Pose landmarks (bones + joints) on each frame and saves as video.

Usage (via main.py):
  dividr-tools skeleton-render --input <file> --output <file>
"""

import json
import math
import os
import sys
import urllib.request

import cv2
import numpy as np

_MODEL_URL = (
    'https://storage.googleapis.com/mediapipe-models/'
    'pose_landmarker/pose_landmarker_full/float16/latest/pose_landmarker_full.task'
)

# BlazePose 33-landmark connections (parent → child pairs)
_POSE_CONNECTIONS = [
    (0, 1), (1, 2), (2, 3), (3, 7),          # right face edge
    (0, 4), (4, 5), (5, 6), (6, 8),          # left face edge
    (9, 10),                                   # mouth
    (11, 12),                                  # shoulders
    (11, 13), (13, 15),                        # left arm
    (15, 17), (17, 19), (19, 15), (15, 21),   # left hand
    (12, 14), (14, 16),                        # right arm
    (16, 18), (18, 20), (20, 16), (16, 22),   # right hand
    (11, 23), (12, 24),                        # torso sides
    (23, 24),                                  # hips
    (23, 25), (25, 27), (27, 29), (29, 31), (31, 27),  # left leg
    (24, 26), (26, 28), (28, 30), (30, 32), (32, 28),  # right leg
]

# Joint colors by body region (BGR)
_JOINT_COLORS = {
    'face':     (180, 255, 180),   # light green
    'arm_l':    (0,   200, 255),   # cyan
    'arm_r':    (255, 200, 0),     # amber
    'torso':    (255, 255, 255),   # white
    'leg_l':    (120, 100, 255),   # purple
    'leg_r':    (255, 100, 180),   # pink
}

_IDX_REGION = {
    0: 'face', 1: 'face', 2: 'face', 3: 'face', 4: 'face',
    5: 'face', 6: 'face', 7: 'face', 8: 'face', 9: 'face', 10: 'face',
    11: 'torso', 12: 'torso',
    13: 'arm_l', 15: 'arm_l', 17: 'arm_l', 19: 'arm_l', 21: 'arm_l',
    14: 'arm_r', 16: 'arm_r', 18: 'arm_r', 20: 'arm_r', 22: 'arm_r',
    23: 'torso', 24: 'torso',
    25: 'leg_l', 27: 'leg_l', 29: 'leg_l', 31: 'leg_l',
    26: 'leg_r', 28: 'leg_r', 30: 'leg_r', 32: 'leg_r',
}
_BONE_COLOR = (0, 255, 80)   # neon green for all bones


def _get_model_path():
    script_dir = os.path.dirname(os.path.abspath(__file__))
    model_path = os.path.join(script_dir, 'pose_landmarker_full.task')
    if not os.path.exists(model_path):
        print('PROGRESS|skeleton_render|downloading_model', flush=True)
        urllib.request.urlretrieve(_MODEL_URL, model_path)
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
        print('ERROR|mediapipe not installed', file=sys.stderr)
        sys.exit(1)


def _draw_skeleton(frame, landmarks, w, h):
    """Draw bones and joints onto frame in-place."""
    # Convert normalised coords → pixel coords
    pts = []
    for lm in landmarks:
        px = int(lm.x * w)
        py = int(lm.y * h)
        pts.append((px, py, lm.visibility))

    overlay = frame.copy()

    # Draw bones
    for a, b in _POSE_CONNECTIONS:
        if a >= len(pts) or b >= len(pts):
            continue
        if pts[a][2] < 0.3 or pts[b][2] < 0.3:
            continue
        cv2.line(overlay, (pts[a][0], pts[a][1]), (pts[b][0], pts[b][1]),
                 _BONE_COLOR, 3, cv2.LINE_AA)

    # Draw joints
    for idx, (px, py, vis) in enumerate(pts):
        if vis < 0.3:
            continue
        color = _IDX_REGION.get(idx, 'torso')
        color_bgr = _JOINT_COLORS.get(color, (255, 255, 255))
        # Outer glow
        cv2.circle(overlay, (px, py), 8, (0, 0, 0), -1, cv2.LINE_AA)
        cv2.circle(overlay, (px, py), 6, color_bgr, -1, cv2.LINE_AA)

    # Alpha blend: 0.45 original + 0.55 overlay → skeleton pops but footage visible
    cv2.addWeighted(overlay, 0.65, frame, 0.35, 0, frame)


def run(input_path: str, output_path: str):
    import mediapipe as mp

    model_path = _get_model_path()

    cap = cv2.VideoCapture(input_path)
    if not cap.isOpened():
        print(f'ERROR|Cannot open: {input_path}', file=sys.stderr)
        sys.exit(1)

    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))

    print(f'PROGRESS|skeleton_render|fps={fps:.1f}|frames={total}|size={w}x{h}', flush=True)

    # Write to a temp file first, then move (avoids partial reads)
    tmp_out = output_path + '.tmp.mp4'
    fourcc = cv2.VideoWriter_fourcc(*'mp4v')
    writer = cv2.VideoWriter(tmp_out, fourcc, fps, (w, h))

    with _create_landmarker(model_path) as landmarker:
        frame_idx = 0
        while True:
            ret, frame = cap.read()
            if not ret:
                break

            rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
            timestamp_ms = int(frame_idx * 1000 / fps)
            result = landmarker.detect_for_video(mp_image, timestamp_ms)

            if result.pose_landmarks:
                _draw_skeleton(frame, result.pose_landmarks[0], w, h)

            writer.write(frame)

            if frame_idx % 30 == 0:
                pct = int(frame_idx / total * 100) if total > 0 else 0
                print(f'PROGRESS|skeleton_render|frame={frame_idx}|pct={pct}', flush=True)

            frame_idx += 1

    cap.release()
    writer.release()

    # Re-encode with ffmpeg for browser compatibility (mp4v → h264)
    import subprocess
    ffmpeg_result = subprocess.run(
        ['ffmpeg', '-y', '-i', tmp_out, '-c:v', 'libx264', '-preset', 'fast',
         '-crf', '23', '-movflags', '+faststart', output_path],
        capture_output=True
    )
    if ffmpeg_result.returncode == 0 and os.path.exists(output_path):
        os.remove(tmp_out)
    else:
        # ffmpeg not available or failed — use raw mp4v output
        import shutil
        shutil.move(tmp_out, output_path)

    print(f'RESULT|{json.dumps({"outputPath": output_path})}', flush=True)


def handle_args(args):
    run(args.input, args.output)
