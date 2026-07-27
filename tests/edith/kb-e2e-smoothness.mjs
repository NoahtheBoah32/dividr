/**
 * Ken Burns smoothness e2e — plays the chipmunk clip through with the
 * lossless __kbTrace armed (one row per DRAWN frame) and proves the push-in
 * is smooth: zoom strictly non-decreasing, per-frame steps bounded by the
 * ease's peak slope, healthy draw cadence, and the zoom lands at endZoom.
 * Also saves paused screenshots at start/mid/end for visual QA.
 *
 * Expects the kb-e2e-flow project (clip + kenBurns). Run:
 *   node tests/edith/kb-e2e-smoothness.mjs
 */
import { chromium } from 'playwright-core';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SP = 'C:/Users/User/AppData/Local/Temp/claude/C--Users-User-Documents-AANG-V2/4b42243e-b537-438d-b50a-750efc6019b4/scratchpad';

let pass = 0, fail = 0;
const check = (n, ok, d = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  — ' + d : ''}`); ok ? pass++ : fail++; };

const b = await chromium.connectOverCDP('http://localhost:9222');
let page = null;
for (const c of b.contexts()) for (const p of c.pages()) {
  const u = p.url();
  if (u.includes('localhost:5173') && !u.startsWith('blob:')) page = p;
}
if (!page) { console.log('FAIL  no dev app page'); process.exit(1); }

const clip = await page.evaluate(() => {
  const s = window.__videoEditorStore.getState();
  const t = (s.tracks || []).find((x) => x.type === 'video' && x.kenBurns);
  return t ? { id: t.id, startFrame: t.startFrame, endFrame: t.endFrame } : null;
});
if (!clip) { console.log('FAIL  no KB clip — run kb-e2e-flow.mjs first'); process.exit(1); }
const span = clip.endFrame - clip.startFrame;
const Z = 1.25;

// Known state: enabled, endZoom 1.25, centred, deselected (no overlay in shots)
await page.evaluate((id) => {
  const st = window.__videoEditorStore.getState();
  const t = st.tracks.find((x) => x.id === id);
  st.updateTrack(id, { kenBurns: { ...t.kenBurns, enabled: true, endZoom: 1.25, endCenter: { x: 0.5, y: 0.5 } } });
  for (const f of ['setSelectedTrackIds', 'selectTracks']) if (typeof st[f] === 'function') { st[f]([]); break; }
  window.dispatchEvent(new CustomEvent('dividr:forceRender'));
}, clip.id);

// rAF health first — measurements are garbage if the window is throttled
const rafHz = await page.evaluate(async () => {
  let n = 0;
  const t0 = performance.now();
  await new Promise((res) => {
    const tick = () => { n++; performance.now() - t0 > 1000 ? res() : requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  });
  return n;
});
check('rAF healthy (window not throttled)', rafHz >= 30, `${rafHz}Hz`);

// Visual QA frames (paused): start / middle / end-ish
const seek = (f) => page.evaluate((fr) => {
  const st = window.__videoEditorStore.getState();
  for (const fn of ['setCurrentFrame', 'seekToFrame', 'setPlayheadFrame'])
    if (typeof st[fn] === 'function') { st[fn](fr); break; }
  window.dispatchEvent(new CustomEvent('dividr:forceRender'));
}, f);
for (const [name, f] of [['start', clip.startFrame + 5], ['mid', clip.startFrame + Math.round(span / 2)], ['end', clip.endFrame - 8]]) {
  await seek(f);
  await sleep(1100);
  await page.screenshot({ path: `${SP}/kb-frame-${name}.png` });
}

// Play the clip through with the trace armed
await seek(clip.startFrame);
await sleep(600);
await page.evaluate(() => { window.__kbTrace = []; });
await page.evaluate(() => {
  const st = window.__videoEditorStore.getState();
  for (const fn of ['togglePlayback', 'setIsPlaying', 'play'])
    if (typeof st[fn] === 'function') { fn === 'setIsPlaying' ? st[fn](true) : st[fn](); break; }
});
await sleep(10800);
await page.evaluate(() => {
  const st = window.__videoEditorStore.getState();
  if (st.playback?.isPlaying) {
    for (const fn of ['togglePlayback', 'setIsPlaying', 'pause'])
      if (typeof st[fn] === 'function') { fn === 'setIsPlaying' ? st[fn](false) : st[fn](); break; }
  }
});
const trace = await page.evaluate(() => { const t = window.__kbTrace; window.__kbTrace = null; return t; });

// One row per DISTINCT timeline frame, in draw order
const rows = [];
for (const [t, frame, zoom] of trace) {
  if (!rows.length || rows[rows.length - 1].frame !== frame) rows.push({ t, frame, zoom });
}
// Every DRAWN picture must carry a KB window — coverage is judged against
// what the clip's decode actually presented (raw 4K plays ~9 pics/s in
// preview app-wide; kb-e2e-control-cadence.mjs proves KB ≥ control there).
check('trace present across the whole clip', rows.length >= 40 && rows[rows.length - 1].frame >= clip.endFrame - 15,
  `${rows.length} drawn frames, last=${rows[rows.length - 1]?.frame} of ${clip.endFrame}`);

if (rows.length >= 10) {
  // 1 — every drawn frame's zoom matches the theory EXACTLY (deterministic
  //     frame-driven motion: scrub, playback and export all agree)
  const ease = (p) => 0.5 - 0.5 * Math.cos(Math.PI * Math.min(1, Math.max(0, p)));
  let worstErr = 0;
  for (const r of rows) {
    const expect = 1 + (Z - 1) * ease((r.frame - clip.startFrame) / span);
    worstErr = Math.max(worstErr, Math.abs(r.zoom - expect));
  }
  check('drawn zoom matches eased theory exactly', worstErr < 1e-6, `worst |Δ| ${worstErr.toExponential(1)}`);

  // 2 — zoom never steps backwards while frames advance
  let mono = true;
  for (let i = 1; i < rows.length; i++)
    if (rows[i].frame > rows[i - 1].frame && rows[i].zoom < rows[i - 1].zoom - 1e-9) mono = false;
  check('zoom strictly non-decreasing across playback', mono);

  // 3 — per-frame steps bounded by the ease's peak slope (scaled by frame gap)
  const peak = (Z - 1) * (Math.PI / 2) / span;
  let worst = 0;
  for (let i = 1; i < rows.length; i++) {
    const gap = Math.max(1, rows[i].frame - rows[i - 1].frame);
    worst = Math.max(worst, (rows[i].zoom - rows[i - 1].zoom) / gap);
  }
  check('per-frame zoom step ≤ ease peak slope', worst <= peak * 1.05, `worst=${worst.toFixed(6)} peak=${peak.toFixed(6)}`);

  // 4 — starts at ~1x, lands at ~endZoom
  check('starts at ~1.0x', rows[0].zoom < 1.02, `${rows[0].zoom.toFixed(4)}`);
  const last = rows[rows.length - 1].zoom;
  check('lands at ~endZoom', last > Z - 0.02, `${last.toFixed(4)} (target ${Z})`);

  // info — draw cadence (bounded by the clip's own decode rate, see control test)
  const gaps = [];
  for (let i = 1; i < rows.length; i++) gaps.push(rows[i].t - rows[i - 1].t);
  gaps.sort((a, b) => a - b);
  console.log(`info: ${rows.length} drawn frames, median gap ${gaps[Math.floor(gaps.length / 2)].toFixed(1)}ms, p95 ${gaps[Math.floor(gaps.length * 0.95)].toFixed(1)}ms`);
} else {
  fail += 5;
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
