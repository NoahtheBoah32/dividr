#!/usr/bin/env python3
"""
organize_media — plan how to sort the media library into folders.

This is the reasoning behind EDITH's "organize my media" pass. It takes the
library inventory (one JSON object per item) and returns an assignment of every
item to ONE folder, drawn from a FIXED vocabulary of general folder names. The
fixed vocabulary is the whole trick against "weird folder names": the model is
never asked to invent a name, only to pick a category, so the folders are always
clean and predictable.

Two screening passes, mirroring how the user described it:
  1. NAME pass (deterministic, instant): most footage self-labels — camera codes
     (C2685, MVI_, DJI_), screen recordings, AI-gen names, photos, audio,
     subtitles. These resolve with high confidence and never touch the model.
  2. VISION pass (only the leftovers): for clips whose NAME is opaque AND that are
     NOT on the timeline, grab ONE frame and let Claude classify it into the SAME
     fixed categories. Timeline ("main") footage is never frame-referenced — its
     name is treated as representative, per the spec.

Anything still unresolved (vision unsure, vision unavailable, opaque audio) lands
in "Miscellaneous" — the user's explicit choice for low-confidence items. Nothing
is dropped: every non-reference item gets exactly one folder.

Input  (--input <path>): JSON list of
  {"id","name","type":"video|audio|image|subtitle","origin"?,"onTimeline":bool,"path"}
Output (RESULT| line): {"success",true,"assignments":{id:folder},"folders":[{name,count}],"summary":{...}}

The vision pass reuses frame_reference._claude_vision (subscription CLI, no API
key). Pass --no-vision to run the deterministic core alone (used by tests).
"""
import json
import os
import re
import sys
import tempfile

# Canonical folder vocabulary. Folder NAMES only ever come from this list, so the
# organizer can never produce an odd or over-specific name. Order here is also the
# display order the UI falls back to (Miscellaneous always last).
CAMERA = "Camera Footage"
SCREEN = "Screen Recordings"
GENERATED = "Generated"
STOCK = "Stock Footage"
BROLL = "B-Roll"
STILLS = "Stills"
AUDIO = "Audio"
SUBTITLES = "Subtitles"
MISC = "Miscellaneous"

FOLDER_ORDER = [CAMERA, SCREEN, GENERATED, STOCK, BROLL, STILLS, AUDIO, SUBTITLES, MISC]

# Categories the VISION pass is allowed to choose. Kept tight on purpose: a crisp,
# unambiguous choice (filmed vs screen vs synthetic vs photo) is far more reliable
# than asking the model to also guess fuzzy human distinctions like "is this b-roll".
VISION_CATEGORIES = [CAMERA, SCREEN, GENERATED, STILLS]


def _log(stage, progress, message=""):
    print(f"PROGRESS|{json.dumps({'stage': stage, 'progress': progress, 'message': message})}", flush=True)


# ---------------------------------------------------------------------------
# Pass 1 — name classification (deterministic). Returns (folder | None, confident).
# None folder = opaque, hand to the vision pass. The order of checks matters:
# strongest, least-ambiguous signals first.
# ---------------------------------------------------------------------------
_SCREEN_RE = re.compile(
    r"screen[\s_-]?(?:recording|cast|capture|cap|grab)|screencast|\bscreen[\s_-]?rec\b"
    r"|\bobs\b|camtasia|\bloom\b|bandicam|snagit|\bcapture\b.*\bscreen\b",
    re.I,
)
_SCREENSHOT_RE = re.compile(r"screen[\s_-]?shot|screenshot|^scr[\s_-]?\d", re.I)
_GENERATED_RE = re.compile(
    r"midjourney|\bmj[_-]\d|dall[\s._-]?e|dalle|\bsora\b|runway(?:ml)?|\bkling\b|\bpika\b"
    r"|\bveo\b|\bluma\b|comfyui|stable[\s_-]?diffusion|\bsdxl\b|\bsd[\s_-]?\d|firefly"
    r"|leonardo|ideogram|seedance|hailuo|nano[\s_-]?banana|\bgen(?:erated|eration)?[_-]?\d"
    r"|ai[\s_-]?gen|^output[_-]|^frame[\s_]?\d+\b|render(?:ed|_)?",
    re.I,
)
_CAMERA_RE = re.compile(
    r"^c\d{3,4}\b|^mvi[_-]|^dji[_-]|^gopr|^gx01|^gh0\d|^gp\d|^vid[_-]?\d|^mov[_-]?\d"
    r"|^pxl_|^00\d\d\b|^dsc[_-]?\d|^a\d{3,4}\b|handphone|iphone|\bdslr\b|sony|canon|nikon"
    r"|^clip[_-]?\d|^take[_-]?\d|recording[_-]?\d|^rec[_-]?\d",
    re.I,
)
_BROLL_RE = re.compile(r"\bb[\s_-]?roll\b", re.I)
_STOCK_RE = re.compile(r"pixabay|pexels|\bstock\b|shutterstock|istock|envato|storyblocks", re.I)


