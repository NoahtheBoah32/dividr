import { describe, expect, it } from 'vitest';
import {
  MIN_RAMP,
  type RampShape,
  type SpeedRegion,
  buildProfile,
  clampRegions,
  cloneRegions,
  easeShape,
  formatSpeed,
  framesKept,
  layoutHolds,
  makeRegion,
  reframeRegion,
  speedAt,
} from './speedRampCurve';

const D = 20;
const SHAPES: RampShape[] = ['smooth', 'whip', 'snap', 'linear'];

/** The ramp EDITH lays down for "3000% between 6 and 13 seconds". */
const edith = (): SpeedRegion[] => [makeRegion(6, 13, 30)];

/** Numeric derivative of speed with respect to source time. */
const dSpeed = (rs: SpeedRegion[], t: number, h = 1e-4) =>
  (speedAt(rs, t + h) - speedAt(rs, t - h)) / (2 * h);

describe('easing families', () => {
  it('all anchor at 0 and 1', () => {
    for (const s of SHAPES) {
      expect(easeShape(0, s)).toBeCloseTo(0, 10);
      expect(easeShape(1, s)).toBeCloseTo(1, 10);
    }
  });

  it('are monotonic — speed never backs up mid-transition', () => {
    for (const s of SHAPES) {
      let prev = -1;
      for (let i = 0; i <= 400; i++) {
        const v = easeShape(i / 400, s);
        expect(v).toBeGreaterThanOrEqual(prev - 1e-12);
        prev = v;
      }
    }
  });

  it('meet the holds tangentially — zero slope at both ends', () => {
    // This is the property that removes the corner where a ramp joins a
    // constant-speed hold. Linear is exempt by design.
    for (const s of SHAPES.filter((x) => x !== 'linear')) {
      const h = 1e-5;
      const slope0 = (easeShape(h, s) - easeShape(0, s)) / h;
      const slope1 = (easeShape(1, s) - easeShape(1 - h, s)) / h;
      expect(Math.abs(slope0)).toBeLessThan(1e-3);
      expect(Math.abs(slope1)).toBeLessThan(1e-3);
    }
  });
});

describe('speed curve smoothness', () => {
  it('is continuous — no instantaneous jumps anywhere', () => {
    const rs = edith();
    const step = 1 / 2000;
    let prev = speedAt(rs, 0);
    for (let t = step; t <= D; t += step) {
      const v = speedAt(rs, t);
      // Over 0.5ms nothing may move more than a hair, even through the
      // steepest part of a 1x -> 30x climb.
      expect(Math.abs(v - prev)).toBeLessThan(0.25);
      prev = v;
    }
  });

  it('has no kinks — the derivative is itself continuous', () => {
    // A choppy ramp shows up as a spike in the second derivative. A drone move
    // does not have one. Sample d(speed)/dt densely and assert it never jumps.
    const rs = edith();
    const step = 1 / 1500;
    let prev = dSpeed(rs, step);
    let worst = 0;
    for (let t = 2 * step; t < D - step; t += step) {
      const d = dSpeed(rs, t);
      worst = Math.max(worst, Math.abs(d - prev));
      prev = d;
    }
    // Empirically ~0.5 for this ramp; a stepped or cut-based implementation
    // lands in the hundreds here.
    expect(worst).toBeLessThan(5);
  });

  it('starts and ends every region at exactly 1x', () => {
    const rs = edith();
    expect(speedAt(rs, 6)).toBeCloseTo(1, 6);
    expect(speedAt(rs, 13)).toBeCloseTo(1, 6);
    // and just outside
    expect(speedAt(rs, 5.9)).toBe(1);
    expect(speedAt(rs, 13.1)).toBe(1);
  });

  it('actually reaches the speed it was asked for', () => {
    let peak = 0;
    const rs = edith();
    for (let t = 6; t <= 13; t += 0.001) peak = Math.max(peak, speedAt(rs, t));
    expect(peak).toBeGreaterThan(29.9);
    expect(peak).toBeLessThanOrEqual(30.0001);
  });

  it('accelerates progressively, never instantaneously', () => {
    // Walk the climb and confirm the speed rises through a broad band of
    // intermediate values rather than snapping from 1x to 30x.
    const rs = edith();
    const seen = new Set<number>();
    for (let t = 6; t <= 9.5; t += 0.002) {
      const v = speedAt(rs, t);
      if (v > 1.5 && v < 28) seen.add(Math.round(v));
    }
    // At least 15 distinct integer speeds are actually passed through.
    expect(seen.size).toBeGreaterThan(15);
  });
});

