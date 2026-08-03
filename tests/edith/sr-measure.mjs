/**
 * Speed ramp measurement — the honest judder signal, before/after any fix.
 *
 * Samples `presentedMediaTime` (the frame actually ON SCREEN) from
 * __dividrCompositor.videos() while playing through staged ramps. currentTime
 * runs ahead of the presented frame and aliases when sampled, so it lies about
 * smoothness; presentedMediaTime does not.
 *
 * Reports per scenario: how many distinct pictures were presented per second,
 * the longest stall (same picture held), and how uneven the advance was.
 * A smooth drive shows many distinct pictures and a small max stall.
 * Run: node tests/edith/sr-measure.mjs ["Project Title"]
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
  if (!v) return null;
  return {
    id: v.id, name: v.name, start: v.startFrame, end: v.endFrame,
    srcDur: (v.endFrame - v.startFrame) / (s.timeline?.fps ?? 30),
    fps: s.timeline?.fps ?? 30,
    w: v.width, h: v.height,
  };
});
if (!clip) { console.log('no video clip'); process.exit(1); }
console.log(`clip "${clip.name}" ${clip.w}x${clip.h} ${clip.srcDur.toFixed(2)}s @${clip.fps}fps\n`);

const setRamp = (ramp) => page.evaluate(({ id, ramp }) => {
  const st = window.__videoEditorStore.getState();
  st.updateTrack(id, { speedRamp: ramp });
  window.dispatchEvent(new CustomEvent('dividr:forceRender'));
}, { id: clip.id, ramp });
const seek = (f) => page.evaluate((fr) => {
  const st = window.__videoEditorStore.getState();
  for (const fn of ['setCurrentFrame', 'seekToFrame', 'setPlayheadFrame'])
    if (typeof st[fn] === 'function') { st[fn](fr); break; }
  window.dispatchEvent(new CustomEvent('dividr:forceRender'));
}, f);
const play = () => page.evaluate(() => {
  const st = window.__videoEditorStore.getState();
  for (const fn of ['togglePlayback', 'setIsPlaying', 'play'])
    if (typeof st[fn] === 'function') { fn === 'setIsPlaying' ? st[fn](true) : st[fn](); break; }
});
const stop = () => page.evaluate(() => {
  const st = window.__videoEditorStore.getState();
  if (st.playback?.isPlaying) {
    for (const fn of ['togglePlayback', 'setIsPlaying', 'pause'])
      if (typeof st[fn] === 'function') { fn === 'setIsPlaying' ? st[fn](false) : st[fn](); break; }
  }
});

/**
 * Sample presentedMediaTime in-page at ~120Hz for `ms`, so the sampler itself
 * isn't the bottleneck (a CDP round trip per sample would alias worse than the
 * judder being measured).
 */
async function record(ms) {
  await page.evaluate((dur) => {
    const w = window;
    w.__srSamples = [];
    const t0 = performance.now();
    const tick = () => {
      const vids = w.__dividrCompositor?.videos?.() ?? [];
      const v = vids[0];
      if (v) w.__srSamples.push({
        t: performance.now() - t0,
        p: v.presentedMediaTime,
        c: v.currentTime,
        rate: v.playbackRate,
        paused: v.paused,
        seeking: v.seeking,
        stepping: v.stepping,
      });
      if (performance.now() - t0 < dur) requestAnimationFrame(tick);
      else w.__srDone = true;
    };
    w.__srDone = false;
    requestAnimationFrame(tick);
  }, ms);
  await sleep(ms + 400);
  return page.evaluate(() => window.__srSamples ?? []);
}

