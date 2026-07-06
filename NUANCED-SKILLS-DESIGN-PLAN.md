# Nuanced Skills — Design Plan (pre-build)

> Standard: `GOAL-3-NUANCED-SKILLS.md`. This is a **design plan, not built code.** No skill
> code gets written until Joaquin signs off. Produced by a 28-agent Opus 4.8 design pass
> (map the real codebase → 3 distinct approaches per skill → usability question-pyramids →
> adversarial critique → completeness critic → synthesis).

---

## Two foundation-level truths the codebase audit surfaced

**1. The motion-blur "EDITH-first gate" does not exist.** Searched the whole editor: motion
blur is a plain, always-editable slider, gated only by `isMultipleSelected`
(`videoProperties.tsx:672`). There is no `appliedBy` / `unlocked` / EDITH-activation flag on
any effect. The gating model you want is real and good — but it must be **built from scratch**,
not copied. This plan specs it.

**2. The In-Frame Speed code already on disk violates the cutout ban.** `regional_speed.py`'s
`--subject` path imports `selective_freeze._RvmMatter`, computes a per-frame alpha matte, and
intersects it with the region (`regional_speed.py:130-138`). That is exactly the
remove-and-reinsert you forbade. **Step one for skill 2 is deleting that path**, not extending it.

---

## The spine decision (resolves most blockers at once)

Every baking skill currently swaps `track.source` to the baked mp4. That means a *second* op
reads the *already-baked* file as its input — double-encoding, compounding the effect on itself,
and quietly breaking "30 times in a row" the moment a user freezes, then slows, then undoes, then
re-trims the same clip.

**Decision to lock in:** the **effect parameters are the source of truth; the baked mp4 is a
derived artifact.** On first bake, write an immutable `originalSource`. Every op (manual or EDITH)
re-bakes the **full ordered effect stack** from `originalSource ?? source`, never from the prior
output. One Python `nuancedBake` pipeline renders the stack once.

This single architectural choice dissolves blockers B1 (compounding), B2 (freeze+speed mutual
destruction), most of B3 (undo), and N4 (mode-flip re-bake) together. It is the only way the
30× guarantee survives a real, iterative edit session.

---

## Skill 1 — Hold the World, Let One Thing Move (`selectiveFreeze`)

### Chosen approach
**Temporal-difference motion-key inside a YOLO-or-lasso-localized box, with a global-motion
bouncer in front, and no Gaussian feather across the held↔live seam.** None of the three
standalone approaches ships safely; this is the blend the critique forced.

The structural defense against the cutout ban: every output pixel is a choice between two
pixel-aligned full frames of the **same scene** — the live frame at time `t` and a held plate
frozen at `freezeAt`. `out[mask>0] = live[mask>0]`, copied at identical `(x,y)`. No sprite is
lifted, no matte reinserted, no resampling, no gap to fill. In unchanged areas the plate pixel is
byte-identical to the live frame, so the worst-case seam error equals sensor noise.

**No feather by default.** A 2–3px Gaussian across the held↔live boundary *is* the ghost-ring
failure: in `freezeWorld` the live edge is a moving, motion-blurred silhouette while the plate
behind it is the old background, so blending makes a translucent halo. Feather is allowed **only
where `D < noise_floor`** (the two images already agree); where the silhouette actually disagrees
the edge is **hard**, cleaned by `morphologyEx(CLOSE)` + 1px median, never blurred.

**YOLO decides presence/count/which; motion only selects pixels inside an already-localized box.**
Raw diff/flow can't tell a person from waving foliage and can't answer "everyone but her." That
division of labor is what satisfies the ban.

### How it works (all cv2/numpy CPU, BAKE pattern)
1. **Global-motion bouncer** — `cv2.phaseCorrelate` on consecutive luma frames; median background
   displacement > ~1.5px/frame → `success:false, reason:"camera-motion"`. Runs before any plate.
2. **Plate** = the single source frame at `freezeAt` (NOT a median stack — a median absorbs a
   dwelling subject into the background and ghosts it).
3. **Box** = resolved YOLO box (auto) or rasterized lasso polygon (manual), as a uint8 mask.
4. Per frame: `D = absdiff(frame_t, plate)` luma+chroma, illumination-normalized; hysteresis
   threshold → binary; `morphologyEx(OPEN→CLOSE)`; AND with the box; 3-frame EMA → `α`.
5. **Composite** — `freezeWorld`: `out=plate; out[α>0]=frame_t[α>0]`. `freezeSubject`: inverted.
   `freezeAll`: `out=plate` everywhere (the plain freeze).

