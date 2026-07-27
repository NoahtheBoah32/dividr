/**
 * speedRampFilter — bakes a speed ramp into an ffmpeg filter chain.
 *
 * `setpts` rewrites each input frame's timestamp, so a variable speed is just
 * `setpts = outAt(T)/TB` where outAt is the ramp's source->output time map.
 * That integral has no closed form for an eased curve, so it is approximated
 * with a CUBIC HERMITE spline: each knot contributes both its value and its
 * exact slope (1/speed), which makes the emitted expression C1-continuous. A
 * piecewise-LINEAR approximation would be C0 only, and the slope steps at its
 * knots are exactly the stutter the ramp exists to avoid.
 *
 * Knots are placed adaptively — dense through a transition where the curve
 * bends, sparse over a constant-speed hold where the map is already exactly
 * linear — so the expression stays small enough for ffmpeg's evaluator.
 */

import { buildProfile, speedAt, type SpeedRegion } from './speedRampCurve';

export interface SpeedRampExport {
  enabled?: boolean;
  regions?: SpeedRegion[];
  sourceDuration?: number;
  audio?: boolean;
  pitch?: boolean;
  /** Frame interpolation through the ramp. See buildInterpolationFilter. */
  blend?: 'off' | 'blend' | 'flow';
}

/**
 * Synthetic motion blur for the sped-up half of a ramp.
 *
 * Speeding footage up shortens its effective exposure in exact proportion. A
 * 1/60s shutter at 30fps is a 180 degree shutter; at 25x each output frame
 * still holds 1/60s of light but now stands for a full second of scene, which
 * is a 7 degree shutter. Seven degrees is a strobe light, and no amount of
 * re-timing or interpolation repairs it — those photons were never recorded.
 * What DOES repair it is the frames either side of the one being kept: they
 * hold the missing exposure, so averaging them back in reconstructs the long
 * shutter the camera never took. This is the single thing that makes a fast
 * drone shot read as flow rather than a slideshow.
 *
 * frames = speed × shutter/360, the standard timelapse rule, and the averaging
 * must run BEFORE `setpts` so the frames still exist when they are combined.
 *
 * 1.0 here is a 360 degree shutter: the averaged window is exactly as long as
 * the gap between the frames that survive the re-time, so consecutive output
 * frames butt up against each other with nothing missing in between. 180
 * degrees is what a real camera does, but it leaves half of every interval
 * unrecorded, and at 15x that gap is the strobing. Measured on the drone clip,
 * mean inter-frame motion through the ramp fell 18.5 (no blur) -> 17.6 (180
 * degrees) -> 15.9 (360 degrees), with no loss of detail on the 1x shoulders
 * because the width follows the local speed.
 *
 * NOTE: this is applied by cutting the stream into bands (see
 * buildRampVideoGraph), never by `tmix=...:enable='between(t,a,b)'`. Gating a
 * filter that holds a window renders visibly wrong — see the graph builder.
 */
const BAND_SHUTTER = 1.0;

/** tmix holds this many decoded frames at once — 4K × 32 is already ~800MB. */
const MAX_BLUR_FRAMES = 32;

/** Frame counts a band may use. Quantised so a region yields few bands. */
const BAND_STEPS = [1, 2, 3, 4, 6, 8, 12, 16, 24, 32];

/** Below this there is nothing to smear and the blur only costs sharpness. */
const BAND_MIN_SPEED = 1.35;

/**
 * Frame interpolation for the slow half of a ramp.
 *
 * `setpts` only re-times the frames that exist. Below 1x the ramp asks for
 * moments the camera never shot, and ffmpeg's default is to hold the previous
 * frame — which is exactly the judder a ramp is supposed to avoid. `minterpolate`
 * synthesises the missing ones, and it ships with ffmpeg, so this needs no
 * model, no download and no extra dependency:
 *
 *  - blend: averages the neighbours. Cheap, slightly ghosty, always safe.
 *  - flow:  motion-compensated (`mci`) with overlapped block compensation.
 *    This is the one that looks like real slow motion, and it is slow to
 *    render — a motion-estimation pass over every output frame.
 *
 * Speeding UP discards frames rather than inventing them, so a ramp that never
 * goes below 1x gets nothing and pays nothing.
 */
export function buildInterpolationFilter(
  ramp?: SpeedRampExport | null,
  fps = 30,
): string | null {
  if (!ramp?.enabled) return null;
  const mode = ramp.blend ?? 'off';
  if (mode === 'off') return null;
  const regions = ramp.regions ?? [];
  const slowest = regions.reduce(
    (m, r) => Math.min(m, ...(r.segs ?? [1])),
    Infinity,
  );
  // Nothing is being stretched — interpolating would cost minutes for no
  // visible difference.
  if (!Number.isFinite(slowest) || slowest >= 0.95) return null;
  const f = Math.max(1, Math.round(fps));
  return mode === 'flow'
    ? `minterpolate=fps=${f}:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1`
    : `minterpolate=fps=${f}:mi_mode=blend`;
}

