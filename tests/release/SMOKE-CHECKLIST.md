# Stable Release — 10-Minute Manual Smoke Checklist

Run after the automated gate is green (`node tests/release/run-gate.mjs`) and before
promoting to `stable`. Use a real project with at least one video clip. Any ✗ blocks
the promotion.

## Core editing (4 min)
- [ ] Open an existing project — timeline, media library, and preview all populate
- [ ] Import a new video via the media panel — thumbnail appears, clip is playable
- [ ] Drag the clip to the timeline, play — video + audio in sync in the preview
- [ ] Cut the clip (razor / split), delete one half — gap behaves as expected, undo restores it
- [ ] Drag the timeline horizontal scrollbar and Shift+wheel — panning is smooth, no jumps
- [ ] Zoom in/out — ruler, clips, and playhead stay aligned

## Audio + SFX (2 min)
- [ ] Audio Tools panel: search a sound, click play-preview — it plays and toggles off
- [ ] Drag an SFX row onto the timeline — it lands at the drop position on a free row

## EDITH (3 min)
- [ ] Open EDITH, send "what do you see on my timeline right now?" — she answers with real timeline facts
- [ ] Paste a .txt file into the chat — it becomes an attachment chip; ask her to read it — she quotes it
- [ ] Ask her for one simple edit (e.g. "cut the first 2 seconds") — the op runs, timeline updates
- [ ] Interrupt/stop works — she stops, app stays responsive

## Export (1 min)
- [ ] Export a short (~10s) section to MP4 — file plays in an external player, captions/SFX present if used

## After pulling an update (testers)
- [ ] Fully quit and relaunch the app (main-process changes never hot-reload)
