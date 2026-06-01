# Dividr vs CapCut — honest comparison

*Built from the Dividr codebase (commit `3fd75ec`). For comparing on your phone while the laptop's down.*

---

## The one-line truth

**CapCut runs on your phone. Dividr does not — and isn't built to.** Dividr is a desktop Electron app (Windows/Mac/Linux only, per `forge.config.ts`). So this isn't "which is better on mobile" — it's "what each tool is *for*."

- **CapCut** = a polished, general-purpose editor you can use anywhere, with a giant library of effects/templates/music.
- **Dividr** = a purpose-built machine for turning raw footage into **Instagram Reels automatically**, driven by an AI agent crew (FRIDAY/ARTHUR/EDITH), tuned for Mycelium's permaculture content.

---

## Where Dividr wins

These come straight from the code and have no real CapCut equivalent:

- **AI agent auto-editing.** You talk to FRIDAY in a chat panel; it emits live edit ops onto the timeline (`agentRuntime.ts`, `friday.md`). "Make 3 reels from this" → it cuts segments, writes captions, drops b-roll, adds the CTA. CapCut has AI helpers, but nothing that *operates the whole timeline* conversationally.
- **Reel-specific automation ops:** `cutSilence`, `zoomToFace`, `setBroll`, `analyzeMotion`, `scanVideo`, `setSpeed`, `buildCaptions`, `renderGraphic`.
- **Motion analysis pipeline** — MediaPipe pose detection w/ energy/punch/jump events (`motionanalyze.py`), face/object tracking with hold-then-ease-to-center (`facezoom.py`), and a live skeleton overlay in preview (`SkeletonOverlay.tsx`).
- **Self-correcting QA loop** — `qaChecker.ts` runs programmatic + vision checks after edits (caption position, duplicate b-roll, black gaps); `edithLessons.ts` remembers fixes so the same mistake isn't repeated.
- **Style matching from reference videos** (`claudeReferenceAnalyzer.ts`, `geminiAnalyzer.ts`) — analyzes a reference reel's caption style/highlight pattern and matches it.
- **Local & private.** Transcription (`faster-whisper`), noise reduction (DeepFilterNet) run on your machine. No cloud upload of footage.
- **Opinionated caption standard baked in** — ALL CAPS, yellow keyword highlight, 4-word phrases, 65%-from-top. Consistent Mycelium look every time.

## Where CapCut wins

- **It runs on your phone.** Right now. That's the whole reason we're here.
- **Massive content library** — effects, stickers, transitions, trending templates, licensed music/sounds.
- **Zero setup** — no `yarn install`, no Python, no FFmpeg/torch environment.
- **Cloud + cross-device** — start on phone, finish on desktop, share instantly.
- **Maturity** — millions of users, constant updates, polished UX on the small details.

---

## Feature-by-feature

| Capability | Dividr | CapCut |
|---|---|---|
| **Runs on phone** | ❌ desktop only | ✅ iOS/Android/web/desktop |
| Timeline / multi-track | ✅ video, audio, image, text, subtitle | ✅ |
| Auto captions / transcription | ✅ faster-whisper (local) | ✅ (cloud) |
| AI agent that edits *for* you | ✅ FRIDAY/ARTHUR/EDITH | ❌ (only assist features) |
| Auto silence removal | ✅ `cutSilence` | ⚠️ limited |
| Auto zoom-to-face / tracking | ✅ YOLO + CSRT | ⚠️ basic auto-zoom |
| Motion / pose analysis | ✅ MediaPipe + skeleton | ❌ |
| Noise reduction | ✅ DeepFilterNet (local) | ✅ |
| Effects / stickers / templates | ❌ minimal | ✅ huge library |
| Stock music / sound library | ❌ | ✅ large, licensed |
| Hardware-accel export | ✅ nvenc/qsv/vaapi/videotoolbox/amf | ✅ |
| Subtitle export | ✅ srt / ass / vtt | ⚠️ limited |
| Karaoke captions | ✅ | ✅ |
| Privacy (no cloud upload) | ✅ fully local | ❌ cloud-based |
| Setup friction | ⚠️ Node + Python + FFmpeg | ✅ install & go |
| Cost | free / open (yours) | free + paid Pro tier |

---

## Bottom line

If the goal is **edit a video on your phone today** → CapCut, no contest. Dividr literally can't.

If the goal is **batch-produce on-brand Mycelium Reels with minimal manual work, privately, on a desktop** → that's exactly what Dividr is built for, and CapCut can't match the agent-driven workflow.

They're not really competitors. CapCut is the everywhere-editor; Dividr is your custom Reel factory that happens to need a real computer.

**Fastest unblock:** borrow a charger or any desktop, run `yarn install && yarn start`, and you're in Dividr. Until then, CapCut on the phone is the right call.
