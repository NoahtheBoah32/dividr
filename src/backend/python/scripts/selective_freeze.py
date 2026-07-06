#!/usr/bin/env python3
"""
Selective freeze — "Hold the world, let one thing move."

Two modes over a [start, end] region of a clip:
  world-frozen   : the world locks into a single held frame while the chosen
                   subject keeps playing right through it ("she walks through
                   frozen time").
  subject-frozen : the subject freezes mid-motion while the world keeps moving
                   ("everyone's a blur, she's a statue").

Seamless, NOT a crude background-remove-and-paste. The subject silhouette is a
soft RVM matte (the same recurrent matting used for clean edges through motion),
and the hole the subject leaves in the held frame is filled with REAL background
pixels sampled from frames where the moving subject has vacated that spot — only
the tiny never-revealed residual is inpainted. The composite is alpha-feathered
so there is no cut-out edge.

Outputs a full-length H.264 mp4 (yuv420p) — the region is replaced by the
effect, the rest of the clip is passed through. Chromium/Electron decode it
natively, so the preview just plays a normal video.

RESULT|{json} protocol on stdout, mirroring the other DiviDr python tools.
"""

import json
import os
import subprocess
import sys


def _log_progress(stage: str, progress: int, message: str = "") -> None:
    print(f"PROGRESS|{json.dumps({'stage': stage, 'progress': progress, 'message': message})}", flush=True)


def _find_ffmpeg() -> str:
    import shutil
    return shutil.which("ffmpeg") or "ffmpeg"


def _rvm_model_path() -> str:
    """RVM ONNX model — bundled next to this script (downloaded on first use if missing)."""
    import urllib.request
    model_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "rvm_mobilenetv3_fp32.onnx")
    if not os.path.exists(model_path):
        url = "https://github.com/PeterL1n/RobustVideoMatting/releases/download/v1.0.0/rvm_mobilenetv3_fp32.onnx"
        tmp = model_path + ".part"
        urllib.request.urlretrieve(url, tmp)
        if os.path.getsize(tmp) < 1_000_000:
            os.unlink(tmp)
            raise RuntimeError("RVM model download incomplete")
        os.replace(tmp, model_path)
    return model_path


class _RvmMatter:
    """Recurrent RVM matting. Feed frames IN ORDER so the hidden state stays warm
    (this is what keeps edges stable through fast motion — no flicker/ghosting)."""

    def __init__(self, width: int, height: int):
        import numpy as np
        import onnxruntime as ort

        sess_opts = ort.SessionOptions()
        sess_opts.intra_op_num_threads = os.cpu_count() or 4
        sess_opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        self._np = np
        self._session = ort.InferenceSession(_rvm_model_path(), sess_opts, providers=["CPUExecutionProvider"])

        long_side = max(width, height)
        self._scale = min(1.0, 1024.0 / long_side) if long_side > 0 else 1.0
        self._iw = max(2, int(round(width * self._scale)))
        self._ih = max(2, int(round(height * self._scale)))
        self._w = width
        self._h = height
        self._downsample = np.array([0.25], dtype=np.float32)
        self._rec = [np.zeros((1, 1, 1, 1), dtype=np.float32) for _ in range(4)]
        self._out_names = ["fgr", "pha", "r1o", "r2o", "r3o", "r4o"]

    def alpha(self, bgr) -> "object":
        """Return a HxW float32 alpha (0..1) at full resolution for a BGR frame."""
        import cv2
        np = self._np
        rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
        small = cv2.resize(rgb, (self._iw, self._ih), interpolation=cv2.INTER_AREA) if self._scale < 1.0 else rgb
        inp = (small.astype(np.float32) / 255.0).transpose(2, 0, 1)[None]
        outputs = self._session.run(self._out_names, {
            "src": inp,
            "r1i": self._rec[0], "r2i": self._rec[1], "r3i": self._rec[2], "r4i": self._rec[3],
            "downsample_ratio": self._downsample,
        })
        pha = np.clip(outputs[1][0, 0], 0.0, 1.0)
        self._rec = outputs[2:6]
        if self._scale < 1.0:
            pha = cv2.resize(pha, (self._w, self._h), interpolation=cv2.INTER_LINEAR)
        return pha.astype(np.float32)


