/**
 * transcriptEditUtils — pure helpers for the transcript-based editor.
 *
 * The transcript itself is produced by EDITH's `transcribe` op (Whisper, with
 * word-level timestamps) and cached on the media-library item as
 * `cachedKaraokeSubtitles.transcriptionResult`. This module turns that data into
 * the structures the panel renders, and does the source-time <-> timeline-frame
 * math used to ripple-delete a word.
 *
 * Key design choice: a word's "deleted" state is DERIVED from whether its
 * source-time still maps onto a clip on the timeline — never stored separately.
 * Deleting a word ripples the timeline (closing the gap); that removal of source
 * coverage is what makes the word render struck-through. Undo restores the clip,
 * which restores coverage, which un-strikes the word — for free.
 *
 * No DOM / store imports here — keep it unit-testable.
 */

export interface TranscriptWord {
  word: string;
  start: number; // seconds, absolute in source media
  end: number; // seconds
  confidence?: number;
}

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
  words?: TranscriptWord[];
}

export interface TranscriptionResult {
  segments?: TranscriptSegment[];
  text?: string;
  duration?: number;
  language?: string;
}

/** A flattened word with stable identity + position. */
export interface FlatWord {
  /** stable id derived from timing + index, safe as a React key */
  id: string;
  text: string;
  start: number;
  end: number;
  segIndex: number;
  wordIndex: number;
  globalIndex: number;
}

/** A rendered line (Clipchamp architecture): a timestamp + its words. */
export interface TranscriptLine {
  startSec: number;
  words: FlatWord[];
}

/** Minimal clip shape needed for coverage / frame math. */
export interface CoverageClip {
  startFrame: number;
  endFrame: number;
  sourceStartTime?: number;
  playbackRate?: number;
  speed?: number;
}

const clipSpeed = (clip: CoverageClip): number => {
  const s = clip.playbackRate ?? clip.speed ?? 1;
  return Number.isFinite(s) && s > 0 ? s : 1;
};

/** Source-time interval [start,end] (seconds) a clip currently exposes. */
export function clipSourceInterval(
  clip: CoverageClip,
  fps: number,
): { start: number; end: number } {
  const start = clip.sourceStartTime ?? 0;
  const timelineDurSec = (clip.endFrame - clip.startFrame) / fps;
  const sourceSpan = timelineDurSec * clipSpeed(clip);
  return { start, end: start + sourceSpan };
}

/** Flatten transcript segments to a single ordered word list. */
export function flattenWords(result: TranscriptionResult | null): FlatWord[] {
  if (!result?.segments?.length) return [];
  const out: FlatWord[] = [];
  let g = 0;
  result.segments.forEach((seg, segIndex) => {
    const words = seg.words?.length
      ? seg.words
      : // Fallback: if a segment has no word timings, treat the whole segment as
        // one "word" so it can still be shown (but it will delete the whole line).
        [{ word: seg.text, start: seg.start, end: seg.end }];
    words.forEach((w, wordIndex) => {
      const text = (w.word ?? '').toString();
      if (!text.trim()) return;
      out.push({
        id: `${segIndex}-${wordIndex}-${w.start.toFixed(3)}`,
        text,
        start: w.start,
        end: w.end,
        segIndex,
        wordIndex,
        globalIndex: g++,
      });
    });
  });
  return out;
}

/**
 * Group words into Clipchamp-style lines. We use the transcript's own segments
 * as the natural phrase boundaries, with a second-resolution timestamp per line.
 */
export function groupIntoLines(result: TranscriptionResult | null): TranscriptLine[] {
  const flat = flattenWords(result);
  if (!flat.length) return [];
  const lines: TranscriptLine[] = [];
  let cur: TranscriptLine | null = null;
  let curSeg = -1;
  for (const w of flat) {
    if (w.segIndex !== curSeg) {
      curSeg = w.segIndex;
      cur = { startSec: w.start, words: [] };
      lines.push(cur);
    }
    cur!.words.push(w);
  }
  return lines;
}

