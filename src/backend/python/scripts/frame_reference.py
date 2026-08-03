#!/usr/bin/env python3
"""
Frame-referencing vision — "Claude looks at the footage."

Open-vocabulary replacement for YOLO (which only knows ~80 COCO classes). Claude
vision runs through the `claude` CLI on the user's SUBSCRIPTION (no API key), so it
identifies ANYTHING — an ampalaya vine, a glass tipping, a specific action — not a
fixed class list.

Two capabilities, mirroring how Joaquin does it by hand:
  - find_moment_vision(clip, query, start, end): build a CONTACT SHEET of frames
    sampled across time, each stamped with its timestamp, and ask Claude which
    timestamp shows the query. -> temporal localization.
  - locate_subject(clip, subject, at_sec): overlay a red COORDINATE GRID on one
    frame and ask Claude for the subject's bounding box. -> spatial localization
    (a region box for selective freeze / in-frame speed).

RESULT|{json}.
"""
import base64
import json
import os
import queue
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time

MODEL = "claude-sonnet-4-6"  # Sonnet: ~7-10s find, open-vocab, accurate. Switchable.


def _log(stage, progress, message=""):
    print(f"PROGRESS|{json.dumps({'stage': stage, 'progress': progress, 'message': message})}", flush=True)


def _claude_bin():
    return shutil.which("claude") or shutil.which("claude.cmd") or "claude"


# ---------------------------------------------------------------------------
# Warm Claude sessions — the big speed win. A fresh `claude --print` re-BOOTS (~9s)
# every call; the boot, not the looking, is the bottleneck. A kept-alive streaming
# session pays the boot ONCE, then each look is ~5s. We boot a small POOL once per
# find and reuse those sessions for every scan batch AND the verify. (No API key —
# still the subscription CLI. Images are sent inline so there's no file-open loop.)
# ---------------------------------------------------------------------------
def _img_block(path):
    with open(path, "rb") as f:
        data = base64.b64encode(f.read()).decode()
    return {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": data}}


class _WarmClaude:
    """One kept-alive `claude` streaming session. Boot once; each .ask() reuses it."""

    def __init__(self, model=MODEL):
        cmd = [_claude_bin(), "--input-format", "stream-json", "--output-format", "stream-json",
               "--verbose", "--model", model, "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}']
        self.p = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                  stderr=subprocess.DEVNULL, text=True, bufsize=1)
        self._q = queue.Queue()
        threading.Thread(target=self._reader, daemon=True).start()

    def _reader(self):
        try:
            for line in self.p.stdout:
                self._q.put(line)
        except Exception:  # noqa
            pass
        self._q.put(None)

    def ask(self, content, timeout=70):
        """content = list of content blocks (text / image). Returns the model's text ('' on failure)."""
        try:
            self.p.stdin.write(json.dumps({"type": "user", "message": {"role": "user", "content": content}}) + "\n")
            self.p.stdin.flush()
        except Exception:  # noqa - dead session
            return ""
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                line = self._q.get(timeout=max(0.1, deadline - time.monotonic()))
            except queue.Empty:
                break
            if line is None:  # process ended
                break
            try:
                ev = json.loads(line)
            except Exception:  # noqa
                continue
            if ev.get("type") == "result" and isinstance(ev.get("result"), str):
                return ev["result"]
        return ""

    def close(self):
        for fn in (lambda: self.p.stdin.close(), self.p.terminate):
            try:
                fn()
            except Exception:  # noqa
                pass


class _WarmPool:
    """A small fixed pool of warm sessions. .ask() borrows a free one (blocks if all busy),
    so N concurrent callers run on N sessions in parallel; the verify reuses a freed one."""

    def __init__(self, size, model=MODEL):
        self._sessions = [_WarmClaude(model) for _ in range(max(1, size))]
        self._free = queue.Queue()
        for s in self._sessions:
            self._free.put(s)

    def ask(self, content, timeout=70):
        s = self._free.get()
        try:
            return s.ask(content, timeout)
        finally:
            self._free.put(s)

    def close(self):
        for s in self._sessions:
            s.close()


def _claude_vision(image_paths, prompt, timeout=60):
    """One-shot Claude vision via the subscription CLI. Accepts ONE path or a LIST of paths —
    several images EACH keep their own resolution budget, so a handful of small sheets read far
    sharper than one big sheet (which Claude downscales to a single budget). MCP disabled for a
    faster cold start; the Read tool views the local images (no API key needed)."""
    if isinstance(image_paths, str):
        image_paths = [image_paths]
    cmd = [
        _claude_bin(), "--print", "--model", MODEL,
        "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
        "--allowedTools", "Read",
    ]
    reads = "\n".join(f"Read {p}" for p in image_paths)
    full = f"{reads}\n\nRead ALL {len(image_paths)} image(s) above before answering.\n\n{prompt}"
    try:
        p = subprocess.run(cmd, input=full, capture_output=True, text=True,
                           timeout=timeout, shell=False)
        return (p.stdout or "").strip()
    except subprocess.TimeoutExpired:
        return ""
    except Exception as e:  # noqa
        return f"__ERR__ {e}"


# ---------------------------------------------------------------------------
# Contact sheet (temporal)
# ---------------------------------------------------------------------------
def _build_contact_sheet(clip, start, end, n, out_path, cols=4, tile=(384, 216)):
    import cv2
    import numpy as np

    tw, th = tile
    cap = cv2.VideoCapture(clip)
    if not cap.isOpened():
        return None
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) or 0
    dur = (total / fps) if total else 0.0
    s = max(0.0, float(start))
    e = float(end) if (end and end > 0) else dur
    if e <= s:
        e = dur if dur > s else s + 1.0
    times = [s + (e - s) * i / max(1, n - 1) for i in range(n)]

    tiles = []
    for t in times:
        cap.set(cv2.CAP_PROP_POS_FRAMES, int(round(t * fps)))
        ok, f = cap.read()
        if not ok:
            continue
        f = cv2.resize(f, (tw, th))
        label = f"{int(t // 60)}:{int(t % 60):02d}"
        cv2.rectangle(f, (0, 0), (86, 26), (0, 0, 0), -1)
        cv2.putText(f, label, (5, 19), cv2.FONT_HERSHEY_SIMPLEX, 0.66, (255, 255, 255), 2)
        cv2.rectangle(f, (0, 0), (tw - 1, th - 1), (70, 70, 70), 1)
        tiles.append((round(t, 2), f))
    cap.release()
    if not tiles:
        return None

    rows = (len(tiles) + cols - 1) // cols
    grid = np.zeros((rows * th, cols * tw, 3), np.uint8)
    for i, (_, f) in enumerate(tiles):
        r, c = divmod(i, cols)
        grid[r * th:(r + 1) * th, c * tw:(c + 1) * tw] = f
    cv2.imwrite(out_path, grid)
    return [t for t, _ in tiles]


