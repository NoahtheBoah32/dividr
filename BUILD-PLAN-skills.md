# Build Plan — Transcript Editor + Voice Isolation Curve

Scope: ADD two skills to DiviDr. Do not remove/break existing UI. Both gated behind an EDITH op.
Validation target: any clip with voice + background. Senior-editor bug pass must report ZERO verified errors.

## Decisions (locked)
- Word delete = ripple (close gap), per WHOLE word only, ctrl-z restores. Derived "deleted" state from timeline coverage (undo just works).
- Voice isolation preview = REAL-TIME via Web Audio graphic-EQ graph driven by the curve; live AnalyserNode spectrogram. Export = ffmpeg `equalizer` chain (same band map). No heavy models, no API keys.
- Scope = whole clip in the timeline.
- Both UIs in `AudioProperties` (shows for audio tracks AND video clips via forceTrackId). Transcript = Clipchamp architecture, monochrome grays, no purple. Curve = green on gray.

## Tap points (verified)
- Audio plays via `MultiAudioOverlay.tsx` `sourceAudioElementsRef` HTMLAudioElement per source. Video element is `muted=true`. Gate isolation on `request.track.voiceIsolation` like `noiseReductionEnabled` (line ~367).
- Transcript data already exists: `mediaItem.cachedKaraokeSubtitles.transcriptionResult.segments[].words[]` (word.start/end seconds, produced by `transcribe.py` word_timestamps=True). EDITH `transcribe` op populates it.
- Ripple model: storeAdapter `deleteSegment` (1106-1176) split/remove/ripple. splitTrack in tracksSlice.
- Undo: deep clone of tracks (undoRedoSlice) auto-covers new fields. Use beginGroup/endGroup for one step.

## Tasks
1. [ ] Types: `voiceIsolation` on track (track.types.ts).
2. [ ] Pure logic + node tests: curve sampling (Catmull-Rom yAt), EQ band mapping (voiceness->dB), source-time->timeline-frame, transcript coverage derivation.
3. [ ] `voiceIsolationEngine.ts` singleton (AudioContext + per-source EQ graph + analyser + curve LUT live update).
4. [ ] Wire engine into MultiAudioOverlay (attach on enabled, live curve, resume on play, bypass when disabled, cleanup).
5. [ ] `VoiceIsolationCurve.tsx` (draggable curve port + presets + EDITH auto + live analyser viz). Green/gray.
6. [ ] `TranscriptEditor.tsx` (Clipchamp list, second timestamps, per-word delete -> ripple, coverage-derived strikethrough). Gray.
7. [ ] Store actions: `deleteTimelineRange(from,to)` (no-anim ripple), voiceIsolation update.
8. [ ] AudioProperties: mount both sections, gated. Never remove existing controls.
9. [ ] EDITH op `isolateVoice` (storeAdapter + edith-v2.md). Transcript unlock note.
10. [ ] Export: ffmpeg equalizer chain from curve in audioHandling.ts.
11. [ ] tsc clean. App validation via Playwright/CDP, multiple runs (transcribe->delete->undo; isolate->drag->export-measure).
12. [ ] Bug-catcher subagent workflow (senior editors, read-only). Verify every claim. Fix. Re-verify ZERO.
