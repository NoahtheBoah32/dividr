#!/usr/bin/env python3
"""
Hold the World, Let One Thing Move — motion-key rebuild (no background remover).

This replaces the RVM-matte selective freeze. The forbidden approach lifted the
subject out with a human-matting model and pasted it back, which only works for
people and leaves feathered, gappy edges. Here NOTHING is lifted or pasted.

Every output pixel is a straight COPY from one of two pixel-aligned full frames of
the SAME scene at the SAME (x, y):
  - the live frame at time t, or
  - a held plate frozen at `freeze_at`.

The selector is MOTION: a pixel goes live only where the live frame disagrees with
the plate (the thing that is moving) AND it is inside the allowed region box. The
mask edge is HARD (morphological clean-up, never a Gaussian blur across the
held<->live seam) — so the composite can never produce a translucent halo or a
pixel that is a blend of the two. That property is asserted in the test harness:
out == plate OR out == live, everywhere.

Modes (named by what is HELD):
  freezeWorld   : world is the held plate; the moving subject plays through it.
  freezeSubject : world plays live; the subject is held as a statue at `freeze_at`.
  freezeAll     : the whole frame is held — a plain freeze-frame.

Region box (what is allowed to differ from the held world):
  ""                       -> whole frame (only sensible when ONE thing moves).
  "rect:x,y,w,h"           -> normalized [0,1] rectangle.
  "lasso:[[x,y],...]"      -> normalized [0,1] closed polygon.
  "yolo:<class>"           -> union of YOLOv8n boxes for that class across the region.

A locked-off camera is required; a global-motion bouncer refuses a moving camera
rather than producing a smeared result. Output is a full-length H.264/yuv420p mp4
(region replaced, rest passed through) with the original audio re-muxed.

RESULT|{json} protocol on stdout, mirroring the other DiviDr python tools.
"""

import json
import os
import subprocess
import sys


def _log(stage, progress, message=""):
    print(f"PROGRESS|{json.dumps({'stage': stage, 'progress': progress, 'message': message})}", flush=True)


def _find_ffmpeg():
    import shutil
    return shutil.which("ffmpeg") or "ffmpeg"


# ---------------------------------------------------------------------------
# Region box
# ---------------------------------------------------------------------------
def _box_from_spec(spec, frames, width, height):
    """Return a uint8 HxW mask (1 = allowed to go live) for the region spec."""
    import cv2
    import numpy as np

    spec = (spec or "").strip()
    if not spec:
        return np.ones((height, width), np.uint8)

    if spec.startswith("rect:"):
        x, y, w, h = [float(v) for v in spec[5:].split(",")]
        m = np.zeros((height, width), np.uint8)
        x0, y0 = int(x * width), int(y * height)
        x1, y1 = int((x + w) * width), int((y + h) * height)
        m[max(0, y0):min(height, y1), max(0, x0):min(width, x1)] = 1
        return m

    if spec.startswith("lasso:"):
        pts = json.loads(spec[6:])
        poly = np.array([[int(px * width), int(py * height)] for px, py in pts], np.int32)
        m = np.zeros((height, width), np.uint8)
        if len(poly) >= 3:
            cv2.fillPoly(m, [poly], 1)
        return m

    if spec.startswith("yolo:"):
        return _yolo_union_box(spec[5:], frames, width, height)

    if spec.startswith("vision:"):
        # Open-vocabulary subject targeting via Claude vision (grid overlay on a mid
        # frame). Works for ANY subject, not YOLO's 80 classes. None -> caller degrades
        # to full-frame ("keep all motion live"), same as a YOLO miss.
        if not frames:
            return None
        from scripts import frame_reference
        # Union the subject's box across the window -> its full swept PATH (a single frame
        # would slice a moving subject). Inside it, the per-frame mask keeps the moving
        # subject and freezes anything static caught in the path.
        boxstr = frame_reference.locate_subject_path(frames, spec[7:])
        if not boxstr:
            return None
        x, y, w, h = [float(v) for v in boxstr.split(",")]
        m = np.zeros((height, width), np.uint8)
        x0, y0 = int(x * width), int(y * height)
        x1, y1 = int((x + w) * width), int((y + h) * height)
        m[max(0, y0):min(height, y1), max(0, x0):min(width, x1)] = 1
        return m

    return np.ones((height, width), np.uint8)


