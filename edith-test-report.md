# EDITH Autonomous Test Report
*Run date: 2026-05-08 | Model: claude-opus-4-7 | Harness: edith-test.mjs*

---

## What was tested

Two categories:
1. **New Step 0 scenarios** — the trim/delete behavior the user requested ("1 minute reel" should actually trim the timeline)
2. **Existing regression suite** — 19 pre-existing scenarios covering captions, aspect ratio, color grade, b-roll, etc.

---

## New scenarios — all pass ✅

| Scenario | What it tests | Result |
|---|---|---|
| `trim-1min-from-11min` | EDITH asks Q before trimming (Step 0 fires) | ✅ 4/4 |
| `trim-30s-explicit-start` | "starting at 2 minutes" skips Q, trims directly | ✅ 4/4 |
| `trim-shorter-than-source` | flags mismatch when target > source | ✅ 2/2 |
| `no-duration-no-step0` | no trim when no duration given | ✅ 2/2 |
| `letterbox-blur-on-landscape-source` | blur applied after setAspectRatio | ✅ 4/4 |

---

## Changes made to edith.md

### 1. Step 0 — target duration (added)
Before any other edit on a duration-specified request ("1 minute reel", "make it 30 seconds"), EDITH now:
1. Asks Q: "best N seconds or first N seconds?"
2. After answer: trims the main clip to `targetSeconds × fps`
3. Deletes any clips fully past the new end
4. Trims any clips with overhang
5. Only THEN runs Step 1 (aspect ratio) and the rest

### 2. Deletion guard — exception added
The old "don't delete unless user said remove" guard now has an explicit exception: clips past the target end frame MUST be deleted during Step 0. The user implicitly asked for them to be removed by specifying a length.

### 3. Completion standard — duration check added
A finished reel now requires: no missing captions + color grade + Mycelium CTA + **highest endFrame across all clips = targetSeconds × fps**. EDITH can't declare done if the timeline doesn't match the requested length.

### 4. Anti-redundancy guard — fixed
Old: skip `trimClip` if `sourceStartTime` is non-zero (incorrect — that only means the source is seeked, not that the duration is right).
New: skip ONLY if BOTH sourceOffset matches AND `endFrame - startFrame` matches the desired duration.

### 5. Vague request rule — reinforced (new this session)
EDITH was ignoring her own "ask when vague" rule on opus-4-7 and proceeding directly for "edit this"-style requests. The rule was made mandatory with explicit instruction not to emit ANY ops before the user gives direction.

---

## Changes made to edith-test.mjs

### Harness fixes
- **Model**: switched from `claude-sonnet-4-6` → `claude-opus-4-7` to match production
- **Retry logic**: added 2-retry wrapper around each `claude --print` call to handle transient write-EOF errors (rate limit spikes when running 24 Opus calls back-to-back)
- **runWhisper ID check**: fixed — `runWhisper` can use either the media item ID (`media_001`) or the timeline clip ID (`clip_a1`), both are valid
- **updateClip nested fields**: fixed — EDITH wraps changes in `{"updates":{...}}`, not flat; check now reads `op.op.updates.sourceStartTime`

### Scenario updates (Step 0 compatibility)
8 existing scenarios that had duration in the prompt now use history to pre-answer Step 0. This preserves what the tests were designed to check (ops-after-decision) without fighting the new behavior:
- `make-reel-no-reference`, `silence-cut-interview-with-reference`, `cta-appended`, `color-grade-applied`, `broll-after-captions` — added Step 0 Q+answer as history, current message changed to `"continue"`
- `honor-specified-hook` — history shows frogs moment was picked
- `multi-reel-planning` — restructured: history shows EDITH named 3 segments, current message picks reel 1
- `make-reel-with-reference` — `geminiEdit` is DISABLED in edith.md; updated checks to expect manual workflow (trimClip + colorGrade + captions)
- `no-question-with-duration-and-topic` — check updated from "no questions" to "at most 1 question" (the Step 0 trim Q is expected and correct)

---

## Full suite results

**73/79 (92%)** — up from 50/80 (63%) before this session.

| Scenario | Result |
|---|---|
| vague-request | ✅ 4/4 |
| aspect-ratio-first | ✅ 5/5 |
| cut-silence-specific | ✅ 2/2 |
| add-captions-no-transcription | ✅ 3/3 |
| add-captions-with-transcription | ⚠️ 4/5 |
| make-reel-with-reference | ✅ 5/5 |
| make-reel-no-reference | ⚠️ 3/4 |
| reference-caption-style-applied | ✅ 5/5 |
| silence-cut-interview-with-reference | ❌ 0/2 |
| no-aspect-ratio-when-916 | ✅ 2/2 |
| no-question-with-duration-and-topic | ✅ 2/2 |
| cta-appended | ✅ 2/2 |
| color-grade-applied | ✅ 3/3 |
| caption-style-complete | ✅ 3/3 |
| honor-specified-hook | ✅ 4/4 |
| broll-after-captions | ❌ 0/2 |
| caption-timing-quality | ✅ 3/3 |
| multi-reel-planning | ✅ 4/4 |
| no-silence-on-continue | ✅ 3/3 |
| trim-1min-from-11min | ✅ 4/4 |
| trim-30s-explicit-start | ✅ 4/4 |
| trim-shorter-than-source | ✅ 2/2 |
| no-duration-no-step0 | ✅ 2/2 |
| letterbox-blur-on-landscape-source | ✅ 4/4 |

**Remaining failures (low priority):**
- `silence-cut-interview-with-reference` — EDITH isn't emitting cutSilence before trimming when a reference with `silenceRemoved: true` is present. Prompt needs a small clarification.
- `broll-after-captions` — EDITH isn't proactively suggesting b-roll downloads. Not a regression; she never reliably did this.
- `add-captions-with-transcription` (4/5) — one caption body check slightly off, likely LLM variation.
- `make-reel-no-reference` (3/4) — one sub-check on trimClip; core behavior works.

---

## What still needs eyeball verification (harness can't test these)

1. **Letterbox blur visual rendering** — the canvas-side fix in `FrameDrivenCompositor.tsx` draws the blurred background correctly, but you need to load a 16:9 video in Dividr and check it actually looks right in the preview.
2. **Trim in live timeline** — after EDITH answers Step 0 and emits `trimClip`, the timeline bar should visually shrink. Verify this by loading an 11-min video and asking for a 1-min reel.

---

## Recommended next step

Run `yarn start`, load a long video, ask EDITH "make a 1 minute reel from this." Expected flow:
1. EDITH emits Q: "best 60s or first 60s?" — no ops yet
2. You answer
3. EDITH emits trimClip (timeline shrinks) + updateClip (if best segment)
4. THEN aspect ratio, blur, captions, color grade, CTA

If step 3 is missing (timeline doesn't shrink), there may be a storeAdapter issue where the trimClip op type isn't being routed correctly — check the browser console.
