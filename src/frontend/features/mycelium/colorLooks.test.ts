import { describe, expect, it } from 'vitest';
import {
  buildCurvesFromAnchors,
  ffmpegCurvesFilter,
  identityLut,
  lerpLutToIdentity,
  lutFromAnchors,
  resolveLabelColor,
  resolveLook,
  CLIP_LABEL_COLORS,
  LOOK_PRESETS,
  STINGER_CANDIDATES,
} from './colorLooks';

describe('lutFromAnchors', () => {
  it('identity anchors produce a near-identity LUT', () => {
    const lut = lutFromAnchors([[0, 0], [0.5, 0.5], [1, 1]]);
    expect(lut).toHaveLength(256);
    expect(lut[0]).toBe(0);
    expect(lut[255]).toBe(255);
    expect(Math.abs(lut[128] - 128)).toBeLessThanOrEqual(2);
  });

  it('implies identity endpoints when anchors do not span 0..1', () => {
    const lut = lutFromAnchors([[0.5, 0.75]]);
    expect(lut[0]).toBe(0);
    expect(lut[255]).toBe(255);
    expect(lut[128]).toBeGreaterThan(160); // lifted midpoint
  });

  it('lifted-blacks fade keeps output within range and raises shadows', () => {
    const lut = lutFromAnchors([[0, 0.1], [0.5, 0.52], [1, 0.95]]);
    expect(lut[0]).toBe(Math.round(0.1 * 255));
    expect(lut[255]).toBe(Math.round(0.95 * 255));
    for (const v of lut) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(255);
    }
  });

  it('garbage input falls back to identity', () => {
    const lut = lutFromAnchors([[NaN, 2]] as any);
    expect(lut[0]).toBe(0);
    expect(lut[255]).toBe(255);
  });
});

describe('lerpLutToIdentity', () => {
  it('t=0 is identity, t=1 keeps the LUT', () => {
    const lut = lutFromAnchors([[0, 0.2], [1, 0.8]]);
    expect(lerpLutToIdentity(lut, 0)).toEqual(identityLut());
    expect(lerpLutToIdentity(lut, 1)).toEqual(lut);
  });

  it('t=0.5 lands halfway', () => {
    const lut = identityLut().map(() => 255);
    const half = lerpLutToIdentity(lut, 0.5);
    expect(half[0]).toBe(128);
    expect(half[100]).toBe(Math.round(100 + (255 - 100) * 0.5));
  });
});

describe('buildCurvesFromAnchors', () => {
  it('builds all three channels + a valid ffmpeg filter', () => {
    const curves = buildCurvesFromAnchors({ master: [[0, 0.08], [1, 0.95]] });
    expect(curves.r).toHaveLength(256);
    expect(curves.g).toHaveLength(256);
    expect(curves.b).toHaveLength(256);
    expect(curves.r[0]).toBe(Math.round(0.08 * 255));
    // first point is the LUT value re-normalized: round(0.08*255)=20 → 20/255=0.0784
    expect(curves.ffmpegFilter).toMatch(/^curves=red='0\.0000\/0\.078/);
    expect(curves.ffmpegFilter).toContain(":green='");
    expect(curves.ffmpegFilter).toContain(":blue='");
  });

  it('master composes after the channel curve', () => {
    const curves = buildCurvesFromAnchors({
      red: [[0, 0.5], [1, 0.5]],   // red flattened to mid
      master: [[0, 0], [0.5, 1], [1, 1]], // master pushes mids to white
    });
    // red channel: every input → ~0.5 → master(0.5) ≈ 255
    expect(curves.r[10]).toBeGreaterThan(240);
    // green untouched by channel curve, only master
    expect(curves.g[0]).toBe(0);
  });
});

describe('ffmpegCurvesFilter', () => {
  it('samples 17 points per channel', () => {
    const id = identityLut();
    const f = ffmpegCurvesFilter(id, id, id);
    const redPart = f.match(/red='([^']+)'/)![1];
    expect(redPart.split(' ')).toHaveLength(17);
    expect(redPart).toContain('1.0000/1.0000');
  });
});

describe('resolveLabelColor', () => {
  it('resolves names, synonyms, and hex', () => {
    expect(resolveLabelColor('teal')).toBe(CLIP_LABEL_COLORS.teal);
    expect(resolveLabelColor('GREY')).toBe(CLIP_LABEL_COLORS.gray);
    expect(resolveLabelColor('violet')).toBe(CLIP_LABEL_COLORS.purple);
    expect(resolveLabelColor('#a1b2c3')).toBe('#a1b2c3');
    expect(resolveLabelColor('#abc')).toBe('#aabbcc');
  });

  it('rejects unknowns', () => {
    expect(resolveLabelColor('chartreuse-dream')).toBeNull();
    expect(resolveLabelColor('')).toBeNull();
    expect(resolveLabelColor(42)).toBeNull();
  });
});

describe('resolveLook', () => {
  it('resolves keys, titles, aliases, and loose phrases', () => {
    expect(resolveLook('teal-orange')!.key).toBe('teal-orange');
    expect(resolveLook('Black & White')!.key).toBe('bw');
    expect(resolveLook('noir')!.key).toBe('bw');
    expect(resolveLook('cinematic')!.key).toBe('teal-orange');
    expect(resolveLook('make it teal and orange')!.key).toBe('teal-orange');
    expect(resolveLook('vintage')!.key).toBe('vintage');
  });

  it('rejects unknowns', () => {
    expect(resolveLook('quantum-flux')).toBeNull();
    expect(resolveLook('')).toBeNull();
  });

  it('every preset only uses valid grade params in sane ranges', () => {
    for (const look of Object.values(LOOK_PRESETS)) {
      const p = look.params;
      if (p.saturation !== undefined) {
        expect(p.saturation).toBeGreaterThanOrEqual(0);
        expect(p.saturation).toBeLessThanOrEqual(2);
      }
      if (p.grain !== undefined) {
        expect(p.grain).toBeGreaterThanOrEqual(0);
        expect(p.grain).toBeLessThanOrEqual(100);
      }
      for (const k of ['temperature', 'tint', 'shadows', 'midtones', 'highlights'] as const) {
        if (p[k] !== undefined) {
          expect(Math.abs(p[k]!)).toBeLessThanOrEqual(100);
        }
      }
    }
  });
});

describe('STINGER_CANDIDATES', () => {
  it('is a non-empty best-first list of hit sounds', () => {
    expect(STINGER_CANDIDATES.length).toBeGreaterThan(3);
    expect(STINGER_CANDIDATES).toContain('vine_boom');
  });
});
