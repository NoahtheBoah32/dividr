#!/usr/bin/env python3
"""
Speed that lives inside the clip, not on it.

Brush a region of the frame and ONLY that region runs at a different speed — the
waterfall crawls while the kid beside it runs real-time, one shot, no splitting,
no layers. You are painting multiple speeds into a single frame.

Region-locked, NO subject cut-out. The mask is a stationary stencil in source-frame
coordinates; every output frame is one in-place composite (retimed region over the
real-time passthrough). Nothing is ever lifted out of its frame and re-pasted — that
forbidden RVM "subject" path is gone. To retime a subject that travels across the
frame, use `invert`: keep the subject real-time and slow the COMPLEMENT of a drawn
region (the backdrop), which never leaves its own pixels.

Seamless: in-region slow-motion is motion-compensated with optical flow (no
frame-dupe stutter), and the region boundary is alpha-feathered. Cleanest when the
brushed boundary sits in low-motion content (the gap between the two things).

Outputs a full-length H.264 mp4; the [start,end] region carries the effect, the rest
of the clip passes through untouched. RESULT|{json} on stdout.
"""

import json
import os
import subprocess
import sys


def _log_progress(stage, progress, message=""):
    print(f"PROGRESS|{json.dumps({'stage': stage, 'progress': progress, 'message': message})}", flush=True)


def _find_ffmpeg():
    import shutil
    return shutil.which("ffmpeg") or "ffmpeg"


def _build_region_mask(region: str, w: int, h: int, feather: int):
    """Return a HxW float32 mask (0..1), feathered. Accepts:
      "x,y,w,h"             normalized rectangle (0..1)
      "ellipse:cx,cy,rx,ry" normalized ellipse (0..1)
      "lasso:[[x,y],...]"   normalized closed polygon (0..1)
    """
    import cv2
    import numpy as np
    mask = np.zeros((h, w), np.float32)
    try:
        if region.startswith("ellipse:"):
            cx, cy, rx, ry = [float(v) for v in region[len("ellipse:"):].split(",")]
            cv2.ellipse(mask, (int(cx * w), int(cy * h)), (int(rx * w), int(ry * h)), 0, 0, 360, 1.0, -1)
        elif region.startswith("lasso:"):
            pts = json.loads(region[len("lasso:"):])
            poly = np.array([[int(px * w), int(py * h)] for px, py in pts], np.int32)
            if len(poly) >= 3:
                cv2.fillPoly(mask, [poly], 1.0)
        else:
            x, y, rw, rh = [float(v) for v in region.split(",")]
            x0, y0 = int(x * w), int(y * h)
            x1, y1 = int((x + rw) * w), int((y + rh) * h)
            mask[max(0, y0):min(h, y1), max(0, x0):min(w, x1)] = 1.0
    except Exception:
        # default: centered horizontal band
        mask[int(h * 0.25):int(h * 0.75), :] = 1.0
    if feather > 0:
        k = feather * 2 + 1
        mask = cv2.GaussianBlur(mask, (k, k), 0)
    return mask


def _flow_interp(a, b, f, flow_fwd=None):
    """Motion-compensated interpolation between BGR frames a and b at fraction f
    (0..1). Warps a forward and b backward along Farneback flow and blends."""
    import cv2
    import numpy as np
    if f <= 0:
        return a
    if f >= 1:
        return b
    ga = cv2.cvtColor(a, cv2.COLOR_BGR2GRAY)
    gb = cv2.cvtColor(b, cv2.COLOR_BGR2GRAY)
    if flow_fwd is None:
        flow_fwd = cv2.calcOpticalFlowFarneback(ga, gb, None, 0.5, 3, 21, 3, 5, 1.2, 0)
    h, w = ga.shape
    gx, gy = np.meshgrid(np.arange(w, dtype=np.float32), np.arange(h, dtype=np.float32))
    # a warped forward by f
    mapxa = gx + flow_fwd[..., 0] * f
    mapya = gy + flow_fwd[..., 1] * f
    wa = cv2.remap(a, mapxa, mapya, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT)
    # b warped backward by (1-f)
    mapxb = gx - flow_fwd[..., 0] * (1.0 - f)
    mapyb = gy - flow_fwd[..., 1] * (1.0 - f)
    wb = cv2.remap(b, mapxb, mapyb, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT)
    return cv2.addWeighted(wa, 1.0 - f, wb, f, 0)


