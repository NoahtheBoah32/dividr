"""Video stabilization — camera-shake compensation the way real stabilizers do it:
counter-motion (translation + rotation) plus a small constant auto-zoom that keeps
the corrected frame covering the viewport, so no edges are ever revealed. Native
resolution and aspect ratio are always preserved.

Three modes, one motion model shared by the live preview and the export bake:

  analyze  — measure per-frame global camera motion (sparse optical flow on a
             downscaled gray raster -> similarity transform: translation +
             rotation, scale forced to 1), low-pass the camera path ("the
             camera rides a cart"), and write a sidecar JSON of per-frame
             counter-offsets [dx, dy, da] in SOURCE pixels / radians.
  bake     — apply those corrections to the pixels (warpAffine rotate-about-
             center + translate, edges replicated) and re-encode at the SAME
             resolution/fps, audio copied. Used only at export; the preview
             applies the same corrections live.
  measure  — print the shake metric of any file (used by tests to prove the
             before/after difference with numbers, not vibes).

The offsets JSON is the single source of truth: FrameDrivenCompositor applies
offsets[frame] inside a FIXED destination rect in the preview, and ffmpegRun's
pre-pass bakes the identical transform at export — what you see is what ships.

Motion is estimated feature-first (goodFeaturesToTrack + calcOpticalFlowPyrLK +
RANSAC estimateAffinePartial2D, coordinates centered so rotation decomposes
about the frame center) because handheld shake is rarely pure translation —
the phase-correlation path remains as a fallback for featureless frames.
"""

import json
import math
import os
import subprocess
import sys

import cv2
import numpy as np

ANALYZE_WIDTH = 320          # analysis raster width (motion rescaled to source px)
SMOOTH_SECONDS = 2.0         # camera-path low-pass window ("cart" feel)
MAX_SHIFT_FRAC = 0.12        # clamp correction to 12% of min(W,H) — bounds edge reveal
MAX_ANGLE = 0.06             # clamp rotation correction to ~3.4 deg — bounds corner reveal
CUT_FRAC = 0.10              # per-frame motion above this fraction of width = scene cut, not shake
MIN_TRACKS = 12              # fewer surviving feature tracks than this -> phase-correlate fallback
ZOOM_CAP = 1.15              # max auto-zoom (the industry-standard edge hider — Premiere
                             # routinely auto-scales 110-115% on rough handheld). The zoom
                             # is ADAPTIVE per clip: mild footage computes a tiny one; the
                             # cap only guards pathological clips, whose worst corrections
                             # get trimmed to fit.


def _print_result(payload):
    print("RESULT|" + json.dumps(payload), flush=True)


def _shake_stats(rel):
    """Mean per-frame |translation| in px — the shake metric used everywhere."""
    if len(rel) == 0:
        return 0.0
    return float(np.mean(np.linalg.norm(np.asarray(rel)[:, :2], axis=1)))


def _pair_motion(prev_u8, cur_u8, prev_f32, cur_f32, win, scale, cut_px_src, center):
    """Camera motion prev->cur as (dx, dy, da) in SOURCE px / radians.

    Feature path: track corners with pyramidal LK, fit a partial affine
    (similarity) with RANSAC on CENTERED coordinates so the rotation is
    decomposed about the frame center — the same pivot the preview and the
    bake rotate around. Scale is discarded (NO zoom, ever).
    """
    pts = cv2.goodFeaturesToTrack(
        prev_u8, maxCorners=300, qualityLevel=0.01, minDistance=6, blockSize=7
    )
    if pts is not None and len(pts) >= MIN_TRACKS:
        nxt, st, _err = cv2.calcOpticalFlowPyrLK(prev_u8, cur_u8, pts, None)
        if nxt is not None:
            ok = st.reshape(-1) == 1
            p0 = pts.reshape(-1, 2)[ok] - center
            p1 = nxt.reshape(-1, 2)[ok] - center
            if len(p0) >= MIN_TRACKS:
                M, inliers = cv2.estimateAffinePartial2D(
                    p0, p1, method=cv2.RANSAC, ransacReprojThreshold=1.5
                )
                if M is not None and inliers is not None and int(inliers.sum()) >= MIN_TRACKS // 2:
                    da = math.atan2(M[1, 0], M[0, 0])
                    dx = float(M[0, 2]) / scale
                    dy = float(M[1, 2]) / scale
                    if abs(dx) > cut_px_src or abs(dy) > cut_px_src or abs(da) > 0.25:
                        return 0.0, 0.0, 0.0  # scene cut / estimation blow-up: don't chase it
                    return dx, dy, da

    # Featureless frame (sky, blur, black) — global translation via phase correlation.
    (dx, dy), resp = cv2.phaseCorrelate(prev_f32, cur_f32, win)
    dx, dy = dx / scale, dy / scale
    if resp < 0.03 or abs(dx) > cut_px_src or abs(dy) > cut_px_src:
        return 0.0, 0.0, 0.0
    return dx, dy, 0.0