def _parse_ts(out):
    m = re.search(r"TIMESTAMP\s*=\s*(\d+):(\d+)", out or "")
    if (not m) or ("NONE" in (out or "").upper()):
        return None
    return int(m.group(1)) * 60 + int(m.group(2))


def _parse_conf(out):
    m = re.search(r"CONFIDENCE\s*=\s*(high|medium|low)", out or "", re.I)
    return m.group(1).lower() if m else "medium"


# Rules that fix the real failures: clarity-first selection, look-alike/missing-key rejection,
# compound queries, flash-rejection. (Earliest is enforced as a tie-break in code by _pick, below.)
_FIND_RULES = (
    "Rules:\n"
    "- Pick the frame where the described thing is UNMISTAKABLY happening — the clearest, most complete "
    "instance. If a KEY element of the description is missing (asked for 'catches a fish' but NO fish is "
    "visible; 'playing piano' but no piano), it does NOT count, however suggestive the pose looks.\n"
    "- Do NOT accept a look-alike: a paddle/oar is not a fishing rod, a stick is not a bat. If you can't "
    "tell the real thing from a look-alike in a frame, rate that frame CONFIDENCE=low.\n"
    "- If the description is a subject DOING an action, BOTH must be clearly visible in the SAME frame.\n"
    "- CLARITY beats time: a clearly-correct later frame outranks a weak or ambiguous earlier one. Use "
    "the earliest ONLY to break ties between frames that match EQUALLY clearly.\n"
    "- Ignore a lone isolated flash; prefer a sustained moment that is plainly the described scene.\n"
    "- If the footage genuinely does NOT contain this, reply NONE. Answering NONE is correct — never "
    "force a guess or settle for the closest-looking frame."
)


