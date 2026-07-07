import { describe, it, expect } from 'vitest';
import {
  estimateLight,
  kelvinToRgb,
  dragToAzimuth,
  lightFromSource,
  lightGradientStops,
  defaultLight,
} from './paintedLightUtils';

/** Build a WxH RGBA frame from a per-pixel color function. */
function makeFrame(w: number, h: number, fn: (x: number, y: number) => [number, number, number]) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      const [r, g, b] = fn(x, y);
      data[o] = r; data[o + 1] = g; data[o + 2] = b; data[o + 3] = 255;
    }
  }
  return data;
}

describe('paintedLightUtils — light estimation + math', () => {
  it('detects light coming from the top-left when that corner is brightest', () => {
    const W = 64, H = 64;
    // Bright at (0,0), dark at (W,H): brightness falls with distance from top-left.
    const data = makeFrame(W, H, (x, y) => {
      const d = 1 - Math.hypot(x, y) / Math.hypot(W, H);
      const v = Math.round(clamp255(255 * d));
      return [v, v, v];
    });
    const src = estimateLight(data, W, H);
    // Direction points toward the bright side → both components negative (up-left).
    expect(src.dir[0]).toBeLessThan(0);
    expect(src.dir[1]).toBeLessThan(0);
    expect(src.confidence).toBeGreaterThan(0.1);
  });

  it('detects light from the right when the right edge is brightest', () => {
    const W = 64, H = 64;
    const data = makeFrame(W, H, (x) => {
      const v = Math.round((x / (W - 1)) * 255);
      return [v, v, v];
    });
    const src = estimateLight(data, W, H);
    expect(src.dir[0]).toBeGreaterThan(0); // bright side is +x
  });

  it('reads a warm light color from warm highlights', () => {
    const W = 32, H = 32;
    // Warm highlight blob top-left, dark elsewhere.
    const data = makeFrame(W, H, (x, y) => {
      const bright = x < 10 && y < 10;
      return bright ? [255, 200, 120] : [20, 20, 24];
    });
    const src = estimateLight(data, W, H);
    expect(src.color[0]).toBeGreaterThan(src.color[2]); // red > blue → warm
  });

  it('falls back to a neutral top-left key light on a flat frame', () => {
    const W = 16, H = 16;
    const data = makeFrame(W, H, () => [128, 128, 128]);
    const src = estimateLight(data, W, H);
    expect(src.dir[0]).toBeLessThan(0);
    expect(src.dir[1]).toBeLessThan(0);
  });

  it('handles an empty frame without throwing', () => {
    const src = estimateLight(new Uint8ClampedArray(0), 0, 0);
    expect(src).toEqual(defaultLight());
  });

  it('kelvinToRgb is warm below neutral and cool above', () => {
    const warm = kelvinToRgb(2700);
    const cool = kelvinToRgb(9000);
    expect(warm[0]).toBeGreaterThanOrEqual(warm[2]); // more red than blue
    expect(cool[2]).toBeGreaterThan(cool[0]); // more blue than red
  });

  it('dragToAzimuth maps a rightward drag to ~0° and downward to ~90°', () => {
    expect(Math.abs(dragToAzimuth(1, 0))).toBeLessThan(1);
    expect(dragToAzimuth(0, 1)).toBeCloseTo(90, 0);
  });

  it('lightFromSource places the light on the bright side, tinted the light color', () => {
    const src = estimateLight(
      makeFrame(32, 32, (x, y) => (x < 8 && y < 8 ? [255, 240, 210] : [10, 10, 10])),
      32, 32,
    );
    const light = lightFromSource(src, 'l1');
    // Bright side is top-left → placed in the upper-left quadrant.
    expect(light.pos[0]).toBeLessThan(0.5);
    expect(light.pos[1]).toBeLessThan(0.5);
    expect(light.color).toEqual(src.color);
  });

  it('lightGradientStops go bright→transparent and scale with intensity', () => {
    const stops = lightGradientStops({ color: [255, 255, 255], intensity: 1 });
    expect(stops[0].offset).toBe(0);
    expect(stops[stops.length - 1].color).toContain(',0)'); // fully transparent edge
  });
});

function clamp255(v: number) {
  return Math.max(0, Math.min(255, v));
}