describe('source/output mapping', () => {
  it('is strictly monotonic — time never runs backwards', () => {
    const p = buildProfile(edith(), D);
    let prev = -1;
    for (let o = 0; o <= p.outDuration; o += p.outDuration / 3000) {
      const s = p.srcAt(o);
      expect(s).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = s;
    }
  });

  it('round-trips source -> output -> source', () => {
    const p = buildProfile(edith(), D);
    for (let t = 0; t <= D; t += 0.25) {
      expect(p.srcAt(p.outAt(t))).toBeCloseTo(t, 1);
    }
  });

  it('speeding up shortens the clip', () => {
    const p = buildProfile(edith(), D);
    expect(p.outDuration).toBeLessThan(D);
    expect(p.outDuration).toBeGreaterThan(D - 8);
  });

  it('slowing down lengthens the clip', () => {
    const p = buildProfile([makeRegion(4, 12, 0.35)], D);
    expect(p.outDuration).toBeGreaterThan(D);
  });

  it('an untouched clip maps 1:1', () => {
    const p = buildProfile([], D);
    expect(p.outDuration).toBeCloseTo(D, 4);
    expect(p.srcAt(7)).toBeCloseTo(7, 3);
  });

  /** Per-output-frame source stride — what the compositor actually walks. */
  const strides = (rs: SpeedRegion[], fps = 30) => {
    const p = buildProfile(rs, D);
    const n = Math.floor(p.outDuration * fps);
    const out: number[] = [];
    for (let k = 0; k < n; k++) out.push(p.srcAt((k + 1) / fps) - p.srcAt(k / fps));
    return out;
  };

  /**
   * Smoothness of the acceleration itself, measured scale-free.
   *
   * Absolute stride differences are useless here: at 30x a single output frame
   * legitimately covers a whole second of source, so a big absolute jump is the
   * ramp working, not stuttering. What the eye actually reads is the RATE OF
   * CHANGE of the stride, so measure the second difference of log(stride).
   * A stepped implementation (constant-speed segments butted together, which is
   * what matchBrollPace does) jumps by log(30) ≈ 3.4 in a single frame here.
   */
  const jerk = (step: number[]) => {
    const ls = step.map(Math.log);
    let worst = 0;
    for (let k = 1; k < ls.length - 1; k++) {
      worst = Math.max(worst, Math.abs(ls[k + 1] - 2 * ls[k] + ls[k - 1]));
    }
    return worst;
  };

  it('advances source time forward on every single output frame', () => {
    const step = strides(edith());
    expect(Math.min(...step)).toBeGreaterThan(0);
  });

  it('accelerates without a step — no frame-to-frame jerk spike', () => {
    // Measured ~0.88 for the aggressive 1x->30x default. A piecewise-constant
    // ramp lands above 3.4 here, so this threshold separates the two designs.
    expect(jerk(strides(edith()))).toBeLessThan(1.5);
  });

  it('gets smoother as the user widens the transition', () => {
    // Widening the ramp with the bracket handles is the user's smoothness dial;
    // prove it actually is one rather than a decoration.
    const tight = makeRegion(6, 13, 30);
    const wide = makeRegion(6, 13, 30);
    wide.bounds[0] = { t0: 6.05, t1: 9.4 };
    wide.bounds[1] = { t0: 9.6, t1: 12.95 };
    expect(jerk(strides([wide]))).toBeLessThan(jerk(strides([tight])));
  });

  it('a gentle ramp is near-perfectly smooth', () => {
    // 1x -> 2.5x over a generous window: the drone-move case.
    const r = makeRegion(4, 16, 2.5);
    expect(jerk(strides([r]))).toBeLessThan(0.02);
  });

  it('slow motion is smooth too', () => {
    expect(jerk(strides([makeRegion(4, 14, 0.35)]))).toBeLessThan(0.05);
  });
});

