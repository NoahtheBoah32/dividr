/**
 * speedRampCurve — the math behind the per-clip speed ramp.
 *
 * A ramp REGION is a working window [a,b] in source seconds. Inside it the
 * speed is a staircase of constant-speed HOLDS joined by smooth TRANSITIONS.
 * The first and last hold are pinned to 1x so a ramp always splices back into
 * the untouched clip with no jump.
 *
 * Speed is interpolated in LOG space: going 1x -> 30x -> 1x reads as a
 * symmetric arc rather than a spike, and 0.25x slow-mo gets the same visual
 * weight as 4x fast. Every transition uses an easing with zero slope at both
 * ends, so it meets its neighbouring holds tangentially — no corner, no step.
 * That tangency is what makes the result read as a drone move instead of a cut.
 *
 * A transition is stored as its two EDGES (t0 < t1), not a centre plus a
 * half-width. That keeps the editor's drag behaviour honest: the left handle
 * owns the left edge and the right handle owns the right edge, so a handle
 * always travels in the same direction as the pointer.
 */

export type RampShape = 'smooth' | 'whip' | 'snap' | 'linear';
export type RampBlend = 'off' | 'blend' | 'flow';

/** One speed transition, as the absolute source-second span it occupies. */
export interface RampTransition {
  t0: number;
  t1: number;
}

export interface SpeedRegion {
  /** Working window in source seconds. Only this span may be edited. */
  a: number;
  b: number;
  shape: RampShape;
  dir: 'forward' | 'reverse';
  /** n+1 hold speeds; segs[0] and segs[n] are always 1. */
  segs: number[];
  /** n transitions between the holds, ordered and non-overlapping. */
  bounds: RampTransition[];
}

export interface SpeedRampState {
  enabled: boolean;
  regions: SpeedRegion[];
  /** How in-between frames are synthesised when speeding up. */
  blend: RampBlend;
  /** Time-stretch the audio along with the picture. */
  audio: boolean;
  /** Preserve pitch while stretching (ignored when audio is off). */
  pitch: boolean;
  /** Set once EDITH has laid a ramp down — unlocks the manual editor. */
  appliedByEdith?: boolean;
}

/** Speed bounds. 0.1x is a 10x slow-mo; 40x covers a long timelapse. */
export const SPEED_MIN = 0.1;
export const SPEED_MAX = 40;
/** A region narrower than this can't hold a legible ramp. */
export const MIN_REGION = 1.2;
/** Gap kept between adjacent regions so their walls stay separately grabbable. */
export const REGION_GAP = 0.3;
/**
 * A transition shorter than this is a cut, not a ramp. At 30fps 0.25s is about
 * seven frames, which is the least that still reads as an acceleration — below
 * it the eye sees the speed change as a splice no matter how good the easing.
 */
export const MIN_RAMP = 0.25;
/** Gap kept between adjacent transitions so a hold always survives between them. */
export const HOLD_GAP = 0.2;
export const MAX_HOLDS = 4;

export const clamp = (v: number, a: number, b: number) =>
  v < a ? a : v > b ? b : v;
const lerp = (a: number, b: number, k: number) => a + (b - a) * k;

/**
 * Easing families. Every one of these satisfies f(0)=0, f(1)=1, f'(0)=f'(1)=0.
 * The zero end-slopes are the whole point — they are what removes the corner
 * where a transition meets a constant-speed hold.
 */
export function easeShape(u: number, shape: RampShape): number {
  const x = clamp(u, 0, 1);
  switch (shape) {
    // Linear is the one family with non-zero end slopes; offered because some
    // edits genuinely want a mechanical, constant-rate change.
    case 'linear':
      return x;
    // Front-loaded: most of the speed change happens early, then it coasts.
    // Biasing smootherstep rather than the raw input matters — biasing x
    // directly (pow(x,0.62) first) reintroduces a near-infinite slope at 0,
    // which is exactly the corner these curves exist to avoid.
    case 'whip':
      return Math.pow(x * x * x * (x * (x * 6 - 15) + 10), 0.62);
    // Smoothstep applied twice — sits flat longer, then moves decisively.
    case 'snap': {
      const q = x * x * (3 - 2 * x);
      return q * q * (3 - 2 * q);
    }
    // smootherstep: C2 continuous, zero 1st AND 2nd derivative at both ends.
    // This is the default because matching curvature (not just slope) is what
    // stops the eye from finding the seam.
    default:
      return x * x * x * (x * (x * 6 - 15) + 10);
  }
}

