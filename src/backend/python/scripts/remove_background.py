#!/usr/bin/env python3
"""
AI background removal.
- Images: rembg (U2Net) — best quality for stills.
- Videos: MediaPipe Selfie Segmentation — real-time speed, designed for talking heads.

Returns JSON on stdout:
  {"success": true, "filePath": "/abs/path/to/output.webm", "model": "mediapipe-selfie"}
  {"success": false, "error": "No main subject detected — cannot execute background removal"}
"""

import sys
import json
import os
import subprocess

IMAGE_EXTS = {'.jpg', '.jpeg', '.png', '.webp', '.bmp', '.tif', '.tiff'}
VIDEO_EXTS = {'.mp4', '.mov', '.avi', '.mkv', '.webm', '.mts', '.m4v'}


def find_ffmpeg():
    import shutil
    return shutil.which('ffmpeg') or 'ffmpeg'


def find_ffprobe():
    import shutil
    return shutil.which('ffprobe') or 'ffprobe'


def has_clear_subject_mask(mask_img) -> bool:
    import numpy as np
    arr = numpy_alpha(mask_img)
    fg_ratio = (arr > 127).sum() / arr.size
    return 0.01 <= fg_ratio <= 0.98


def numpy_alpha(pil_img):
    import numpy as np
    arr = np.array(pil_img)
    return arr[:, :, 3] if arr.ndim == 3 else arr


def remove_background_image(input_path: str, model_name: str = 'u2net') -> dict:
    from rembg import remove, new_session
    from PIL import Image
    import io

    session = new_session(model_name)
    with open(input_path, 'rb') as f:
        input_data = f.read()

    output_data = remove(input_data, session=session)
    result_img = Image.open(io.BytesIO(output_data)).convert('RGBA')

    if not has_clear_subject_mask(result_img):
        return {'success': False, 'error': 'No main subject detected — cannot execute background removal'}

    base, _ = os.path.splitext(input_path)
    out_path = f"{base}_nobg.png"
    result_img.save(out_path, 'PNG')
    return {'success': True, 'filePath': out_path, 'model': model_name}


def _get_rvm_model_path() -> str:
    """RVM ONNX model — cached next to this script; downloaded on first use if missing."""
    import urllib.request
    model_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'rvm_mobilenetv3_fp32.onnx')
    if not os.path.exists(model_path):
        url = 'https://github.com/PeterL1n/RobustVideoMatting/releases/download/v1.0.0/rvm_mobilenetv3_fp32.onnx'
        # Atomic download: write to .part then rename, so an interrupted download
        # never leaves a truncated model that permanently breaks bg removal.
        tmp = model_path + '.part'
        urllib.request.urlretrieve(url, tmp)
        if os.path.getsize(tmp) < 1_000_000:
            os.unlink(tmp)
            raise RuntimeError('RVM model download incomplete')
        os.replace(tmp, model_path)
    return model_path