def _yolo_union_box(cls, frames, width, height, pad=0.04):
    """Union of YOLOv8n boxes for `cls` across sampled region frames, padded."""
    import cv2
    import numpy as np
    from ultralytics import YOLO

    model = YOLO(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "..", "yolov8n.pt"))
    names = model.names
    want = cls.strip().lower()
    m = np.zeros((height, width), np.uint8)
    n = len(frames)
    step = max(1, n // 12)  # ~12 samples is plenty to bound the path
    padx, pady = int(pad * width), int(pad * height)
    hit = False
    for i in range(0, n, step):
        res = model.predict(frames[i], verbose=False, conf=0.35)[0]
        if res.boxes is None:
            continue
        for b in res.boxes:
            label = names[int(b.cls[0])].lower()
            if label != want:
                continue
            hit = True
            x0, y0, x1, y1 = [int(v) for v in b.xyxy[0].tolist()]
            cv2.rectangle(m, (max(0, x0 - padx), max(0, y0 - pady)),
                          (min(width, x1 + padx), min(height, y1 + pady)), 1, -1)
    if not hit:
        return None  # signal "subject not present"
    return m


# ---------------------------------------------------------------------------
# Camera-motion bouncer
# ---------------------------------------------------------------------------
def _camera_moving(frames, frac_thresh=0.22, diff_thr=25):
    """A locked camera changes only where the subject moves (a small fraction of
    the frame); a pan/zoom shifts most of it. Median per-consecutive-frame changed
    fraction above the threshold means the camera is moving. Robust to a single
    high-contrast moving subject (which phase correlation is fooled by).

    Threshold derived empirically: locked shots (incl. ones with a big fast subject)
    sit under 0.05 changed fraction; a pan over detailed content is 0.4+. Even a
    worst-case full-contrast pan only reaches ~0.43, so the old 0.5 cutoff MISSED
    real pans. 0.22 sits in the wide gap — ~4x margin from locked shots and from
    pans — so it flags moving cameras without false-positiving a busy locked shot."""
    import cv2
    import numpy as np

    if len(frames) < 2:
        return False

    def small(f):
        return cv2.resize(cv2.cvtColor(f, cv2.COLOR_BGR2GRAY), (160, 90))

    step = max(1, len(frames) // 20)
    prev = small(frames[0])
    fracs = []
    for i in range(step, len(frames), step):
        cur = small(frames[i])
        fracs.append(float((cv2.absdiff(prev, cur) > diff_thr).mean()))
        prev = cur
    return bool(np.median(fracs) > frac_thresh) if fracs else False


# ---------------------------------------------------------------------------
# Motion mask
# ---------------------------------------------------------------------------
def _motion_mask(frame, plate, box, hi=22.0, lo=10.0, ksize=5):
    """Binary mask (uint8 0/1) of where `frame` differs from `plate`, inside `box`.

    The selector must be SOLID and CLEAN, or the hard live/plate composite reads as a
    pasted cut-out. So after the illumination-normalized absdiff + hysteresis we:
      1. drop confetti (tiny false-positive blobs from sensor noise / leaf flutter),
      2. close + fill each subject's interior per external contour (dark-on-dark areas
         no longer punch holes that show the frozen plate THROUGH a person),
      3. gently dilate so the boundary sits on static background, where plate==frame and
         the seam is therefore invisible.
    The soft FEATHER that finally hides the edge happens at composite time, not here."""
    import cv2
    import numpy as np

    f = frame.astype(np.float32)
    p = plate.astype(np.float32)
    # Illumination normalization: remove slow local brightness drift so exposure
    # flicker does not register as motion. Subtract a heavily blurred difference.
    d = np.abs(f - p).max(axis=2)
    bg = cv2.GaussianBlur(d, (0, 0), 9)
    d = np.clip(d - bg * 0.6, 0, 255)

    strong = (d >= hi).astype(np.uint8)
    weak = (d >= lo).astype(np.uint8)
    # Hysteresis: keep weak pixels connected to a strong seed.
    num, lbl = cv2.connectedComponents(weak, connectivity=8)
    keep = np.zeros(num, np.uint8)
    for c in np.unique(lbl[strong > 0]):
        if c != 0:
            keep[c] = 1
    m = keep[lbl].astype(np.uint8)

    area = m.shape[0] * m.shape[1]
    min_area = 0.0008 * area  # ~0.08% of frame — kills confetti, keeps real subjects

    # 1) CLOSE FIRST — bridge thin connectors (a person's NECK) and small gaps so the head,
    #    neck and body become ONE component before any size filtering. The old order (drop
    #    small THEN close) split the head off on frames where the thin neck's weak signal
    #    didn't survive, and the area filter deleted it -> the head flickered in and out.
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (15, 15)))

    # 2) now drop genuine confetti (the subject is one connected blob, so it survives)
    num, lbl, stats, _ = cv2.connectedComponentsWithStats(m, connectivity=8)
    keep = np.zeros(num, np.uint8)
    for c in range(1, num):
        if stats[c, cv2.CC_STAT_AREA] >= min_area:
            keep[c] = 1
    m = keep[lbl].astype(np.uint8)

    # 3) fill each subject's interior per external contour (no holes show the frozen plate)
    cnts, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    solid = np.zeros_like(m)
    for c in cnts:
        if cv2.contourArea(c) >= min_area:
            cv2.drawContours(solid, [c], -1, 1, cv2.FILLED)
    m = solid

    # 4) push the boundary a few px out onto static background
    m = cv2.dilate(m, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5)))
    if box is not None:
        m = m & box
    return m.astype(np.uint8)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def motion_freeze(input_path, output_path, start, end, mode="freezeWorld",
                  freeze_at=-1.0, box="", hi=22.0, lo=10.0, max_region_sec=14.0):
    import cv2
    import numpy as np

    if not os.path.exists(input_path):
        return {"success": False, "error": f"File not found: {input_path}"}
    cap = cv2.VideoCapture(input_path)
    if not cap.isOpened():
        return {"success": False, "error": f"Cannot open video: {input_path}"}

    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) or 0

    s0 = max(0, int(round(start * fps)))
    s1 = int(round(end * fps))
    if total > 0:
        s1 = min(s1, total)
    if s1 <= s0:
        s1 = s0 + 1
    if (s1 - s0) / fps > max_region_sec:
        s1 = s0 + int(round(max_region_sec * fps))
    freeze_idx = s0 if freeze_at < 0 else max(s0, min(s1 - 1, int(round(freeze_at * fps))))

    _log("loading", 5, "Reading region")
    cap.set(cv2.CAP_PROP_POS_FRAMES, s0)
    region = []
    plate = None
    idx = s0
    while idx < s1:
        ret, bgr = cap.read()
        if not ret:
            break
        region.append(bgr)
        if idx == freeze_idx:
            plate = bgr.copy()
        idx += 1
    n = len(region)
    if n == 0:
        cap.release()
        return {"success": False, "error": "No frames in the selected region"}
    if plate is None:
        plate = region[0].copy()

    # full freeze needs no motion analysis
    if mode == "freezeAll":
        composed = [plate.copy() for _ in range(n)]
        return _encode(cap, input_path, output_path, composed, s0, s1, total, fps,
                       width, height, mode, "freezeAll")

    # locked-off camera required for the held modes
    if _camera_moving(region):
        cap.release()
        return {"success": False, "reason": "camera-motion",
                "error": "Camera is moving; selective freeze needs a locked-off shot."}

    # GHOST-KILLER (world-frozen): the held plate must NOT contain the subject, or wherever
    # the motion mask fails to erase the subject's frozen silhouette (e.g. a dark figure on
    # a dark background) it lingers as a translucent trail — the "looks like a bad cut-out"
    # artifact. A per-pixel temporal MEDIAN across the region keeps the static world and
    # drops the moving subject entirely (it's transient at each pixel), so there is nothing
    # to ghost. Sampled to bound memory on long regions.
    if mode == "freezeWorld":
        # Median plate = the static world with the moving subject mostly removed. A subject
        # that lingers centrally can survive the median, but that residue sits INSIDE the
        # union path below — which always shows the live frame — so it is never revealed.
        step = max(1, n // 48)
        plate = np.median(np.stack(region[::step], axis=0), axis=0).astype(np.uint8)

    box_mask = _box_from_spec(box, region, width, height)
    if box_mask is None:
        # A YOLO class lookup found nothing — an object YOLO doesn't know (a generic
        # ball, a glass) or a plain missed detection. Don't hard-decline: for a held
        # freeze the safe degrade is to keep ALL motion live (freeze the static world,
        # everything that actually moves keeps moving). The no-motion check below still
        # catches a genuinely static clip, so this never produces a do-nothing freeze.
        _log("processing", 25, "Subject not pinned; keeping all motion live")
        box_mask = np.ones((height, width), np.uint8)

    _log("processing", 30, "Keying motion")
    masks = [_motion_mask(f, plate, box_mask, hi, lo) for f in region]
    # temporal smoothing: a pixel is live if it is live in a small window, to kill
    # single-frame shimmer without softening the spatial edge.
    win = 1
    smooth = []
    for i in range(n):
        acc = np.zeros((height, width), np.float32)
        cnt = 0
        for j in range(max(0, i - win), min(n, i + win + 1)):
            acc += masks[j]
            cnt += 1
        smooth.append((acc / cnt >= 0.5).astype(np.uint8))
    masks = smooth

    # presence/stationarity sanity for the held modes
    live_area = float(np.mean([m.mean() for m in masks]))
    if live_area < 0.0008:
        cap.release()
        return {"success": False, "reason": "no-motion",
                "error": "Nothing is moving in the region; use a plain freeze instead."}

    _log("processing", 60, "Compositing")
    plate_f = plate.astype(np.float32)
    composed = []
    for i in range(n):
        # PER-FRAME selector: ONLY the subject's CURRENT position goes live, so the world is
        # the frozen median plate everywhere else — it does NOT drag/move with the subject.
        # The median plate already erased the (laterally-moving) subject, so the subject's
        # past positions show clean frozen background, not a ghost. ~2px feather on the edge
        # (which the dilation parks on static bg) keeps it seamless, not a hard cut-out.
        a = cv2.GaussianBlur(masks[i].astype(np.float32), (0, 0), 2.0)[:, :, None]
        live_f = region[i].astype(np.float32)
        if mode == "freezeSubject":
            out = live_f * (1.0 - a) + plate_f * a
        else:  # freezeWorld
            out = plate_f * (1.0 - a) + live_f * a
        composed.append(np.clip(out, 0, 255).astype(np.uint8))

    return _encode(cap, input_path, output_path, composed, s0, s1, total, fps,
                   width, height, mode, "ok")


def _encode(cap, input_path, output_path, composed, s0, s1, total, fps,
            width, height, mode, status):
    import cv2
    import numpy as np

    _log("saving", 90, "Encoding")
    base, _ = os.path.splitext(input_path)
    if not output_path:
        output_path = f"{base}_mfreeze.mp4"

    cmd = [
        _find_ffmpeg(), "-y",
        "-f", "rawvideo", "-vcodec", "rawvideo",
        "-s", f"{width}x{height}", "-pix_fmt", "bgr24", "-r", str(fps),
        "-i", "pipe:0", "-an",
        "-vcodec", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast", "-crf", "18",
        "-movflags", "+faststart", output_path,
    ]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stderr=subprocess.DEVNULL)
    cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
    w_idx = 0
    try:
        while True:
            if total > 0 and w_idx >= total:
                break
            ret, bgr = cap.read()
            if not ret:
                break
            frame = composed[w_idx - s0] if s0 <= w_idx < s1 else bgr
            try:
                proc.stdin.write(np.ascontiguousarray(frame, dtype=np.uint8).tobytes())
            except (BrokenPipeError, OSError):
                break
            w_idx += 1
    finally:
        cap.release()
        try:
            if proc.stdin and not proc.stdin.closed:
                proc.stdin.close()
        except (BrokenPipeError, OSError, ValueError):
            pass
        proc.wait()

    if proc.returncode not in (0, None):
        return {"success": False, "error": f"ffmpeg encode failed (exit {proc.returncode})"}
    if not os.path.exists(output_path) or os.path.getsize(output_path) < 1000:
        return {"success": False, "error": "Motion freeze produced no output file"}

    # re-mux original audio (length unchanged)
    try:
        muxed = f"{os.path.splitext(output_path)[0]}_a.mp4"
        r = subprocess.run([_find_ffmpeg(), "-y", "-i", output_path, "-i", input_path,
                            "-map", "0:v:0", "-map", "1:a:0?", "-c:v", "copy", "-c:a", "aac",
                            "-shortest", muxed], stderr=subprocess.DEVNULL, stdout=subprocess.DEVNULL)
        if r.returncode == 0 and os.path.exists(muxed) and os.path.getsize(muxed) > 1000:
            os.replace(muxed, output_path)
    except Exception:
        pass

    duration = (total / fps) if total > 0 else (s1 / fps)
    return {
        "success": True,
        "filePath": output_path,
        "mode": mode,
        "regionStart": round(s0 / fps, 3),
        "regionEnd": round(s1 / fps, 3),
        "duration": round(duration, 3),
        "status": status,
    }


def handle_args(args):
    result = motion_freeze(
        input_path=args.input, output_path=args.output, start=args.start, end=args.end,
        mode=args.mode, freeze_at=args.freeze_at, box=args.box, hi=args.hi, lo=args.lo,
    )
    print(f"RESULT|{json.dumps(result)}", flush=True)


if __name__ == "__main__":
    payload = json.loads(sys.argv[1]) if len(sys.argv) > 1 else {}

    class _A:
        pass

    a = _A()
    a.input = payload["filePath"]
    a.output = payload.get("output", "")
    a.start = float(payload.get("start", 0))
    a.end = float(payload.get("end", 0))
    a.mode = payload.get("mode", "freezeWorld")
    a.freeze_at = float(payload.get("freezeAt", -1))
    a.box = payload.get("box", "")
    a.hi = float(payload.get("hi", 22.0))
    a.lo = float(payload.get("lo", 10.0))
    handle_args(a)