/** Speed inside a region at source time t (t is assumed within [a,b]). */
export function speedInRegion(r: SpeedRegion, t: number): number {
  const n = r.bounds.length;
  for (let i = 0; i < n; i++) {
    const { t0, t1 } = r.bounds[i];
    if (t < t0) return r.segs[i];
    if (t <= t1) {
      const u = (t - t0) / Math.max(1e-4, t1 - t0);
      return Math.exp(
        lerp(
          Math.log(r.segs[i]),
          Math.log(r.segs[i + 1]),
          easeShape(u, r.shape),
        ),
      );
    }
  }
  return r.segs[n];
}

/** Speed at source time t across the whole clip. 1x outside every region. */
export function speedAt(regions: SpeedRegion[], t: number): number {
  for (let i = 0; i < regions.length; i++) {
    const r = regions[i];
    if (t >= r.a && t <= r.b) return speedInRegion(r, t);
  }
  return 1;
}

/** The speed furthest from 1x in either direction — used to colour a region. */
export function extremeSpeed(r: SpeedRegion): number {
  let best = 1;
  for (const s of r.segs) {
    if (Math.abs(Math.log(s)) > Math.abs(Math.log(best))) best = s;
  }
  return best;
}

export function peakSpeed(r: SpeedRegion): number {
  return Math.max(...r.segs);
}

/**
 * A sampled source->output time map.
 *
 * Output duration is the integral of dt/speed(t), which has no closed form for
 * an eased curve, so it is integrated numerically once and then inverted by
 * binary search. Both directions are needed: the compositor asks "what source
 * frame do I show at this output time" (srcAt) while the UI asks "where does
 * this source moment land in the export" (outAt).
 */
export interface RampProfile {
  /** Source duration this profile was built for. */
  duration: number;
  /** Output (post-ramp) duration in seconds. */
  outDuration: number;
  /** Output time for a given source time. */
  outAt: (t: number) => number;
  /** Source time for a given output time — the one playback actually needs. */
  srcAt: (o: number) => number;
}

const PROFILE_STEPS = 2048;

export function buildProfile(
  regions: SpeedRegion[],
  duration: number,
): RampProfile {
  const steps = PROFILE_STEPS;
  const dt = duration / steps;
  const cum = new Float64Array(steps + 1);
  for (let i = 0; i < steps; i++) {
    // Midpoint rule: sampling the centre of each slice rather than an edge
    // keeps the integral accurate through the steep part of a ramp.
    const s = Math.max(0.02, speedAt(regions, (i + 0.5) * dt));
    cum[i + 1] = cum[i] + dt / s;
  }
  const outDuration = cum[steps];

  const outAt = (t: number) => {
    const f = (clamp(t, 0, duration) / duration) * steps;
    const i = Math.floor(f);
    if (i >= steps) return cum[steps];
    return lerp(cum[i], cum[i + 1], f - i);
  };

  const srcAt = (o: number) => {
    const target = clamp(o, 0, outDuration);
    let lo = 0;
    let hi = steps;
    while (lo < hi - 1) {
      const m = (lo + hi) >> 1;
      if (cum[m] <= target) lo = m;
      else hi = m;
    }
    const d = cum[hi] - cum[lo];
    // Linear interpolation inside the bracket. The table is dense enough that
    // this stays sub-frame accurate even at 40x.
    return ((lo + (d > 1e-9 ? (target - cum[lo]) / d : 0)) / steps) * duration;
  };

  return { duration, outDuration, outAt, srcAt };
}

/**
 * Force a region set back into a legal shape after any edit.
 *
 * Regions are kept sorted and non-overlapping by pushing each one to start at
 * or after the previous one's end. A colliding region gives way itself; it
 * never shrinks the region before it, because the one being dragged should be
 * the only one that moves.
 */
export function clampRegions(
  regions: SpeedRegion[],
  duration: number,
): SpeedRegion[] {
  regions.sort((p, q) => p.a - q.a);
  let prevEnd = 0;
  for (const r of regions) {
    r.a = Math.max(r.a, prevEnd);
    r.b = Math.min(Math.max(r.b, r.a + MIN_REGION), duration);
    r.a = Math.min(r.a, r.b - MIN_REGION);
    prevEnd = r.b + REGION_GAP;

    // The 1x anchors are structural, not editable.
    r.segs[0] = 1;
    r.segs[r.segs.length - 1] = 1;
    for (let k = 1; k < r.segs.length - 1; k++) {
      r.segs[k] = clamp(r.segs[k], SPEED_MIN, SPEED_MAX);
    }

    // Transitions: ordered, inside the window, never touching, never inverted.
    const n = r.bounds.length;
    for (let k = 0; k < n; k++) {
      const bd = r.bounds[k];
      const lo = k === 0 ? r.a : r.bounds[k - 1].t1 + HOLD_GAP;
      const hi = k === n - 1 ? r.b : r.bounds[k + 1].t0 - HOLD_GAP;
      const room = Math.max(MIN_RAMP, hi - lo);
      bd.t0 = clamp(bd.t0, lo, hi - MIN_RAMP);
      bd.t1 = clamp(bd.t1, bd.t0 + MIN_RAMP, lo + room);
      bd.t0 = Math.min(bd.t0, bd.t1 - MIN_RAMP);
    }
  }
  return regions;
}