_BATCH_SPAN = 330.0      # one contact-sheet "batch" covers ~5.5 min (≈28 frames @ ~one per 11s)
_MAX_BATCH_WORKERS = 6   # batches scanned concurrently per wave (≤~33 min = one wave); early-exit after


# Confidence rank for selection. THE RULE (_pick): a LATER match overrides an EARLIER one only if it
# is >=2 ranks clearer — i.e. only an unmistakable HIGH beats an early weak LOW; an earlier MEDIUM-or-
# better always wins. This satisfies BOTH constraints at once: a clear later scene beats an early
# look-alike (LOW), AND an early real scene beats a late cameo (a HIGH cameo can't override an earlier
# MEDIUM). Clarity is primary; time breaks ties and protects early real matches.
_CONF_RANK = {"high": 0, "medium": 1, "low": 2}


def _pick(cands):
    """cands: list of (snapped_sec, confidence). Earliest in time wins UNLESS a later candidate is at
    least 2 confidence ranks clearer. Returns (sec, confidence) or None."""
    if not cands:
        return None
    cs = sorted(cands, key=lambda c: c[0])  # by timestamp (time-priority / earliest)
    best = cs[0]
    for c in cs[1:]:
        if _CONF_RANK[c[1]] <= _CONF_RANK[best[1]] - 2:  # only an unmistakable HIGH overrides an early LOW
            best = c
    return best


