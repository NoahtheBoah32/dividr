import { describe, it, expect, vi, beforeEach } from 'vitest';
import { flattenWords, matchPhraseInWords, type TranscriptionResult } from './transcriptEditUtils';

/**
 * Store-level tests for Transcript Surgery (Skill 1).
 *
 * These drive the real surgery core (transcriptSurgery.ts) against an in-memory
 * model of the videoEditor store that faithfully reproduces the three behaviors
 * the surgery relies on:
 *   - addTrack({type:'video'})  → creates the linked video+audio PAIR (no manual audio)
 *   - splitTrack                → splits the linked audio partner in lockstep
 *   - removeTrack               → cascades to the linked partner
 * so we can prove the timeline math (ripple-open, insert, ripple-close) without Electron.
 */

let idc = 1;
const nid = () => 't' + idc++;

// A single main video clip + its linked audio, both covering the whole source.
const FPS = 30;
const SENT =
  "He was going after me and I didn't know what to do He was really running after me it was very scary but I think now is a better time to relax";
const WORDS = SENT.split(' ').length; // 32
const WORD_DUR = 0.4;
const TOTAL_FRAMES = Math.round(WORDS * WORD_DUR * FPS); // 384

function makeTranscript(): TranscriptionResult {
  const toks = SENT.split(' ');
  const words = toks.map((w, i) => ({
    word: w,
    start: i * WORD_DUR,
    end: i * WORD_DUR + WORD_DUR,
  }));
  return {
    segments: [{ start: 0, end: WORDS * WORD_DUR, text: SENT, words }],
  };
}

function freshTimeline() {
  return [
    {
      id: 'main_v',
      type: 'video',
      source: 'C:/vid.mp4',
      mediaId: 'm1',
      trackRowIndex: 0,
      startFrame: 0,
      endFrame: TOTAL_FRAMES,
      sourceStartTime: 0,
      sourceDuration: TOTAL_FRAMES,
      isLinked: true,
      linkedTrackId: 'main_a',
      muted: false,
    },
    {
      id: 'main_a',
      type: 'audio',
      source: 'C:/vid.mp4',
      trackRowIndex: 0,
      startFrame: 0,
      endFrame: TOTAL_FRAMES,
      sourceStartTime: 0,
      sourceDuration: TOTAL_FRAMES,
      isLinked: true,
      linkedTrackId: 'main_v',
    },
  ];
}

function makeStore(tracks: any[]) {
  return {
    tracks,
    timeline: { fps: FPS, currentFrame: 0 },
    mediaLibrary: [{ id: 'm1', source: 'C:/vid.mp4', type: 'video' }],
    groups: 0,
    beginGroup() {
      this.groups++;
    },
    endGroup() {
      this.groups--;
    },
    updateTrack(id: string, patch: any) {
      const t = this.tracks.find((x: any) => x.id === id);
      if (t) Object.assign(t, patch);
    },
    removeTrack(id: string) {
      const t = this.tracks.find((x: any) => x.id === id);
      const kill = new Set<string>([id]);
      if (t?.isLinked && t.linkedTrackId) kill.add(t.linkedTrackId);
      this.tracks = this.tracks.filter((x: any) => !kill.has(x.id));
    },
    splitTrack(id: string, frame: number) {
      const t = this.tracks.find((x: any) => x.id === id);
      if (!t || frame <= t.startFrame || frame >= t.endFrame) return;
      const rightId = nid();
      const right: any = {
        ...t,
        id: rightId,
        startFrame: frame,
        endFrame: t.endFrame,
        sourceStartTime: (t.sourceStartTime || 0) + (frame - t.startFrame) / FPS,
      };
      if (t.isLinked && t.linkedTrackId) {
        const lk = this.tracks.find((x: any) => x.id === t.linkedTrackId);
        if (lk && frame > lk.startFrame && frame < lk.endFrame) {
          const lkRightId = nid();
          const lkRight: any = {
            ...lk,
            id: lkRightId,
            startFrame: frame,
            endFrame: lk.endFrame,
            sourceStartTime: (lk.sourceStartTime || 0) + (frame - lk.startFrame) / FPS,
            linkedTrackId: rightId,
          };
          lk.endFrame = frame;
          lk.linkedTrackId = t.id;
          right.linkedTrackId = lkRightId;
          this.tracks.push(lkRight);
        }
      }
      t.endFrame = frame;
      this.tracks.push(right);
    },
    async addTrack(td: any) {
      const id = nid();
      const dur = td.endFrame - td.startFrame;
      if (td.type === 'video') {
        const audioId = nid();
        this.tracks.push({
          ...td,
          id,
          type: 'video',
          trackRowIndex: td.trackRowIndex ?? 0,
          isLinked: true,
          linkedTrackId: audioId,
          startFrame: td.startFrame,
          endFrame: td.startFrame + dur,
        });
        this.tracks.push({
          ...td,
          id: audioId,
          type: 'audio',
          trackRowIndex: td.trackRowIndex ?? 0,
          isLinked: true,
          linkedTrackId: id,
          name: `${td.name || ''} (Audio)`,
          startFrame: td.startFrame,
          endFrame: td.startFrame + dur,
        });
        return id;
      }
      this.tracks.push({ ...td, id });
      return id;
    },
  };
}