describe('region clamping', () => {
  it('pushes a colliding region right without shrinking its neighbour', () => {
    const rs = [makeRegion(6, 13, 30), makeRegion(10, 16, 0.5)];
    clampRegions(rs, D);
    expect(rs[0].a).toBeCloseTo(6, 6);
    expect(rs[0].b).toBeCloseTo(13, 6);
    expect(rs[1].a).toBeGreaterThanOrEqual(13);
  });

  it('keeps transitions ordered and non-overlapping', () => {
    const r = makeRegion(2, 18, 8);
    layoutHolds(r, 3, 17, [8, 0.5, 20, 2]);
    clampRegions([r], D);
    for (let i = 0; i < r.bounds.length; i++) {
      expect(r.bounds[i].t1).toBeGreaterThan(r.bounds[i].t0);
      if (i) expect(r.bounds[i].t0).toBeGreaterThanOrEqual(r.bounds[i - 1].t1);
    }
    expect(r.bounds[0].t0).toBeGreaterThanOrEqual(r.a - 1e-9);
    expect(r.bounds[r.bounds.length - 1].t1).toBeLessThanOrEqual(r.b + 1e-9);
  });

  it('never lets a hold escape the speed limits', () => {
    const r = makeRegion(4, 12, 30);
    r.segs[1] = 9999;
    clampRegions([r], D);
    expect(r.segs[1]).toBeLessThanOrEqual(40);
    expect(r.segs[0]).toBe(1);
    expect(r.segs[r.segs.length - 1]).toBe(1);
  });

  it('multiple ramps in one clip each keep their own shape', () => {
    const rs = [makeRegion(2, 7, 12), makeRegion(11, 18, 0.4)];
    clampRegions(rs, D);
    const p = buildProfile(rs, D);
    expect(speedAt(rs, 4.5)).toBeGreaterThan(5);
    expect(speedAt(rs, 14.5)).toBeLessThan(0.6);
    expect(speedAt(rs, 9)).toBe(1);
    expect(p.outDuration).toBeGreaterThan(0);
  });
});

describe('frame accounting', () => {
  it('never reports more frames kept than the source had', () => {
    const p = buildProfile([makeRegion(4, 14, 0.2)], D);
    const { kept, total } = framesKept(p, 30);
    expect(kept).toBeLessThanOrEqual(total + 1);
  });

  it('drops frames when speeding up', () => {
    const p = buildProfile(edith(), D);
    const { kept, total } = framesKept(p, 30);
    expect(kept).toBeLessThan(total);
  });
});

describe('formatting', () => {
  it('renders both units', () => {
    expect(formatSpeed(30)).toBe('30×');
    expect(formatSpeed(0.35)).toBe('0.35×');
    expect(formatSpeed(0.35, 'pct')).toBe('35%');
    expect(formatSpeed(2.5)).toBe('2.5×');
  });
});

describe('reframeRegion — a window drag must carry its curve', () => {
  const transitionLengths = (r: SpeedRegion) =>
    r.bounds.map((b) => +(b.t1 - b.t0).toFixed(4));

  it('translates the whole curve when a region is moved', () => {
    const r = makeRegion(4, 12, 25);
    const before = transitionLengths(r);
    reframeRegion(r, cloneRegions([r])[0], 10, 18);
    expect(r.a).toBe(10);
    expect(r.b).toBe(18);
    // Same span, so the shape is untouched — only its position moved.
    expect(transitionLengths(r)).toEqual(before);
    expect(r.bounds[0].t0).toBeCloseTo(10 + (4 + 8 * 0.12 - 4), 4);
  });

  it('scales transitions with the window instead of crushing them', () => {
    const r = makeRegion(4, 12, 25); // 8s window
    const before = transitionLengths(r);
    const snap = cloneRegions([r])[0];
    reframeRegion(r, snap, 4, 8); // halve it from the right
    const after = transitionLengths(r);
    after.forEach((v, i) => expect(v).toBeCloseTo(before[i] / 2, 3));
  });

  it('never compounds: repeated moves from the same snapshot are stable', () => {
    const r = makeRegion(4, 12, 25);
    const snap = cloneRegions([r])[0];
    for (const a of [5, 7, 6, 4.5, 6]) reframeRegion(r, snap, a, a + 8);
    const direct = makeRegion(4, 12, 25);
    reframeRegion(direct, cloneRegions([direct])[0], 6, 14);
    expect(transitionLengths(r)).toEqual(transitionLengths(direct));
  });

  /**
   * The regression that made every ramp look like a cut: moving a region wrote
   * a and b but left the transitions at their old absolute times, and the clamp
   * then squashed them against the new wall down to MIN_RAMP.
   */
  it('survives clampRegions with its transitions intact', () => {
    const r = makeRegion(4, 12, 25);
    const before = transitionLengths(r);
    reframeRegion(r, cloneRegions([r])[0], 14, 22);
    const [out] = clampRegions([r], 30);
    expect(transitionLengths(out)).toEqual(before);
    expect(Math.min(...transitionLengths(out))).toBeGreaterThan(MIN_RAMP * 3);
  });

  it('shows what the bug did — writing a/b alone collapses the ramp to a cut', () => {
    const r = makeRegion(4, 12, 25);
    r.a = 14; // the old code path
    r.b = 22;
    const [out] = clampRegions([r], 30);
    expect(Math.min(...transitionLengths(out))).toBeCloseTo(MIN_RAMP, 4);
  });
});