def classify_by_name(item):
    """Deterministic first pass. Returns (folder, confident: bool). folder=None means
    'opaque, send to vision'. confident=True suppresses the vision pass for this item."""
    name = (item.get("name") or "").strip()
    low = name.lower()
    ftype = item.get("type") or "video"
    origin = (item.get("origin") or "").lower()

    # Hard type signals first — audio/subtitle can never be a video category.
    if ftype == "subtitle":
        return SUBTITLES, True
    if ftype == "audio":
        return AUDIO, True

    # Strong provenance / explicit-name signals (apply to video and image alike).
    if origin == "generated" or _GENERATED_RE.search(low):
        return GENERATED, True
    if origin == "stock" or _STOCK_RE.search(low):
        return STOCK, True
    if _BROLL_RE.search(low):
        return BROLL, True

    if ftype == "image":
        # A screenshot is still a still image; everything image-typed is a Still.
        return STILLS, True

    # video
    if _SCREEN_RE.search(low) or _SCREENSHOT_RE.search(low):
        return SCREEN, True
    if _CAMERA_RE.search(low):
        return CAMERA, True

    # Opaque video name. If it's on the timeline we are told NOT to frame-reference
    # it (its name is "representative"), so we make the best name-only call: footage
    # the user is actively editing is overwhelmingly real camera footage.
    if item.get("onTimeline"):
        return CAMERA, True

    return None, False  # off-timeline + opaque -> vision pass decides


# ---------------------------------------------------------------------------
# Pass 2 — vision classification of the opaque, off-timeline leftovers.
# ---------------------------------------------------------------------------
def _extract_frame(path, ftype, out_path, width=400):
    """One representative frame -> small jpg. Returns True on success. Never raises."""
    try:
        import cv2
    except Exception:
        return False
    try:
        if ftype == "image":
            img = cv2.imread(path)
        else:
            cap = cv2.VideoCapture(path)
            if not cap.isOpened():
                return False
            total = cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0
            # ~18% in: skips black intros / slates without risking the very end.
            target = int(max(0, min(total - 1, total * 0.18))) if total else 0
            cap.set(cv2.CAP_PROP_POS_FRAMES, target)
            ok, img = cap.read()
            if not ok:
                cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
                ok, img = cap.read()
            cap.release()
            if not ok:
                img = None
        if img is None:
            return False
        h, w = img.shape[:2]
        if w > width:
            img = cv2.resize(img, (width, max(1, int(h * width / w))))
        cv2.imwrite(out_path, img, [cv2.IMWRITE_JPEG_QUALITY, 80])
        return True
    except Exception:
        return False


def _canon_category(text):
    t = (text or "").strip().lower()
    if "camera" in t or "filmed" in t:
        return CAMERA
    if "screen" in t:
        return SCREEN
    if "generat" in t or "synthetic" in t or "cgi" in t or "ai" == t:
        return GENERATED
    if "still" in t or "photo" in t:
        return STILLS
    return None


