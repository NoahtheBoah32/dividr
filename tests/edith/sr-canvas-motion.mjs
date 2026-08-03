/**
 * Canvas motion probe — the ground truth for "does the picture actually move,
 * and does it move evenly". Hashes the PREVIEW CANVAS every animation frame,
 * so it sees whatever the user sees: element-driven playback, stepped seeks,
 * and reverse frames served from the bitmap cache alike. presentedMediaTime
 * cannot see reverse at all (the element is deliberately paused there), which
 * is why this exists.
 *
 * Reports per scenario: distinct pictures per second, the longest frozen
 * stretch, and how uneven the picture changes were (CV of the gaps — the
 * number that actually corresponds to "choppy").
 * Run: node tests/edith/sr-canvas-motion.mjs ["Project Title"]
 */
import { chromium } from 'playwright-core';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TITLE = process.argv[2] || 'J-cut DEMO';

const b = await chromium.connectOverCDP('http://localhost:9222');
let page = null;
for (const c of b.contexts()) for (const p of c.pages()) {
  const u = p.url();
  if (u.includes('localhost:5173') && !u.startsWith('blob:')) page = p;
}
if (!page) { console.log('no dev app page'); process.exit(1); }
page.setDefaultTimeout(25000);
// A hidden or minimised window throttles requestAnimationFrame to ~1Hz, which
// both starves the app's own draw loop and makes every smoothness number here
// meaningless. Measure only with the window actually presenting.
await page.bringToFront();
await sleep(600);
const vis = await page.evaluate(() => ({ hidden: document.hidden, state: document.visibilityState }));
console.log(`visibility: ${vis.state}${vis.hidden ? ' (HIDDEN — numbers will be throttled)' : ''}`);

for (let i = 0; i < 30; i++) {
  const st = await page.evaluate(() => {
    const s = window.__videoEditorStore?.getState?.();
    return s ? { ready: (s.tracks || []).length > 0 } : { ready: false };
  }).catch(() => ({ ready: false }));
  if (st.ready) break;
  await page.evaluate(async (t) => {
    try { await window.__dividrTest.openProjectByTitle(t); } catch (e) {}
  }, TITLE).catch(() => {});
  await sleep(1000);
}

const clip = await page.evaluate(() => {
  const s = window.__videoEditorStore.getState();
  const v = s.tracks.filter((t) => t.type === 'video').sort((a, b) => a.startFrame - b.startFrame)[0];
  return v ? { id: v.id, name: v.name, w: v.width, h: v.height } : null;
});
if (!clip) { console.log('no clip'); process.exit(1); }
console.log(`clip "${clip.name}" ${clip.w}x${clip.h}\n`);

const applyOp = (op) => page.evaluate(async (o) => {
  await window.__dividrTest.applyOps([o]);
  await window.__dividrTest.waitForQueueDrained();
}, op);
const stop = () => page.evaluate(() => {
  const st = window.__videoEditorStore.getState();
  if (st.playback?.isPlaying) { for (const fn of ['togglePlayback', 'setIsPlaying', 'pause']) if (typeof st[fn] === 'function') { fn === 'setIsPlaying' ? st[fn](false) : st[fn](); break; } }
});
const play = () => page.evaluate(() => {
  const st = window.__videoEditorStore.getState();
  for (const fn of ['togglePlayback', 'setIsPlaying', 'play']) if (typeof st[fn] === 'function') { fn === 'setIsPlaying' ? st[fn](true) : st[fn](); break; }
});
const seek = (f) => page.evaluate((fr) => {
  const st = window.__videoEditorStore.getState();
  st.setCurrentFrame?.(fr);
  window.dispatchEvent(new CustomEvent('dividr:forceRender'));
}, f);
const geom = () => page.evaluate(({ id }) => {
  const s = window.__videoEditorStore.getState();
  const t = s.tracks.find((x) => x.id === id);
  return { start: t.startFrame, end: t.endFrame, fps: s.timeline?.fps ?? 30 };
}, { id: clip.id });
const makeReverse = () => page.evaluate(({ id }) => {
  const st = window.__videoEditorStore.getState();
  const t = st.tracks.find((x) => x.id === id);
  const sr = t?.speedRamp;
  if (!sr?.regions?.length) return false;
  st.updateTrack(id, { speedRamp: { ...sr, regions: sr.regions.map((r) => ({ ...r, dir: 'reverse' })) } });
  window.dispatchEvent(new CustomEvent('dividr:forceRender'));
  return true;
}, { id: clip.id });

