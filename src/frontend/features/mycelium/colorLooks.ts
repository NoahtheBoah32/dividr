/**
 * colorLooks — pure data + math for three EDITH skills:
 *   - setCurves:     user anchor points → 256-value per-channel LUTs
 *   - applyLook:     one-tap named looks written into colorGrade params
 *   - setClipColor:  named label palette for timeline clip color-coding
 *
 * No DOM, no store access — unit-testable. The LUTs slot straight into
 * `colorGrade.curves`, which the existing preview (SVG feComponentTransfer)
 * and export (FFmpeg `curves=`) pipelines already consume.
 */

import {
  CurveNode,
  sampleCurve,
} from '../editor/preview/utils/voiceIsolationCurve';

export type AnchorPoint = [number, number]; // [in, out], both 0..1

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** Piecewise-linear lookup over sampled curve points (x ascending). */
const yAt = (samples: CurveNode[], x: number): number => {
  if (samples.length === 0) return x;
  if (x <= samples[0].x) return samples[0].y;
  for (let i = 1; i < samples.length; i++) {
    if (samples[i].x >= x) {
      const a = samples[i - 1];
      const b = samples[i];
      return a.y + (b.y - a.y) * ((x - a.x) / Math.max(1e-6, b.x - a.x));
    }
  }
  return samples[samples.length - 1].y;
};

/**
 * Build a 256-entry LUT (values 0..255) from normalized anchor points.
 * Endpoints are implied: if the anchors don't cover x=0 / x=1, identity
 * endpoints are added so the curve always spans the full range.
 */
export function lutFromAnchors(anchors: AnchorPoint[]): number[] {
  const nodes: CurveNode[] = (anchors ?? [])
    .filter(
      (p) =>
        Array.isArray(p) &&
        p.length === 2 &&
        Number.isFinite(p[0]) &&
        Number.isFinite(p[1]),
    )
    .map((p) => ({ x: clamp01(p[0]), y: clamp01(p[1]) }))
    .sort((a, b) => a.x - b.x);

  if (nodes.length === 0 || nodes[0].x > 0.0001) nodes.unshift({ x: 0, y: 0 });
  if (nodes[nodes.length - 1].x < 0.9999) nodes.push({ x: 1, y: 1 });
  if (nodes.length < 2) return identityLut();

  const samples = sampleCurve(nodes, 32);
  const lut: number[] = new Array(256);
  for (let i = 0; i < 256; i++) {
    lut[i] = Math.round(clamp01(yAt(samples, i / 255)) * 255);
  }
  return lut;
}

export function identityLut(): number[] {
  return Array.from({ length: 256 }, (_, i) => i);
}

/** Blend a LUT toward identity: t=1 keeps the LUT, t=0 is a no-op. */
export function lerpLutToIdentity(lut: number[], t: number): number[] {
  const k = clamp01(t);
  return lut.map((v, i) => Math.round(i + (v - i) * k));
}

/** Compose master ∘ channel (master applied after the channel curve). */
const composeLut = (channel: number[], master: number[]): number[] =>
  channel.map((v) => master[Math.max(0, Math.min(255, v))]);

/** FFmpeg `curves=` filter string from the three LUTs (16-step sampling — matches the grade bake). */
export function ffmpegCurvesFilter(r: number[], g: number[], b: number[]): string {
  const pts = (lut: number[]) =>
    Array.from({ length: 17 }, (_, i) => {
      const x = i / 16;
      const idx = Math.round(x * 255);
      return `${x.toFixed(4)}/${(lut[idx] / 255).toFixed(4)}`;
    }).join(' ');
  return `curves=red='${pts(r)}':green='${pts(g)}':blue='${pts(b)}'`;
}

export interface CurveAnchorsInput {
  red?: AnchorPoint[];
  green?: AnchorPoint[];
  blue?: AnchorPoint[];
  master?: AnchorPoint[];
}

/**
 * Build the full `colorGrade.curves` payload from per-channel + master anchors.
 * Channels without anchors stay identity (master still applies to them).
 */
export function buildCurvesFromAnchors(input: CurveAnchorsInput): {
  r: number[];
  g: number[];
  b: number[];
  ffmpegFilter: string;
} {
  const master = input.master?.length ? lutFromAnchors(input.master) : identityLut();
  const r = composeLut(input.red?.length ? lutFromAnchors(input.red) : identityLut(), master);
  const g = composeLut(input.green?.length ? lutFromAnchors(input.green) : identityLut(), master);
  const b = composeLut(input.blue?.length ? lutFromAnchors(input.blue) : identityLut(), master);
  return { r, g, b, ffmpegFilter: ffmpegCurvesFilter(r, g, b) };
}

// ── Clip label palette (Labels / Colors) ────────────────────────────────

export const CLIP_LABEL_COLORS: Record<string, string> = {
  red: '#ef4444',
  orange: '#f97316',
  yellow: '#eab308',
  green: '#22c55e',
  teal: '#14b8a6',
  blue: '#3b82f6',
  purple: '#a855f7',
  pink: '#ec4899',
  gray: '#9ca3af',
};