/** Format seconds as a Clipchamp-style timestamp (mm:ss, or h:mm:ss past an hour). */
export function formatTimestamp(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = (n: number) => n.toString().padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(ss)}` : `${pad(m)}:${pad(ss)}`;
}

const COVERAGE_EPS = 1e-3;

/**
 * Is a word still present on the timeline? True if its midpoint source-time falls
 * inside any covering clip's source interval. Deleting (rippling) the word out
 * removes that coverage, so this returns false and the word renders struck.
 */
export function isWordPresent(
  word: { start: number; end: number },
  clips: CoverageClip[],
  fps: number,
): boolean {
  const mid = (word.start + word.end) / 2;
  for (const clip of clips) {
    const { start, end } = clipSourceInterval(clip, fps);
    if (mid >= start - COVERAGE_EPS && mid <= end + COVERAGE_EPS) return true;
  }
  return false;
}

/**
 * Can this word actually be ripple-deleted? True only when it maps onto a clip
 * AND its span is at least one whole frame (so there is something to cut). A
 * present-but-sub-frame word (Whisper sometimes emits zero-duration tokens)
 * returns false, so the UI can render it as non-interactive instead of offering
 * a delete affordance that would silently do nothing.
 */
export function isWordDeletable(
  word: { start: number; end: number },
  clips: CoverageClip[],
  fps: number,
): boolean {
  return wordToTimelineRange(word, clips, fps) !== null;
}

/**
 * Find the clip that currently covers a given source-time (its midpoint), and
 * return the timeline frame range to remove for [wordStart, wordEnd].
 * Returns null when no covering clip exists (already deleted / trimmed out).
 */
export function wordToTimelineRange(
  word: { start: number; end: number },
  clips: CoverageClip[],
  fps: number,
): { fromFrame: number; toFrame: number; clip: CoverageClip } | null {
  const mid = (word.start + word.end) / 2;
  for (const clip of clips) {
    const { start, end } = clipSourceInterval(clip, fps);
    if (mid < start - COVERAGE_EPS || mid > end + COVERAGE_EPS) continue;
    const speed = clipSpeed(clip);
    const srcStart = clip.sourceStartTime ?? 0;
    const toTimelineFrame = (srcSec: number) =>
      clip.startFrame + Math.round(((srcSec - srcStart) / speed) * fps);
    let fromFrame = toTimelineFrame(word.start);
    let toFrame = toTimelineFrame(word.end);
    // Clamp inside the clip so we never split outside its bounds.
    fromFrame = Math.max(clip.startFrame, Math.min(fromFrame, clip.endFrame));
    toFrame = Math.max(clip.startFrame, Math.min(toFrame, clip.endFrame));
    if (toFrame <= fromFrame) return null; // sub-frame word — nothing to cut cleanly
    return { fromFrame, toFrame, clip };
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Transcript Surgery — pure helpers for reordering / pulling scenes by text.
// ADDED, non-destructive: the delete-only editor logic above is untouched. These
// power the opt-in "Surgery" mode (drag a phrase to reorder its scene) and the
// quotation "pull scene" trigger (type the spoken words in quotes to copy that
// scene to a new point). All DOM/store-free so they stay unit-testable.
// ─────────────────────────────────────────────────────────────────────────────

/** Normalize text for phrase matching: lowercase, drop punctuation (keep apostrophes), collapse whitespace. */
export function normalizeForMatch(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9'\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const toTokens = (s: string): string[] => {
  const n = normalizeForMatch(s);
  return n ? n.split(' ') : [];
};

/** A contiguous run of transcript words plus its source-time span. */
export interface PhraseMatch {
  words: FlatWord[];
  startSec: number;
  endSec: number;
  wordIds: string[];
}

const makeMatch = (run: FlatWord[]): PhraseMatch | null =>
  run.length
    ? {
        words: run,
        startSec: run[0].start,
        endSec: run[run.length - 1].end,
        wordIds: run.map((w) => w.id),
      }
    : null;

/**
 * Find the FIRST contiguous run of transcript words whose spoken text matches
 * `phrase` (word-for-word after normalization). Handles words that normalize to
 * multiple tokens. Returns null when the phrase was never spoken in this video —
 * that no-match is what makes the quotation "pull" a clean no-op on unknown text.
 */
export function matchPhraseInWords(words: FlatWord[], phrase: string): PhraseMatch | null {
  const target = toTokens(phrase);
  if (!target.length) return null;
  // Flatten to a token stream that remembers which FlatWord each token came from.
  const flat: { tok: string; wi: number }[] = [];
  words.forEach((w, wi) => toTokens(w.text).forEach((tok) => flat.push({ tok, wi })));
  if (flat.length < target.length) return null;
  for (let i = 0; i + target.length <= flat.length; i++) {
    let ok = true;
    for (let k = 0; k < target.length; k++) {
      if (flat[i + k].tok !== target[k]) {
        ok = false;
        break;
      }
    }
    if (ok) {
      const firstWi = flat[i].wi;
      const lastWi = flat[i + target.length - 1].wi;
      return makeMatch(words.slice(firstWi, lastWi + 1));
    }
  }
  return null;
}

/** Resolve a selected run of words (by first/last id, in either order) to its source span. */
export function resolvePhraseSpan(
  words: FlatWord[],
  startId: string,
  endId: string,
): PhraseMatch | null {
  const i = words.findIndex((w) => w.id === startId);
  const j = words.findIndex((w) => w.id === endId);
  if (i < 0 || j < 0) return null;
  const [a, b] = i <= j ? [i, j] : [j, i];
  return makeMatch(words.slice(a, b + 1));
}

/**
 * Extract fully double-quoted phrases from text — straight ("...") or curly
 * (“...”). Only fully-quoted runs are returned; unquoted text yields
 * nothing, so the caller can enforce "a scene is pulled ONLY when the words are
 * put in quotation marks."
 */
export function extractQuotedPhrases(s: string): string[] {
  const out: string[] = [];
  const re = /[“]([^“”]+)[”]|"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    const inner = (m[1] ?? m[2] ?? '').trim();
    if (inner) out.push(inner);
  }
  return out;
}
