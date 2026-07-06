#!/usr/bin/env python3
"""
Find me the moment — "CTRL-F for video" (visual search).

Type what you're looking for and jump the playhead straight there. This is the
VISUAL half; the spoken-word half is an instant transcript grep done in JS.

Every visual find goes through Claude vision frame-referencing
(frame_reference.find_moment_vision): ANY subject, scene, or action — not a fixed
object list — clarity-first selection (earliest as a tie-break), and long clips split into parallel
~5.5-min batches so the per-second frame density holds. "motion" is the one
instant special case (frame-difference energy peak). No API key — vision uses the
Claude subscription CLI; motion is pure OpenCV.

RESULT|{json}:
  {"success": true, "foundAtSec": 42.0, "confidence": "high", "label": "a person fishing"}
  {"success": true, "foundAtSec": null, "label": "a person fishing"}   # not found
"""

import json
import sys


def find_motion(input_path, interval=0.25, start=0.0):
    """Return the second of peak motion energy (frame-to-frame difference)."""
    import cv2
    import numpy as np  # noqa: F401 — cv2 returns ndarrays; numpy must be importable

    cap = cv2.VideoCapture(input_path)
    if not cap.isOpened():
        return {"success": False, "error": f"Cannot open video: {input_path}"}
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) or 0
    duration = (total / fps) if total else 0.0
    step = max(1, int(round(interval * fps)))

    prev = None
    best_t, best_e = 0.0, -1.0
    i = int(start * fps)
    cap.set(cv2.CAP_PROP_POS_FRAMES, i)
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        small = cv2.resize(cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY), (160, 90))
        if prev is not None:
            e = float(cv2.absdiff(small, prev).mean())
            if e > best_e:
                best_e, best_t = e, round(i / fps, 3)
        prev = small
        i += step
        cap.set(cv2.CAP_PROP_POS_FRAMES, i)
        if total and i >= total:
            break
    cap.release()
    if best_e < 0:
        # Fewer than two readable frames (start past content / 1-frame / corrupt source) — no
        # motion was actually measured. Return a clean miss, not a confident bogus "0:00".
        return {"success": True, "foundAtSec": None, "label": "motion"}
    return {"success": True, "foundAtSec": best_t, "label": "motion", "energy": round(best_e, 2)}


def _vision_find(args):
    try:
        from scripts import frame_reference          # when src/backend/python is on the path
    except ImportError:
        import frame_reference                        # when run directly from the scripts/ dir
    return frame_reference.find_moment_vision(
        args.input, args.target, start=args.start, end=getattr(args, "end", -1) or -1)


def handle_args(args):
    """Route a visual find. "motion" → instant frame-difference energy peak; everything else →
    Claude vision frame-referencing (ANY subject/scene/action, clarity-first, long-form batching).
    Spoken-word finds are answered upstream by the JS transcript grep before this script runs."""
    target = (args.target or "").strip().lower()
    if target in ("motion", "movement"):
        result = find_motion(args.input, start=args.start)
    else:
        try:
            result = _vision_find(args)
        except Exception as e:  # noqa - vision unavailable -> clean miss
            result = {"success": True, "foundAtSec": None, "label": target, "error": f"vision-failed: {e}"}
    print(f"RESULT|{json.dumps(result)}", flush=True)


if __name__ == "__main__":
    payload = json.loads(sys.argv[1]) if len(sys.argv) > 1 else {}

    class _A:
        pass

    a = _A()
    a.input = payload["filePath"]
    a.target = payload.get("target", "person")
    a.interval = float(payload.get("interval", 0.5))
    a.start = float(payload.get("start", 0.0))
    a.end = float(payload.get("end", -1) or -1)
    a.find_all = bool(payload.get("findAll", False))
    handle_args(a)