/**
 * One contiguous stretch of the clip that is treated uniformly.
 *
 * `t0`/`t1` are where the band sits on the RE-TIMED timeline; `srcT0`/`srcT1`
 * are the source span whose pictures fill it. They differ only for a reversed
 * region, where the band at the front of the window is filled from the back of
 * it — which is what lets reversed bands be concatenated in forward order and
 * still read backwards.
 */
interface RampBand {
  t0: number;
  t1: number;
  srcT0: number;
  srcT1: number;
  /** tmix window, 1 meaning "pass through untouched". */
  frames: number;
  reverse: boolean;
}

const quantiseFrames = (n: number): number => {
  // Nearest, not largest-below: rounding down cost a 15x peak three frames of
  // its window, which is a 288 degree shutter pretending to be 360.
  let best = BAND_STEPS[0];
  for (const s of BAND_STEPS)
    if (Math.abs(s - n) < Math.abs(best - n)) best = s;
  return Math.min(MAX_BLUR_FRAMES, best);
};

/**
 * Cut the clip into bands: untouched outside the regions, and inside a region
 * one band per blur width.
 *
 * The blur has to follow the LOCAL speed, not the region's peak. A single tmix
 * across a whole region over-blurs the 1x shoulders, and the step from a sharp
 * frame to an over-blurred one at the region edge is visible as a pop — it
 * measured as a 6x spike in inter-frame motion on an otherwise flat 1.0 floor.
 * Banding by speed keeps each seam between neighbouring blur widths, where it
 * is invisible.
 */
function planBands(
  regions: SpeedRegion[],
  duration: number,
  blurOn: boolean,
  fps: number,
): RampBand[] {
  const bands: RampBand[] = [];
  // `reflect` maps a position in the window to the source time that fills it.
  const push = (
    t0: number,
    t1: number,
    frames: number,
    reverse: boolean,
    reflect: ((t: number) => number) | null,
  ) => {
    if (t1 - t0 <= 1e-6) return;
    const srcT0 = reflect ? reflect(t1) : t0;
    const srcT1 = reflect ? reflect(t0) : t1;
    const last = bands[bands.length - 1];
    // Merge only when the merged band stays one contiguous source span.
    if (last && last.frames === frames && last.reverse === reverse) {
      if (!reverse && Math.abs(last.srcT1 - srcT0) < 1e-6) {
        last.t1 = t1;
        last.srcT1 = srcT1;
        return;
      }
      if (reverse && Math.abs(last.srcT0 - srcT1) < 1e-6) {
        last.t1 = t1;
        last.srcT0 = srcT0;
        return;
      }
    }
    bands.push({ t0, t1, srcT0, srcT1, frames, reverse });
  };

  const sorted = [...regions].sort((p, q) => p.a - q.a);
  let cursor = 0;
  for (const r of sorted) {
    const a = Math.max(0, Math.min(r.a, duration));
    const b = Math.max(a, Math.min(r.b, duration));
    push(cursor, a, 1, false, null);

    const reverse = r.dir === 'reverse';
    const reflect = reverse ? (t: number) => a + (b - t) : null;
    if (!blurOn) {
      push(a, b, 1, reverse, reflect);
    } else {
      // Sample at frame resolution; adjacent samples that quantise to the same
      // width are merged by push().
      const step = 1 / Math.max(1, fps);
      for (let t = a; t < b - 1e-9; t += step) {
        const t1 = Math.min(b, t + step);
        const s = speedAt(sorted, (t + t1) / 2);
        const want = s >= BAND_MIN_SPEED ? s * BAND_SHUTTER : 1;
        push(t, t1, quantiseFrames(want), reverse, reflect);
      }
    }
    cursor = b;
  }
  push(cursor, duration, 1, false, null);
  return bands.filter((x) => x.t1 - x.t0 > 1e-6);
}

/**
 * The full video graph for a ramp: blur, reverse and re-time in one piece.
 *
 * Returned WITHOUT its leading input label and trailing output label, matching
 * how the exporter splices filters together.
 *
 * Why a split/concat graph rather than a flat chain with `enable`:
 * `tmix=...:enable='between(t,a,b)'` looked right and rendered wrong. A filter
 * that buffers frames cannot be toggled mid-stream — its window is stale when
 * it switches on, and the export came out with five identical frames, a jump of
 * 43 (on a floor of 1), six more identical frames and another jump of 22, all
 * inside the first half second of the ramp. Cutting the stream instead means no
 * filter ever toggles: each band is trimmed, blurred with a full window, and
 * concatenated back. Measured, that takes duplicate frames from 13 to 0.
 *
 * Each blurred band is trimmed a full window EARLY and the warm-up frames are
 * dropped afterwards, so no band ever emits an average of frames it does not
 * have yet — that warm-up was worth another 4 duplicates on its own.
 */
