// Instrument the page: log every drawImage/fillRect on the preview canvas and every
// video seek, interleaved with canvas luma, around the detect op.
import { chromium } from 'playwright-core';
const b = await chromium.connectOverCDP('http://localhost:9222');
let page = null;
for (const c of b.contexts()) for (const p of c.pages()) { const u = p.url(); if (u.includes('localhost:5173') && !u.startsWith('blob:')) page = p; }
if (!page) { console.log('no page'); process.exit(1); }

await page.evaluate(() => {
  const s = window.__dividrTest.getStoreSnapshot();
  const vid = s.tracks.find((t) => t.type === 'video');
  s.updateTrack(vid.id, { relight: undefined, paintedLights: [], lightSource: undefined });
  const mid = Math.round(((vid?.startFrame ?? 0) + (vid?.endFrame ?? 240)) / 2);
  s.setCurrentFrame(mid);
  window.dispatchEvent(new CustomEvent('dividr:forceRender'));
});
await page.waitForTimeout(800);

await page.evaluate(() => {
  const log = [];
  window.__ilog = log;
  const t0 = performance.now();
  const T = () => Math.round(performance.now() - t0);
  const target = document.querySelector('canvas[data-testid="preview-canvas"]');

  const lumaOf = (c) => {
    try {
      const off = window.__loff ?? (window.__loff = Object.assign(document.createElement('canvas'), { width: 16, height: 9 }));
      const ctx = off.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(c, 0, 0, 16, 9);
      const d = ctx.getImageData(0, 0, 16, 9).data;
      let sum = 0; for (let j = 0; j < d.length; j += 4) sum += d[j] + d[j + 1] + d[j + 2];
      return Math.round(sum / (d.length / 4) / 3);
    } catch { return -1; }
  };

  if (!window.__instrumented) {
    window.__instrumented = true;
    const origDraw = CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage = function (...args) {
      const r = origDraw.apply(this, args);
      if (this.canvas === target) {
        const src = args[0];
        const kind = src instanceof HTMLVideoElement ? `video(rs=${src.readyState},seek=${src.seeking},t=${src.currentTime.toFixed(2)})`
          : src instanceof ImageBitmap ? 'bitmap'
          : src instanceof HTMLCanvasElement ? 'canvas' : String(src?.constructor?.name);
        window.__ilog.push({ t: T(), draw: kind, lumaAfter: lumaOf(this.canvas) });
      }
      return r;
    };
    const origFill = CanvasRenderingContext2D.prototype.fillRect;
    CanvasRenderingContext2D.prototype.fillRect = function (...args) {
      const r = origFill.apply(this, args);
      if (this.canvas === target && args[2] >= this.canvas.width - 1 && args[3] >= this.canvas.height - 1) {
        window.__ilog.push({ t: T(), fillRect: this.fillStyle, lumaAfter: lumaOf(this.canvas) });
      }
      return r;
    };
    const origPut = CanvasRenderingContext2D.prototype.putImageData;
    CanvasRenderingContext2D.prototype.putImageData = function (...args) {
      const r = origPut.apply(this, args);
      if (this.canvas === target) window.__ilog.push({ t: T(), putImageData: true, lumaAfter: lumaOf(this.canvas) });
      return r;
    };
    const desc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime');
    Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', {
      get: desc.get,
      set(v) { window.__ilog?.push({ t: T(), seekTo: Math.round(v * 100) / 100 }); return desc.set.call(this, v); },
    });
  }
  window.__imark = (m) => log.push({ t: T(), mark: m });
});

await page.evaluate(() => window.__imark('pre-detect'));
await page.evaluate(async () => {
  window.__dividrTest.applyOps([{ type: 'detectLight' }]);
  await window.__dividrTest.waitForQueueDrained();
  window.__imark('queue-drained');
});
await page.waitForTimeout(2000);

const out = await page.evaluate(() => window.__ilog.slice(-120));
for (const e of out) console.log(JSON.stringify(e));
process.exit(0);
