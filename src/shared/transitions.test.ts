// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  findOverlapPairs,
  transitionProgress,
  transitionFx,
  dipOverlay,
} from './transitions';

const clip = (id: string, s: number, e: number, row = 0, type = 'video') => ({
  id,
  startFrame: s,
  endFrame: e,
  trackRowIndex: row,
  type,
});

describe('findOverlapPairs', () => {
  it('detects an overlap on the same row and orders from=earlier', () => {
    const pairs = findOverlapPairs([clip('a', 0, 100), clip('b', 80, 200)]);
    expect(pairs).toEqual([{ fromId: 'a', toId: 'b', startFrame: 80, endFrame: 100 }]);
  });

  it('ignores clips on different rows', () => {
    expect(findOverlapPairs([clip('a', 0, 100, 0), clip('b', 80, 200, 1)])).toEqual([]);
  });

  it('ignores non-overlapping (touching) clips', () => {
    expect(findOverlapPairs([clip('a', 0, 100), clip('b', 100, 200)])).toEqual([]);
  });

  it('ignores non-video clips', () => {
    expect(findOverlapPairs([clip('a', 0, 100, 0, 'video'), clip('b', 80, 200, 0, 'audio')])).toEqual([]);
  });

  it('orders from/to regardless of array order', () => {
    const pairs = findOverlapPairs([clip('b', 80, 200), clip('a', 0, 100)]);
    expect(pairs[0].fromId).toBe('a');
    expect(pairs[0].toId).toBe('b');
  });
});

describe('transitionProgress', () => {
  const pair = { fromId: 'a', toId: 'b', startFrame: 80, endFrame: 100 };
  it('is 0 at overlap start, 0.5 mid, 1 at end', () => {
    expect(transitionProgress(pair, 80)).toBe(0);
    expect(transitionProgress(pair, 90)).toBe(0.5);
    expect(transitionProgress(pair, 100)).toBe(1);
  });
  it('clamps outside the overlap', () => {
    expect(transitionProgress(pair, 50)).toBe(0);
    expect(transitionProgress(pair, 200)).toBe(1);
  });
});

describe('transitionFx — dissolve (the KEY transition)', () => {
  it('crossfades opacity: from fades out, to fades in', () => {
    expect(transitionFx('from', 'dissolve', 0).opacity).toBe(1);
    expect(transitionFx('to', 'dissolve', 0).opacity).toBe(0);
    expect(transitionFx('from', 'dissolve', 0.5).opacity).toBe(0.5);
    expect(transitionFx('to', 'dissolve', 0.5).opacity).toBe(0.5);
    expect(transitionFx('from', 'dissolve', 1).opacity).toBe(0);
    expect(transitionFx('to', 'dissolve', 1).opacity).toBe(1);
  });
});

describe('transitionFx — zoom / push / wipe', () => {
  it('zoom: incoming punches in (scale>1 fading to 1) and fades in', () => {
    const a = transitionFx('to', 'zoom', 0);
    const b = transitionFx('to', 'zoom', 1);
    expect(a.scaleMul).toBeGreaterThan(1);
    expect(b.scaleMul).toBeCloseTo(1, 5);
    expect(a.opacity).toBe(0);
    expect(b.opacity).toBe(1);
  });

  it('push-left: incoming enters from the right (positive X) ending at 0', () => {
    const start = transitionFx('to', 'push', 0, { direction: 'left' });
    const end = transitionFx('to', 'push', 1, { direction: 'left' });
    expect(start.translateXFrac).toBeGreaterThan(0);
    expect(end.translateXFrac).toBeCloseTo(0, 5);
  });

  it('wipe: incoming reveal grows 0 -> 1', () => {
    expect(transitionFx('to', 'wipe', 0, { direction: 'right' }).wipe?.revealFrac).toBe(0);
    expect(transitionFx('to', 'wipe', 1, { direction: 'right' }).wipe?.revealFrac).toBe(1);
  });
});

describe('dipOverlay', () => {
  it('peaks (alpha 1) at the midpoint, 0 at the edges', () => {
    expect(dipOverlay('dip', 0)?.alpha).toBe(0);
    expect(dipOverlay('dip', 0.5)?.alpha).toBe(1);
    expect(dipOverlay('dip', 1)?.alpha).toBe(0);
  });
  it('returns null for non-dip', () => {
    expect(dipOverlay('dissolve', 0.5)).toBeNull();
  });
  it('uses the provided color', () => {
    expect(dipOverlay('dip', 0.5, { color: 'white' })?.color).toBe('white');
  });
});
