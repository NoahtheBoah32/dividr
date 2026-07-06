/**
 * voiceIsolationCurve — pure, dependency-free math for the Voice Isolation
 * "separation curve".
 *
 * The curve is the exact model the user validated in the HTML concept:
 *   x = voiceness 0..1  (0 = noise / ambiance on the left, 1 = voice on the right)
 *   y = keep-gain 0..1  (1 = keep fully, 0 = cut)
 *
 * Four Catmull-Rom control nodes shape a smooth curve. Each frequency band of
 * the audio is assigned a fixed "voiceness prior" (how voice-like that band is);
 * the curve maps that prior to a keep-gain, which becomes a per-band dB cut.
 *
 * This SAME mapping drives both:
 *   - the real-time preview (Web Audio graphic-EQ graph), and
 *   - the export bake (ffmpeg equalizer/bass/treble chain),
 * so what you hear while dragging is what you get on export.
 *
 * No DOM, no Web Audio, no Node APIs here — keep it unit-testable.
 */

export interface CurveNode {
  x: number;
  y: number;
}

/** Sensible presets — identical to the validated HTML concept. */
export const VOICE_ISOLATION_PRESETS: Record<string, CurveNode[]> = {
  studio: [
    { x: 0, y: 0.04 },
    { x: 0.4, y: 0.07 },
    { x: 0.6, y: 0.86 },
    { x: 1, y: 0.985 },
  ],
  podcast: [
    { x: 0, y: 0.1 },
    { x: 0.34, y: 0.17 },
    { x: 0.64, y: 0.8 },
    { x: 1, y: 0.94 },
  ],
  ambiance: [
    { x: 0, y: 0.36 },
    { x: 0.34, y: 0.42 },
    { x: 0.66, y: 0.83 },
    { x: 1, y: 0.92 },
  ],
  light: [
    { x: 0, y: 0.56 },
    { x: 0.35, y: 0.62 },
    { x: 0.68, y: 0.9 },
    { x: 1, y: 1 },
  ],
};

/** EDITH's default pick — natural, balanced cleanup. */
export const DEFAULT_VOICE_ISOLATION_NODES: CurveNode[] =
  VOICE_ISOLATION_PRESETS.podcast.map((p) => ({ ...p }));

/** A passthrough curve (keep everything) — the effect does nothing. */
export const PASSTHROUGH_NODES: CurveNode[] = [
  { x: 0, y: 1 },
  { x: 0.34, y: 1 },
  { x: 0.66, y: 1 },
  { x: 1, y: 1 },
];

const clamp = (v: number, a: number, b: number): number =>
  Math.max(a, Math.min(b, v));

/** Validate / repair a node array so downstream math is always safe. */
export function normalizeNodes(nodes: unknown): CurveNode[] {
  if (!Array.isArray(nodes) || nodes.length < 2) {
    return DEFAULT_VOICE_ISOLATION_NODES.map((p) => ({ ...p }));
  }
  const cleaned = nodes
    .filter(
      (n): n is CurveNode =>
        !!n &&
        typeof (n as any).x === 'number' &&
        typeof (n as any).y === 'number' &&
        Number.isFinite((n as any).x) &&
        Number.isFinite((n as any).y),
    )
    .map((n) => ({ x: clamp(n.x, 0, 1), y: clamp(n.y, 0, 1) }))
    .sort((a, b) => a.x - b.x);
  if (cleaned.length < 2)
    return DEFAULT_VOICE_ISOLATION_NODES.map((p) => ({ ...p }));
  return cleaned;
}

/**
 * Catmull-Rom spline sampling over the control nodes — a direct port of the
 * validated HTML `spline()`. Returns densely sampled {x,y} points, x ascending,
 * both clamped to [0,1].
 */
