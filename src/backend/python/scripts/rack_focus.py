#!/usr/bin/env python3
"""
Rack focus — the focus pull, in post.

A rack focus is the shot where focus travels from one subject to another while
the camera keeps rolling: the plant in the foreground is razor sharp and the
person behind is soft, then the lens "racks" and the person snaps into clarity
while the plant melts away. It only reads with a shallow depth of field, so
this bake makes the depth of field VERY shallow on purpose — the effect must
be blatant.

How: MiDaS-small monocular depth per frame (onnxruntime, model cached next to
this script, downloaded on first use). Depth is normalized (temporally smoothed
bounds so it never flickers), a focus plane eases from the NEAR plane to the
FAR plane (or the reverse) across the segment, and every pixel is blended
between the sharp frame and two Gaussian blur levels by its distance from the
focus plane. Output is a full-length H.264 mp4: passthrough outside
[start,end], the rack inside, original audio muxed back. RESULT|{json}.
"""

import json
import os
import subprocess
import sys

MODEL_URL = "https://github.com/isl-org/MiDaS/releases/download/v2_1/model-small.onnx"
MODEL_NAME = "midas_small_v21.onnx"
MODEL_MIN_BYTES = 40_000_000  # real file is ~66MB — reject truncated downloads


def _log_progress(stage, progress, message=""):
    print(f"PROGRESS|{json.dumps({'stage': stage, 'progress': progress, 'message': message})}", flush=True)


def _find_ffmpeg():
    import shutil
    return shutil.which("ffmpeg") or "ffmpeg"


def _get_model_path() -> str:
    """MiDaS-small ONNX — cached next to this script; atomic download on first use."""
    model_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), MODEL_NAME)
    if not os.path.exists(model_path):
        import urllib.request
        _log_progress("model", 2, "Downloading depth model (one-time, ~66MB)")
        tmp = model_path + ".part"
        urllib.request.urlretrieve(MODEL_URL, tmp)
        if os.path.getsize(tmp) < MODEL_MIN_BYTES:
            os.remove(tmp)
            raise RuntimeError("Depth model download incomplete")
        os.replace(tmp, model_path)
    return model_path


class _DepthEstimator:
    """MiDaS small via onnxruntime. infer() returns HxW float32, higher = nearer."""

    SIZE = 256

    def __init__(self):
        import onnxruntime as ort
        self.sess = ort.InferenceSession(_get_model_path(), providers=["CPUExecutionProvider"])
        self.input_name = self.sess.get_inputs()[0].name

    def infer(self, bgr):
        import cv2
        import numpy as np
        h, w = bgr.shape[:2]
        img = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0
        img = cv2.resize(img, (self.SIZE, self.SIZE), interpolation=cv2.INTER_AREA)
        mean = np.array([0.485, 0.456, 0.406], np.float32)
        std = np.array([0.229, 0.224, 0.225], np.float32)
        img = (img - mean) / std
        blob = img.transpose(2, 0, 1)[None]
        depth = self.sess.run(None, {self.input_name: blob})[0][0]
        depth = cv2.resize(depth.astype("float32"), (w, h), interpolation=cv2.INTER_CUBIC)
        return depth


def _ease(t: float) -> float:
    """Smootherstep — a focus pull accelerates and settles, it doesn't tick linearly."""
    t = max(0.0, min(1.0, t))
    return t * t * t * (t * (t * 6.0 - 15.0) + 10.0)


