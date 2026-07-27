import { describe, expect, it } from 'vitest';
import { buildProfile, makeRegion } from './speedRampCurve';
import {
  buildInterpolationFilter,
  buildSpeedRampAudioFilter,
  buildRampVideoGraph,
  buildSpeedRampFilter,
} from './speedRampFilter';

const D = 20;
const ramp = (regions = [makeRegion(6, 13, 30)], audio = false) => ({
  enabled: true,
  regions,
  sourceDuration: D,
  audio,
});

/**
 * Evaluate the emitted ffmpeg expression the way ffmpeg would.
 * Only `if`, `lt` and arithmetic appear in it, so a tiny shim is enough — and
 * evaluating it is the only way to know the filter actually says what the
 * curve means rather than merely looking well-formed.
 */
function evalSetpts(filter: string, T: number): number {
  const m = filter.match(/^setpts='\((.*)\)\/TB'$/);
  if (!m) throw new Error(`unexpected filter shape: ${filter.slice(0, 60)}`);
  const js = m[1].replace(/\blt\(/g, '__lt(').replace(/\bif\(/g, '__if(');
  // eslint-disable-next-line no-new-func
  const fn = new Function('T', '__if', '__lt', `return ${js};`) as (
    t: number,
    i: (c: number, a: number, b: number) => number,
    l: (a: number, b: number) => number,
  ) => number;
  return fn(
    T,
    (c, a, b) => (c ? a : b),
    (a, b) => (a < b ? 1 : 0),
  );
}

describe('speed ramp export filter', () => {
  it('emits nothing when there is no ramp', () => {
    expect(buildSpeedRampFilter(null)).toBeNull();
    expect(
      buildSpeedRampFilter({ enabled: false, regions: [], sourceDuration: D }),
    ).toBeNull();
    expect(
      buildSpeedRampFilter({ enabled: true, regions: [], sourceDuration: D }),
    ).toBeNull();
  });

  it('emits a setpts expression for a real ramp', () => {
    const f = buildSpeedRampFilter(ramp());
    expect(f).toMatch(/^setpts='\(.*\)\/TB'$/);
    // No exponent notation — ffmpeg's parser cannot read it.
    expect(f).not.toMatch(/e[+-]\d/i);
  });

  it('tracks the real time map to within a frame everywhere', () => {
    // This is the test that matters: the emitted expression is compared against
    // the same profile the preview walks, across the whole clip.
    const r = ramp();
    const f = buildSpeedRampFilter(r)!;
    const profile = buildProfile(r.regions, D);
    let worst = 0;
    for (let t = 0; t <= D; t += 0.01) {
      worst = Math.max(worst, Math.abs(evalSetpts(f, t) - profile.outAt(t)));
    }
    // Well inside a 30fps frame (0.0333s).
    expect(worst).toBeLessThan(0.01);
  });

  it('is monotonic — timestamps never go backwards', () => {
    const f = buildSpeedRampFilter(ramp())!;
    let prev = -1;
    for (let t = 0; t <= D; t += 0.005) {
      const v = evalSetpts(f, t);
      expect(v).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = v;
    }
  });

  it('has no slope steps — the emitted curve is C1', () => {
    // A piecewise-LINEAR approximation would fail this; the Hermite spline is
    // what keeps the baked file as smooth as the preview.
    const f = buildSpeedRampFilter(ramp())!;
    const h = 0.002;
    const slope = (t: number) =>
      (evalSetpts(f, t + h) - evalSetpts(f, t - h)) / (2 * h);
    let worst = 0;
    let prev = slope(0.05);
    for (let t = 0.05 + h; t < D - 0.05; t += h) {
      const s = slope(t);
      worst = Math.max(worst, Math.abs(s - prev));
      prev = s;
    }
    expect(worst).toBeLessThan(0.05);
  });

  it('handles slow motion and multiple ramps', () => {
    const rs = [makeRegion(2, 7, 12), makeRegion(11, 18, 0.4)];
    const r = { enabled: true, regions: rs, sourceDuration: D, audio: false };
    const f = buildSpeedRampFilter(r)!;
    const profile = buildProfile(rs, D);
    let worst = 0;
    for (let t = 0; t <= D; t += 0.01) {
      worst = Math.max(worst, Math.abs(evalSetpts(f, t) - profile.outAt(t)));
    }
    expect(worst).toBeLessThan(0.01);
  });

  it('stays within ffmpeg-friendly size', () => {
    const f = buildSpeedRampFilter(ramp())!;
    expect(f.length).toBeLessThan(12000);
  });
});

describe('speed ramp audio filter', () => {
  it('mutes the ramped span when audio does not ride along', () => {
    const f = buildSpeedRampAudioFilter(ramp())!;
    expect(f).toContain('volume=');
    expect(f).toContain('between(t,6,13)');
    expect(f).toContain('eval=frame');
  });

  it('chains atempo within its stable range when audio rides along', () => {
    const f = buildSpeedRampAudioFilter(ramp(undefined, true))!;
    const rates = [...f.matchAll(/atempo=([\d.]+)/g)].map((m) => Number(m[1]));
    expect(rates.length).toBeGreaterThan(0);
    for (const r of rates) {
      expect(r).toBeGreaterThanOrEqual(0.5);
      expect(r).toBeLessThanOrEqual(2.0);
    }
    // The product must restore the ramp's net ratio, or audio drifts off the end.
    const profile = buildProfile([makeRegion(6, 13, 30)], D);
    const product = rates.reduce((a, b) => a * b, 1);
    expect(product).toBeCloseTo(D / profile.outDuration, 4);
  });

  it('emits nothing without a ramp', () => {
    expect(buildSpeedRampAudioFilter(null)).toBeNull();
  });
});

describe('buildInterpolationFilter', () => {
  it('emits nothing when interpolation is off', () => {
    expect(buildInterpolationFilter({ ...ramp(), blend: 'off' })).toBeNull();
    expect(buildInterpolationFilter({ ...ramp() })).toBeNull();
  });

  it('emits nothing for a speed-UP, which discards frames rather than inventing them', () => {
    // 30x: every output frame already has a real source frame behind it.
    const f = buildInterpolationFilter({ ...ramp(), blend: 'flow' });
    expect(f).toBeNull();
  });

  it('emits motion-compensated interpolation for slow motion', () => {
    const slow = {
      ...ramp([makeRegion(6, 13, 0.3)]),
      blend: 'flow' as const,
    };
    const f = buildInterpolationFilter(slow, 30);
    expect(f).toContain('minterpolate');
    expect(f).toContain('mi_mode=mci');
    expect(f).toContain('fps=30');
  });

  it('emits the cheap blend mode when asked, and honours the target fps', () => {
    const slow = {
      ...ramp([makeRegion(6, 13, 0.3)]),
      blend: 'blend' as const,
    };
    const f = buildInterpolationFilter(slow, 24);
    expect(f).toBe('minterpolate=fps=24:mi_mode=blend');
  });

  it('emits nothing when the ramp is disabled entirely', () => {
    expect(
      buildInterpolationFilter({
        ...ramp([makeRegion(6, 13, 0.3)]),
        blend: 'flow',
        enabled: false,
      }),
    ).toBeNull();
  });
});

describe('buildRampVideoGraph', () => {
  const graph = (regions: ReturnType<typeof makeRegion>[], blend = 'blend') =>
    buildRampVideoGraph(
      { enabled: true, regions, sourceDuration: D, blend } as never,
      { id: 'clipA', fps: 30 },
    );

  it('never toggles a buffering filter mid-stream', () => {
    // tmix with `enable` looked correct and rendered five identical frames, a
    // jump of 43 on a floor of 1, then six more identical frames. A filter that
    // holds a window cannot be switched on and off inside one stream.
    const g = graph([makeRegion(6, 13, 15)])!;
    expect(g).not.toContain('enable=');
    expect(g).toContain('split=');
    expect(g).toContain('concat=n=');
  });

  it('bands the blur by local speed instead of the region peak', () => {
    const g = graph([makeRegion(6, 13, 15)])!;
    const widths = [...g.matchAll(/tmix=frames=(\d+)/g)].map((m) => +m[1]);
    expect(widths.length).toBeGreaterThan(2);
    // A single width across the whole region over-blurs the 1x shoulders and
    // the step to it is visible; banded widths climb toward the peak.
    expect(new Set(widths).size).toBeGreaterThan(1);
    expect(Math.max(...widths)).toBeGreaterThan(Math.min(...widths));
  });

  it('gives every blurred band a full window before it emits', () => {
    const g = graph([makeRegion(6, 13, 15)])!;
    for (const stage of g.split(';')) {
      if (!stage.includes('tmix=')) continue;
      // pre-roll trim, then tmix, then the warm-up is trimmed back off
      const order = stage.indexOf('tmix=');
      expect(stage.slice(0, order)).toContain('trim=start=');
      expect(stage.slice(order)).toContain('trim=start=');
    }
  });

  it('reverses a region by reading its window back to front', () => {
    const r = makeRegion(6, 13, 15);
    r.dir = 'reverse';
    const g = graph([r])!;
    expect(g).toContain('reverse');
    // The band covering the START of the window must read from the END of it,
    // otherwise concatenating the bands forward scrambles the motion.
    const stages = g.split(';').filter((s) => s.includes('reverse'));
    const starts = stages
      .map((s) => Number(/trim=start=([\d.]+)/.exec(s)?.[1] ?? NaN))
      .filter((n) => !Number.isNaN(n));
    expect(starts.length).toBeGreaterThan(1);
    expect(starts[0]).toBeGreaterThan(starts[starts.length - 1]);
  });

  it('a forward ramp reads its bands front to back', () => {
    const g = graph([makeRegion(6, 13, 15)])!;
    const starts = g
      .split(';')
      .filter((s) => s.includes('trim=start='))
      .map((s) => Number(/trim=start=([\d.]+)/.exec(s)?.[1] ?? NaN))
      .filter((n) => !Number.isNaN(n));
    expect(starts[0]).toBeLessThan(starts[starts.length - 1]);
  });

  it('handles more than one region', () => {
    const g = graph([makeRegion(2, 6, 8), makeRegion(9, 15, 0.4)])!;
    expect(g).toContain('concat=n=');
    expect(g).toContain('setpts=');
    // The slow region asks for interpolation, the fast one for blur.
    expect(g).toContain('minterpolate');
    expect(g).toContain('tmix=');
  });

  it('namespaces its labels so two ramped clips cannot collide', () => {
    const a = buildRampVideoGraph(
      { enabled: true, regions: [makeRegion(6, 13, 15)], sourceDuration: D, blend: 'blend' } as never,
      { id: 'clip-aaa', fps: 30 },
    )!;
    const b = buildRampVideoGraph(
      { enabled: true, regions: [makeRegion(6, 13, 15)], sourceDuration: D, blend: 'blend' } as never,
      { id: 'clip-bbb', fps: 30 },
    )!;
    const labels = (s: string) => new Set([...s.matchAll(/\[(\w+?)i\d+\]/g)].map((m) => m[1]));
    const shared = [...labels(a)].filter((x) => labels(b).has(x));
    expect(shared).toHaveLength(0);
  });

  it('falls back to a plain chain when there is nothing to blur or reverse', () => {
    const g = graph([makeRegion(6, 13, 15)], 'off')!;
    expect(g).not.toContain('split=');
    expect(g).toContain('setpts=');
  });
});