export function sampleCurve(nodes: CurveNode[], stepsPerSeg = 20): CurveNode[] {
  const n = nodes.length;
  const pts: CurveNode[] = [];
  for (let i = 0; i < n - 1; i++) {
    const a = nodes[i - 1] || nodes[i];
    const b = nodes[i];
    const c = nodes[i + 1];
    const d = nodes[i + 2] || nodes[i + 1];
    for (let s = 0; s <= stepsPerSeg; s++) {
      const t = s / stepsPerSeg;
      const t2 = t * t;
      const t3 = t2 * t;
      pts.push({
        x: clamp(
          0.5 *
            (2 * b.x +
              (-a.x + c.x) * t +
              (2 * a.x - 5 * b.x + 4 * c.x - d.x) * t2 +
              (-a.x + 3 * b.x - 3 * c.x + d.x) * t3),
          0,
          1,
        ),
        y: clamp(
          0.5 *
            (2 * b.y +
              (-a.y + c.y) * t +
              (2 * a.y - 5 * b.y + 4 * c.y - d.y) * t2 +
              (-a.y + 3 * b.y - 3 * c.y + d.y) * t3),
          0,
          1,
        ),
      });
    }
  }
  return pts;
}

/** Keep-gain at voiceness x — piecewise-linear over the sampled curve (HTML `yAt`). */
export function gainAtVoiceness(samples: CurveNode[], x: number): number {
  if (samples.length === 0) return 1;
  if (x <= samples[0].x) return samples[0].y;
  for (let i = 1; i < samples.length; i++) {
    if (samples[i].x >= x) {
      const a = samples[i - 1];
      const b = samples[i];
      return a.y + (b.y - a.y) * ((x - a.x) / Math.max(1e-6, b.x - a.x));
    }
  }
  return samples[samples.length - 1].y;
}

/**
 * EQ band table. Each band has a center frequency, a "voiceness prior" (how
 * voice-like that part of the spectrum is — speech mids high, rumble/hiss low),
 * a filter shape, and a Q. The lowest band is a low-shelf and the highest a
 * high-shelf so the extremes are broadly controlled; the middle bands are
 * peaking. This topology maps 1:1 to ffmpeg `bass` / `equalizer` / `treble`.
 */
export interface EqBand {
  freq: number;
  voiceness: number;
  q: number;
  type: 'lowshelf' | 'peaking' | 'highshelf';
}

export const EQ_BANDS: EqBand[] = [
  { freq: 70, voiceness: 0.02, q: 0.7, type: 'lowshelf' },
  { freq: 130, voiceness: 0.12, q: 1.0, type: 'peaking' },
  { freq: 250, voiceness: 0.5, q: 1.1, type: 'peaking' },
  { freq: 500, voiceness: 0.82, q: 1.1, type: 'peaking' },
  { freq: 1000, voiceness: 1.0, q: 1.1, type: 'peaking' },
  { freq: 2000, voiceness: 0.95, q: 1.1, type: 'peaking' },
  { freq: 3500, voiceness: 0.7, q: 1.1, type: 'peaking' },
  { freq: 6000, voiceness: 0.34, q: 1.0, type: 'peaking' },
  { freq: 9000, voiceness: 0.13, q: 1.0, type: 'peaking' },
  { freq: 12000, voiceness: 0.04, q: 0.7, type: 'highshelf' },
];

/** Floor on keep-gain so we never request -inf dB (max ~ -40 dB cut). */
const MIN_KEEP = 0.01;
const MIN_DB = -40;
const MAX_DB = 0;

/** keep-gain (0..1) -> dB, clamped to [-40, 0]. */
export function keepToDb(keep: number): number {
  const k = clamp(keep, MIN_KEEP, 1);
  return clamp(20 * Math.log10(k), MIN_DB, MAX_DB);
}

export interface BandGain extends EqBand {
  keep: number;
  db: number;
}

/**
 * Compute per-band gains from the curve nodes. This is the single source of
 * truth shared by preview and export.
 */
export function computeBandGains(nodes: CurveNode[]): BandGain[] {
  const samples = sampleCurve(normalizeNodes(nodes));
  return EQ_BANDS.map((band) => {
    const keep = gainAtVoiceness(samples, band.voiceness);
    return { ...band, keep, db: keepToDb(keep) };
  });
}

