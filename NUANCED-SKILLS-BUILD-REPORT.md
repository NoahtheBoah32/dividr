# Nuanced Skills — Build Report

Built per `GOAL-3-NUANCED-SKILLS.md`. Three new DiviDr/EDITH skills, each with an
automatic (EDITH chat) path and a manual (right-panel) path. All lightweight,
on-device, no API keys, no tokens, no new heavy installs — reuses what the venv
already ships (RVM ONNX, OpenCV, MediaPipe, ultralytics/YOLO, faster-whisper).

## The three skills

### 1. Hold the World, Let One Thing Move  (`selectiveFreeze`)
The world holds on one frame while the chosen subject keeps moving through it
("she walks through frozen time"), or the subject freezes mid-motion while the
world keeps moving ("everyone's a blur, she's a statue").

- **Seamless, not a cut-out paste.** Soft RVM matte for the subject + a temporal
  clean-plate that fills the frozen subject's footprint with REAL background
  pixels sampled from frames where the moving subject has vacated that spot; only
  the tiny never-revealed sliver is inpainted. Edge is alpha-feathered.
- Proven on a real single-subject clip: between two in-region frames the ONLY
  changed pixels are the subject silhouette — the whole background is byte-frozen
  (right third 0% change). No ghost, no seam.
- EDITH: "freeze the world but keep her moving", "make the crowd freeze", "freeze
  everyone but the dancer". Manual: Hold the World panel (mode toggle, from/to).
- Backend: `src/backend/python/scripts/selective_freeze.py` (~7.5s for a 3s region).

### 2. Find Me the Moment  (`findMoment`)
CTRL-F for video — jumps the playhead straight to a moment instead of scrubbing.

- **Two instant paths, both API-free.** Spoken words → transcript grep (instant,
  uses the Whisper transcript already on the clip). A visual thing ("the car",
  "the dog") → YOLO scan with early-exit (returns in a few seconds; near-instant
  when the moment is early).
- EDITH decides which path from the phrasing. Manual: "Find a Moment" search box.
- Backend: `src/backend/python/scripts/find_moment.py` (~3–5s incl. model load).

### 3. Speed That Lives Inside the Clip  (`regionalSpeed`)
One painted region of the frame runs at its own speed while the rest stays
real-time — two speeds in a single shot, no splitting, no layers.

- **Seamless, production-level.** In-region slow-motion is motion-compensated with
  optical flow (smooth, not stuttery); the region edge is feathered.
- Proven on a real clip: brushing the left half to 35% dropped its frame-to-frame
  motion to ~0.30× while the untouched right half stayed unchanged.
- EDITH: "slow just the waterfall", "make the background crawl but keep him
  real-time". Manual: In-Frame Speed panel (speed slider, region presets, from/to).
- Backend: `src/backend/python/scripts/regional_speed.py` (~12–28s depending on region).

## Where everything lives
- Python backends: `src/backend/python/scripts/{selective_freeze,find_moment,regional_speed}.py`
- Subcommands registered in `src/backend/python/main.py`
- IPC handlers (`media:selectiveFreeze` / `media:regionalSpeed` / `media:findMoment`): `src/main.ts`
- EDITH ops (`selectiveFreeze` / `regionalSpeed` / `findMoment`): `src/frontend/features/mycelium/storeAdapter.ts`
- Op types: `src/frontend/features/mycelium/types.ts`
- EDITH prompt docs + response discipline: `src/backend/mycelium/prompts/edith-v2.md`
- Manual UI: `src/frontend/features/editor/components/properties-panel/effects/nuancedEffectsPanel.tsx`
  (mounted in `propertiesPanel.tsx` for any selected video clip; matches DiviDr —
  monochrome + green `--secondary`, shared Slider/Button/Input primitives). The
  manual buttons enqueue the SAME op EDITH emits, so the two paths can't diverge.

