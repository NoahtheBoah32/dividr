import { describe, it, expect } from 'vitest';
import {
  flattenWords,
  matchPhraseInWords,
  resolvePhraseSpan,
  extractQuotedPhrases,
  normalizeForMatch,
  wordToTimelineRange,
  type TranscriptionResult,
  type CoverageClip,
} from './transcriptEditUtils';

/** Build a word-timed transcript from a plain sentence (0.4s per word). */
function makeTranscript(sentence: string, startSec = 0, wordDur = 0.4): TranscriptionResult {
  const toks = sentence.split(' ');
  const words = toks.map((w, i) => ({
    word: w,
    start: startSec + i * wordDur,
    end: startSec + i * wordDur + wordDur,
  }));
  return {
    segments: [{ start: words[0].start, end: words[words.length - 1].end, text: sentence, words }],
  };
}

// The user's example line.
const SENT =
  "He was going after me and I didn't know what to do He was really running after me it was very scary but I think now is a better time to relax";

describe('transcript surgery — pure helpers', () => {
  const tr = makeTranscript(SENT);
  const words = flattenWords(tr);

  it('flattens every spoken word', () => {
    expect(words.length).toBe(SENT.split(' ').length);
  });

  it('normalizeForMatch lowercases and strips punctuation (keeps apostrophes)', () => {
    expect(normalizeForMatch('Here you go, EAT this!')).toBe('here you go eat this');
    expect(normalizeForMatch("didn't")).toBe("didn't");
  });

  it('matches a spoken phrase and returns its source span', () => {
    const m = matchPhraseInWords(words, 'but I think now is a better time to relax');
    expect(m).not.toBeNull();
    expect(m!.words[0].text).toBe('but');
    expect(m!.words[m!.words.length - 1].text).toBe('relax');
    expect(m!.endSec).toBeGreaterThan(m!.startSec);
  });

  it('matches case- and punctuation-insensitively', () => {
    expect(matchPhraseInWords(words, 'A BETTER TIME.')).not.toBeNull();
  });

  it('returns null when the phrase was never spoken (pull is a clean no-op)', () => {
    expect(matchPhraseInWords(words, 'here you go eat this')).toBeNull();
  });

  it('extractQuotedPhrases pulls ONLY quoted runs (straight + curly), never plain text', () => {
    expect(extractQuotedPhrases('plain text with no quotes')).toEqual([]);
    expect(extractQuotedPhrases('say "here you go" now')).toEqual(['here you go']);
    expect(extractQuotedPhrases('a “curly quoted” phrase')).toEqual(['curly quoted']);
    expect(extractQuotedPhrases('"first" and "second"')).toEqual(['first', 'second']);
  });

  it('resolvePhraseSpan works regardless of selection direction', () => {
    const a = words[2].id;
    const b = words[5].id;
    const fwd = resolvePhraseSpan(words, a, b);
    const rev = resolvePhraseSpan(words, b, a);
    expect(fwd!.wordIds).toEqual(rev!.wordIds);
    expect(fwd!.words.length).toBe(4);
  });

  it('maps a matched phrase onto timeline frames (source->timeline bridge)', () => {
    const fps = 30;
    const clip: CoverageClip = {
      startFrame: 0,
      endFrame: Math.round(SENT.split(' ').length * 0.4 * fps),
      sourceStartTime: 0,
    };
    const m = matchPhraseInWords(words, 'a better time to relax')!;
    const range = wordToTimelineRange({ start: m.startSec, end: m.endSec }, [clip], fps);
    expect(range).not.toBeNull();
    expect(range!.toFrame).toBeGreaterThan(range!.fromFrame);
  });
});
