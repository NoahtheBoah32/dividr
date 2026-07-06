// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { parseSceneTimestamps, sceneTimesToMarkers } from './sceneDetection';

describe('parseSceneTimestamps', () => {
  it('extracts pts_time values from showinfo output', () => {
    const out = `
[Parsed_showinfo_1 @ 0x55] n:0 pts:60 pts_time:2 pos:1234
[Parsed_showinfo_1 @ 0x55] n:1 pts:120 pts_time:4 pos:5678
`;
    expect(parseSceneTimestamps(out)).toEqual([2, 4]);
  });

  it('handles fractional seconds', () => {
    const out = 'pts_time:1.533 ... pts_time:12.04';
    expect(parseSceneTimestamps(out)).toEqual([1.533, 12.04]);
  });

  it('dedupes and sorts ascending', () => {
    const out = 'pts_time:4 pts_time:2 pts_time:4 pts_time:1';
    expect(parseSceneTimestamps(out)).toEqual([1, 2, 4]);
  });

  it('returns empty array when no scenes detected', () => {
    expect(parseSceneTimestamps('no matches here')).toEqual([]);
    expect(parseSceneTimestamps('')).toEqual([]);
  });
});

describe('sceneTimesToMarkers', () => {
  it('maps absolute times to clip-relative fractions', () => {
    // clip shows source [0, 10]s; cut at 2.5s -> fraction 0.25
    const markers = sceneTimesToMarkers([2.5, 5], 0, 10);
    expect(markers).toEqual([
      { atSeconds: 2.5, fraction: 0.25 },
      { atSeconds: 5, fraction: 0.5 },
    ]);
  });

  it('respects a trimmed clip in-point (sourceStartTime)', () => {
    // clip shows source [4, 8]s; cut at 6s -> (6-4)/(8-4) = 0.5
    const markers = sceneTimesToMarkers([6], 4, 8);
    expect(markers).toEqual([{ atSeconds: 6, fraction: 0.5 }]);
  });

  it('drops cuts outside the clip window and those hugging the edges', () => {
    // window [2, 6]; 1 is before, 7 is after, 2.01 hugs start, 5.99 hugs end
    const markers = sceneTimesToMarkers([1, 2.01, 4, 5.99, 7], 2, 6);
    expect(markers.map((m) => m.atSeconds)).toEqual([4]);
  });

  it('returns empty for zero/negative duration', () => {
    expect(sceneTimesToMarkers([3], 5, 5)).toEqual([]);
    expect(sceneTimesToMarkers([3], 8, 4)).toEqual([]);
  });

  it('does not drop every cut on a very short clip (margin scales down)', () => {
    // 0.08s clip: a fixed 0.05s margin would invert the valid range. The scaled margin keeps it.
    const markers = sceneTimesToMarkers([10.04], 10, 10.08);
    expect(markers).toHaveLength(1);
    expect(markers[0].atSeconds).toBe(10.04);
  });
});