def _instance_mask_at_click(frame_bgr, click_x: float, click_y: float):
    """Use YOLOv8-seg to pick the ONE instance under a normalized (0..1) click point.
    Returns a HxW float32 mask (0..1) for that instance, or None if nothing there."""
    import cv2
    import numpy as np
    from ultralytics import YOLO

    h, w = frame_bgr.shape[:2]
    px, py = int(round(click_x * w)), int(round(click_y * h))
    model = YOLO("yolov8n-seg.pt")
    res = model.predict(frame_bgr, verbose=False, conf=0.25)[0]
    if res.masks is None:
        return None
    masks = res.masks.data.cpu().numpy()  # [n, mh, mw], 0..1
    best = None
    best_area = 0.0
    for m in masks:
        mm = cv2.resize(m, (w, h), interpolation=cv2.INTER_LINEAR)
        if mm[py, px] > 0.5:
            area = float((mm > 0.5).sum())
            if area > best_area:
                best_area = area
                best = mm
    return best.astype(np.float32) if best is not None else None


def _feather(alpha, px: int):
    """Soften a 0..1 alpha edge so the composite has no cut-out line."""
    import cv2
    if px <= 0:
        return alpha
    k = px * 2 + 1
    return cv2.GaussianBlur(alpha, (k, k), 0)


def _build_clean_plate(plate_bgr, frames, mattes, freeze_idx: int, footprint):
    """Fill the chosen subject's footprint in the held frame with REAL background
    pixels taken from the frame (nearest to freeze) where that pixel is NOT the
    subject. Residual that is never revealed is inpainted. Returns a clean plate."""
    import cv2
    import numpy as np

    h, w = plate_bgr.shape[:2]
    out = plate_bgr.copy().astype(np.uint8)
    hole = footprint > 0.35           # pixels to replace (slightly dilated coverage)
    if not hole.any():
        return out
    remaining = hole.copy()

    n = len(frames)
    # Visit frames by increasing temporal distance from the freeze instant so the
    # filled background is as close in time (and lighting) as possible.
    order = sorted(range(n), key=lambda i: abs(i - freeze_idx))
    for i in order:
        if not remaining.any():
            break
        if i == freeze_idx:
            continue
        cover = mattes[i] > 0.5       # subject in donor frame
        usable = remaining & (~cover)
        if usable.any():
            out[usable] = frames[i][usable]
            remaining &= ~usable

    if remaining.any():
        # Never-revealed sliver — inpaint from surrounding real pixels.
        m = (remaining.astype(np.uint8)) * 255
        m = cv2.dilate(m, np.ones((3, 3), np.uint8), iterations=1)
        out = cv2.inpaint(out, m, 3, cv2.INPAINT_TELEA)
    return out


def _restrict_to_instance(mattes, frames, instance_mask, freeze_idx: int):
    """When a specific subject was clicked, keep only that subject 'live' and let
    everyone else stay frozen. We anchor on the clicked instance's bounding box at
    the freeze frame and follow it loosely by overlap so a walking subject stays
    selected. Returns mattes restricted to the chosen subject."""
    import cv2
    import numpy as np

    h, w = frames[0].shape[:2]
    inst = instance_mask > 0.5
    # Generous dilation → a soft gate that tolerates the subject moving frame-to-frame.
    gate = cv2.dilate(inst.astype(np.uint8), np.ones((41, 41), np.uint8), iterations=2).astype(bool)
    restricted = []
    for i, a in enumerate(mattes):
        ra = a.copy()
        ra[~gate] = 0.0
        # Re-grow the gate around where the subject currently is so it tracks motion.
        cur = ra > 0.4
        if cur.any():
            gate = cv2.dilate(cur.astype(np.uint8), np.ones((41, 41), np.uint8), iterations=2).astype(bool)
        restricted.append(ra)
    return restricted