def vision_classify(items, batch=8):
    """Classify opaque clips by ONE frame each, in batches, into VISION_CATEGORIES.
    Reuses frame_reference._claude_vision (subscription CLI). Returns {id: folder}.
    Any clip we can't frame, send, or parse is simply left out (caller -> Miscellaneous)."""
    out = {}
    if not items:
        return out
    try:
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        from frame_reference import _claude_vision
    except Exception:
        return out  # vision unavailable -> all leftovers fall through to Miscellaneous

    # Extract frames first; drop any we can't read.
    framed = []  # (item, jpg_path)
    for it in items:
        p = it.get("path") or ""
        if not p or not os.path.exists(p):
            continue
        jpg = os.path.join(tempfile.gettempdir(), f"_org_{os.getpid()}_{len(framed)}.jpg")
        if _extract_frame(p, it.get("type") or "video", jpg):
            framed.append((it, jpg))

    cat_list = "\n".join(
        {
            CAMERA: "- Camera Footage: filmed by a real camera or phone — real people, places, or objects in the physical world (talking heads, handheld, b-roll of real scenes).",
            SCREEN: "- Screen Recordings: a capture of a computer or phone SCREEN — a browser, website, web app, software UI, document, report, slide deck, spreadsheet, code editor, dashboard, or gameplay HUD. If you are looking at a screen, window, webpage, or document of ANY kind, choose this — even when the layout looks clean, polished, or professionally designed.",
            GENERATED: "- Generated: AI-generated or fully synthetic IMAGERY — a photorealistic or illustrated picture or scene of people, places, objects, or art that was clearly produced by an AI image/video model or a 3D/CGI render. NOT a screenshot of software, a webpage, or a text document.",
            STILLS: "- Stills: a static photograph or single real image with no implied motion.",
        }[c]
        for c in VISION_CATEGORIES
    )

    try:
        for i in range(0, len(framed), batch):
            chunk = framed[i:i + batch]
            roster = "\n".join(
                f"Image {j + 1} — clip filename: \"{it.get('name', '')}\""
                for j, (it, _) in enumerate(chunk)
            )
            prompt = (
                f"You are sorting raw clips into folders for a video editor. You have been shown "
                f"{len(chunk)} image(s), each ONE still frame from a different clip, in order:\n\n{roster}\n\n"
                f"Classify EACH image into EXACTLY ONE of these categories:\n{cat_list}\n\n"
                f"Tie-breaker: a document, report, webpage, slide, or app shown on a screen is ALWAYS "
                f"Screen Recordings, never Generated, no matter how clean or designed it looks. Generated "
                f"is only for synthetic photos/illustrations/renders of the real-looking world, not software.\n"
                f"Use the filename only as a weak hint — judge mainly by what the frame shows.\n"
                f"Reply with one line per image and NOTHING else, exactly:\n"
                f"<image number> | <Category>\n"
                f"Use the category spelling exactly as written above. If you genuinely cannot tell, "
                f"write: <image number> | Unsure"
            )
            paths = [jpg for _, jpg in chunk]
            _log("processing", 40 + int(40 * i / max(1, len(framed))), f"Looking at {len(chunk)} clips")
            reply = _claude_vision(paths, prompt, timeout=90) or ""
            for line in reply.splitlines():
                m = re.match(r"\s*(\d+)\s*[|\-:]\s*(.+)", line)
                if not m:
                    continue
                idx = int(m.group(1)) - 1
                if 0 <= idx < len(chunk):
                    folder = _canon_category(m.group(2))
                    if folder:
                        out[chunk[idx][0]["id"]] = folder
    finally:
        for _, jpg in framed:
            try:
                os.remove(jpg)
            except OSError:
                pass
    return out


# ---------------------------------------------------------------------------
# Assembly
# ---------------------------------------------------------------------------
def organize(items, use_vision=True):
    assignments = {}
    opaque = []

    for it in items:
        folder, confident = classify_by_name(it)
        if folder and confident:
            assignments[it["id"]] = folder
        else:
            opaque.append(it)

    vision_used = 0
    if opaque and use_vision:
        _log("processing", 35, f"Frame-referencing {len(opaque)} unnamed clips")
        vmap = vision_classify(opaque)
        vision_used = len(vmap)
        for it in opaque:
            assignments[it["id"]] = vmap.get(it["id"], MISC)
    else:
        for it in opaque:
            assignments[it["id"]] = MISC

    # Counts per folder, in canonical display order, dropping empties.
    counts = {}
    for f in assignments.values():
        counts[f] = counts.get(f, 0) + 1
    folders = [{"name": f, "count": counts[f]} for f in FOLDER_ORDER if f in counts]
    # Any non-canonical name (shouldn't happen) appended so nothing is lost.
    for f in counts:
        if f not in FOLDER_ORDER:
            folders.append({"name": f, "count": counts[f]})

    return {
        "success": True,
        "assignments": assignments,
        "folders": folders,
        "summary": {
            "total": len(items),
            "folderCount": len(folders),
            "visionUsed": vision_used,
            "misc": counts.get(MISC, 0),
            "byFolder": {f["name"]: f["count"] for f in folders},
        },
    }


def handle_args(args):
    try:
        with open(args.input, "r", encoding="utf-8") as fh:
            items = json.load(fh)
    except Exception as e:
        print(f"RESULT|{json.dumps({'success': False, 'error': f'bad inventory: {e}'})}", flush=True)
        return
    if not isinstance(items, list):
        print(f"RESULT|{json.dumps({'success': False, 'error': 'inventory must be a list'})}", flush=True)
        return
    items = [it for it in items if it.get("id")]
    result = organize(items, use_vision=not getattr(args, "no_vision", False))
    print(f"RESULT|{json.dumps(result)}", flush=True)


if __name__ == "__main__":
    # Direct test entry: organize_media.py <inventory.json> [--no-vision]
    class _A:
        pass

    a = _A()
    a.input = sys.argv[1] if len(sys.argv) > 1 else ""
    a.no_vision = "--no-vision" in sys.argv[1:]
    handle_args(a)