export function buildRampVideoGraph(
  ramp?: SpeedRampExport | null,
  opts: { id?: string; fps?: number } = {},
): string | null {
  if (!ramp?.enabled) return null;
  const regions = ramp.regions ?? [];
  const duration = ramp.sourceDuration ?? 0;
  if (!regions.length || duration <= 0) return null;

  const setpts = buildSpeedRampFilter(ramp);
  const interp = buildInterpolationFilter(ramp, opts.fps ?? 30);
  const fps = Math.max(1, Math.round(opts.fps ?? 30));
  const blurOn = (ramp.blend ?? 'off') !== 'off';
  const bands = planBands(regions, duration, blurOn, fps);

  const tail = [setpts, interp].filter(Boolean).join(',');
  const needsWork = bands.some((x) => x.frames > 1 || x.reverse);
  if (!needsWork) return tail || null;

  // Labels must not collide with another ramped clip in the same graph.
  const ns = `sr${(opts.id ?? '').replace(/[^a-zA-Z0-9]/g, '').slice(-8) || '0'}`;
  const n = bands.length;
  const parts: string[] = [];
  parts.push(`split=${n}${bands.map((_, i) => `[${ns}i${i}]`).join('')}`);

  bands.forEach((band, i) => {
    const stages: string[] = [];
    const pre = band.frames > 1 ? band.frames / fps : 0;
    const head = Math.max(0, band.srcT0 - pre);
    stages.push(`trim=start=${f(head)}:end=${f(band.srcT1)}`);
    stages.push('setpts=PTS-STARTPTS');
    if (band.frames > 1) {
      stages.push(`tmix=frames=${band.frames}`);
      // Drop the warm-up, which is the part with an incomplete window. Done
      // BEFORE any reverse, so the discarded frames are the ones tmix could not
      // fill rather than a chunk of the picture.
      if (band.srcT0 - head > 1e-6) {
        stages.push(`trim=start=${f(band.srcT0 - head)}`);
        stages.push('setpts=PTS-STARTPTS');
      }
    }
    // The band already reads the reflected source span, so reversing it here
    // makes the concatenation walk backwards while the ramp curve below stays
    // forward. Pacing and direction stay independent, exactly as the preview
    // resolves them.
    if (band.reverse) stages.push('reverse,setpts=PTS-STARTPTS');
    parts.push(`[${ns}i${i}]${stages.join(',')}[${ns}o${i}]`);
  });

  const inputs = bands.map((_, i) => `[${ns}o${i}]`).join('');
  parts.push(`${inputs}concat=n=${n}:v=1${tail ? `,${tail}` : ''}`);
  return parts.join(';');
}

/** Hard cap on knots. Deep nested if() chains slow ffmpeg's evaluator down. */
const MAX_KNOTS = 64;
/** Target error of the spline against the true map, in seconds. */
/** Target error of the spline against the true map, in output seconds.
 * Measured: tightening this to 0.0003 with 192 knots produced a byte-identical
 * motion profile on a 15x ramp, so the spline is not what limits smoothness. */
const TOL = 0.002;

const f = (n: number) => {
  // ffmpeg's parser wants plain decimals, never exponent notation.
  const s = n.toFixed(6);
  return s.replace(/\.?0+$/, '') || '0';
};

/**
 * Choose knot times: every structural edge, then bisect the widest remaining
 * error until the spline is within tolerance or the cap is hit.
 */
function chooseKnots(
  regions: SpeedRegion[],
  duration: number,
  outAt: (t: number) => number,
  slope: (t: number) => number,
): number[] {
  const set = new Set<number>([0, duration]);
  for (const r of regions) {
    set.add(r.a);
    set.add(r.b);
    for (const b of r.bounds) {
      set.add(b.t0);
      set.add(b.t1);
      // Seed the interior of each transition — this is where all the bend is.
      for (let i = 1; i < 4; i++) set.add(b.t0 + ((b.t1 - b.t0) * i) / 4);
    }
  }
  let knots = [...set]
    .filter((t) => t >= 0 && t <= duration)
    .sort((a, b) => a - b);

  const hermiteAt = (t: number, i: number) => {
    const k0 = knots[i];
    const k1 = knots[i + 1];
    const h = k1 - k0;
    if (h <= 1e-9) return outAt(k0);
    const u = (t - k0) / h;
    const u2 = u * u;
    const u3 = u2 * u;
    return (
      outAt(k0) * (2 * u3 - 3 * u2 + 1) +
      h * slope(k0) * (u3 - 2 * u2 + u) +
      outAt(k1) * (-2 * u3 + 3 * u2) +
      h * slope(k1) * (u3 - u2)
    );
  };

  while (knots.length < MAX_KNOTS) {
    let worstErr = 0;
    let worstIdx = -1;
    for (let i = 0; i < knots.length - 1; i++) {
      const mid = (knots[i] + knots[i + 1]) / 2;
      const err = Math.abs(hermiteAt(mid, i) - outAt(mid));
      if (err > worstErr) {
        worstErr = err;
        worstIdx = i;
      }
    }
    if (worstIdx < 0 || worstErr < TOL) break;
    knots.splice(worstIdx + 1, 0, (knots[worstIdx] + knots[worstIdx + 1]) / 2);
    knots = knots.sort((a, b) => a - b);
  }
  return knots;
}