def _locate_one(pool, clip, query, bs, be, tag="", dense=False):
    """Build SEVERAL small timestamped contact sheets for [bs, be] and hand them to a warm Claude
    session (from the pool) in ONE inline call. Multiple images EACH keep their own resolution
    budget, so each frame is ~520px (sharp)
    instead of ~270px (one big sheet gets downscaled to a single budget — the 'analyzing 2 pixels'
    problem). Returns a LIST of (snapped_sec, confidence) candidates so the cross-clip ranker can
    enforce clarity-first + earliest-tie-break in CODE. Sheets deleted right after (nothing stored)."""
    span = be - bs
    # Default density (~1 frame / 11s) is tuned for find-the-moment on long footage. Dense mode
    # (~1 frame / 2.5s) is for VERIFYING short downloaded clips, where the thing being checked
    # may be a few-second action that sparse sampling steps right over.
    n = (max(24, min(48, int(round(span / 2.5)) or 24)) if dense
         else max(12, min(30, int(round(span / 11)) or 12)))  # total frames across this batch
    M = 6  # frames per sub-sheet — kept small so each frame stays large within the per-image budget
    K = max(1, (n + M - 1) // M)  # number of small sub-sheets, handed to Claude together
    sheets, times = [], []
    for i in range(K):
        ss, se = bs + span * i / K, bs + span * (i + 1) / K
        path = os.path.join(tempfile.gettempdir(), f"_fr_b{tag}_{i}_{os.getpid()}.jpg")
        ts = _build_contact_sheet(clip, ss, se, M, path, cols=3, tile=(520, 292))
        if ts:
            sheets.append(path)
            times.extend(ts)
    if not sheets:
        return []
    prompt = (
        f"You have been shown {len(sheets)} contact-sheet image(s), together holding {len(times)} "
        f"video frames in time order, each labeled with its timestamp (M:SS) in the top-left.\n\n"
        f"Across ALL of them, find every moment that genuinely matches: \"{query}\".\n\n"
        f"{_FIND_RULES}\n\nList up to 3 matches, CLEAREST first, one per line, EXACTLY like:\n"
        f"M:SS | high       (use medium or low instead of high when less certain)\n"
        f"If a frame only loosely resembles it or is missing a key element, rate it low or leave it out. "
        f"If NOTHING genuinely matches, reply with the single word: NONE"
    )
    content = [_img_block(p) for p in sheets] + [{"type": "text", "text": prompt}]
    out = pool.ask(content)
    for p in sheets:
        try:
            os.remove(p)
        except OSError:
            pass
    cands = []
    for line in (out or "").splitlines():
        tm = re.search(r"(\d+):(\d+)", line)
        if not tm:
            continue
        cm = re.search(r"\b(high|medium|low)\b", line, re.I)
        conf = cm.group(1).lower() if cm else "low"  # a line we can't fully parse is not unmistakable
        sec = int(tm.group(1)) * 60 + int(tm.group(2))
        cands.append((min(times, key=lambda t: abs(t - sec)), conf))
    return cands


def _verify_frame(pool, clip, sec, query):
    """Skeptical FULL-RESOLUTION check (on a warm session) of the exact frame the contact sheet picked. The locate pass
    runs on tiny ~384px tiles, where a green water bottle reads as a fish-on-a-rod; this re-looks at
    the real frame, large, and explicitly rules out look-alikes. Returns True only on a clear YES —
    so a confident contact-sheet misread (a bottle called a fish) is caught instead of trusted."""
    import cv2
    cap = cv2.VideoCapture(clip)
    cap.set(cv2.CAP_PROP_POS_FRAMES, int(round(sec * (cap.get(cv2.CAP_PROP_FPS) or 30.0))))
    ok, frame = cap.read()
    cap.release()
    if not ok:
        return False
    h, w = frame.shape[:2]
    if w > 1100:  # keep it large enough that a fish vs a bottle is still distinguishable
        frame = cv2.resize(frame, (1100, max(1, int(h * 1100 / w))))
    path = os.path.join(tempfile.gettempdir(), f"_fr_v_{os.getpid()}.jpg")
    cv2.imwrite(path, frame)
    prompt = (
        f"Look carefully at this full video frame.\n\n"
        f"Is this GENUINELY the scene: \"{query}\"?\n\n"
        f"Say YES if the described subject and setting are really present — the action does NOT have to "
        f"be at its exact peak. Judge the SCENE, not a split-second pose: a character SITTING AT a piano "
        f"counts as 'playing the piano' even if their hands aren't on the keys this instant; a person with "
        f"a caught fish counts even mid-motion.\n"
        f"Say NO only if it is actually a DIFFERENT thing: a look-alike (a bottle or can is not a fish, a "
        f"paddle is not a fishing rod), a different subject, or the key subject/object is simply not "
        f"present in the frame at all.\n\n"
        f"Answer with ONLY one word: YES or NO."
    )
    out = pool.ask([_img_block(path), {"type": "text", "text": prompt}])
    try:
        os.remove(path)
    except OSError:
        pass
    m = re.search(r"\b(YES|NO)\b", out or "", re.I)
    return bool(m) and m.group(1).upper() == "YES"


def find_moment_vision(clip, query, start=0.0, end=-1.0, pool=None, dense=False):
    """Open-vocab 'find the part where X' via timestamped contact sheets ('frame canvas').
    Short footage scans as one sheet; long footage splits into ~5.5-min batches scanned in parallel
    waves, so a 28-min clip keeps a 5-min clip's frame density without going linearly slower.
    Selection is CLARITY-FIRST with earliest as a tie-break, enforced in code by _pick (a later match
    beats an earlier one only if it is >=2 confidence ranks clearer): a clear later scene beats an
    early look-alike, AND an early real scene beats a late cameo. A non-high winner is verified with
    the red grid; if the grid disconfirms it, we fall through to the next-best candidate before giving
    up. Each sheet is one small JPEG deleted right after the call — nothing stored, <=28 frames/batch."""
    if not os.path.exists(clip):
        return {"success": False, "error": f"File not found: {clip}"}
    import cv2
    cap = cv2.VideoCapture(clip)
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) or 0
    clip_dur = (total / (cap.get(cv2.CAP_PROP_FPS) or 30.0)) if total else 0.0
    cap.release()
    s = max(0.0, float(start))
    e = float(end) if (end and end > 0) else clip_dur
    if e <= s:
        e = clip_dur if clip_dur > s else s + 1.0
    span = e - s

    import math
    nb = 1 if span <= _BATCH_SPAN else int(math.ceil(span / _BATCH_SPAN))
    # Boot ONE pool for the whole find — sized to the scan's parallelism. Every scan batch and the verify
    # reuse these sessions, so the ~9s CLI boot is paid once per find, not per call. The pool is closed in
    # the finally below, so NOTHING stays resident between finds (0 idle RAM — no warm daemon).
    own_pool = pool is None  # always true today; kept so a caller could hand us a pool to reuse
    if own_pool:
        # Capped at 4 (not 6) so the transient RAM spike during a find stays ~1.3GB instead of ~2GB; >=2
        # lets the parallel verify run concurrently. Each Claude CLI session is ~326MB, hence the cap.
        pool = _WarmPool(min(max(nb, 2), 4))
    try:
        cands = []
        if span <= _BATCH_SPAN:
            _log("processing", 25, f"Scanning for “{query}”")
            cands = _locate_one(pool, clip, query, s, e, dense=dense)
        else:
            # Long-form: time-ordered batches scanned in PARALLEL WAVES across the warm pool. Stop as
            # soon as the current best (_pick) is MEDIUM-or-better: by the +-2-rank rule nothing in a
            # later (later-in-time) wave can beat it. A merely-LOW best keeps scanning (a later HIGH
            # could still override), so an early real scene is never lost while the common case (a
            # solid first-wave match) still terminates fast.
            from concurrent.futures import ThreadPoolExecutor, as_completed
            bounds = [(s + span * i / nb, s + span * (i + 1) / nb) for i in range(nb)]
            _log("processing", 30, f"Scanning {nb} batches (~{int(span // 60)} min) for “{query}”")
            W = _MAX_BATCH_WORKERS
            for w0 in range(0, nb, W):
                with ThreadPoolExecutor(max_workers=W) as ex:
                    futs = [ex.submit(_locate_one, pool, clip, query, bounds[i][0], bounds[i][1], str(i), dense)
                            for i in range(w0, min(w0 + W, nb))]
                    for f in as_completed(futs):
                        try:
                            cands.extend(f.result())
                        except Exception:
                            pass
                best = _pick(cands)
                if best is not None and _CONF_RANK[best[1]] <= 1:  # MEDIUM+ can't be beaten by a later wave
                    break

        if not cands:
            return {"success": True, "foundAtSec": None, "label": query}

        # Verify the top candidates with a FULL-RESOLUTION skeptical look — EVERY pick, HIGH included,
        # because the worst misses (a bottle read as a fish) come back HIGH from the tiny tiles. We run
        # the top few IN PARALLEL across the warm pool (same checks as before, just concurrent) and
        # commit to the HIGHEST-RANKED one that passes — so a None / multi-candidate result no longer
        # pays ~5-10s per rejection in sequence. Order is preserved: _pick ranking decides the winner.
        from concurrent.futures import ThreadPoolExecutor
        top, rest = [], list(cands)
        while rest and len(top) < 4:
            p = _pick(rest)
            if p is None:
                break
            top.append(p)
            rest = [c for c in rest if c != p]
        _log("processing", 80, "Verifying at full resolution")
        with ThreadPoolExecutor(max_workers=max(1, len(top))) as ex:
            oks = list(ex.map(lambda pc: _verify_frame(pool, clip, pc[0], query), top))
        for (sec, conf), ok in zip(top, oks):  # top is already in best-first order
            if ok:
                out_conf = "medium" if conf == "low" else conf  # verified; floor a LOW pick at medium
                return {"success": True, "foundAtSec": float(sec), "box": None,
                        "confidence": out_conf, "label": query, "model": MODEL}

        return {"success": True, "foundAtSec": None, "label": query, "confidence": "low"}
    finally:
        if own_pool:
            pool.close()
        # Frame hygiene: every sheet/verify JPG is os.remove'd right after its model call on the happy
        # path, so peak disk during a find is only a few small JPGs. This sweep is the safety net — it
        # guarantees NONE survive even if a find errors mid-scan, so the user's temp dir never grows.
        # All our temp files are named _fr_*<pid>.jpg in the system temp dir; one find = one process.
        import glob
        for _leftover in glob.glob(os.path.join(tempfile.gettempdir(), f"_fr_*{os.getpid()}.jpg")):
            try:
                os.remove(_leftover)
            except OSError:
                pass


