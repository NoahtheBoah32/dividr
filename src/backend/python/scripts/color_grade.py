#!/usr/bin/env python3
"""
Reference-based color grading — EXTRACT ONLY mode.
Only samples 2 frames and computes per-channel curves. No video re-encoding.
The curves are returned as JSON and stored on the track.
FFmpeg applies them at export time via the curves filter.

Total runtime: 3-8 seconds regardless of video length.
"""

import sys
import json
import os
import subprocess
import tempfile
import numpy as np


def find_ffmpeg():
    import shutil
    return shutil.which('ffmpeg') or 'ffmpeg'


def get_duration(path: str) -> float:
    try:
        r = subprocess.run(
            ['ffprobe', '-v', 'error', '-show_entries', 'format=duration',
             '-of', 'csv=p=0', path],
            capture_output=True, text=True,
        )
        return float(r.stdout.strip())
    except:
        return 5.0


def extract_frame(video_path: str, time_sec: float) -> np.ndarray:
    ffmpeg = find_ffmpeg()
    with tempfile.NamedTemporaryFile(suffix='.png', delete=False) as f:
        tmp = f.name
    try:
        subprocess.run(
            [ffmpeg, '-y', '-ss', str(time_sec), '-i', video_path,
             '-frames:v', '1', '-q:v', '2', '-vf', 'scale=320:-1',
             tmp, '-loglevel', 'quiet'],
            check=True, capture_output=True,
        )
        import imageio.v2 as iio
        img = iio.imread(tmp)
        return img[:, :, :3].astype(np.uint8)
    finally:
        try: os.unlink(tmp)
        except: pass


def kmeans_palette(frame: np.ndarray, n_colors: int = 8) -> list:
    from sklearn.cluster import KMeans
    pixels = frame.reshape(-1, 3).astype(np.float32)
    if len(pixels) > 20000:
        idx = np.random.choice(len(pixels), 20000, replace=False)
        pixels = pixels[idx]
    km = KMeans(n_clusters=n_colors, n_init=3, random_state=42)
    km.fit(pixels)
    centers = km.cluster_centers_.astype(int)
    counts = np.bincount(km.labels_, minlength=n_colors)
    order = np.argsort(-counts)
    return [
        '#{:02x}{:02x}{:02x}'.format(int(centers[i][0]), int(centers[i][1]), int(centers[i][2]))
        for i in order
    ]


def extract_curves(tgt_f: np.ndarray, ref_f: np.ndarray, method: str) -> dict:
    """
    Derive per-channel response curves by running color-matcher on the real
    downscaled target frame and fitting (input_value -> output_value) per
    channel. Robust across all color-matcher methods — does not rely on
    synthetic ramp probes whose shape can trip up some methods.
    """
    from color_matcher import ColorMatcher

    src_u8 = np.clip(tgt_f * 255.0, 0, 255).astype(np.uint8)
    cm = ColorMatcher(method=method)
    transferred = cm.transfer(src=tgt_f, ref=ref_f)
    out_u8 = np.clip(transferred * 255.0, 0, 255).astype(np.uint8)

    def fit_channel(src_ch, out_ch):
        sums = np.bincount(src_ch.ravel(), weights=out_ch.ravel().astype(np.float64), minlength=256)
        counts = np.bincount(src_ch.ravel(), minlength=256).astype(np.float64)
        means = np.where(counts > 0, sums / np.maximum(counts, 1), -1.0)
        known = np.where(means >= 0)[0]
        if known.size < 2:
            return list(range(256))
        # Linear interpolation across empty bins
        all_x = np.arange(256)
        curve = np.interp(all_x, known, means[known])
        # Monotonize so highlights never invert under shadows
        curve = np.maximum.accumulate(curve)
        return np.clip(curve, 0, 255).astype(int).tolist()

    r = fit_channel(src_u8[..., 0], out_u8[..., 0])
    g = fit_channel(src_u8[..., 1], out_u8[..., 1])
    b = fit_channel(src_u8[..., 2], out_u8[..., 2])

    def to_ffmpeg_pairs(curve):
        step = max(1, len(curve) // 24)
        pairs = []
        for i in range(0, len(curve), step):
            x = round(i / (len(curve) - 1), 4)
            y = round(curve[i] / 255.0, 4)
            pairs.append(f'{x}/{y}')
        pairs.append(f'1.0/{curve[-1]/255.0:.4f}')
        return ' '.join(pairs)

    return {
        'r': r, 'g': g, 'b': b,
        'ffmpegFilter': f"curves=red='{to_ffmpeg_pairs(r)}':green='{to_ffmpeg_pairs(g)}':blue='{to_ffmpeg_pairs(b)}'",
    }


def extract_grade_curves(
    target_path: str,
    reference_path: str,
    method: str = 'hm',
    ref_time_sec: float = None,
    n_colors: int = 8,
) -> dict:
    """
    Extract curves from 3 reference time points (20%, 50%, 80% through the reference).
    Returns the primary set plus all 3 as `palettes` for the UI "View more" picker.
    """
    ref_dur = get_duration(reference_path)
    tgt_dur = get_duration(target_path)

    # Fixed target frame — always sample the target at 40%
    tgt_frame = extract_frame(target_path, tgt_dur * 0.4)
    tgt_f = tgt_frame.astype(np.float32) / 255.0

    # If caller specified a ref time, use it as the primary; otherwise spread 3 samples
    if ref_time_sec is not None:
        ref_times = [ref_time_sec, ref_dur * 0.5, ref_dur * 0.8]
    else:
        ref_times = [ref_dur * 0.2, ref_dur * 0.5, ref_dur * 0.8]

    palettes_data = []
    for rt in ref_times:
        ref_frame = extract_frame(reference_path, max(rt, 0.1))
        ref_f = ref_frame.astype(np.float32) / 255.0
        palette = kmeans_palette(ref_frame, n_colors)
        curves = extract_curves(tgt_f, ref_f, method)
        palettes_data.append({
            'palette': palette,
            'curves': curves,
            'refTimeSec': round(rt, 2),
        })

    primary = palettes_data[0]

    return {
        'success': True,
        'palette': primary['palette'],
        'curves': primary['curves'],
        'palettes': palettes_data,
        'method': method,
        'refFrameSec': primary['refTimeSec'],
    }


if __name__ == '__main__':
    args = json.loads(sys.argv[1])
    try:
        result = extract_grade_curves(
            target_path=args['targetPath'],
            reference_path=args['referencePath'],
            method=args.get('method', 'hm'),
            ref_time_sec=args.get('refTimeSec'),
            n_colors=args.get('nColors', 8),
        )
        print(json.dumps(result))
    except Exception as e:
        import traceback
        print(json.dumps({'success': False, 'error': str(e), 'trace': traceback.format_exc()}))