/**
 * The video filter for a ramp, or null when the ramp changes nothing.
 * Returned WITHOUT stream labels — the caller wraps it, matching how
 * colorGradeFilter is appended.
 */
export function buildSpeedRampFilter(
  ramp?: SpeedRampExport | null,
): string | null {
  if (!ramp?.enabled) return null;
  const regions = ramp.regions ?? [];
  const duration = ramp.sourceDuration ?? 0;
  if (!regions.length || duration <= 0) return null;

  const profile = buildProfile(regions, duration);
  // A ramp that does not move the clip's length is almost certainly a no-op.
  if (Math.abs(profile.outDuration - duration) < 1e-4) return null;

  const outAt = (t: number) => profile.outAt(t);
  const slope = (t: number) => 1 / Math.max(0.02, speedAt(regions, t));
  const knots = chooseKnots(regions, duration, outAt, slope);

  // Build the nested if() from the LAST interval backwards so each branch's
  // else-arm is the already-built remainder.
  let expr = f(outAt(duration));
  for (let i = knots.length - 2; i >= 0; i--) {
    const k0 = knots[i];
    const k1 = knots[i + 1];
    const h = k1 - k0;
    if (h <= 1e-9) continue;
    const y0 = outAt(k0);
    const y1 = outAt(k1);
    const m0 = slope(k0) * h;
    const m1 = slope(k1) * h;
    // Hermite expanded into the u-polynomial basis, so ffmpeg evaluates four
    // multiplies instead of re-deriving the blending functions.
    const a = y0;
    const b = m0;
    const c = -3 * y0 - 2 * m0 + 3 * y1 - m1;
    const d = 2 * y0 + m0 - 2 * y1 + m1;
    const u = `((T-${f(k0)})/${f(h)})`;
    const poly = `(${f(a)}+${f(b)}*${u}+${f(c)}*${u}*${u}+${f(d)}*${u}*${u}*${u})`;
    expr = `if(lt(T,${f(k1)}),${poly},${expr})`;
  }

  // Guard the head: frames before the first knot keep their own timestamp.
  return `setpts='(${expr})/TB'`;
}

/**
 * The audio filter for a ramp.
 *
 * Audio cannot follow a time-varying tempo — `atempo` is a constant, and there
 * is no per-sample tempo expression in ffmpeg. So there are exactly two honest
 * behaviours, and the panel's toggle picks between them:
 *
 *  - off (default): silence the ramped spans, so the audio never drifts out of
 *    sync with a picture that is no longer running at its own rate.
 *  - on: stretch the whole clip by the ramp's net ratio, so the audio still
 *    ends where the picture ends. The middle drifts; the ends line up.
 */
export function buildSpeedRampAudioFilter(
  ramp?: SpeedRampExport | null,
): string | null {
  if (!ramp?.enabled) return null;
  const regions = ramp.regions ?? [];
  const duration = ramp.sourceDuration ?? 0;
  if (!regions.length || duration <= 0) return null;

  const profile = buildProfile(regions, duration);
  if (Math.abs(profile.outDuration - duration) < 1e-4) return null;

  if (!ramp.audio) {
    // Mute exactly the ramped spans. `between` on `t` is the same mechanism the
    // ducking expression already uses, so this stays inside proven ground.
    const spans = regions
      .map((r) => `between(t,${f(r.a)},${f(r.b)})`)
      .join('+');
    return `volume='if(gt(${spans},0),0,1)':eval=frame`;
  }

  // atempo is only stable within [0.5, 2.0], so a large ratio is chained.
  const ratio = duration / profile.outDuration;
  const steps: number[] = [];
  let remaining = ratio;
  while (remaining > 2.0) {
    steps.push(2.0);
    remaining /= 2.0;
  }
  while (remaining < 0.5) {
    steps.push(0.5);
    remaining /= 0.5;
  }
  steps.push(remaining);
  return steps.map((s) => `atempo=${f(s)}`).join(',');
}
