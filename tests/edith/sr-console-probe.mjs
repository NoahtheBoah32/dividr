/** Captures console errors and page exceptions during playback. */
import { chromium } from 'playwright-core';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b = await chromium.connectOverCDP('http://localhost:9222');
let page = null;
for (const c of b.contexts())
  for (const p of c.pages()) if (/5173/.test(p.url())) page = p;
await page.bringToFront();

const errs = [];
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning')
    errs.push(`${m.type()}: ${m.text().slice(0, 200)}`);
});
page.on('pageerror', (e) => errs.push(`PAGEERROR: ${String(e).slice(0, 300)}`));

await page.evaluate(() => {
  const s = window.__videoEditorStore.getState();
  s.setCurrentFrame(60);
  s.play?.();
  setTimeout(() => window.__videoEditorStore.getState().pause?.(), 9000);
});
await sleep(9800);

const counts = new Map();
for (const e of errs) counts.set(e, (counts.get(e) ?? 0) + 1);
console.log(`captured ${errs.length} console errors/warnings\n`);
for (const [k, c] of [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12))
  console.log(`  x${String(c).padStart(4)}  ${k}`);
process.exit(0);