def selective_freeze(input_path: str, output_path: str, start: float, end: float,
                     mode: str = "world-frozen", freeze_at: float = -1.0,
                     click: str = "", feather: int = 3, fill_world: bool = True,
                     max_region_sec: float = 14.0) -> dict:
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
    # Keep memory + time bounded; the effect region for this skill is short by design.
    if (s1 - s0) / fps > max_region_sec:
        s1 = s0 + int(round(max_region_sec * fps))

    freeze_idx_global = s0 if freeze_at < 0 else max(s0, min(s1 - 1, int(round(freeze_at * fps))))

    # "full" = a plain freeze-frame: the whole frame is held as a still, no subject
    # isolation needed, so we skip RVM entirely (fast).
    need_matte = mode != "full"

    # Warm up RVM a little before the region so the matte is stable at s0.
    warmup = min(s0, 15) if need_matte else 0
    read_start = s0 - warmup

    _log_progress("loading", 5, "Holding frame" if not need_matte else "Matting subject")
    matter = _RvmMatter(width, height) if need_matte else None

    cap.set(cv2.CAP_PROP_POS_FRAMES, read_start)
    region_frames = []   # BGR frames for [s0, s1)
    region_mattes = []   # matching alphas (None entries in "full" mode)
    plate_bgr = None
    idx = read_start
    while idx < s1:
        ret, bgr = cap.read()
        if not ret:
            break
        a = matter.alpha(bgr) if need_matte else None
        if idx >= s0:
            region_frames.append(bgr.copy())
            region_mattes.append(a)
            if idx == freeze_idx_global:
                plate_bgr = bgr.copy()
        idx += 1
        if region_frames and len(region_frames) % 10 == 0:
            pct = 5 + int(35 * len(region_frames) / max(1, s1 - s0))
            _log_progress("processing", min(40, pct), "Holding frame" if not need_matte else "Matting subject")

    n = len(region_frames)
    if n == 0:
        cap.release()
        return {"success": False, "error": "No frames in the selected region"}
    if plate_bgr is None:
        plate_bgr = region_frames[0].copy()
    freeze_local = max(0, min(n - 1, freeze_idx_global - s0))

    # Subject sanity — the matte must actually contain a subject (skip for "full").
    if need_matte:
        fg_ratio = float((region_mattes[freeze_local] > 0.5).sum()) / float(width * height)
        if fg_ratio < 0.002:
            cap.release()
            return {"success": False, "error": "No clear subject found in the selected region"}

    # Optional: restrict to ONE clicked subject (freeze everyone but her).
    instance_mask = None
    if click and need_matte:
        try:
            cx, cy = [float(v) for v in click.split(",")]
            instance_mask = _instance_mask_at_click(plate_bgr, cx, cy)
        except Exception:
            instance_mask = None
    if instance_mask is not None:
        region_mattes = _restrict_to_instance(region_mattes, region_frames, instance_mask, freeze_local)

    _log_progress("processing", 45, "Compositing")

    # ---- compose the region ----
    composed = []
    if mode == "full":
        # Plain freeze-frame: hold the whole frame as a still for the region.
        composed = [plate_bgr.copy() for _ in range(n)]
    elif mode == "subject-frozen":
        # World plays live; the subject is frozen at the freeze instant on top.
        footprint = region_mattes[freeze_local]
        frozen_subj = plate_bgr.astype(np.float32)
        frozen_alpha = _feather(footprint.copy(), feather)[..., None]
        # Estimate a moving-world background to erase the live subject (median over
        # the region where each pixel is not the subject) so there is no double image.
        world_bg = None
        if fill_world:
            stack = np.stack([f.astype(np.float32) for f in region_frames], axis=0)
            cov = np.stack([m > 0.5 for m in region_mattes], axis=0)
            masked = np.where(cov[..., None], np.nan, stack)
            with np.errstate(all="ignore"):
                world_bg = np.nanmedian(masked, axis=0)
            world_bg = np.where(np.isnan(world_bg), stack[0], world_bg)
        for i in range(n):
            base = region_frames[i].astype(np.float32)
            if world_bg is not None:
                a_live = _feather(region_mattes[i].copy(), feather)[..., None]
                base = base * (1.0 - a_live) + world_bg * a_live
            out = base * (1.0 - frozen_alpha) + frozen_subj * frozen_alpha
            composed.append(np.clip(out, 0, 255).astype(np.uint8))
            if i % 10 == 0:
                _log_progress("processing", 45 + int(45 * i / n), "Compositing")
    else:
        # world-frozen (default): the held frame is the world; the subject plays live.
        footprint = region_mattes[freeze_local]
        clean_plate = _build_clean_plate(plate_bgr, region_frames, region_mattes, freeze_local, footprint)
        clean_plate_f = clean_plate.astype(np.float32)
        for i in range(n):
            a_live = _feather(region_mattes[i].copy(), feather)[..., None]
            live = region_frames[i].astype(np.float32)
            out = clean_plate_f * (1.0 - a_live) + live * a_live
            composed.append(np.clip(out, 0, 255).astype(np.uint8))
            if i % 10 == 0:
                _log_progress("processing", 45 + int(45 * i / n), "Compositing")

    # ---- encode full-length output: passthrough outside region, composite inside ----
    _log_progress("saving", 92, "Encoding")
    base, _ = os.path.splitext(input_path)
    if not output_path:
        output_path = f"{base}_freeze_{int(start*1000)}_{int(end*1000)}.mp4"

    encode_cmd = [
        _find_ffmpeg(), "-y",
        "-f", "rawvideo", "-vcodec", "rawvideo",
        "-s", f"{width}x{height}", "-pix_fmt", "bgr24", "-r", str(fps),
        "-i", "pipe:0",
        "-an",
        "-vcodec", "libx264", "-pix_fmt", "yuv420p",
        "-preset", "veryfast", "-crf", "18",
        "-movflags", "+faststart",
        output_path,
    ]
    proc = subprocess.Popen(encode_cmd, stdin=subprocess.PIPE, stderr=subprocess.DEVNULL)

    cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
    write_idx = 0
    try:
        while True:
            if total > 0 and write_idx >= total:
                break
            ret, bgr = cap.read()
            if not ret:
                break
            if s0 <= write_idx < s1:
                frame = composed[write_idx - s0]
            else:
                frame = bgr
            try:
                proc.stdin.write(frame.astype(np.uint8).tobytes())
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
        return {"success": False, "error": "Selective freeze produced no output file"}

    # Re-mux original audio so the clip keeps its sound (length unchanged).
    try:
        muxed = f"{os.path.splitext(output_path)[0]}_a.mp4"
        mux_cmd = [
            _find_ffmpeg(), "-y", "-i", output_path, "-i", input_path,
            "-map", "0:v:0", "-map", "1:a:0?", "-c:v", "copy", "-c:a", "aac", "-shortest", muxed,
        ]
        r = subprocess.run(mux_cmd, stderr=subprocess.DEVNULL, stdout=subprocess.DEVNULL)
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
    }


def handle_args(args) -> None:
    result = selective_freeze(
        input_path=args.input,
        output_path=args.output,
        start=args.start,
        end=args.end,
        mode=args.mode,
        freeze_at=args.freeze_at,
        click=args.click,
        feather=args.feather,
        fill_world=not args.no_fill_world,
    )
    print(f"RESULT|{json.dumps(result)}", flush=True)


if __name__ == "__main__":
    # Standalone: python selective_freeze.py '{"filePath":...}' OR via main.py subcommand.
    payload = json.loads(sys.argv[1]) if len(sys.argv) > 1 else {}

    class _A:
        pass

    a = _A()
    a.input = payload["filePath"]
    a.output = payload.get("output", "")
    a.start = float(payload.get("start", 0))
    a.end = float(payload.get("end", 0))
    a.mode = payload.get("mode", "world-frozen")
    a.freeze_at = float(payload.get("freezeAt", -1))
    a.click = payload.get("click", "")
    a.feather = int(payload.get("feather", 3))
    a.no_fill_world = not payload.get("fillWorld", True)
    handle_args(a)
