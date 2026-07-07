/**
 * paintedLightUtils — pure, dependency-free math for the Light Brush (Skill 4).
 *
 * Single source of truth shared by EDITH's detectLight/paintLight ops, the manual
 * LightBrushOverlay, and the LightCompositeOverlay renderer. No model, no token:
 * light COLOR comes from a Shades-of-Gray illuminant estimate cross-checked against
 * the brightest-highlight chroma; light DIRECTION from the luminance centroid of the
 * brightest pixels (the classic "lighting from shading" 2.5D cue). All in-browser.
 */

export interface LightSource {
  /** Dominant light direction as a unit vector in frame space (x right, y down). */
  dir: [number, number];
  /** Azimuth of `dir` in degrees (0 = from the right, 90 = from below, CCW-ish). */
  azimuth: number;
  /** Rough elevation in degrees (higher = more head-on, lower = more grazing). */
  elevation: number;
  /** Estimated light color, 0..255 RGB. */
  color: [number, number, number];
  /** 0..1 — how strongly directional the estimate is (off-centre highlight = higher). */
  confidence: number;
}

export interface PaintedLight {
  id: string;
  /** Position in normalized frame space, 0..1. */
  pos: [number, number];
  /** Radius as a fraction of the frame's smaller dimension, 0..1. */
  radius: number;
  /** 0..2 — brightness of the added light. */
  intensity: number;
  /** Light color, 0..255 RGB. */
  color: [number, number, number];
  /** Canvas/CSS blend mode used to composite the light. */
  blend: 'screen' | 'soft-light' | 'overlay' | 'lighten';
  /** Optional BlazePose landmark index to anchor+track the light to a body part. */
  anchor?: number;
  /** Confine the light to the subject (RVM alpha) or let it fall on the whole frame. */
  maskMode: 'subject' | 'free';
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const clamp01 = (v: number) => clamp(v, 0, 1);

/** Rec.709 luma from 0..255 channels. */
export function luma(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Kelvin → RGB (Tanner Helland approximation), 0..255. 1500K (candle) → warm,
 * 6500K → neutral, 12000K → cool blue. Used to turn a temperature slider into color.
 */
export function kelvinToRgb(kelvin: number): [number, number, number] {
  const t = clamp(kelvin, 1000, 40000) / 100;
  let r: number, g: number, b: number;
  if (t <= 66) {
    r = 255;
    g = clamp(99.4708025861 * Math.log(t) - 161.1195681661, 0, 255);
    b = t <= 19 ? 0 : clamp(138.5177312231 * Math.log(t - 10) - 305.0447927307, 0, 255);
  } else {
    r = clamp(329.698727446 * Math.pow(t - 60, -0.1332047592), 0, 255);
    g = clamp(288.1221695283 * Math.pow(t - 60, -0.0755148492), 0, 255);
    b = 255;
  }
  return [Math.round(r), Math.round(g), Math.round(b)];
}

/**
 * Estimate the dominant light (color + direction) from a downscaled RGBA frame.
 * Pure: takes the pixel array + dimensions, returns a LightSource. Robust to any
 * input (falls back to a neutral top-left key light when the frame is flat).
 */
export function estimateLight(data: Uint8ClampedArray, width: number, height: number): LightSource {
  const n = width * height;
  if (n === 0 || data.length < 4) return defaultLight();

  // Shades-of-Gray illuminant (Minkowski p=6) — robust generalization of gray-world.
  const P = 6;
  let sr = 0, sg = 0, sb = 0;
  // Brightest-highlight accumulation for direction + highlight chroma.
  let cx = 0, cy = 0, wsum = 0;
  let hr = 0, hg = 0, hb = 0, hcount = 0;
  // First pass: mean luma to set a highlight threshold.
  let lumaSum = 0, lumaMax = 0;
  const stride = 1; // caller already downscales
  for (let i = 0; i < n; i += stride) {
    const o = i * 4;
    const L = luma(data[o], data[o + 1], data[o + 2]);
    lumaSum += L;
    if (L > lumaMax) lumaMax = L;
  }
  const lumaMean = lumaSum / n;
  const hiThresh = lumaMean + (lumaMax - lumaMean) * 0.55; // top of the bright range

  for (let i = 0; i < n; i += stride) {
    const o = i * 4;
    const r = data[o], g = data[o + 1], b = data[o + 2];
    sr += Math.pow(r, P);
    sg += Math.pow(g, P);
    sb += Math.pow(b, P);
    const L = luma(r, g, b);
    if (L >= hiThresh) {
      const x = i % width;
      const y = (i / width) | 0;
      const w = L - hiThresh + 1;
      cx += x * w;
      cy += y * w;
      wsum += w;
      hr += r; hg += g; hb += b; hcount++;
    }
  }

  // Illuminant color: blend Shades-of-Gray with the highlight chroma (highlights carry
  // the light's color most directly). Normalize so the brightest channel is 255.
  const sog: [number, number, number] = [
    Math.pow(sr / n, 1 / P),
    Math.pow(sg / n, 1 / P),
    Math.pow(sb / n, 1 / P),
  ];
  const hi: [number, number, number] = hcount
    ? [hr / hcount, hg / hcount, hb / hcount]
    : sog;
  let color: [number, number, number] = [
    0.4 * sog[0] + 0.6 * hi[0],
    0.4 * sog[1] + 0.6 * hi[1],
    0.4 * sog[2] + 0.6 * hi[2],
  ];
  const maxc = Math.max(color[0], color[1], color[2], 1);
  color = [
    Math.round((color[0] / maxc) * 255),
    Math.round((color[1] / maxc) * 255),
    Math.round((color[2] / maxc) * 255),
  ];

  // Direction: unit vector from frame centre to the bright-highlight centroid.
  let dx = 0, dy = 0, confidence = 0;
  if (wsum > 0) {
    const bx = cx / wsum / width; // 0..1
    const by = cy / wsum / height;
    dx = bx - 0.5;
    dy = by - 0.5;
    const mag = Math.hypot(dx, dy);
    confidence = clamp01(mag * 2); // centre → 0, corner → ~1
    if (mag > 1e-4) {
      dx /= mag;
      dy /= mag;
    } else {
      dx = -0.7071; dy = -0.7071; // flat highlight → default key from top-left
    }
  } else {
    dx = -0.7071; dy = -0.7071;
  }
  const azimuth = (Math.atan2(dy, dx) * 180) / Math.PI;
  // Grazing when the highlight is far off-centre; head-on when centred.
  const elevation = clamp(60 - confidence * 40, 15, 60);

  return { dir: [dx, dy], azimuth, elevation, color, confidence };
}

/** A sensible neutral key light from the top-left when nothing can be estimated. */
export function defaultLight(): LightSource {
  return { dir: [-0.7071, -0.7071], azimuth: -135, elevation: 45, color: [255, 244, 224], confidence: 0.35 };
}

/** Drag vector → azimuth in degrees. */
export function dragToAzimuth(dx: number, dy: number): number {
  return (Math.atan2(dy, dx) * 180) / Math.PI;
}

/**
 * Place a painted light that matches a detected LightSource: on the bright side of
 * the frame, tinted the light's colour. Used by detectLight to auto-add a light and
 * by paintLight as the starting point.
 */
export function lightFromSource(src: LightSource, id: string, intensity = 0.8): PaintedLight {
  // Put the light where the illumination comes FROM (bright side), just inside the frame.
  const pos: [number, number] = [
    clamp01(0.5 + src.dir[0] * 0.42),
    clamp01(0.5 + src.dir[1] * 0.42),
  ];
  return {
    id,
    pos,
    radius: 0.5,
    intensity: clamp(intensity, 0, 2),
    color: src.color,
    blend: 'soft-light',
    maskMode: 'free',
  };
}

/**
 * Radial-gradient colour stops for a painted light. Returns [offset, 'rgba(...)']
 * pairs the renderer feeds into a CanvasGradient (centre bright → transparent edge).
 */
export function lightGradientStops(
  light: Pick<PaintedLight, 'color' | 'intensity'>,
): { offset: number; color: string }[] {
  const [r, g, b] = light.color;
  const a = clamp(light.intensity, 0, 2);
  return [
    { offset: 0, color: `rgba(${r},${g},${b},${clamp01(0.85 * a).toFixed(3)})` },
    { offset: 0.45, color: `rgba(${r},${g},${b},${clamp01(0.4 * a).toFixed(3)})` },
    { offset: 0.8, color: `rgba(${r},${g},${b},${clamp01(0.12 * a).toFixed(3)})` },
    { offset: 1, color: `rgba(${r},${g},${b},0)` },
  ];
}

let seq = 0;
/** Stable-ish id for a new painted light (no Date.now / Math.random needed). */
export function newLightId(): string {
  seq += 1;
  return `light_${seq}`;
}