### EDITH behavior (enum named by what is HELD: `freezeWorld | freezeSubject | freezeAll`)
- **No subject named** ("freeze 3s–6s") → `"Freezing the frame from 3.0s to 6.0s."` → `freezeAll`.
- **Absent** (YOLO finds 0 of the class in window, ≤360p sampled) → `"Cannot run selective freeze. Subject not present."` → no op.
- **Camera moving** → `"This clip's camera is moving, so I can't hold the world steady. Selective freeze needs a locked-off shot."` → no op.
- **Present + stationary** → `"That subject isn't moving, so a selective freeze looks identical to a plain freeze. Freezing the whole frame instead."` → `freezeAll`.
- **Present + single + moving** → `"Holding the world frozen, keeping her moving from 4.0s to 7.0s."` → `freezeWorld` (or `freezeSubject` for the inverse).
- **Polarity unstated** → emit `freezeWorld` with `defaulted:true`; the UI shows the flip affordance (no stray chat remark).
- **Ambiguous** (2+ of the class, no qualifier) → `"Subject unclear. Consider using the Lasso tool to effectively select the desired subject."` → no op; arms the lasso.
- **Resolved by qualifier** ("the left rock", "the one rolling") → pick leftmost/largest/only-moving box, seed `click:[nx,ny]`.

### Manual / autonomy
EDITH-first gate (new): `selectiveFreeze` on the track becomes an object carrying
`appliedByEdith?: boolean`. The 3-way mode control, From/To, ramp toggle are
`disabled` until the first successful run flips the flag. **Exception:** the Lasso button arms
even before a freeze ran, because the user is supplying the selection EDITH lacked.
`LassoOverlay` is a new sibling of `PipDragOverlay`; closed-loop enforced (auto-close on
pointer-up, <3 distinct points discarded). Polygon rides the op as normalized `lasso:[[nx,ny],…]`.