# ---------------------------------------------------------------------------
# Grid overlay (spatial)
# ---------------------------------------------------------------------------
def _grid_on(frame, cols=12, rows=8):
    import cv2

    f = frame.copy()
    h, w = f.shape[:2]
    for c in range(1, cols):
        cv2.line(f, (int(w * c / cols), 0), (int(w * c / cols), h), (0, 0, 255), 1)
    for r in range(1, rows):
        cv2.line(f, (0, int(h * r / rows)), (w, int(h * r / rows)), (0, 0, 255), 1)
    return f


def locate_subject_frame(frame_bgr, subject):
    """Grid-overlay one in-memory BGR frame and ask Claude for the subject's box.
    Returns a normalized 'x,y,w,h' string, or None if absent/failed. Used by the freeze
    and speed bakes (they already hold the frame) so no re-read of the clip is needed."""
    import cv2

    img = os.path.join(tempfile.gettempdir(), f"_fr_grid_{os.getpid()}.jpg")
    cv2.imwrite(img, _grid_on(frame_bgr))
    prompt = (
        f"This video frame has a red coordinate grid overlaid (~12 columns x 8 rows) "
        f"to help you reference position. Give the TIGHT bounding box around: {subject}. "
        f"Reply with ONLY one line: BOX=x,y,w,h  where x,y,w,h are normalized 0-1 "
        f"(x,y = top-left corner of the box). If the subject is not present: BOX=NONE"
    )
    out = _claude_vision(img, prompt)
    try:
        os.remove(img)
    except OSError:
        pass
    m = re.search(r"BOX\s*=\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)", out)
    if (not m) or ("NONE" in out.upper()):
        return None
    x, y, w, h = (max(0.0, min(1.0, float(g))) for g in m.groups())
    if w <= 0 or h <= 0:
        return None
    return f"{x:.3f},{y:.3f},{w:.3f},{h:.3f}"