/** Lay n interior holds evenly across an event span. Used by add/remove hold. */
export function layoutHolds(
  r: SpeedRegion,
  e0: number,
  e1: number,
  interior: number[],
): void {
  const n = interior.length;
  const nb = n + 1;
  const span = Math.max(0.8, e1 - e0);
  // Two thirds of the span goes to the ramps, one third to the flat holds —
  // enough plateau to read as a held speed, enough ramp to read as smooth.
  const rampW = (span * 0.66) / nb;
  const holdW = n ? (span * 0.34) / n : 0;
  const bounds: RampTransition[] = [];
  let t = e0;
  for (let i = 0; i < nb; i++) {
    bounds.push({ t0: t, t1: t + rampW });
    t += rampW;
    if (i < n) t += holdW;
  }
  r.segs = [1, ...interior, 1];
  r.bounds = bounds;
}

/**
 * Move or resize a region's window, carrying its curve with it.
 *
 * Transitions are stored as absolute source times, so a wall drag that only
 * writes `a` and `b` leaves them where they were and the clamp then crushes
 * them against the new wall — drag a 4-second ramp sideways and its 1.7s
 * acceleration collapses to MIN_RAMP, which is precisely the instantaneous cut
 * the whole feature exists to avoid. Rescaling the transitions into the new
 * window keeps the shape the user drew; only its extent changes.
 */
export function reframeRegion(
  r: SpeedRegion,
  from: SpeedRegion,
  newA: number,
  newB: number,
): void {
  const oldSpan = Math.max(1e-4, from.b - from.a);
  const k = (newB - newA) / oldSpan;
  // Always mapped from `from` (the state at grab), never from r's own current
  // bounds, so a long drag cannot compound its own rescaling.
  r.bounds = from.bounds.map((b) => ({
    t0: newA + (b.t0 - from.a) * k,
    t1: newA + (b.t1 - from.a) * k,
  }));
  r.a = newA;
  r.b = newB;
}

/** The span actually occupied by transitions, ignoring the flat anchors. */
export function eventSpan(r: SpeedRegion): [number, number] {
  const f = r.bounds[0];
  const l = r.bounds[r.bounds.length - 1];
  return [f.t0, l.t1];
}

export function cloneRegions(rs: SpeedRegion[]): SpeedRegion[] {
  return rs.map((r) => ({
    a: r.a,
    b: r.b,
    shape: r.shape,
    dir: r.dir,
    segs: r.segs.slice(),
    bounds: r.bounds.map((b) => ({ t0: b.t0, t1: b.t1 })),
  }));
}

/**
 * Build the region EDITH lays down for "take it to <speed> between <a> and <b>".
 * The ramp in and out are sized as a fraction of the window so the same request
 * reads the same whether the window is 2 seconds or 20.
 */
export function makeRegion(
  a: number,
  b: number,
  speed: number,
  shape: RampShape = 'smooth',
): SpeedRegion {
  const r: SpeedRegion = {
    a,
    b,
    shape,
    dir: 'forward',
    segs: [1, clamp(speed, SPEED_MIN, SPEED_MAX), 1],
    bounds: [],
  };
  const span = b - a;
  layoutHolds(r, a + span * 0.12, b - span * 0.12, [
    clamp(speed, SPEED_MIN, SPEED_MAX),
  ]);
  return r;
}

export const DEFAULT_BLEND: RampBlend = 'blend';

/** Speeds the plateau handle snaps to while dragging. */
export const SPEED_SNAPS = [
  0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 5, 8, 10, 15, 20, 25, 30, 40,
];

export function formatSpeed(v: number, unit: 'x' | 'pct' = 'x'): string {
  if (unit === 'pct') return `${Math.round(v * 100)}%`;
  return `${v >= 10 ? v.toFixed(0) : v.toFixed(v < 1 ? 2 : 1)}×`;
}

/**
 * How many distinct SOURCE frames survive into the export.
 * Slow motion repeats frames rather than inventing them, so the count is of
 * distinct source indices and can never exceed what the clip started with.
 */
export function framesKept(
  profile: RampProfile,
  fps: number,
): { kept: number; total: number } {
  const total = Math.round(profile.duration * fps);
  const n = Math.floor(profile.outDuration * fps);
  const seen = new Set<number>();
  for (let k = 0; k <= n; k++) {
    seen.add(Math.round(profile.srcAt(k / fps) * fps));
  }
  return { kept: Math.min(seen.size, total + 1), total };
}