/** Resolve a color name or #hex to a hex string; null when unknown. */
export function resolveLabelColor(input: unknown): string | null {
  if (typeof input !== 'string' || !input.trim()) return null;
  const q = input.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(q)) return q;
  if (/^#[0-9a-f]{3}$/.test(q)) {
    return `#${q[1]}${q[1]}${q[2]}${q[2]}${q[3]}${q[3]}`;
  }
  if (CLIP_LABEL_COLORS[q]) return CLIP_LABEL_COLORS[q];
  // loose synonyms
  const synonyms: Record<string, string> = {
    grey: 'gray', violet: 'purple', magenta: 'pink', cyan: 'teal',
    aqua: 'teal', gold: 'yellow', amber: 'orange', lime: 'green',
  };
  const mapped = synonyms[q];
  return mapped ? CLIP_LABEL_COLORS[mapped] : null;
}

// ── One-tap looks (Filters / LUTs) ──────────────────────────────────────

export interface LookPreset {
  /** Display name shown in status messages + the look picker. */
  title: string;
  /** colorGrade params (only the keys the look touches). */
  params: {
    temperature?: number;
    tint?: number;
    hue?: number;
    shadows?: number;
    midtones?: number;
    highlights?: number;
    vignette?: number;
    sharpen?: number;
    blur?: number;
    saturation?: number; // 0..2, 1 = neutral
    grain?: number;      // 0..100
  };
  /** Optional curve anchors layered on top of the params. */
  curves?: CurveAnchorsInput;
  aliases: string[];
}

export const LOOK_PRESETS: Record<string, LookPreset> = {
  'teal-orange': {
    title: 'Teal & Orange',
    params: { temperature: 14, tint: -6, shadows: -10, highlights: 8, saturation: 1.18 },
    curves: {
      red: [[0, 0], [0.5, 0.54], [1, 1]],
      blue: [[0, 0.06], [0.5, 0.47], [1, 0.94]],
    },
    aliases: ['tealorange', 'teal and orange', 'cinematic', 'blockbuster', 'movie'],
  },
  'warm-film': {
    title: 'Warm Film',
    params: { temperature: 24, shadows: 6, highlights: -6, saturation: 0.92, grain: 18 },
    curves: { master: [[0, 0.05], [0.5, 0.52], [1, 0.97]] },
    aliases: ['warm', 'film', 'kodak', 'golden', 'golden hour'],
  },
  cold: {
    title: 'Cold Steel',
    params: { temperature: -26, tint: 4, shadows: -6, saturation: 0.95 },
    aliases: ['cool', 'steel', 'winter', 'icy', 'blue look'],
  },
  bw: {
    title: 'Black & White',
    params: { saturation: 0, shadows: -14, highlights: 10, grain: 12 },
    aliases: ['black and white', 'blackwhite', 'noir', 'monochrome', 'grayscale', 'greyscale'],
  },
  sepia: {
    title: 'Sepia',
    params: { saturation: 0.25, temperature: 34, tint: 8, midtones: 5 },
    aliases: ['old photo', 'antique', 'brown'],
  },
  vintage: {
    title: 'Vintage Fade',
    params: { temperature: 10, saturation: 0.8, grain: 22, vignette: 25 },
    curves: { master: [[0, 0.1], [0.5, 0.52], [1, 0.93]] },
    aliases: ['faded', 'retro', '70s', 'old film', 'nostalgic'],
  },
  vibrant: {
    title: 'Vibrant Pop',
    params: { saturation: 1.35, midtones: 4, sharpen: 15 },
    aliases: ['pop', 'punchy', 'saturated', 'colorful', 'vivid'],
  },
  dreamy: {
    title: 'Dreamy Haze',
    params: { highlights: 12, saturation: 1.05, vignette: 12, temperature: 8 },
    curves: { master: [[0, 0.08], [0.45, 0.5], [1, 0.98]] },
    aliases: ['haze', 'soft', 'ethereal', 'pastel', 'airy'],
  },
};

/** Resolve a look by key, title, or alias (case/space tolerant). */
export function resolveLook(input: unknown): (LookPreset & { key: string }) | null {
  if (typeof input !== 'string' || !input.trim()) return null;
  const q = input.trim().toLowerCase().replace(/[_\s]+/g, ' ');
  for (const [key, look] of Object.entries(LOOK_PRESETS)) {
    if (
      key === q ||
      key.replace(/-/g, ' ') === q ||
      look.title.toLowerCase() === q ||
      look.aliases.some((a) => a === q)
    ) {
      return { key, ...look };
    }
  }
  // substring fallback ("apply the teal orange look please")
  for (const [key, look] of Object.entries(LOOK_PRESETS)) {
    if (q.includes(key.replace(/-/g, ' ')) || look.aliases.some((a) => q.includes(a))) {
      return { key, ...look };
    }
  }
  return null;
}

// ── Stinger sound candidates (best-first) ───────────────────────────────
// Resolved against the live SFX library at op time; the first present wins.
export const STINGER_CANDIDATES = [
  'dramatic_hit',
  'cinematic_hit',
  'impact',
  'vine_boom',
  'boom',
  'dramatic_impact',
  'orchestral_hit',
  'thunder',
  'bass_drop',
  'dun_dun_dun',
];