def _measure_relative_motion(src, progress_tag=None):
    """Per-frame camera motion (source px / rad) — Nx3 array of (dx, dy, da)."""
    cap = cv2.VideoCapture(src)
    if not cap.isOpened():
        raise RuntimeError(f"cannot open video: {src}")
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    W = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    H = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) or 0
    scale = ANALYZE_WIDTH / max(1, W)
    AW, AH = ANALYZE_WIDTH, max(2, int(round(H * scale)))
    win = cv2.createHanningWindow((AW, AH), cv2.CV_32F)
    center = np.float32([AW / 2.0, AH / 2.0])
    cut_px_src = CUT_FRAC * W

    rel = []
    prev_u8 = None
    prev_f32 = None
    n = 0
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        g = cv2.cvtColor(cv2.resize(frame, (AW, AH)), cv2.COLOR_BGR2GRAY)
        g_f32 = g.astype(np.float32)
        if prev_u8 is not None:
            rel.append(
                _pair_motion(prev_u8, g, prev_f32, g_f32, win, scale, cut_px_src, center)
            )
        prev_u8, prev_f32 = g, g_f32
        n += 1
        if progress_tag and total and n % 200 == 0:
            print(f"PROGRESS|{progress_tag}|{int(100 * n / total)}", flush=True)
    cap.release()
    return np.asarray(rel, dtype=np.float64).reshape(-1, 3), fps, W, H, n


def _required_zoom(dx, dy, da, W, H):
    """Minimal zoom (about center) so the corrected frame still covers the
    full viewport — i.e. no revealed edges at all for this correction."""
    c, s = math.cos(abs(da)), math.sin(abs(da))
    den_x = W / 2.0 - (c * abs(dx) + s * abs(dy))
    den_y = H / 2.0 - (s * abs(dx) + c * abs(dy))
    if den_x <= 0 or den_y <= 0:
        return float("inf")
    zx = (c * W / 2.0 + s * H / 2.0) / den_x
    zy = (s * W / 2.0 + c * H / 2.0) / den_y
    return max(1.0, zx, zy)


def _corrections(rel, fps, W, H, smoothing_sec):
    """(corr Nx3, zoom): smoothed-path counter-offsets + the constant auto-zoom.

    The zoom is how every real stabilizer (Premiere, CapCut, vidstab optzoom)
    hides revealed edges: one constant scale-about-center that guarantees the
    counter-moved frame always covers the viewport. It is computed as the
    minimum that covers the whole correction curve, capped at ZOOM_CAP; the
    few frames that would need more get their correction scaled down to fit
    (briefly less stabilized beats any edge artifact). Constant = no breathing.
    """
    if len(rel) == 0:
        return np.zeros((1, 3)), 1.0
    path = np.cumsum(rel, axis=0)
    S = max(3, int(round(fps * smoothing_sec)) | 1)  # odd window
    pad = S // 2
    padded = np.pad(path, ((pad, pad), (0, 0)), mode="edge")
    kernel = np.ones(S) / S
    smooth = np.stack(
        [np.convolve(padded[:, i], kernel, mode="valid") for i in range(3)], axis=1
    )
    corr = smooth - path
    lim = MAX_SHIFT_FRAC * min(W, H)
    corr[:, 0] = np.clip(corr[:, 0], -lim, lim)
    corr[:, 1] = np.clip(corr[:, 1], -lim, lim)
    corr[:, 2] = np.clip(corr[:, 2], -MAX_ANGLE, MAX_ANGLE)
    # Frame 0 has no relative measurement — it anchors the path with zero offset.
    corr = np.vstack([[0.0, 0.0, 0.0], corr])

    z_req = np.array([_required_zoom(dx, dy, da, W, H) for dx, dy, da in corr])
    zoom = float(min(ZOOM_CAP, np.max(z_req)))
    for i in np.nonzero(z_req > zoom)[0]:
        lo, hi = 0.0, 1.0
        for _ in range(24):  # largest scale of this correction that fits the zoom
            mid = (lo + hi) / 2.0
            if _required_zoom(corr[i, 0] * mid, corr[i, 1] * mid, corr[i, 2] * mid, W, H) <= zoom:
                lo = mid
            else:
                hi = mid
        corr[i] *= lo
    return corr, zoom