### Honest limits
- Moving camera is **refused, not rescued** (the lasso can't fix parallax). EDITH declines cleanly.
- **Ramp** (slow→stop→snap) needs motion-compensated interpolation. If it blows the latency
  budget, ship v1 with **hard-cut freezes only** (the pyramid allows ramp as optional). Never fake
  deceleration with a plate-dissolve — it reads as double-exposure.
- Static lasso doesn't track a fast-traveling subject; default the box to the union of YOLO
  motion-boxes across the window. Subject-colored-as-background spots leave a small hole that
  `CLOSE` mitigates, not perfects.

---

## Skill 2 — Speed That Lives Inside the Clip (`regionSpeed`)

### Chosen approach
**Region-locked speed.** The user paints (or names) a *fixed frame-area*; only that area runs at a
different rate, the rest stays real-time. This is the only no-cutout answer. **Step one is
deletion:** drop the `subject` branch and the `_RvmMatter` import from the script, stop the IPC
handler forwarding `--subject`, strip `subject:true` at the op layer. With that gone, the mask is a
stationary stencil in source coordinates and every output frame is one in-place composite:
`out = retimed*w + passthrough*(1-w)`, `w` a feathered weight map. No pixel leaves its frame.

**Why not subject-locked:** to retime a subject that walks out of its painted box you must isolate
its pixels every frame — the ban by another name. We refuse it cleanly and offer the senior-editor
inversion instead: keep the subject real-time, slow the **complement** of a generously-drawn
polygon. The slowed thing (the backdrop) never leaves its own pixels.

### How it works
Reuses the verified BAKE spine (`regional_speed.py` already does Farneback motion-compensated
interpolation for true slow-mo in-betweens, pipes bgr24 → libx264/yuv420p, re-muxes audio). Four
changes: (1) de-RVM; (2) add a `polygon` mask branch (`fillPoly` + feather) and `invert`; (3) an
**integral-conserving ramp** — the remap curve must satisfy `∫ speed dt = n_frames` over the
window so the region is phase-aligned at the end (a naive cosine leaves a position pop); (4) crop
Farneback to the region bbox at ≤720p and cache flow per source-pair for cost.

### EDITH behavior (apex question: does the slowed thing stay in its frame-area or walk out?)
- **Absent** → `Cannot run region speed. "{target}" not found in this clip.` (no op)
- **Region-locked, nameable** (waterfall fills a third) → `Slowing the waterfall region to 35% from 0.0s to 4.0s. Rest stays real-time.` → `regionSpeed{region:"left", speed:0.35, feather:8, rampFrames:6}`
- **Region named but mixed content** → `The left region also covers the runner. Draw the area to slow, or say "include him."` → arms lasso.
- **Subject stationary** → `He stays in one spot here. Draw around him and I'll run his speed at 50% from 1.0s to 3.0s.` → on lasso-close: `regionSpeed{region:"lasso", polygon:[...]}`.
- **Subject traverses (the invert move)** → `He moves across the frame, so I'll keep him real-time and slow everything around him. Draw around him to mark what stays fast.` → `regionSpeed{invert:true,...}`.
- **Insists on a moving subject's own timeline** → `Can't give a subject its own speed while it crosses the frame without cutting it out, which looks broken. I can slow everything except him, or slow him where he holds still. Which?` (no op)
- **Region has no motion** → `Region has no motion to retime.` (no op)

### Manual / autonomy
MVP ships rect/ellipse presets (already work); the speed Slider, presets, feather, and a Lasso
button gate behind `appliedByEdith`. `LassoOverlay` is shared with skill 1.

### Honest limits
- **Does not track a subject across the frame.** The invert path is the answer and is *not
  perfectly seamless* — fast motion over a slowed background shows a soft halo at the feather.
  Mitigation is UX (over-draw, cap background ≥ ~0.4×), not a heavier model.
- One speed per region. Latency is honest: 10–40s for a few-second 1080p slow-mo region
  (Farneback-bound); sub-5s for speed-ups / short / low-res. EDITH never promises "a few seconds"
  for slow-mo.

---

## Skill 3 — Find Me the Moment (`findMoment`)

### Chosen approach
**Hybrid: transcript-first, visual fallback.** Transcript carries the dominant "the part where she
says X" case at sub-50ms over the already-cached Whisper transcript; the visual scan only spends
compute when speech misses. **It bakes nothing and swaps no source** — it ends in
`setCurrentFrame`. No plate, no matte, no reinsertion. The visual pass reads frames purely as
scoring signals, then discards every pixel and returns an integer second.

**The lasso/region branch is cut entirely for this skill** — it's the slowest disambiguation route
and a normalized-polygon→python affordance is the exact input shape of the banned matting pipeline.
Spatial disambiguation is done in *text* ("the one on the left") mapped to candidate bbox-x.

### How it works (two read-only passes)
- **Pass A — transcript (pure JS):** term-coverage fraction (query terms matched / total),
  tie-broken by mean word confidence, snapped to the **word-level** `start`. Every segment scoring
  > 0 is a candidate.
- **Pass B — visual (only on a weak Pass A):** reuse the existing verified `media:detectScenes`
  FFmpeg output to bound scenes (not a new histogram segmenter); inside each scene use
  `compareHist` to reject near-duplicates, **YOLOv8n** for object presence ("car", "dog"),
  Farneback/frame-diff energy for the motion signature of "drives past" / "laughs". Cap
  `max_samples=60`, early-exit on single-find.

Candidates merge, dedupe (collapse hits <1.5s apart), rank. Determinism for 30× is real: immutable
transcript cache + deterministic CV on fixed CPU input → same query, same frame every run.

### EDITH behavior
- **Which clip?** (2+ tracks, no name match) → `Which clip — the interview or the b-roll?` (no op)
- **Single clear hit** → `The woman laughing is at 1:32.` → `findMoment{clipName,query}` + snap
- **Absent** → `No match for "woman laughing" in this clip.` (no op)
- **Ambiguous** (≥2 candidates with `score ≥ 0.7 × topScore`) → `Found 6 spots of a woman laughing. Which — near the start, after she sits down, or the close-up?` (no op; candidates cached)
- **Discriminator resolves it** → `The close-up of the woman laughing is at 2:47.` → snap
- **Still ties** → `Closest is at 2:47. Step through the rest in the panel.` → snap
- **No transcript AND no detectable subject** → `Cannot search this clip. No transcript or detectable subject yet.` (no op)

One disambiguation rule, tuned once (`score ≥ 0.7 × topScore` → comparable; 2+ comparable → ask).
The ask is the feature, not a fallback — she never snaps to a guess.

### Manual / autonomy — the candidate stepper
The always-live blind-search input is **demoted, not deleted.** New track field
`findMoment?: { candidates, lastQuery, activatedByEdith }` (find can write track state without
swapping source). Before EDITH runs, the input + Find button are greyed. After EDITH's first run
flips `activatedByEdith`, the cached candidates populate a `◀ 1 / N ▶` stepper that walks the
playhead across all matches. Manual refines between EDITH's ranked candidates; it never runs its
own blind search. EDITH stays the entry point.

### Honest limits
- **No semantic/emotion search** ("the bittersweet goodbye"). This is CTRL-F, not search-by-meaning.
- **"Laughing" is approximate** — YOLO resolves to `person` + scene-level motion peak, not a
  verified facial-action classifier. Not building bbox-gated facial micro-motion in v1.
- No cross-clip search; long-form (>10 min) scene decode may exceed the 5s budget (DiviDr's common
  case is short reels). Cold path (untranscribed clip) needs a Whisper pass first — see N3.

---

## Shared infrastructure: Lasso selector + EDITH-first gating

Shared by skills 1 and 2. Build once; the skills become thin consumers.

### Closed-loop lasso
New `LassoOverlay.tsx`, sibling of `PipDragOverlay` inside the centered `actualWidth × actualHeight`
letterbox box. A region that drives an op MUST be a closed, non-self-intersecting polygon of area
> 0. **No open-lasso state:** freehand auto-closes on `pointerup` (snap-to-start within 12px, else
auto-close anyway); box and ellipse are closed by construction. Validate with the shoelace formula:
reject if `area < 0.0008` or `< 3` points (flash `--destructive` 400ms, discard, no op). Three modes
via the existing `Seg` control, default **Box**. Coordinates: divide pointer by the overlay rect for
normalized `[0,1]`; `getBoundingClientRect()` already absorbs zoom+pan+letterbox. Store normalized
only; Python multiplies by `preview.canvasWidth/Height`. **Arming pauses playback** (you can't trace
a moving subject on a playing video) and parks the playhead on a representative frame.

### Shared op-schema additions
```ts
region?: {
  shape: 'box' | 'ellipse' | 'poly';
  bbox: [number, number, number, number];   // x,y,w,h — always present (cheap reject + crop)
  points?: Array<[number, number]>;          // poly only, ordered
};                                            // all normalized [0,1]
appliedByEdith?: boolean;                     // gate flag
```
The lasso is interpreted as the union of the subject's motion-boxes across `[start,end]`, not the
single drawn frame, so a moving subject stays bounded.

### Gating
`appliedByEdith` is written **only in `applyOp`'s success branch** — the same `updateTrack` that
swaps the source. Manual Apply and EDITH both flow through `operationEngine.enqueue → applyOp`, so
neither path is privileged. The **Apply button stays enabled** (it's the first-run trigger); only
the *refine* controls and "Draw region" gate behind the flag.

### Re-bake, undo, performance
Effect params are truth; the baked mp4 is derived (the spine decision). Write immutable
`originalSource` on first bake; every re-bake reads it, never the prior output. Undo snapshots
`{source, previewUrl, originalSource, region, appliedByEdith}` atomically. Performance: bake only
the affected region via ffmpeg segment concat (`-c copy` the untouched head/tail, re-encode only
`[start,end]`) — a 3s effect on a 60s clip in seconds, not a full re-encode.

---

## Cross-cutting open questions (completeness critic) — these need decisions before building

### Blockers
- **B1 / B2 — re-bake compounding & freeze+speed mutual destruction.** Resolved by the spine
  decision above (params-as-truth + `originalSource` + one `nuancedBake` stack). **Confirm this model.**
- **B3 — undo of a baked op.** Must snapshot `source`/`previewUrl`/`originalSource`/effect-params as
  one atomic unit. **Needs a read of the actual history slice before building** (does undo deep-snapshot track objects or only timeline structure?).
- **B4 — trim/split after a bake invalidates source-second timestamps.** Pick one: (a) re-bake on
  trim/split, or (b) forbid re-trimming a baked region and have EDITH say "trim before applying."
  **Your call.**

### Important
- **I1 — long-clip bake cost.** Full-length re-encode for a 2–3s effect violates "never minutes."
  Fix = region-only bake via segment concat. **Confirm we build the segment-concat path, not full re-encode.**
- **I2 / I3 — lasso is drawn on one frame but bounds a moving region.** Default to union-of-motion-
  boxes; arming pauses playback and seeks to the region midpoint.
- **I4 — `findMoment` writes no effect, so gate + candidates must persist on the track** (not an
  ephemeral CustomEvent). Specced.
- **I5 — clip resolution when one source is split into several timeline clips.** EDITH resolves by
  the clip under the playhead and names it in her confirm line.
- **I6 — failed-bake error path.** Wire the python `ERROR|`/reject to a clean EDITH decline line and
  guarantee a failed op leaves no half-swapped source.

### Nice-to-have
- **N1 — timeline visibility chip** (snowflake / gauge badge on a baked clip).
- **N2 — shared defaults block** (feather, ramp frames, min area, motion threshold) so the three
  skills don't drift.
- **N3 — cold-transcript path** for find (EDITH says "Transcribing this clip first — one moment.").
- **N4 — re-bake on explicit Apply only**, not on every segment toggle.

---

## Proposed build order (after sign-off)

1. **Spine + shared infra first** — `originalSource` + params-as-truth + one `nuancedBake` stack;
   the `LassoOverlay`; the `appliedByEdith` gate. Everything else depends on it.
2. **Skill 1 (Hold the World)** rebuilt on motion-key (delete RVM reliance), 30× gate on a person,
   a glass, and a car clip.
3. **Skill 2 (In-Frame Speed)** — delete the `--subject` RVM path, ship region-locked + invert, 30×
   gate including a ramp phase-continuity check.
4. **Skill 3 (Find the Moment)** — candidate list + scoring + stepper + gate, 30× determinism gate.
5. **Regression** — confirm the existing 49 ops/skills still pass (tsc baseline, vitest).

Each skill is gated at 30× on BOTH the EDITH chat path and the manual path before moving on.