## Did NOT break anything
- `tsc --noEmit`: 58 errors — identical to the pre-existing baseline (no new errors).
- `vitest run`: 117 unit tests pass (the only failures are pre-existing — 2 Playwright
  e2e specs vitest can't run, 1 unrelated caption-font default test).

## Reliability gate (30× in a row, real onnx/cv2/ffmpeg, with correctness asserts)

Each run shells the real `main.py` subcommand (real RVM ONNX / OpenCV / FFmpeg),
parses the `RESULT`, and verifies the output is valid AND has the right property
(not just "didn't crash"). Runner: `C:\tmp\skills-test\run30.py`.

| Skill / mode            | Result  | Correctness assert per run                                  | ~time/run |
|-------------------------|---------|-------------------------------------------------------------|-----------|
| Hold the World — world  | 30/30   | background third byte-frozen between two in-region frames    | 7.5s |
| Hold the World — subject| 30/30   | valid non-black output, expected length                      | 15.8s |
| In-Frame Speed          | 30/30   | slowed region motion < 0.7× the untouched region            | 16.3s |
| Find the Moment — car   | 30/30   | object found, timestamp returned                             | 2.8s |
| Find the Moment — person| 30/30   | object found, timestamp returned                             | 2.8s |
| Freeze Frame — full     | 30/30   | region held as a still (two in-region frames identical)      | 1.5s |

**180/180 backend runs.** Every run also asserts a non-black mid-frame, so the
"operation is visible in the preview" requirement is verified on every output.

### EDITH chat side — verified with the real Claude CLI (6/6)
Replicated agentRuntime's exact prompt assembly (edith-v2.md + context + `User:` +
`EDITH:`) through `claude --print --model claude-opus-4-7` and checked the emitted
`OP:` line + reply. Every phrasing produced the right op, one stray-op-free
confirmation, no hallucination:
- "freeze frame 4 to 7 seconds" → `selectiveFreeze mode:full` → "Freeze-framed 4.0–7.0."
- "freeze the world… keep the person walking" → `mode:world-frozen`
- "freeze the person mid-stride… street keep moving" → `mode:subject-frozen`
- "slow just the left half to 35%" → `regionalSpeed speed:0.35 region:0,0,0.5,1`
- "jump to the part where she laughs" → `findMoment query:"she laughs"`
- "find where the car drives past" → `findMoment target:"car"`

This is the exact response style the goal asked for ("Freezeframed 6:00-12:00").

### Plain freeze-frame ("freeze a frame into a still image")
The goal requires the basic whole-frame freeze too, not only the nuanced version.
Added as `selectiveFreeze mode:"full"` — holds the whole frame as a still over the
region (no matte, ~1.5s). EDITH picks it for "freeze frame X to Y"; the manual
panel has a third "Whole frame" toggle. world-frozen / subject-frozen remain the
nuanced "keep one thing moving" modes.

Plus a renderer op-plumbing harness (`tests/visual/run.mjs nuanced-op-plumbing`):
each op applied 30× through the REAL operationEngine/store (main-process result
mocked) asserting the store updates correctly — selectiveFreeze/regionalSpeed swap
the clip source + set metadata, findMoment jumps the playhead to the right frame.

## How the user drives each skill
- **EDITH (chat):** "freeze the world but keep her walking" · "slow just the left
  side to 35%" · "jump to where she laughs" / "find the car". She emits one op,
  confirms in one line, runs nothing stray.
- **Manual (right panel, any selected video clip):** Hold the World (mode toggle +
  from/to), In-Frame Speed (speed slider + region presets + from/to), Find a Moment
  (search box). Each Apply runs the identical op.

## Notes / honest limits (no edge-case over-engineering, per the brief)
- Effects BAKE a new clip (3-min budget is met: longest is ~30s for a multi-second
  region). The region times are source-seconds, consistent with `setSpeed`.
- Hold-the-World is cleanest on a mostly-static camera (the most striking "frozen
  world" look anyway); on a hard tracking shot the clean-plate fill in the vacated
  footprint can soften slightly, hidden behind the moving subject.
- In-Frame Speed reads best when the painted boundary sits in low-motion content
  (the gap between the two things) — as the skill itself describes.
- "Freeze everyone but her" instance pick (`click`) uses YOLOv8-seg (pre-cached at
  repo root). The manual panel ships the auto-subject path; click-pick is wired for EDITH.
