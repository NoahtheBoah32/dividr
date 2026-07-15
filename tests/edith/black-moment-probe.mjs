// Pinpoint WHEN the base preview canvas turns black around the detect op.
// Starts a 25Hz in-page luma monitor, replays the e2e steps, dumps the timeline.
import { chromium } from 'playwright-core';
const b = await chromium.connectOverCDP('http://localhost:9222');
let page = null;
for (const c of b.contexts()) for (const p of c.pages()) { const u = p.url(); if (u.includes('localhost:5173') && !u.startsWith('blob:')) page = p; }
if (!page) { console.log('no page'); process.exit(1); }

// clear lights
await page.evaluate(() => {
  const s = window.__dividrTest.getStoreSnapshot();
  const vid = s.tracks.find((t) => t.type === 'video');
  s.updateTrack(vid.id, { relight: undefined, paintedLights: [], lightSource: undefined });
});
await page.waitForTimeout(500);

// seek mid + start monitor
await page.evaluate(() => {
  const s = window.__dividrTest.getStoreSnapshot();
  const vid = s.tracks.find((t) => t.type === 'video');
  const mid = Math.round(((vid?.startFrame ?? 0) + (vid?.endFrame ?? 240)) / 2);
  s.setCurrentFrame(mid);
  window.dispatchEvent(new CustomEvent('dividr:forceRender'));

  const log = [];
  window.__lumaLog = log;
  const c = document.querySelector('canvas[data-testid="preview-canvas"]');
  const off = document.createElement('canvas'); off.width = 16; off.height = 9;
  const ctx = off.getContext('2d', { willReadFrequently: true });
  const t0 = performance.now();
  window.__lumaMark = (label) => log.push({ t: Math.round(performance.now() - t0), mark: label });
  window.__lumaTimer = setInterval(() => {
    try {
      ctx.drawImage(c, 0, 0, 16, 9);
      const d = ctx.getImageData(0, 0, 16, 9).data;
      let sum = 0; for (let j = 0; j < d.length; j += 4) sum += d[j] + d[j + 1] + d[j + 2];
      log.push({ t: Math.round(performance.now() - t0), luma: Math.round(sum / (d.length / 4) / 3) });
    } catch (e) { log.push({ t: Math.round(performance.now() - t0), err: String(e).slice(0, 40) }); }
  }, 40);
});

await page.waitForTimeout(1200);
await page.evaluate(() => window.__lumaMark('pre-detect'));
await page.evaluate(async () => {
  window.__dividrTest.applyOps([{ type: 'detectLight' }]);
  await window.__dividrTest.waitForQueueDrained();
  window.__lumaMark('queue-drained');
});
await page.waitForTimeout(1500);

const out = await page.evaluate(() => {
  clearInterval(window.__lumaTimer);
  const s = window.__dividrTest.getStoreSnapshot();
  const vid = s.tracks.find((t) => t.type === 'video');
  const log = window.__lumaLog;
  // compress: only keep entries where luma changed by >3 vs previous kept, plus marks
  const kept = [];
  let last = null;
  for (const e of log) {
    if (e.mark || e.err) { kept.push(e); continue; }
    if (last === null || Math.abs(e.luma - last) > 3) { kept.push(e); last = e.luma; }
  }
  return { kept, tail: log.slice(-3), relight: vid?.relight ?? null, lightSource: vid?.lightSource ?? null };
});
console.log(JSON.stringify(out, null, 1));
process.exit(0);