/**
 * True if the curve meaningfully changes the audio (any band cut beyond ~0.5 dB).
 * Used to skip work / show "no effect" states.
 */
export function curveHasEffect(nodes: CurveNode[]): boolean {
  return computeBandGains(nodes).some((b) => b.db < -0.5);
}

/**
 * Build an ffmpeg audio-filter fragment that realizes the same per-band EQ for
 * export. Returns a comma-joined chain of bass/equalizer/treble filters, or ''
 * if the curve has no effect.
 */
export function buildFfmpegEqChain(nodes: CurveNode[]): string {
  const bands = computeBandGains(nodes);
  const parts: string[] = [];
  for (const b of bands) {
    // Skip near-zero adjustments to keep the chain short and clean.
    if (b.db > -0.25) continue;
    const g = b.db.toFixed(2);
    if (b.type === 'lowshelf') {
      // Match the Web Audio low-shelf, which uses a fixed slope (S=1) and ignores
      // Q. ffmpeg `bass` defaults to width_type=q w=0.5, a different (wider) knee —
      // so pin the slope explicitly to keep preview and export roll-offs identical.
      parts.push(`bass=g=${g}:f=${b.freq}:width_type=s:w=1`);
    } else if (b.type === 'highshelf') {
      // Same reasoning for the high-shelf (Web Audio high-shelf is also S=1).
      parts.push(`treble=g=${g}:f=${b.freq}:width_type=s:w=1`);
    } else {
      parts.push(`equalizer=f=${b.freq}:width_type=q:w=${b.q}:g=${g}`);
    }
  }
  return parts.join(',');
}

/**
 * Voice-forward chain parameters.
 *
 * An EQ alone can only cut, so the voice can never come forward and overlapping
 * midrange (voice + music + room) stays muddy. The fix is a fixed "voice-forward"
 * post-chain that runs whenever isolation is enabled, on top of the curve EQ
 * (and, when available, on top of the real-time RNNoise denoise):
 *   - high-pass: strip sub-bass rumble / AC hum / handling thumps (mud),
 *   - presence: a lift around 2.8 kHz for intelligibility / clarity,
 *   - compressor: even out and PUSH the voice forward (so it gets louder, not
 *     only quieter), with makeup gain.
 *
 * The amount scales with how aggressively the curve cuts the noise side, so the
 * presets keep their character (Studio pushes hard, Light stays gentle). The
 * SAME params drive the live Web Audio nodes (preview) and the ffmpeg chain
 * (export), so what you hear is what you get.
 */
export interface VoiceForwardParams {
  /** strength 0..1 derived from the curve's noise-side cut (Light≈0.4, Studio≈1). */
  strength: number;
  highpassHz: number;
  presenceHz: number;
  presenceDb: number;
  /** overall makeup gain in dB (>0 so the voice gets louder). */
  makeupDb: number;
  compressor: {
    thresholdDb: number;
    ratio: number;
    attack: number; // seconds (Web Audio)
    release: number; // seconds (Web Audio)
    knee: number; // dB
  };
}

/** How hard the curve cuts the noise side -> 0 (keep all) .. 1 (full cut). */
export function curveStrength(nodes: CurveNode[]): number {
  const samples = sampleCurve(normalizeNodes(nodes));
  const noiseKeep = gainAtVoiceness(samples, 0.1);
  return clamp(1 - noiseKeep, 0, 1);
}

