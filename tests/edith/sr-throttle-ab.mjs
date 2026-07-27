/**
 * A/B: how much preview frame rate is being lost to per-tick React rendering?
 * Caps the playhead's store writes at various rates and measures what the
 * canvas can do with the main thread it gets back.
 */
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

async function run(hz) {
  await page.evaluate((h) => {
    globalThis.__srThrottleHz = h || 0;
    globalThis.__srLastWrite = 0;
    const s = window.__videoEditorStore.getState();
    s.setCurrentFrame(60);
    window.__rafTicks = [];
    window.__srDraw = [];
    s.play?.();
    const tick = () => {
      const t = window.__rafTicks;
      if (!t) return;
      t.push(performance.now());
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    setTimeout(() => {
      window.__videoEditorStore.getState().pause?.();
      window.__rafDone = window.__rafTicks;
      window.__rafTicks = null;
    }, 3000);
  }, hz);
  await sleep(3600);
  const r = await page.evaluate(() => {
    const ticks = window.__rafDone ?? [];
    const draws = window.__srDraw ?? [];
    delete window.__rafDone;
    delete window.__srDraw;
    const span = ticks.length ? (ticks[ticks.length - 1] - ticks[0]) / 1000 : 0;
    const dspan = draws.length
      ? (draws[draws.length - 1][0] - draws[0][0]) / 1000
      : 0;
    // distinct pictures, not just draws
    let distinct = 0;
    for (let i = 1; i < draws.length; i++)
      if (draws[i][1] !== draws[i - 1][1] && draws[i][1] !== -1) distinct++;
    return {
      rafHz: span ? ticks.length / span : 0,
      drawHz: dspan ? draws.length / dspan : 0,
      picHz: dspan ? distinct / dspan : 0,
    };
  });
  console.log(
    `store writes ${(hz ? `${hz}Hz` : 'uncapped').padEnd(9)}  rAF=${r.rafHz.toFixed(1).padStart(6)}Hz   canvas draws=${r.drawHz.toFixed(1).padStart(5)}Hz   distinct pictures=${r.picHz.toFixed(1).padStart(5)}Hz`,
  );
}

await run(0);
await run(30);
await run(15);
await run(10);
await run(0);
await page.evaluate(() => {
  globalThis.__srThrottleHz = 0;
});
process.exit(0);