function stats(samples) {
  const valid = samples.filter((s) => typeof s.p === 'number' && s.p > 0);
  if (valid.length < 5) return { err: `only ${valid.length} valid samples` };
  const distinct = [];
  for (const s of valid) {
    if (!distinct.length || Math.abs(s.p - distinct[distinct.length - 1].p) > 1e-6) distinct.push(s);
  }
  const spanSec = (valid[valid.length - 1].t - valid[0].t) / 1000;
  const stalls = [];
  for (let i = 1; i < distinct.length; i++) stalls.push(distinct[i].t - distinct[i - 1].t);
  const advances = [];
  for (let i = 1; i < distinct.length; i++) advances.push(distinct[i].p - distinct[i - 1].p);
  const mean = (a) => a.reduce((x, y) => x + y, 0) / (a.length || 1);
  const sd = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((x) => (x - m) ** 2))); };
  const netAdvance = valid[valid.length - 1].p - valid[0].p;
  return {
    pps: +(distinct.length / spanSec).toFixed(1),
    maxStallMs: Math.round(Math.max(...stalls, 0)),
    meanStallMs: Math.round(mean(stalls)),
    stallCV: +(sd(stalls) / (mean(stalls) || 1)).toFixed(2),
    netSrcAdvance: +netAdvance.toFixed(3),
    effRate: +(netAdvance / spanSec).toFixed(2),
    steppingPct: Math.round(100 * valid.filter((s) => s.stepping).length / valid.length),
    seekingPct: Math.round(100 * valid.filter((s) => s.seeking).length / valid.length),
    elRate: +mean(valid.map((s) => s.rate)).toFixed(2),
  };
}

// Stage ramps through the REAL op — it also retimes the clip's endFrame to the
// ramp's output length. Setting speedRamp with updateTrack alone leaves the
// timeline at its original length, so srcAt() clamps for most of the clip and
// the resync seeks thrash: a harness artefact that looks exactly like the bug.
const applyOp = (op) => page.evaluate(async (o) => {
  await window.__dividrTest.applyOps([o]);
  await window.__dividrTest.waitForQueueDrained();
}, op);
const clearRamp = () => applyOp({ type: 'speedRamp', enabled: false }).catch(() => {});
const makeReverse = () => page.evaluate(({ id }) => {
  const st = window.__videoEditorStore.getState();
  const t = st.tracks.find((x) => x.id === id);
  const sr = t?.speedRamp;
  if (!sr?.regions?.length) return false;
  st.updateTrack(id, {
    speedRamp: { ...sr, regions: sr.regions.map((r) => ({ ...r, dir: 'reverse' })) },
  });
  window.dispatchEvent(new CustomEvent('dividr:forceRender'));
  return true;
}, { id: clip.id });

const geom = () => page.evaluate(({ id }) => {
  const s = window.__videoEditorStore.getState();
  const t = s.tracks.find((x) => x.id === id);
  return { start: t.startFrame, end: t.endFrame, fps: s.timeline?.fps ?? 30 };
}, { id: clip.id });

const SCENARIOS = [
  { name: 'A  no ramp (baseline 1x)', op: null },
  { name: 'B  ramp 1 -> 0.5x (slow)', op: { type: 'speedRamp', speed: 0.5 } },
  { name: 'C  ramp 1 -> 8x', op: { type: 'speedRamp', speed: 8 } },
  { name: 'D  ramp 1 -> 30x', op: { type: 'speedRamp', speed: 30 } },
  { name: 'E  reverse region (2x)', op: { type: 'speedRamp', speed: 2 }, reverse: true },
];

for (const sc of SCENARIOS) {
  await stop();
  await clearRamp();
  await sleep(400);
  if (sc.op) {
    try { await applyOp(sc.op); } catch (e) { console.log(`${sc.name}\n   op failed: ${e.message}`); continue; }
    await sleep(500);
    if (sc.reverse) await makeReverse();
    await sleep(400);
  }
  const g = await geom();
  const outSpanSec = (g.end - g.start) / g.fps;
  await seek(g.start + Math.round(0.12 * (g.end - g.start)));
  await sleep(900);
  await play();
  await sleep(350); // let the drive settle before sampling
  const recMs = Math.max(1200, Math.min(3000, outSpanSec * 700));
  const samples = await record(recMs);
  await stop();
  const s = stats(samples);
  console.log(`${sc.name}  [timeline ${g.end - g.start}f = ${outSpanSec.toFixed(2)}s, sampled ${Math.round(recMs)}ms]\n   ${JSON.stringify(s)}`);
}

await stop();
await clearRamp();
await seek(clip.start);
console.log('\nramp cleared');
process.exit(0);
