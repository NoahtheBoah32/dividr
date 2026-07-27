/**
 * Control experiment: draw cadence of the SAME 4K chipmunk clip WITHOUT Ken
 * Burns (via __srDraw, deduped by presented picture) vs WITH Ken Burns (via
 * __kbTrace, deduped by timeline frame). If the two match, KB adds zero
 * choppiness — the cadence is the clip's own 4K decode rate.
 * Run: node tests/edith/kb-e2e-control-cadence.mjs
 */
import { chromium } from 'playwright-core';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (n, ok, d = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  — ' + d : ''}`); ok ? pass++ : fail++; };

const b = await chromium.connectOverCDP('http://localhost:9222');
let page = null;
for (const c of b.contexts()) for (const p of c.pages()) {
  const u = p.url();
  if (u.includes('localhost:5173') && !u.startsWith('blob:')) page = p;
}
// Fresh modules (HMR socket dies in long-lived windows)
await page.reload();
for (let i = 0; i < 30; i++) {
  const ok = await page.evaluate(() => !!window.__videoEditorStore && !!window.__dividrTest).catch(() => false);
  if (ok) break;
  await sleep(1000);
}
// Reload may land on the project picker — reopen the test project.
const haveTracks = await page.evaluate(() => (window.__videoEditorStore.getState().tracks || []).length > 0);
if (!haveTracks) {
  await page.evaluate(async () => { await window.__dividrTest.openProjectByTitle('KB Chipmunk Test'); });
  for (let i = 0; i < 20; i++) {
    const n = await page.evaluate(() => (window.__videoEditorStore.getState().tracks || []).length);
    if (n > 0) break;
    await sleep(1000);
  }
}
const clip = await page.evaluate(() => {
  const s = window.__videoEditorStore.getState();
  const t = (s.tracks || []).find((x) => x.type === 'video' && x.kenBurns);
  return t ? { id: t.id, startFrame: t.startFrame, endFrame: t.endFrame } : null;
});
if (!clip) { console.log('FAIL  no KB clip'); process.exit(1); }

const setKb = (on) => page.evaluate(({ id, on: v }) => {
  const st = window.__videoEditorStore.getState();
  const t = st.tracks.find((x) => x.id === id);
  st.updateTrack(id, { kenBurns: { ...t.kenBurns, enabled: v } });
  window.dispatchEvent(new CustomEvent('dividr:forceRender'));
}, { id: clip.id, on });
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

async function runPass(kbOn) {
  await setKb(kbOn);
  await seek(clip.startFrame);
  await sleep(800);
  await page.evaluate(() => { window.__srDraw = []; window.__kbTrace = []; });
  await play();
  await sleep(10500);
  await stop();
  return page.evaluate(() => {
    const sr = window.__srDraw ?? [], kb = window.__kbTrace ?? [];
    window.__srDraw = null; window.__kbTrace = null;
    return { sr, kb };
  });
}

const distinct = (rows, key) => {
  const out = [];
  for (const r of rows) {
    const k = key(r);
    if (k == null || k < 0) continue;
    if (!out.length || out[out.length - 1].k !== k) out.push({ t: r[0], k });
  }
  return out;
};
const stats = (rows) => {
  const gaps = [];
  for (let i = 1; i < rows.length; i++) gaps.push(rows[i].t - rows[i - 1].t);
  gaps.sort((a, b) => a - b);
  const span = rows.length ? (rows[rows.length - 1].t - rows[0].t) / 1000 : 0;
  return {
    n: rows.length,
    perSec: span > 0 ? rows.length / span : 0,
    median: gaps.length ? gaps[Math.floor(gaps.length / 2)] : 0,
    p95: gaps.length ? gaps[Math.floor(gaps.length * 0.95)] : 0,
  };
};

// Warm-up first (cold decode poisons the first run), then INTERLEAVE
// ctl→kb→ctl→kb so run-order drift can't masquerade as a KB cost.
await runPass(false);
const ctlRuns = [], kbRuns = [];
for (let round = 0; round < 2; round++) {
  ctlRuns.push(await runPass(false));
  kbRuns.push(await runPass(true));
}

const agg = (runs, pick) => {
  const s = runs.map((r) => stats(distinct(pick(r), (row) => row[2] ?? row[1])));
  return {
    perSec: s.reduce((a, x) => a + x.perSec, 0) / s.length,
    median: s.reduce((a, x) => a + x.median, 0) / s.length,
    p95: s.reduce((a, x) => a + x.p95, 0) / s.length,
    each: s.map((x) => x.perSec.toFixed(1)).join(', '),
  };
};
const ctl = agg(ctlRuns, (r) => r.sr);
const kbPics = agg(kbRuns, (r) => r.sr);

console.log(`control (no KB): ${ctl.perSec.toFixed(1)} pics/s [${ctl.each}], median ${ctl.median.toFixed(1)}ms, p95 ${ctl.p95.toFixed(1)}ms`);
console.log(`with KB:         ${kbPics.perSec.toFixed(1)} pics/s [${kbPics.each}], median ${kbPics.median.toFixed(1)}ms, p95 ${kbPics.p95.toFixed(1)}ms`);

check('KB does not reduce picture cadence (≥90% of control)',
  kbPics.perSec >= ctl.perSec * 0.9, `${kbPics.perSec.toFixed(1)}/s vs control ${ctl.perSec.toFixed(1)}/s`);
check('KB does not worsen p95 hitches (≤1.3× control)',
  kbPics.p95 <= Math.max(ctl.p95 * 1.3, 80), `${kbPics.p95.toFixed(1)}ms vs control ${ctl.p95.toFixed(1)}ms`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