let store: any;
vi.mock('../../../stores/videoEditor/index', () => ({
  useVideoEditorStore: { getState: () => store },
}));

// Import AFTER vi.mock is registered.
import { pullSceneToFrame, moveSceneToFrame, movePhrase } from './transcriptSurgery';

const vids = () => store.tracks.filter((t: any) => t.type === 'video' && (t.trackRowIndex ?? 0) === 0);
const auds = () => store.tracks.filter((t: any) => t.type === 'audio' && (t.trackRowIndex ?? 0) === 0);
const totalVideoFrames = () => vids().reduce((n: number, t: any) => n + (t.endFrame - t.startFrame), 0);

describe('transcript surgery — store mutations', () => {
  const words = flattenWords(makeTranscript());
  const phrase = 'a better time to relax';

  beforeEach(() => {
    store = makeStore(freshTimeline());
  });

  it('PULL copies the phrase scene to the playhead and leaves the original intact', async () => {
    const m = matchPhraseInWords(words, phrase)!;
    const durF = Math.round((m.endSec - m.startSec) * FPS);

    const res = await pullSceneToFrame('C:/vid.mp4', m.startSec, m.endSec, 0, FPS);
    expect(res.ok).toBe(true);

    // Original main clip still present, and a NEW block now sits at frame 0.
    expect(vids().length).toBe(2);
    expect(auds().length).toBe(2); // exactly one audio per video — no doubling
    const atZero = vids().find((t: any) => t.startFrame === 0)!;
    expect(atZero).toBeTruthy();
    expect(atZero.endFrame - atZero.startFrame).toBe(durF);
    expect(atZero.sourceStartTime).toBeCloseTo(m.startSec, 5); // plays the pulled span
    // The original was pushed right by the inserted length (ripple-open), still full-length.
    const original = vids().find((t: any) => t.sourceStartTime === 0)!;
    expect(original.startFrame).toBe(durF);
    expect(original.endFrame - original.startFrame).toBe(TOTAL_FRAMES);
    expect(store.groups).toBe(0); // undo group balanced
  });

  it('PULL never adds a second audio track (addTrack already pairs it)', async () => {
    const m = matchPhraseInWords(words, phrase)!;
    await pullSceneToFrame('C:/vid.mp4', m.startSec, m.endSec, 0, FPS);
    // 2 video + 2 audio only.
    expect(store.tracks.length).toBe(4);
  });

  it('MOVE relocates the phrase block to the front and preserves total coverage', async () => {
    const m = matchPhraseInWords(words, phrase)!;
    const fromFrame = Math.round(m.startSec * FPS);
    const toFrame = Math.round(m.endSec * FPS);
    const durF = toFrame - fromFrame;

    const before = totalVideoFrames();
    const res = await moveSceneToFrame('C:/vid.mp4', m.startSec, m.endSec, fromFrame, toFrame, 0, FPS);
    expect(res.ok).toBe(true);

    // Scene now at the front, playing the moved span.
    const atZero = vids().find((t: any) => t.startFrame === 0)!;
    expect(atZero.sourceStartTime).toBeCloseTo(m.startSec, 5);
    expect(atZero.endFrame - atZero.startFrame).toBe(durF);

    // Total base-row video coverage unchanged (true move, not a copy).
    expect(totalVideoFrames()).toBe(before);
    // The remaining original no longer covers the moved tail source range.
    const remainder = vids().find((t: any) => t.sourceStartTime === 0)!;
    expect(remainder.endFrame - remainder.startFrame).toBe(TOTAL_FRAMES - durF);
    expect(store.groups).toBe(0);
  });

  it('movePhrase resolves the on-timeline span itself and moves it', async () => {
    const m = matchPhraseInWords(words, phrase)!;
    const before = totalVideoFrames();
    const res = await movePhrase('C:/vid.mp4', m.startSec, m.endSec, 0, FPS);
    expect(res.ok).toBe(true);
    expect(totalVideoFrames()).toBe(before); // coverage preserved
    const atZero = vids().find((t: any) => t.startFrame === 0)!;
    expect(atZero.sourceStartTime).toBeCloseTo(m.startSec, 5);
  });

  it('rejects an empty span (clean no-op)', async () => {
    const res = await pullSceneToFrame('C:/vid.mp4', 5, 5, 0, FPS);
    expect(res.ok).toBe(false);
    expect(store.tracks.length).toBe(2); // untouched
  });
});
