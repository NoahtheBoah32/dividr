// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  resolveFrameRequests,
  resolveDipOverlay,
  clampTransitionDuration,
} from './FrameResolver';

const track = (id: string, s: number, e: number, srcStart = 0, row = 0) =>
  ({
    id,
    type: 'video',
    name: id,
    source: `http://x/${id}.mp4`,
    previewUrl: `http://x/${id}.mp4`,
    startFrame: s,
    endFrame: e,
    duration: e - s,
    sourceStartTime: srcStart,
    trackRowIndex: row,
    visible: true,
    locked: false,
  }) as any;

// Two ADJACENT clips (no overlap) with a stored transition. Cut at frame 90, duration 30 → window [60, 90).
// B is trimmed (sourceStartTime 2s = inFrame 60) so it has a real pre-roll handle.
const tracks = [track('a', 0, 90, 0), track('b', 90, 180, 2)];
const dissolve = [
  { id: 't1', fromClipId: 'a', toClipId: 'b', type: 'dissolve', durationFrames: 30 },
] as any;

describe('resolveFrameRequests — non-destructive transition (no clip movement)', () => {
  it('before the transition window: only the outgoing clip, no fx', () => {
    const reqs = resolveFrameRequests(50, tracks, 30, dissolve);
    expect(reqs.map((r) => r.clipId)).toEqual(['a']);
    expect(reqs[0].tfx).toBeUndefined();
  });

  it('mid-window (frame 75): BOTH clips render (incoming via pre-roll), each ~0.5 opacity', () => {
    const reqs = resolveFrameRequests(75, tracks, 30, dissolve);
    const a = reqs.find((r) => r.clipId === 'a');
    const b = reqs.find((r) => r.clipId === 'b');
    expect(a?.tfx?.opacity).toBeCloseTo(0.5, 5);
    expect(b).toBeTruthy(); // incoming clip present even though frame 75 < its startFrame (90)
    expect(b?.tfx?.opacity).toBeCloseTo(0.5, 5);
  });

  it('clips do NOT overlap and the outgoing clip keeps its real content (no time consumed)', () => {
    // A still occupies [0,90] and renders its true frames during the window (not a shifted clip).
    const reqs = resolveFrameRequests(75, tracks, 30, dissolve);
    const a = reqs.find((r) => r.clipId === 'a');
    // A's source frame at timeline 75 = inFrame(0) + (75-0) = 75 — its real content, unshifted.
    expect(a?.sourceFrame).toBe(75);
  });

  it('incoming clip uses its source PRE-ROLL handle (frames before its in-point)', () => {
    // B.inFrame = 2s*30 = 60. At frame 75 (15 before the cut 90), handle = 60 - 15 = 45.
    const reqs = resolveFrameRequests(75, tracks, 30, dissolve);
    const b = reqs.find((r) => r.clipId === 'b');
    expect(b?.sourceFrame).toBe(45);
  });

  it('near window end (frame 89): outgoing nearly gone, incoming nearly full', () => {
    const reqs = resolveFrameRequests(89, tracks, 30, dissolve);
    expect(reqs.find((r) => r.clipId === 'a')?.tfx?.opacity).toBeLessThan(0.1);
    expect(reqs.find((r) => r.clipId === 'b')?.tfx?.opacity).toBeGreaterThan(0.9);
  });

  it('incoming pre-roll draws on top of the outgoing clip', () => {
    const reqs = resolveFrameRequests(75, tracks, 30, dissolve);
    const a = reqs.find((r) => r.clipId === 'a')!;
    const b = reqs.find((r) => r.clipId === 'b')!;
    expect(b.layer).toBeGreaterThan(a.layer);
  });
});

describe('resolveFrameRequests — stored type flows through', () => {
  const t = (type: string, params?: any) =>
    [{ id: 'x', fromClipId: 'a', toClipId: 'b', type, durationFrames: 30, params }] as any;

  it('wipe gives the incoming clip a wipe reveal', () => {
    const reqs = resolveFrameRequests(75, tracks, 30, t('wipe', { direction: 'right' }));
    expect(reqs.find((r) => r.clipId === 'b')?.tfx?.wipe?.revealFrac).toBeCloseTo(0.5, 5);
  });

  it('zoom gives the incoming clip scaleMul > 1', () => {
    const reqs = resolveFrameRequests(75, tracks, 30, t('zoom'));
    expect(reqs.find((r) => r.clipId === 'b')?.tfx?.scaleMul).toBeGreaterThan(1);
  });
});

describe('clampTransitionDuration — window never outgrows a trimmed clip', () => {
  it('clamps to the shorter clip so a stale long duration cannot push the window past the cut', () => {
    // Outgoing clip trimmed to 10 frames, incoming 90; a stale 45-frame duration must shrink.
    const shortFrom = track('a', 80, 90, 0); // dur 10
    const longTo = track('b', 90, 180, 2); // dur 90
    expect(clampTransitionDuration(45, shortFrom, longTo, 30)).toBe(9); // min(45, 10-1, 90-1)
  });

  it('a trimmed outgoing clip keeps the outgoing frame visible through the whole window (no black)', () => {
    const shortFrom = track('a', 80, 90, 0);
    const longTo = track('b', 90, 180, 2);
    const tr = [
      { id: 't', fromClipId: 'a', toClipId: 'b', type: 'dissolve', durationFrames: 45 },
    ] as any;
    // Window is [81, 90). At its very start (81) the outgoing clip is still on screen.
    const reqs = resolveFrameRequests(81, [shortFrom, longTo], 30, tr);
    expect(reqs.find((r) => r.clipId === 'a')).toBeTruthy();
    // Before the clamped window (80) there is no transition fx yet.
    expect(resolveFrameRequests(80, [shortFrom, longTo], 30, tr).find((r) => r.clipId === 'a')?.tfx)
      .toBeUndefined();
  });
});

describe('resolveDipOverlay', () => {
  it('peaks at the window midpoint for a dip transition', () => {
    const dip = [
      { id: 't1', fromClipId: 'a', toClipId: 'b', type: 'dip', durationFrames: 30, params: { color: 'black' } },
    ] as any;
    const mid = resolveDipOverlay(75, tracks, dip); // window [60,90), mid = 75
    expect(mid?.color).toBe('black');
    expect(mid?.alpha).toBeCloseTo(1, 5);
  });

  it('returns null with no dip transition', () => {
    expect(resolveDipOverlay(75, tracks, dissolve)).toBeNull();
  });
});
