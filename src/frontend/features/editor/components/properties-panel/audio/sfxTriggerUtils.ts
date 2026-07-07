/**
 * sfxTriggerUtils — pure logic for the transcript "asterisk SFX" trigger.
 *
 * Typing a COMPLETE, valid marker like *whoosh* in the transcript drops that sound
 * effect onto the timeline. The rules:
 *   - Only a fully-closed *word* triggers. *whoosh (no closing asterisk) does nothing.
 *   - The word must resolve to a real SFX in the library. *divebomb* does nothing.
 *   - Matching is friendly: the filename stem, any of its tokens, or a small alias
 *     table (e.g. slide → swoosh_in). Ambiguous tokens resolve deterministically
 *     (prefer the file where the token comes first, then alphabetical).
 *
 * This module has NO DOM/store deps so it can be exhaustively unit-tested against
 * the real library file list.
 */

export interface AsteriskTrigger {
  /** The full matched marker text including both asterisks, e.g. "*whoosh*". */
  raw: string;
  /** The inner word, trimmed, e.g. "whoosh". */
  word: string;
  /** Start index of the opening asterisk in the source text. */
  start: number;
  /** Index just past the closing asterisk. */
  end: number;
}

/** Lowercase + keep only a–z0–9, so "Whoosh_Transition" and "whoosh transition" both key the same. */
export function normalizeSfxKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Strip a known audio extension and return the bare stem. */
export function sfxStem(filename: string): string {
  return filename.replace(/\.(mp3|wav|ogg|m4a)$/i, '');
}

/**
 * Natural words a user is likely to type that are NOT a filename token, mapped to a
 * stem. Keys are normalized (alphanumeric-lowercase). Only used as a fallback after
 * exact-stem and token matching.
 */
export const SFX_ALIASES: Record<string, string> = {
  slide: 'swoosh_in',
  swipe: 'swoosh_in',
  explode: 'explosion',
  boom: 'boom_impact',
  kaching: 'cash_register',
  chaching: 'cash_register',
  cashregister: 'cash_register',
  register: 'cash_register',
  womp: 'sad_trombone',
  wompwomp: 'sad_trombone',
  fail: 'sad_trombone',
  gameover: 'game_over',
  levelup: 'level_up_chime',
  drumroll: 'drum_roll',
  scratch: 'record_scratch',
  clap: 'applause_clap',
  applause: 'applause_clap',
  laugh: 'laugh_track',
  gunshot: 'explosion',
  ding: 'ding_notification',
  sparkle: 'sparkle_twinkle',
  twinkle: 'sparkle_twinkle',
  magic: 'magic_transition',
  suspense: 'suspense_sting',
  riser: 'riser',
  keyboard: 'keyboard_typing',
  typing: 'keyboard_typing',
};

/**
 * Find every COMPLETE `*word*` marker in the text. A marker is an asterisk, one or
 * more non-asterisk / non-newline characters, then a closing asterisk. Empty `**`
 * and unclosed `*word` are ignored.
 */
export function parseAsteriskTriggers(text: string): AsteriskTrigger[] {
  const out: AsteriskTrigger[] = [];
  const re = /\*([^*\n]+?)\*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const word = m[1].trim();
    if (!word) continue;
    out.push({ raw: m[0], word, start: m.index, end: m.index + m[0].length });
  }
  return out;
}

interface Indexed {
  filename: string;
  stem: string;
  key: string; // normalized stem
  tokens: string[]; // lowercased stem tokens
}

function indexLibrary(libraryNames: string[]): Indexed[] {
  return libraryNames.map((filename) => {
    const stem = sfxStem(filename);
    return {
      filename,
      stem,
      key: normalizeSfxKey(stem),
      tokens: stem.toLowerCase().split(/[_\s-]+/).filter(Boolean),
    };
  });
}

/**
 * Resolve a trigger word to a library filename, or null if nothing matches
 * (i.e. the marker should NOT trigger). Deterministic.
 */
export function resolveSfxName(word: string, libraryNames: string[]): string | null {
  const w = normalizeSfxKey(word);
  if (!w) return null;
  const lib = indexLibrary(libraryNames);

  // 1) Exact full-stem match (e.g. *whoosh_transition* or *whoosh transition*).
  const exact = lib.find((e) => e.key === w);
  if (exact) return exact.filename;

  // 2) Single-token match. Prefer the file where the token appears earliest, then the
  //    shortest stem, then alphabetical — so *ding* → ding_notification, *boom* → boom_impact.
  const tokenHits = lib
    .map((e) => ({ e, idx: e.tokens.findIndex((t) => normalizeSfxKey(t) === w) }))
    .filter((h) => h.idx >= 0)
    .sort(
      (a, b) =>
        a.idx - b.idx ||
        a.e.stem.length - b.e.stem.length ||
        a.e.filename.localeCompare(b.e.filename),
    );
  if (tokenHits.length) return tokenHits[0].e.filename;

  // 3) Alias table → stem, if that stem is actually present in the library.
  const aliasStem = SFX_ALIASES[w];
  if (aliasStem) {
    const hit = lib.find((e) => e.key === normalizeSfxKey(aliasStem));
    if (hit) return hit.filename;
  }

  return null;
}

/** True when the word maps to a real library SFX. */
export function isValidSfxWord(word: string, libraryNames: string[]): boolean {
  return resolveSfxName(word, libraryNames) !== null;
}

/** Bright yellow for the completed transcript marker (matches the highlighter look). */
export const SFX_MARKER_YELLOW = '#ffe600';
/** Green for the SFX clip placed on the timeline. */
export const SFX_TIMELINE_GREEN = '#22c55e';

export interface PlaceSfxOp {
  type: 'placeSFX';
  file: string;
  atTime: number; // TIMELINE seconds
  volume: number;
  color: string;
  trackName: string;
}

/**
 * Build the placeSFX op for a resolved `*word*` marker sitting at timeline frame
 * `atFrame`, or null if the word is not a real SFX (so the marker must not trigger).
 * The placed clip is tagged green; the op runs through the same path EDITH's placeSFX
 * uses, so it lands on the timeline overlay at exactly atFrame.
 */
export function sfxOpForWord(
  word: string,
  atFrame: number,
  fps: number,
  libraryNames: string[],
): PlaceSfxOp | null {
  const file = resolveSfxName(word, libraryNames);
  if (!file) return null;
  const f = Math.max(1, fps);
  return {
    type: 'placeSFX',
    file,
    atTime: Math.max(0, atFrame) / f,
    volume: -3,
    color: SFX_TIMELINE_GREEN,
    trackName: sfxStem(file),
  };
}
