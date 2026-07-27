/**
 * Is the ~20Hz canvas rate a throttled rAF, or a composite that costs 50ms?
 * Runs an independent rAF counter alongside real playback and times the draw
 * work directly, so the two causes are separated.
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

async function measure(label, play) {
  await page.evaluate(
    (playing) => {
      const s = window.__videoEditorStore.getState();
      s.setCurrentFrame(60);
      window.__rafTicks = [];
      window.__srDraw = [];
      if (playing) s.play?.();
      const tick = () => {
        const t = window.__rafTicks;
        if (!t) return;
        t.push(performance.now());
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      setTimeout(() => {
        window.__videoEditorStore.getState().pause?.();
        const t = window.__rafTicks;
        window.__rafTicks = null;
        window.__rafDone = t;
      }, 3000);
    },
    play,
  );
  await sleep(3600);
  const r = await page.evaluate(() => {
    const ticks = window.__rafDone ?? [];
    const draws = window.__srDraw ?? [];
    delete window.__rafDone;
    delete window.__srDraw;
    const gaps = [];
    for (let i = 1; i < ticks.length; i++) gaps.push(ticks[i] - ticks[i - 1]);
    gaps.sort((a, b) => a - b);
    const span = ticks.length
      ? (ticks[ticks.length - 1] - ticks[0]) / 1000
      : 0;
    const dspan = draws.length
      ? (draws[draws.length - 1][0] - draws[0][0]) / 1000
      : 0;
    return {
      rafHz: span ? ticks.length / span : 0,
      medGap: gaps.length ? gaps[Math.floor(gaps.length / 2)] : 0,
      p95Gap: gaps.length ? gaps[Math.floor(gaps.length * 0.95)] : 0,
      drawHz: dspan ? draws.length / dspan : 0,
    };
  });
  console.log(
    `${label.padEnd(16)} rAF=${r.rafHz.toFixed(1)}Hz (median gap ${r.medGap.toFixed(1)}ms, p95 ${r.p95Gap.toFixed(1)}ms)   canvas draws=${r.drawHz.toFixed(1)}Hz`,
  );
}

await measure('paused', false);
await measure('playing', true);
process.exit(0);