def locate_subject_path(frames, subject, samples=3):
    """For a MOVING subject (a train sweeping, a car driving), one box at one frame slices
    it — the subject leaves the box. Locate it at a few moments across the window via Claude
    vision (which cleanly tells the subject apart from other movers) and UNION the boxes into
    its full swept PATH. Returns a normalized 'x,y,w,h' covering the whole sweep, or None.
    Inside this region the per-frame motion mask keeps the moving subject and freezes anything
    static (a person standing in the path stays frozen — only motion goes live)."""
    n = len(frames)
    if n == 0:
        return None
    idxs = sorted({max(0, min(n - 1, int(n * f))) for f in (0.2, 0.5, 0.8)})[:samples]
    boxes = []
    for i in idxs:
        b = locate_subject_frame(frames[i], subject)
        if b:
            boxes.append([float(v) for v in b.split(",")])
    if not boxes:
        return None
    x0 = min(b[0] for b in boxes)
    y0 = min(b[1] for b in boxes)
    x1 = max(b[0] + b[2] for b in boxes)
    y1 = max(b[1] + b[3] for b in boxes)
    return f"{x0:.3f},{y0:.3f},{x1 - x0:.3f},{y1 - y0:.3f}"


def locate_subject(clip, subject, at_sec=0.0):
    import cv2

    cap = cv2.VideoCapture(clip)
    if not cap.isOpened():
        return {"success": False, "error": f"File not found: {clip}"}
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    cap.set(cv2.CAP_PROP_POS_FRAMES, int(round(float(at_sec) * fps)))
    ok, f = cap.read()
    cap.release()
    if not ok:
        return {"success": False, "error": "Could not read frame"}
    _log("processing", 40, f"Claude locating “{subject}”")
    box = locate_subject_frame(f, subject)
    return {"success": True, "box": box, "label": subject, "model": MODEL}


def handle_args(args):
    if args.mode == "find":
        r = find_moment_vision(args.input, args.query, start=args.start, end=args.end)
    else:
        r = locate_subject(args.input, args.query, at_sec=args.start)
    print(f"RESULT|{json.dumps(r)}", flush=True)


if __name__ == "__main__":
    payload = json.loads(sys.argv[1]) if len(sys.argv) > 1 else {}

    class _A:
        pass

    a = _A()
    a.mode = payload.get("mode", "find")
    a.input = payload["filePath"]
    a.query = payload.get("query") or payload.get("subject") or payload.get("target", "")
    a.start = float(payload.get("start", payload.get("startSeconds", 0)) or 0)
    a.end = float(payload.get("end", payload.get("endSeconds", -1)) or -1)
    handle_args(a)
