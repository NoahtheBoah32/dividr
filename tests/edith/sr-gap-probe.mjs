/**
 * When the picture freezes mid-playback, did the draw loop stop, or did it keep
 * running with nothing to show? Records every compositeFrame CALL alongside
 * every actual draw, and reports the biggest gap in each.
 */
import { chromium } from 'playwright-core';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b = await chromium.connectOverCDP('http://localhost:9222');
let page = null;
for (const c of b.contexts())
  for (const p of c.pages()) if (/5173/.test(p.url())) page = p;
await page.bringToFront();

await page.evaluate(() => {
  const s = window.__videoEditorStore.getState();
  s.setCurrentFrame(30);
  window.__srCalls = [];
  window.__srDraw = [];
  window.__vidLog = [];
  // Watch the element's own stall signals.
  const vids = window.__dividrCompositor?.videos?.() ?? [];
  window.__vidPoll = setInterval(() => {
    const v = window.__dividrCompositor?.videos?.()[0];
    if (v)
      window.__vidLog.push([
        Math.round(performance.now()),
        +v.currentTime.toFixed(3),
        v.readyState,
        v.seeking ? 1 : 0,
        v.paused ? 1 : 0,
      ]);
  }, 50);
  void vids;
  s.play?.();
  setTimeout(() => {
    window.__videoEditorStore.getState().pause?.();
    clearInterval(window.__vidPoll);
  }, 9000);
});
await sleep(9800);

const r = await page.evaluate(() => {
  const calls = window.__srCalls ?? [];
  const draws = window.__srDraw ?? [];
  const vid = window.__vidLog ?? [];
  delete window.__srCalls;
  delete window.__srDraw;
  delete window.__vidLog;
  const gaps = (arr, get) => {
    const g = [];
    for (let i = 1; i < arr.length; i++) g.push(get(arr[i]) - get(arr[i - 1]));
    return g;
  };
  const cg = gaps(calls, (x) => x);
  const dg = gaps(draws, (x) => x[0]);
  // Find the window around the worst draw gap.
  let worst = 0;
  let wi = 0;
  dg.forEach((g, i) => {
    if (g > worst) {
      worst = g;
      wi = i;
    }
  });
  const t0 = draws[wi]?.[0] ?? 0;
  const t1 = draws[wi + 1]?.[0] ?? 0;
  return {
    calls: calls.length,
    draws: draws.length,
    maxCallGap: cg.length ? Math.max(...cg) : 0,
    maxDrawGap: worst,
    callsInWorstWindow: calls.filter((c) => c >= t0 && c <= t1).length,
    vidInWorstWindow: vid.filter((v) => v[0] >= t0 - 100 && v[0] <= t1 + 100),
  };
});
console.log(
  `compositeFrame calls=${r.calls}  actual draws=${r.draws}\n` +
    `worst gap between CALLS = ${r.maxCallGap.toFixed(0)}ms\n` +
    `worst gap between DRAWS = ${r.maxDrawGap.toFixed(0)}ms\n` +
    `compositeFrame calls inside that draw gap = ${r.callsInWorstWindow}\n`,
);
console.log('element during the gap  [t, currentTime, readyState, seeking, paused]:');
for (const v of r.vidInWorstWindow.slice(0, 40)) console.log('  ', JSON.stringify(v));
process.exit(0);