/** Derive the voice-forward chain params from the separation curve. */
export function voiceForwardParams(nodes: CurveNode[]): VoiceForwardParams {
  const strength = curveStrength(nodes);
  const round2 = (v: number) => Math.round(v * 100) / 100;
  return {
    strength: round2(strength),
    highpassHz: Math.round(70 + 40 * strength), // 70..110 Hz
    presenceHz: 2800,
    presenceDb: round2(2 + 4 * strength), // +2..+6 dB
    // Makeup is sized to OVERCOME the compressor's gain reduction and then some,
    // so the net effect is the voice getting louder and more present (not the
    // quieter-overall trap of low-threshold + low-makeup compression).
    makeupDb: round2(3 + 6 * strength), // +3..+9 dB
    compressor: {
      thresholdDb: round2(-18 - 6 * strength), // -18..-24 dB (peak-catching)
      ratio: round2(2 + 1.2 * strength), // 2..3.2 : 1 (gentle)
      attack: 0.005,
      release: 0.18,
      knee: 6,
    },
  };
}

const dbToLinear = (db: number): number => Math.pow(10, db / 20);

/**
 * Build the ffmpeg fragment for the voice-forward post-chain (high-pass +
 * presence + compressor). Mirrors the live Web Audio nodes so export matches
 * preview. Always returns a non-empty chain (the effect is meaningful whenever
 * isolation is enabled, even when the curve EQ itself is near-flat).
 */
export function buildFfmpegVoiceForwardChain(nodes: CurveNode[]): string {
  const p = voiceForwardParams(nodes);
  const thLin = dbToLinear(p.compressor.thresholdDb).toFixed(4);
  const makeupLin = dbToLinear(p.makeupDb).toFixed(3);
  return [
    `highpass=f=${p.highpassHz}`,
    `equalizer=f=${p.presenceHz}:width_type=q:w=1:g=${p.presenceDb.toFixed(2)}`,
    `acompressor=threshold=${thLin}:ratio=${p.compressor.ratio}:attack=5:release=180:makeup=${makeupLin}:knee=${p.compressor.knee}`,
  ].join(',');
}

/**
 * Full export chain for voice isolation: the separation-curve EQ followed by the
 * voice-forward chain. (The RNNoise `arnndn` denoise is prepended separately in
 * the main process, where the model path lives.)
 */
export function buildFfmpegVoiceChain(nodes: CurveNode[]): string {
  const eq = buildFfmpegEqChain(nodes);
  const forward = buildFfmpegVoiceForwardChain(nodes);
  return [eq, forward].filter((s) => s.length > 0).join(',');
}

/**
 * Map the separation curve to the two STEM levels for the live mix.
 *
 * The curve's voiceness axis maps directly onto the two real layers:
 *   - the VOICE stem is high-voiceness  -> its level is the curve at x = 1,
 *   - the BACKGROUND stem is low-voiceness -> its level is the curve at x = 0.
 *
 * So dragging the LEFT side of the curve down mutes the dedicated background
 * stem (real removal, not just EQ), and dragging the RIGHT side down drops the
 * voice. With the default presets the left side already sits low (background
 * mostly out) and the right side high (voice kept). Both are 0..1, clamped.
 */
export function stemMixGains(nodes: CurveNode[]): { voice: number; bg: number } {
  const samples = sampleCurve(normalizeNodes(nodes));
  return {
    voice: clamp(gainAtVoiceness(samples, 1), 0, 1),
    bg: clamp(gainAtVoiceness(samples, 0), 0, 1),
  };
}

/** Coarse human label for the curve's aggressiveness (mirrors the HTML readout). */
export function separationLabel(nodes: CurveNode[]): string {
  const samples = sampleCurve(normalizeNodes(nodes));
  let x25: number | null = null;
  let x75: number | null = null;
  for (let k = 0; k <= 160; k++) {
    const x = k / 160;
    const y = gainAtVoiceness(samples, x);
    if (x25 === null && y >= 0.25) x25 = x;
    if (x75 === null && y >= 0.75) {
      x75 = x;
      break;
    }
  }
  if (x25 !== null && x75 !== null) {
    const w = x75 - x25;
    return w < 0.16 ? 'Aggressive' : w < 0.4 ? 'Natural' : 'Gentle';
  }
  return normalizeNodes(nodes)[0].y > 0.7 ? 'Off · keep all' : 'Gentle';
}