def rack_focus(input_path, output_path, start, end, direction="near-to-far",
               strength=70.0, hold=0.35, max_region_sec=20.0,
               from_subject="", to_subject=""):
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
    if n < 4:
        cap.release()
        return {"success": False, "error": "Rack focus needs at least a few frames — widen the range"}

    _log_progress("model", 4, "Loading depth model")
    try:
        est = _DepthEstimator()
    except Exception as e:
        cap.release()
        return {"success": False, "error": f"Depth model unavailable: {e}"}

    # Blur ladder scaled by strength and resolution. Heavy enough to be blatant.
    strength = max(10.0, min(100.0, float(strength)))
    base_sigma = (strength / 100.0) * (min(width, height) / 60.0)  # ~18 at 1080p, s=100
    sigma_mid = max(2.0, base_sigma * 0.45)
    sigma_far = max(4.0, base_sigma)

    _log_progress("processing", 8, "Racking focus")
    composed = []
    lo_b = hi_b = None  # temporally-smoothed depth normalization bounds
    plane_a = plane_b = None  # the sweep endpoints: focus travels a → b
    anchored = {"from": False, "to": False}
    hold_frames = int(round(max(0.0, hold) * fps))
    travel = max(1, n - 2 * hold_frames)

    cap.set(cv2.CAP_PROP_POS_FRAMES, s0)
    for i in range(n):
        ok, fr = cap.read()
        if not ok:
            break
        depth = est.infer(fr)

        # Percentile bounds with EMA so normalization never flickers frame-to-frame.
        lo_i, hi_i = np.percentile(depth, 3), np.percentile(depth, 97)
        lo_b = lo_i if lo_b is None else 0.85 * lo_b + 0.15 * lo_i
        hi_b = hi_i if hi_b is None else 0.85 * hi_b + 0.15 * hi_i
        d = np.clip((depth - lo_b) / max(1e-6, (hi_b - lo_b)), 0.0, 1.0)  # 1 = near

        # First frame: decide the two focus BANDS the sweep travels between.
        # Each end is a [lo, hi] depth interval, not a razor-thin plane — a real
        # subject spans a range of depths (a person's face vs shoulders; mountains
        # vs the sky behind them), and a single-value plane leaves half the subject
        # blurred ("mix of blur and focus"). The band is the subject's own p15–p85
        # depth interval, so the WHOLE subject stays sharp at its end of the pull.
        if plane_a is None:
            DEFAULT_HALF = 0.07
            # Default planes from the frame's depth make-up:
            # near = median of the nearest quartile, far = median of the farthest.
            flat = np.sort(d.reshape(-1))
            far_plane = float(np.median(flat[: max(1, flat.size // 4)]))
            near_plane = float(np.median(flat[-max(1, flat.size // 4):]))

            # Subject anchoring ("rack focus from the vase to the man"): locate the
            # named subjects with the vision box helper and read the DEPTH inside
            # each box. Depth only — no matting, nothing is cut out.
            def _band_of(subject):
                """[lo, hi] depth interval of the subject, or None."""
                if not subject:
                    return None
                try:
                    from scripts import frame_reference
                    box = frame_reference.locate_subject_frame(fr, subject)
                except Exception:
                    box = None
                if not box:
                    return None
                try:
                    bx, by, bw2, bh2 = [float(v) for v in box.split(",")]
                except Exception:
                    return None
                x0, y0 = int(bx * width), int(by * height)
                x1, y1 = int((bx + bw2) * width), int((by + bh2) * height)
                region = d[max(0, y0):min(height, y1), max(0, x0):min(width, x1)]
                if region.size < 16:
                    return None
                m = float(np.median(region))
                lo = float(np.percentile(region, 15))
                hi = float(np.percentile(region, 85))
                # Clamp the width so a box that accidentally swallows the scene
                # can't make everything "in focus" — shrink both ends toward the
                # median; widen a too-thin band the same way.
                MAXW, MINW = 0.4, 0.1
                wdt = hi - lo
                if wdt > MAXW:
                    s = MAXW / wdt
                    lo, hi = m + (lo - m) * s, m + (hi - m) * s
                elif wdt < MINW:
                    pad = (MINW - wdt) / 2.0
                    lo, hi = lo - pad, hi + pad
                return (max(0.0, lo), min(1.0, hi))

            band_a = band_b = None
            _mid = lambda b: (b[0] + b[1]) / 2.0
            if from_subject or to_subject:
                _log_progress("vision", 10, "Locating the subjects in the frame")
                band_a = _band_of(from_subject)
                band_b = _band_of(to_subject)
                anchored["from"] = band_a is not None
                anchored["to"] = band_b is not None
                # One subject named → the other end is whichever default plane
                # sits farthest from it (the biggest possible focus travel).
                if band_a is None and band_b is not None:
                    pa = near_plane if abs(near_plane - _mid(band_b)) > abs(far_plane - _mid(band_b)) else far_plane
                    band_a = (pa - DEFAULT_HALF, pa + DEFAULT_HALF)
                if band_b is None and band_a is not None:
                    pb = near_plane if abs(near_plane - _mid(band_a)) > abs(far_plane - _mid(band_a)) else far_plane
                    band_b = (pb - DEFAULT_HALF, pb + DEFAULT_HALF)
                if band_a and band_b and abs(_mid(band_a) - _mid(band_b)) < 0.12:
                    cap.release()
                    return {"success": False, "reason": "no-depth",
                            "error": "Those two subjects sit at the same distance from the camera — there is no focus travel between them, so a rack focus won't read"}

            if band_a is None or band_b is None:
                # No (usable) subjects — blind near/far sweep, direction decides order.
                if near_plane - far_plane < 0.15:
                    cap.release()
                    return {"success": False, "reason": "no-depth",
                            "error": "Scene has no usable depth separation — rack focus needs a foreground and a background"}
                if direction == "far-to-near":
                    band_a, band_b = (far_plane - DEFAULT_HALF, far_plane + DEFAULT_HALF), (near_plane - DEFAULT_HALF, near_plane + DEFAULT_HALF)
                else:
                    band_a, band_b = (near_plane - DEFAULT_HALF, near_plane + DEFAULT_HALF), (far_plane - DEFAULT_HALF, far_plane + DEFAULT_HALF)

            plane_a, plane_b = band_a, band_b  # (lo, hi) depth intervals

        # Focus band position over time (with holds at both ends).
        t = _ease((i - hold_frames) / travel)
        f_lo = plane_a[0] + (plane_b[0] - plane_a[0]) * t
        f_hi = plane_a[1] + (plane_b[1] - plane_a[1]) * t

        # Per-pixel defocus weight: distance OUTSIDE the focus band, shallow falloff.
        softness = 0.18  # smaller = shallower DOF = more blatant
        outside = np.maximum(f_lo - d, d - f_hi)
        w = np.clip(outside / softness, 0.0, 1.0).astype(np.float32)
        w = cv2.GaussianBlur(w, (31, 31), 0)  # feather the mask so edges never ring
        w3 = w[..., None]

        sharp = fr.astype(np.float32)
        blur_mid = cv2.GaussianBlur(fr, (0, 0), sigma_mid).astype(np.float32)
        blur_far = cv2.GaussianBlur(fr, (0, 0), sigma_far).astype(np.float32)
        # Two-stage blend: sharp→mid over w 0..0.5, mid→heavy over w 0.5..1.
        w_a = np.clip(w3 * 2.0, 0.0, 1.0)
        w_b = np.clip(w3 * 2.0 - 1.0, 0.0, 1.0)
        out = sharp * (1.0 - w_a) + blur_mid * w_a
        out = out * (1.0 - w_b) + blur_far * w_b
        composed.append(np.clip(out, 0, 255).astype(np.uint8))
        if i % 8 == 0:
            _log_progress("processing", 8 + int(80 * i / n), f"Racking focus {i}/{n}")

    if not composed:
        cap.release()
        return {"success": False, "error": "No frames in the selected region"}
    # Pad if the reader came up short so passthrough indexing stays aligned.
    while len(composed) < n:
        composed.append(composed[-1])

    # ---- encode full-length: passthrough outside region, rack inside ----
    _log_progress("saving", 92, "Encoding")
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
        return {"success": False, "error": "Rack focus produced no output file"}

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
    return {"success": True, "filePath": output_path, "direction": direction,
            "regionStart": round(s0 / fps, 3), "regionEnd": round(s1 / fps, 3),
            "anchoredFrom": anchored["from"], "anchoredTo": anchored["to"],
            "planeFrom": [round(plane_a[0], 3), round(plane_a[1], 3)] if plane_a else None,
            "planeTo": [round(plane_b[0], 3), round(plane_b[1], 3)] if plane_b else None,
            "duration": round(duration, 3)}


def handle_args(args):
    result = rack_focus(
        input_path=args.input, output_path=args.output,
        start=args.start, end=args.end,
        direction=getattr(args, "direction", "near-to-far"),
        strength=getattr(args, "strength", 70.0),
        hold=getattr(args, "hold", 0.35),
        from_subject=getattr(args, "from_subject", "") or "",
        to_subject=getattr(args, "to_subject", "") or "",
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
    a.direction = payload.get("direction", "near-to-far")
    a.strength = float(payload.get("strength", 70))
    a.hold = float(payload.get("hold", 0.35))
    a.from_subject = payload.get("fromSubject", "")
    a.to_subject = payload.get("toSubject", "")
    handle_args(a)