def remove_background_video(input_path: str, **_kwargs) -> dict:
    """
    Robust Video Matting (RVM, MobileNetV3) via ONNX Runtime.
    Unlike per-frame segmenters, RVM carries recurrent hidden states between frames,
    so edges stay clean and stable through fast motion (no ghosting/flicker).
    CPU bake — outputs WebM VP9 with alpha (natively playable in Electron/Chromium).
    """
    import cv2
    import numpy as np
    import onnxruntime as ort

    model_path = _get_rvm_model_path()
    sess_opts = ort.SessionOptions()
    sess_opts.intra_op_num_threads = os.cpu_count() or 4
    sess_opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    session = ort.InferenceSession(model_path, sess_opts, providers=['CPUExecutionProvider'])

    cap = cv2.VideoCapture(input_path)
    if not cap.isOpened():
        return {'success': False, 'error': f'Cannot open video: {input_path}'}

    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))

    # Run inference at a capped resolution for CPU speed, upscale the matte back.
    # RVM edges are smooth, so a modest downscale costs little visible quality.
    long_side = max(width, height)
    scale = min(1.0, 1024.0 / long_side) if long_side > 0 else 1.0
    iw = max(2, int(round(width * scale)))
    ih = max(2, int(round(height * scale)))
    downsample_ratio = np.array([0.25], dtype=np.float32)

    base, _ = os.path.splitext(input_path)
    out_path = f"{base}_nobg.webm"

    # VP9 with alpha — Chromium/Electron can decode this natively
    encode_cmd = [
        find_ffmpeg(), '-y',
        '-f', 'rawvideo', '-vcodec', 'rawvideo',
        '-s', f'{width}x{height}',
        '-pix_fmt', 'rgba',
        '-r', str(fps),
        '-i', 'pipe:0',
        '-vcodec', 'libvpx-vp9',
        '-pix_fmt', 'yuva420p',
        '-b:v', '0', '-crf', '30',
        '-auto-alt-ref', '0',  # required for VP9 alpha
        # Speed up the (otherwise single-threaded) VP9 alpha encode
        '-deadline', 'good', '-cpu-used', '4', '-row-mt', '1',
        '-threads', str(os.cpu_count() or 4),
        out_path,
    ]

    encode_proc = subprocess.Popen(
        encode_cmd, stdin=subprocess.PIPE, stderr=subprocess.DEVNULL
    )

    # Recurrent states: RVM's documented init is a single [1,1,1,1] zero tensor.
    rec = [np.zeros((1, 1, 1, 1), dtype=np.float32) for _ in range(4)]
    out_names = ['fgr', 'pha', 'r1o', 'r2o', 'r3o', 'r4o']

    frame_idx = 0
    checked_subject = False
    try:
        while True:
            ret, bgr = cap.read()
            if not ret:
                break

            rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
            small = cv2.resize(rgb, (iw, ih), interpolation=cv2.INTER_AREA) if scale < 1.0 else rgb
            inp = (small.astype(np.float32) / 255.0).transpose(2, 0, 1)[None]  # [1,3,ih,iw]

            outputs = session.run(out_names, {
                'src': inp,
                'r1i': rec[0], 'r2i': rec[1], 'r3i': rec[2], 'r4i': rec[3],
                'downsample_ratio': downsample_ratio,
            })
            pha = outputs[1][0, 0]  # [ih,iw], 0..1
            rec = outputs[2:6]

            # Subject sanity check on the first frame
            if not checked_subject:
                fg_ratio = (pha > 0.5).sum() / pha.size
                if not (0.005 <= fg_ratio <= 0.99):
                    cap.release()
                    encode_proc.stdin.close()
                    encode_proc.kill()
                    try:
                        os.unlink(out_path)
                    except Exception:
                        pass
                    return {'success': False, 'error': 'No main subject detected — cannot execute background removal'}
                checked_subject = True

            alpha = (np.clip(pha, 0.0, 1.0) * 255).astype(np.uint8)
            if scale < 1.0:
                alpha = cv2.resize(alpha, (width, height), interpolation=cv2.INTER_LINEAR)
            try:
                encode_proc.stdin.write(np.dstack([rgb, alpha]).tobytes())
            except (BrokenPipeError, OSError):
                # ffmpeg died mid-encode (codec missing, disk full) — stop feeding it.
                break
            frame_idx += 1

    finally:
        cap.release()
        try:
            if encode_proc.stdin and not encode_proc.stdin.closed:
                encode_proc.stdin.close()
        except (BrokenPipeError, OSError, ValueError):
            pass
        encode_proc.wait()

    # Zero frames read → unreadable/corrupt input (subject guard never ran).
    if frame_idx == 0:
        try:
            os.unlink(out_path)
        except Exception:
            pass
        return {'success': False, 'error': 'No frames could be read from the video'}

    # ffmpeg exited non-zero → the WebM is corrupt/partial even if it exceeds the size floor.
    if encode_proc.returncode not in (0, None):
        try:
            os.unlink(out_path)
        except Exception:
            pass
        return {'success': False, 'error': f'ffmpeg encode failed (exit {encode_proc.returncode}). VP9 alpha (libvpx-vp9) may be unavailable.'}

    if not os.path.exists(out_path) or os.path.getsize(out_path) < 1000:
        return {'success': False, 'error': 'Background removal produced no output file'}

    return {'success': True, 'filePath': out_path, 'model': 'rvm-mobilenetv3'}


def remove_background(file_path: str, **kwargs) -> dict:
    ext = os.path.splitext(file_path)[1].lower()
    if ext in IMAGE_EXTS:
        return remove_background_image(file_path, kwargs.get('model', 'u2net'))
    elif ext in VIDEO_EXTS:
        return remove_background_video(file_path)
    else:
        return {'success': False, 'error': f'Unsupported file type: {ext}'}


if __name__ == '__main__':
    args = json.loads(sys.argv[1])
    try:
        result = remove_background(
            file_path=args['filePath'],
            model=args.get('model', 'u2net'),
        )
        print(json.dumps(result))
    except Exception as e:
        import traceback
        print(json.dumps({'success': False, 'error': str(e), 'trace': traceback.format_exc()}))