def _correction_matrix(dx, dy, da, W, H, zoom):
    """2x3 affine: p' = center + zoom * (R @ (p - center) + t).

    Rotate about center, translate, then zoom about center — the zoom scales
    the residual correction too, so coverage math and cancellation stay exact.
    Built by hand so the rotation convention is unambiguous and IDENTICAL to
    the analysis decomposition and the canvas preview (R = [c,-s; s,c], y-down).
    """
    c, s = math.cos(da), math.sin(da)
    cx, cy = W / 2.0, H / 2.0
    zc, zs = zoom * c, zoom * s
    return np.float32(
        [
            [zc, -zs, zoom * dx + cx - (zc * cx - zs * cy)],
            [zs, zc, zoom * dy + cy - (zs * cx + zc * cy)],
        ]
    )


def analyze(args):
    rel, fps, W, H, frames = _measure_relative_motion(args.input, progress_tag="analyze")
    corr, zoom = _corrections(rel, fps, W, H, args.smoothing)
    before = _shake_stats(rel)
    # Predicted residual: the shake left in (path + corr), frame-to-frame.
    if len(rel):
        res_path = np.cumsum(rel, axis=0) + corr[1:]
        after = _shake_stats(np.diff(np.vstack([[0, 0, 0], res_path]), axis=0))
    else:
        after = 0.0

    payload = {
        "version": 3,
        "fps": fps,
        "frames": frames,
        "width": W,
        "height": H,
        "zoom": round(zoom, 4),
        "offsets": [
            [round(float(x), 2), round(float(y), 2), round(float(a), 5)]
            for x, y, a in corr
        ],
        "shakeBefore": round(before, 3),
        "shakeAfter": round(after, 3),
    }
    with open(args.output, "w", encoding="utf-8") as f:
        json.dump(payload, f)
    _print_result({
        "success": True,
        "offsetsPath": args.output,
        "fps": fps,
        "frames": frames,
        "zoom": payload["zoom"],
        "shakeBefore": payload["shakeBefore"],
        "shakeAfter": payload["shakeAfter"],
    })


def bake(args):
    with open(args.offsets, "r", encoding="utf-8") as f:
        data = json.load(f)
    raw = data.get("offsets") or [[0, 0, 0]]
    # v1 sidecars carried [dx, dy]; treat missing rotation as 0.
    offsets = np.asarray([(o + [0.0])[:3] if len(o) < 3 else o[:3] for o in raw], dtype=np.float64)
    zoom = float(data.get("zoom") or 1.0)

    cap = cv2.VideoCapture(args.input)
    if not cap.isOpened():
        raise RuntimeError(f"cannot open video: {args.input}")
    fps = cap.get(cv2.CAP_PROP_FPS) or data.get("fps") or 30.0
    W = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    H = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))

    cmd = [
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{W}x{H}", "-r", f"{fps}", "-i", "-",
        "-i", args.input,
        "-map", "0:v", "-map", "1:a?",
        "-c:v", "libx264", "-crf", "18", "-preset", "veryfast", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-shortest",
        args.output,
    ]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stderr=subprocess.PIPE)

    i = 0
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        dx, dy, da = offsets[min(i, len(offsets) - 1)]
        # Rotate about center + translate + the clip's constant auto-zoom,
        # native resolution. BORDER_REPLICATE stays as belt-and-braces only —
        # the zoom guarantees coverage, so it should never actually show.
        out = cv2.warpAffine(
            frame, _correction_matrix(dx, dy, da, W, H, zoom), (W, H),
            flags=cv2.INTER_LINEAR,
            borderMode=cv2.BORDER_REPLICATE,
        )
        proc.stdin.write(out.tobytes())
        i += 1
    cap.release()
    proc.stdin.close()
    err = proc.stderr.read().decode("utf-8", "ignore")
    code = proc.wait()
    if code != 0 or not os.path.exists(args.output):
        raise RuntimeError(f"ffmpeg encode failed ({code}): {err[-400:]}")
    _print_result({"success": True, "filePath": args.output, "frames": i})


def measure(args):
    rel, fps, W, H, frames = _measure_relative_motion(args.input)
    _print_result({
        "success": True,
        "frames": frames,
        "fps": fps,
        "width": W,
        "height": H,
        "shake": round(_shake_stats(rel), 3),
        "rotShake": round(float(np.mean(np.abs(rel[:, 2]))) if len(rel) else 0.0, 6),
    })


def handle_args(args):
    try:
        if args.stab_mode == "analyze":
            analyze(args)
        elif args.stab_mode == "bake":
            bake(args)
        else:
            measure(args)
    except Exception as e:  # noqa: BLE001 — surface every failure to the caller
        _print_result({"success": False, "error": str(e)})
        sys.exit(1)
