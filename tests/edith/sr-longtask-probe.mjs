/** Catches the main-thread blocks that make the preview rate oscillate. */
import { chromium } from 'playwright-core';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b = await chromium.connectOverCDP('http://localhost:9222');
let page = null;
for (const c of b.contexts())
  for (const p of c.pages()) if (/5173/.test(p.url())) page = p;
if (!page) {
  console.log('no renderer');
  process.exit(1);
}
await page.bringToFront();

await page.evaluate(() => {
  window.__lt = [];
  window.__ltObs?.disconnect();
  const o = new PerformanceObserver((list) => {
    for (const e of list.getEntries())
      window.__lt.push([Math.round(e.startTime), Math.round(e.duration)]);
  });
  o.observe({ entryTypes: ['longtask'] });
  window.__ltObs = o;
  const s = window.__videoEditorStore.getState();
  s.setCurrentFrame(60);
  s.play?.();
  setTimeout(() => window.__videoEditorStore.getState().pause?.(), 6000);
});
await sleep(6600);

const r = await page.evaluate(() => {
  const lt = window.__lt ?? [];
  window.__ltObs?.disconnect();
  delete window.__lt;
  const total = lt.reduce((a, x) => a + x[1], 0);
  return { n: lt.length, total, sample: lt.slice(0, 40) };
});
console.log(`long tasks: ${r.n}, total blocked ${r.total}ms of 6000ms\n`);
let prev = null;
for (const [start, dur] of r.sample) {
  const gap = prev == null ? 0 : start - prev;
  console.log(`  t=${String(start).padStart(6)}ms  dur=${String(dur).padStart(4)}ms  sinceLast=${gap}ms`);
  prev = start;
}
process.exit(0);
