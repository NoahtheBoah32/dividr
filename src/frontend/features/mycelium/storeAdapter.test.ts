// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { pickSubtitleRow } from './captionUtils';

describe('pickSubtitleRow', () => {
  it('returns row 1 when no existing subtitle tracks', () => {
    expect(pickSubtitleRow([], 0, 30)).toBe(1);
  });

  it('reuses row 1 when existing caption does not overlap', () => {
    const existing = [{ trackRowIndex: 1, startFrame: 0, endFrame: 30 }];
    // New caption starts after existing ends
    expect(pickSubtitleRow(existing, 45, 90)).toBe(1);
  });

  it('creates row 2 when row 1 fully collides', () => {
    const existing = [{ trackRowIndex: 1, startFrame: 0, endFrame: 90 }];
    // New caption overlaps with existing
    expect(pickSubtitleRow(existing, 30, 60)).toBe(2);
  });

  it('reuses row 1 when captions are back-to-back (touching frames, no overlap)', () => {
    const existing = [{ trackRowIndex: 1, startFrame: 0, endFrame: 30 }];
    // Start == previous end — no overlap (strict less-than check)
    expect(pickSubtitleRow(existing, 30, 60)).toBe(1);
  });

  it('picks the lowest available row when row 1 is full but row 2 is free', () => {
    const existing = [
      { trackRowIndex: 1, startFrame: 0, endFrame: 60 },
      { trackRowIndex: 2, startFrame: 90, endFrame: 120 },
    ];
    // Collides with row 1, but row 2 is free at 0–60
    expect(pickSubtitleRow(existing, 0, 60)).toBe(2);
  });

  it('creates row 3 when both row 1 and row 2 collide', () => {
    const existing = [
      { trackRowIndex: 1, startFrame: 0, endFrame: 60 },
      { trackRowIndex: 2, startFrame: 0, endFrame: 60 },
    ];
    expect(pickSubtitleRow(existing, 10, 50)).toBe(3);
  });

  it('handles tracks without trackRowIndex (defaults to 1)', () => {
    const existing = [{ startFrame: 0, endFrame: 60 }]; // no trackRowIndex
    expect(pickSubtitleRow(existing, 10, 50)).toBe(2);
  });

  it('packs 5 sequential captions all onto row 1', () => {
    const tracks: Array<{ trackRowIndex: number; startFrame: number; endFrame: number }> = [];
    for (let i = 0; i < 5; i++) {
      const start = i * 30;
      const end = start + 30;
      const row = pickSubtitleRow(tracks, start, end);
      expect(row).toBe(1);
      tracks.push({ trackRowIndex: row, startFrame: start, endFrame: end });
    }
  });

  it('creates separate rows for fully overlapping captions', () => {
    const tracks: Array<{ trackRowIndex: number; startFrame: number; endFrame: number }> = [];
    for (let i = 0; i < 3; i++) {
      const row = pickSubtitleRow(tracks, 0, 60); // all overlap same time range
      expect(row).toBe(i + 1);
      tracks.push({ trackRowIndex: row, startFrame: 0, endFrame: 60 });
    }
  });
});
