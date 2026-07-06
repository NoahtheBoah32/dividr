import { describe, it, expect } from 'vitest';
import {
  flattenWords,
  groupIntoLines,
  formatTimestamp,
  clipSourceInterval,
  isWordPresent,
  isWordDeletable,
  wordToTimelineRange,
  type TranscriptionResult,
} from './transcriptEditUtils';

const RESULT: TranscriptionResult = {
  duration: 10,
  segments: [
    {
      start: 0,
      end: 2.5,
      text: 'this is the part',
      words: [
        { word: 'this', start: 0.0, end: 0.4 },
        { word: 'is', start: 0.4, end: 0.7 },
        { word: 'the', start: 0.7, end: 0.9 },
        { word: 'part', start: 0.9, end: 1.4 },
      ],
    },
    {
      start: 2.5,
      end: 4.0,
      text: 'where pinocchio is',
      words: [
        { word: 'where', start: 2.5, end: 2.9 },
        { word: 'pinocchio', start: 2.9, end: 3.6 },
        { word: 'is', start: 3.6, end: 4.0 },
      ],
    },
  ],
};

describe('transcriptEditUtils', () => {
  it('flattens words in order with stable ids', () => {
    const flat = flattenWords(RESULT);
    expect(flat.map((w) => w.text)).toEqual([
      'this',
      'is',
      'the',
      'part',
      'where',
      'pinocchio',
      'is',
    ]);
    expect(new Set(flat.map((w) => w.id)).size).toBe(flat.length); // unique
    expect(flat[5].text).toBe('pinocchio');
    expect(flat[5].globalIndex).toBe(5);
  });

  it('handles empty / null transcript', () => {
    expect(flattenWords(null)).toEqual([]);
    expect(flattenWords({ segments: [] })).toEqual([]);
    expect(groupIntoLines(null)).toEqual([]);
  });

  it('groups into lines by segment with second timestamps', () => {
    const lines = groupIntoLines(RESULT);
    expect(lines.length).toBe(2);
    expect(lines[0].words.length).toBe(4);
    expect(lines[1].words.length).toBe(3);
    expect(lines[1].startSec).toBeCloseTo(2.5, 3);
  });

  it('formats timestamps mm:ss and h:mm:ss', () => {
    expect(formatTimestamp(0)).toBe('00:00');
    expect(formatTimestamp(7)).toBe('00:07');
    expect(formatTimestamp(83)).toBe('01:23');
    expect(formatTimestamp(3661)).toBe('1:01:01');
  });

  it('computes a clip source interval (with speed)', () => {
    // 0..300 frames @30fps, sourceStartTime 0, speed 1 -> source [0,10]
    expect(clipSourceInterval({ startFrame: 0, endFrame: 300 }, 30)).toEqual({
      start: 0,
      end: 10,
    });
    // sped 2x -> covers twice the source span
    expect(
      clipSourceInterval(
        { startFrame: 0, endFrame: 300, sourceStartTime: 1, speed: 2 },
        30,
      ),
    ).toEqual({ start: 1, end: 21 });
  });

  it('detects word presence against full-clip coverage', () => {
    const clips = [{ startFrame: 0, endFrame: 300, sourceStartTime: 0 }];
    expect(isWordPresent({ start: 2.9, end: 3.6 }, clips, 30)).toBe(true);
    // a word outside the covered source range is absent
    expect(isWordPresent({ start: 12, end: 12.5 }, clips, 30)).toBe(false);
  });

  it('maps a word to the correct timeline frame range', () => {
    const clips = [{ startFrame: 0, endFrame: 300, sourceStartTime: 0 }];
    const r = wordToTimelineRange({ start: 2.9, end: 3.6 }, clips, 30);
    expect(r).not.toBeNull();
    expect(r!.fromFrame).toBe(Math.round(2.9 * 30)); // 87
    expect(r!.toFrame).toBe(Math.round(3.6 * 30)); // 108
  });

  it('present but sub-frame words are NOT deletable (no silent no-op affordance)', () => {
    const clips = [{ startFrame: 0, endFrame: 300, sourceStartTime: 0 }];
    // A normal word maps to >= 1 frame -> deletable.
    expect(isWordDeletable({ start: 2.9, end: 3.6 }, clips, 30)).toBe(true);
    // A zero-duration word is present (midpoint inside) but cuts to nothing.
    expect(isWordPresent({ start: 3.0, end: 3.0 }, clips, 30)).toBe(true);
    expect(isWordDeletable({ start: 3.0, end: 3.0 }, clips, 30)).toBe(false);
    // A sub-frame word (< 1/30s) also rounds to a zero-frame span -> not deletable.
    expect(isWordDeletable({ start: 3.0, end: 3.01 }, clips, 30)).toBe(false);
    // A word with no covering clip is neither present nor deletable.
    expect(isWordDeletable({ start: 50, end: 51 }, clips, 30)).toBe(false);
  });

  it('after a ripple delete, the removed word reads as absent (derived state)', () => {
    // Simulate the timeline AFTER deleting "pinocchio" [2.9,3.6]:
    // left clip keeps source [0,2.9], right clip starts at source 3.6 and
    // shifts left on the timeline to close the gap.
    const leftFrames = Math.round(2.9 * 30); // 87
    const removed = Math.round(3.6 * 30) - leftFrames; // 21
    const clips = [
      { startFrame: 0, endFrame: leftFrames, sourceStartTime: 0 }, // src [0, 2.9]
      {
        startFrame: leftFrames,
        endFrame: 300 - removed,
        sourceStartTime: 3.6,
      }, // src [3.6, 10]
    ];
    expect(isWordPresent({ start: 2.9, end: 3.6 }, clips, 30)).toBe(false); // pinocchio gone
    expect(isWordPresent({ start: 0.0, end: 0.4 }, clips, 30)).toBe(true); // "this" stays
    expect(isWordPresent({ start: 3.6, end: 4.0 }, clips, 30)).toBe(true); // "is" stays
  });
});