def regional_speed(input_path, output_path, start, end, speed=0.5, region="0,0,1,1",
                   feather=24, invert=False, smooth=True, max_region_sec=14.0):
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
    if total:
        s1 = min(s1, total)
    if s1 <= s0:
        s1 = s0 + 1
    if (s1 - s0) / fps > max_region_sec:
        s1 = s0 + int(round(max_region_sec * fps))
    n = s1 - s0

    speed = max(0.05, min(8.0, float(speed)))
    # Open-vocabulary vision targeting: region "vision:<subject>" -> resolve to a rectangle
    # via a grid-overlay Claude-vision lookup on the region's first frame. Any subject, not
    # YOLO's class list. Not found -> whole frame (a plain global retime).
    if isinstance(region, str) and region.startswith("vision:"):
        cap.set(cv2.CAP_PROP_POS_FRAMES, s0)
        ok_v, vf = cap.read()
        resolved = None
        if ok_v:
            try:
                from scripts import frame_reference
                resolved = frame_reference.locate_subject_frame(vf, region[len("vision:"):])
            except Exception:
                resolved = None
        region = resolved if resolved else "0,0,1,1"
    region_mask = _build_region_mask(region, width, height, feather)
    if invert:
        # slow the COMPLEMENT of the drawn region (keep the drawn subject real-time)
        region_mask = 1.0 - region_mask

    _log_progress("loading", 5, "Reading region")
    # Preload the window of source frames the region effect can reach.
    reach = int(np.ceil(n * max(1.0, speed))) + 2
    cap.set(cv2.CAP_PROP_POS_FRAMES, s0)
    window = []
    for _ in range(min(reach if speed > 1 else n + 2, (total - s0) if total else reach)):
        ok, fr = cap.read()
        if not ok:
            break
        window.append(fr)
    if not window:
        cap.release()
        return {"success": False, "error": "No frames in the selected region"}

    _log_progress("processing", 20, "Retiming region")
    mask3 = region_mask[..., None]
    composed = []
    # Cache Farneback flow per (lo,hi) source pair. In slow-mo ~1/speed consecutive output
    # frames fall between the SAME pair (only frac differs), so computing the flow once and
    # reusing it cuts the dominant cost ~1/speed-fold (e.g. ~3x at 0.35) — the difference
    # between ~55s and ~20s on a 3s 720p region.
    flow_cache = {}
    for i in range(n):
        base = window[min(i, len(window) - 1)].astype(np.float32)
        src_pos = i * speed                       # region source position (window-relative)
        lo = int(np.floor(src_pos))
        frac = src_pos - lo
        lo = min(lo, len(window) - 1)
        hi = min(lo + 1, len(window) - 1)
        if smooth and 0 < frac < 1 and lo != hi:
            flow = flow_cache.get((lo, hi))
            if flow is None:
                ga = cv2.cvtColor(window[lo], cv2.COLOR_BGR2GRAY)
                gb = cv2.cvtColor(window[hi], cv2.COLOR_BGR2GRAY)
                flow = cv2.calcOpticalFlowFarneback(ga, gb, None, 0.5, 3, 21, 3, 5, 1.2, 0)
                flow_cache[(lo, hi)] = flow
            region_frame = _flow_interp(window[lo], window[hi], frac, flow_fwd=flow).astype(np.float32)
        else:
            region_frame = window[lo].astype(np.float32)
        out = base * (1.0 - mask3) + region_frame * mask3
        composed.append(np.clip(out, 0, 255).astype(np.uint8))
        if i % 10 == 0:
            _log_progress("processing", 20 + int(70 * i / n), "Retiming region")

    # ---- encode full-length: passthrough outside region, effect inside ----
    _log_progress("saving", 92, "Encoding")
    base_name, _ = os.path.splitext(input_path)
    if not output_path:
        output_path = f"{base_name}_regionspeed_{int(start*1000)}_{int(end*1000)}.mp4"

    encode_cmd = [
        _find_ffmpeg(), "-y",
        "-f", "rawvideo", "-vcodec", "rawvideo",
        "-s", f"{width}x{height}", "-pix_fmt", "bgr24", "-r", str(fps),
        "-i", "pipe:0", "-an",
        "-vcodec", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast", "-crf", "18",
        "-movflags", "+faststart", output_path,
    ]
    proc = subprocess.Popen(encode_cmd, stdin=subprocess.PIPE, stderr=subprocess.DEVNULL)
    cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
    write_idx = 0
    try:
        while True:
            if total and write_idx >= total:
                break
            ok, fr = cap.read()
            if not ok:
                break
            frame = composed[write_idx - s0] if s0 <= write_idx < s1 else fr
            try:
                proc.stdin.write(np.ascontiguousarray(frame, dtype=np.uint8).tobytes())
            except (BrokenPipeError, OSError):
                break
            write_idx += 1
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
        return {"success": False, "error": "Regional speed produced no output file"}

    # keep original audio
    try:
        muxed = f"{os.path.splitext(output_path)[0]}_a.mp4"
        r = subprocess.run([_find_ffmpeg(), "-y", "-i", output_path, "-i", input_path,
                            "-map", "0:v:0", "-map", "1:a:0?", "-c:v", "copy", "-c:a", "aac",
                            "-shortest", muxed], stderr=subprocess.DEVNULL, stdout=subprocess.DEVNULL)
        if r.returncode == 0 and os.path.exists(muxed) and os.path.getsize(muxed) > 1000:
            os.replace(muxed, output_path)
    except Exception:
        pass

    duration = (total / fps) if total else (s1 / fps)
    return {"success": True, "filePath": output_path, "speed": speed,
            "regionStart": round(s0 / fps, 3), "regionEnd": round(s1 / fps, 3),
            "duration": round(duration, 3)}


def handle_args(args):
    result = regional_speed(
        input_path=args.input, output_path=args.output,
        start=args.start, end=args.end, speed=args.speed,
        region=args.region, feather=args.feather, invert=getattr(args, "invert", False),
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
    a.speed = float(payload.get("speed", 0.5))
    a.region = payload.get("region", "0,0,1,1")
    a.feather = int(payload.get("feather", 24))
    a.invert = bool(payload.get("invert", False))
    handle_args(a)
