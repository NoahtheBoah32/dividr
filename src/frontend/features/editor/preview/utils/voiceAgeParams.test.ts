import { describe, it, expect } from 'vitest';
import {
  ageFactor,
  ageToParams,
  ageLabel,
  buildFfmpegAgeChain,
  DEFAULT_AGE_YEARS,
} from './voiceAgeParams';

describe('voiceAgeParams — one dial → DSP bundle', () => {
  it('ageFactor is 0 at the neutral baseline and 1 at the top', () => {
    expect(ageFactor(30)).toBeCloseTo(0, 5);
    expect(ageFactor(90)).toBeCloseTo(1, 5);
    expect(ageFactor(20)).toBeCloseTo(-1 / 6, 2); // clamped floor region
  });

  it('older = deeper (shiftRatio down), duller (tilt down), sparkle cut', () => {
    const old = ageToParams(85);
    expect(old.shiftRatio).toBeLessThan(1);
    expect(old.tiltDb).toBeLessThan(0);
    expect(old.brillianceDb).toBeLessThan(0);
    expect(old.bodyDb).toBeGreaterThan(0);
    expect(old.jitterPct).toBeGreaterThan(0.3);
    expect(old.shimmerDb).toBeGreaterThan(0.2);
  });

  it('younger = brighter/thinner (shiftRatio up) and never compresses', () => {
    const young = ageToParams(22);
    expect(young.shiftRatio).toBeGreaterThan(1);
    expect(young.tiltDb).toBeGreaterThan(0); // -6*a with a<0 → positive (adds highs)
    expect(young.compRatio).toBe(1); // no compression below baseline
  });

  it('is monotonic with age', () => {
    const a = ageToParams(40);
    const b = ageToParams(60);
    const c = ageToParams(80);
    expect(b.shiftRatio).toBeLessThan(a.shiftRatio);
    expect(c.shiftRatio).toBeLessThan(b.shiftRatio);
    expect(c.tiltDb).toBeLessThan(b.tiltDb);
    expect(c.jitterPct).toBeGreaterThan(a.jitterPct);
  });

  it('neutral age bakes to an empty ffmpeg chain (no-op)', () => {
    expect(buildFfmpegAgeChain(ageToParams(30))).toBe('');
  });

  it('older age produces a valid, bounded ffmpeg chain', () => {
    const chain = buildFfmpegAgeChain(ageToParams(70));
    expect(chain).toContain('asetrate=');
    expect(chain).toContain('aresample=48000');
    expect(chain).toMatch(/atempo=[\d.]+/);
    expect(chain).toContain('treble=g=-');
    // atempo must stay inside ffmpeg's [0.5, 2] window.
    const atempo = Number(chain.match(/atempo=([\d.]+)/)![1]);
    expect(atempo).toBeGreaterThanOrEqual(0.5);
    expect(atempo).toBeLessThanOrEqual(2);
  });

  it('label reflects the age band', () => {
    expect(ageLabel(24)).toContain('youthful');
    expect(ageLabel(70)).toContain('elderly');
    expect(ageLabel(DEFAULT_AGE_YEARS)).toMatch(/yrs/);
  });
});