/** Hash the preview canvas every rAF for `ms`; return change timestamps. */
async function recordCanvas(ms) {
  await page.evaluate((dur) => {
    const w = window;
    // The preview canvas is the largest one on screen.
    const canvases = [...document.querySelectorAll('canvas')];
    let target = null, bestArea = 0;
    for (const c of canvases) {
      const r = c.getBoundingClientRect();
      const area = r.width * r.height;
      if (area > bestArea) { bestArea = area; target = c; }
    }
    w.__cmTarget = target;
    w.__cmChanges = [];
    w.__cmFrames = 0;
    const off = document.createElement('canvas');
    off.width = 24; off.height = 14;
    const ctx = off.getContext('2d', { willReadFrequently: true });
    let lastHash = -1;
    const t0 = performance.now();
    const tick = () => {
      if (!target) return;
      w.__cmFrames++;
      try {
        ctx.drawImage(target, 0, 0, 24, 14);
        const d = ctx.getImageData(0, 0, 24, 14).data;
        let h = 0;
        for (let i = 0; i < d.length; i += 4) { h = (h * 31 + d[i]) | 0; h = (h * 31 + d[i + 1]) | 0; }
        if (h !== lastHash) { lastHash = h; w.__cmChanges.push(performance.now() - t0); }
      } catch (e) { /* tainted or not ready */ }
      if (performance.now() - t0 < dur) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, ms);
  await sleep(ms + 500);
  return page.evaluate(() => ({ changes: window.__cmChanges ?? [], ticks: window.__cmFrames ?? 0 }));
}

function stats({ changes, ticks }, ms) {
  if (changes.length < 3) return { err: `only ${changes.length} picture changes in ${ms}ms (ticks=${ticks})` };
  const gaps = [];
  for (let i = 1; i < changes.length; i++) gaps.push(changes[i] - changes[i - 1]);
  const mean = (a) => a.reduce((x, y) => x + y, 0) / (a.length || 1);
  const sd = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((x) => (x - m) ** 2))); };
  const span = (changes[changes.length - 1] - changes[0]) / 1000;
  return {
    picturesPerSec: +(( changes.length - 1) / span).toFixed(1),
    maxFreezeMs: Math.round(Math.max(...gaps)),
    meanGapMs: Math.round(mean(gaps)),
    gapCV: +(sd(gaps) / (mean(gaps) || 1)).toFixed(2),
    rafTicks: ticks,
  };
}

const SCENARIOS = [
  { name: 'A  no ramp (baseline 1x)', op: null },
  { name: 'B  ramp 1 -> 0.5x', op: { type: 'speedRamp', speed: 0.5 } },
  { name: 'C  ramp 1 -> 8x', op: { type: 'speedRamp', speed: 8 } },
  { name: 'D  ramp 1 -> 30x', op: { type: 'speedRamp', speed: 30 } },
  { name: 'E  reverse (2x)', op: { type: 'speedRamp', speed: 2 }, reverse: true },
];

for (const sc of SCENARIOS) {
  await stop();
  try { await applyOp({ type: 'speedRamp', enabled: false }); } catch {}
  await sleep(400);
  if (sc.op) {
    try { await applyOp(sc.op); } catch (e) { console.log(`${sc.name}\n   op failed: ${e.message}`); continue; }
    await sleep(400);
    if (sc.reverse) { await makeReverse(); await sleep(300); }
  }
  const g = await geom();
  const span = (g.end - g.start) / g.fps;
  await seek(g.start + 2);
  // Reverse needs its cache built before the region is entered.
  await sleep(sc.reverse ? 2600 : 900);
  await play();
  await sleep(300);
  const ms = Math.max(1500, Math.min(3000, span * 650));
  const rec = await recordCanvas(ms);
  await stop();
  console.log(`${sc.name}  [timeline ${span.toFixed(2)}s, sampled ${ms}ms]\n   ${JSON.stringify(stats(rec, ms))}`);
}

await stop();
try { await applyOp({ type: 'speedRamp', enabled: false }); } catch {}
await seek(0);
console.log('\nramp cleared');
process.exit(0);
