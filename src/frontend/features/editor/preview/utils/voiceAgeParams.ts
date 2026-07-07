/**
 * voiceAgeParams — pure "one dial → many DSP params" map for the Voice Ager (Skill 3).
 *
 * Mirrors voiceIsolationCurve.ts's voiceForwardParams pattern: a single dependency-free,
 * unit-tested module that both the live Web Audio graph (VoiceIsolationEngine) AND the
 * ffmpeg export bake consume, so preview == export.
 *
 * The single user-facing dial is `ageYears` (20..90). ~30 is treated as neutral. Older
 * voices read as: longer vocal tract (deeper, hollower formants + pitch), high-frequency
 * loss (duller, less sparkle), reduced dynamics (softer transients), and more micro
 * instability (jitter/shimmer). All of that is captured below and nowhere else.
 */

export interface AgeParams {
  /** Combined pitch+formant resample ratio for the shifter (<1 = deeper/older). */
  shiftRatio: number;
  /** Low-shelf @ 180 Hz — body/chest resonance (dB). */
  bodyDb: number;
  /** High-shelf @ 6 kHz — high-frequency loss with age (dB, negative). */
  tiltDb: number;
  /** Peaking cut @ 8 kHz — loss of brilliance/sparkle (dB, negative). */
  brillianceDb: number;
  /** Peaking dip @ 2.2 kHz — slightly hollow, throaty older tone (dB, negative). */
  throatDb: number;
  /** Compressor ratio for reduced dynamic range (softer transients). */
  compRatio: number;
  /** Compressor threshold (dB). */
  compThresholdDb: number;
  /** Pitch-period instability, percent (drives worklet jitter + ffmpeg vibrato). */
  jitterPct: number;
  /** Amplitude instability, dB (drives a trailing tremolo gain). */
  shimmerDb: number;
}

/** Clamp helper. */
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * Normalized age factor. Baseline 30 → 0 (neutral). 90 → 1 (ancient).
 * Allowed slightly negative (down to ~-0.17 at age 20) so a young setting thins/brightens.
 */
export function ageFactor(years: number): number {
  return clamp((years - 30) / 60, -0.17, 1);
}

/** Map the single age dial to the full DSP parameter bundle. */
export function ageToParams(years: number): AgeParams {
  const a = ageFactor(years);
  return {
    shiftRatio: 1 - 0.12 * a, // 0.88 (ancient) .. ~1.02 (young)
    bodyDb: 2 * a,
    tiltDb: -6 * a,
    brillianceDb: -4 * a,
    throatDb: -2 * a,
    compRatio: 1 + 1.5 * Math.max(0, a), // only compress for older, never expand
    compThresholdDb: -18 * Math.max(0, a),
    jitterPct: 0.3 + 1.2 * Math.max(0, a),
    shimmerDb: 0.2 + 0.6 * Math.max(0, a),
  };
}

/** Human label for the slider, e.g. "≈65 yrs · weathered". */
export function ageLabel(years: number): string {
  const y = Math.round(years);
  let tone: string;
  if (y < 28) tone = 'youthful';
  else if (y < 40) tone = 'natural';
  else if (y < 52) tone = 'seasoned';
  else if (y < 65) tone = 'weathered';
  else if (y < 78) tone = 'elderly';
  else tone = 'ancient';
  return `≈${y} yrs · ${tone}`;
}

/** Preset year values for the quick chips. */
export const AGE_PRESETS: { label: string; years: number }[] = [
  { label: 'Middle-aged', years: 50 },
  { label: 'Elderly', years: 70 },
  { label: 'Ancient', years: 85 },
];

/** Default age EDITH applies when no specific number is given. */
export const DEFAULT_AGE_YEARS = 65;

/**
 * ffmpeg audio-filter chain that bakes the same aging at export (dependency-free —
 * asetrate/atempo do the pitch+formant shift, so no rubberband build is required).
 * Returns a comma-joined filter string, or '' when the age is effectively neutral.
 */
export function buildFfmpegAgeChain(params: AgeParams, sampleRate = 48000): string {
  const a = params;
  // Neutral guard — nothing audible to bake.
  if (Math.abs(a.shiftRatio - 1) < 0.005 && Math.abs(a.tiltDb) < 0.2 && Math.abs(a.bodyDb) < 0.2) {
    return '';
  }
  const r = clamp(a.shiftRatio, 0.5, 2);
  const filters: string[] = [];
  // Pitch + formant shift together (deeper vocal tract): slow-down by r via asetrate,
  // resample back to the real rate, then restore duration with atempo=1/r. Net = the
  // voice is shifted by r with its original length. atempo must stay in [0.5, 2].
  if (Math.abs(r - 1) >= 0.005) {
    filters.push(`asetrate=${Math.round(sampleRate * r)}`);
    filters.push(`aresample=${sampleRate}`);
    filters.push(`atempo=${clamp(1 / r, 0.5, 2).toFixed(4)}`);
  }
  if (Math.abs(a.bodyDb) >= 0.2) filters.push(`bass=g=${a.bodyDb.toFixed(2)}:f=180`);
  if (Math.abs(a.tiltDb) >= 0.2) filters.push(`treble=g=${a.tiltDb.toFixed(2)}:f=6000`);
  if (Math.abs(a.brillianceDb) >= 0.2) filters.push(`equalizer=f=8000:t=q:w=1:g=${a.brillianceDb.toFixed(2)}`);
  if (Math.abs(a.throatDb) >= 0.2) filters.push(`equalizer=f=2200:t=q:w=1.4:g=${a.throatDb.toFixed(2)}`);
  // Micro instability. Depths are small and bounded.
  const jitterDepth = clamp(a.jitterPct / 100, 0, 0.08);
  if (jitterDepth >= 0.005) filters.push(`vibrato=f=6:d=${jitterDepth.toFixed(4)}`);
  const shimmerDepth = clamp(a.shimmerDb / 10, 0, 0.09);
  if (shimmerDepth >= 0.005) filters.push(`tremolo=f=6:d=${shimmerDepth.toFixed(4)}`);
  return filters.join(',');
}
