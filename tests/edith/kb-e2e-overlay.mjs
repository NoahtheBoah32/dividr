/**
 * Ken Burns overlay e2e — the FCP-style setup boxes on the real preview:
 * presence, geometry (end box = 1/zoom of the frame box), drag-to-refocus,
 * corner-resize, clamping, hidden-while-playing, and that dragging the End
 * box never disturbs the clip's own transform. Leaves a screenshot in the
 * scratchpad for visual QA.
 *
 * Expects the project kb-e2e-flow.mjs set up (clip + kenBurns enabled).
 * Run: node tests/edith/kb-e2e-overlay.mjs
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
  return t ? { id: t.id, kb: t.kenBurns, tf: t.textTransform ?? null } : null;
});
if (!clip) { console.log('FAIL  no KB clip — run kb-e2e-flow.mjs first'); process.exit(1); }

// Ensure: enabled, selected, paused, reset focus to centre
await page.evaluate((id) => {
  const st = window.__videoEditorStore.getState();
  const t = st.tracks.find((x) => x.id === id);
  st.updateTrack(id, { kenBurns: { ...t.kenBurns, enabled: true, endZoom: 1.25, endCenter: { x: 0.5, y: 0.5 } } });
  const fns = ['setSelectedTrackIds', 'selectTracks', 'setSelectedTracks'];
  for (const f of fns) if (typeof st[f] === 'function') { st[f]([id]); break; }
  window.dispatchEvent(new CustomEvent('dividr:forceRender'));
}, clip.id);
await sleep(800);

// 1 ── presence
const dom = await page.evaluate(() => ({
  overlay: !!document.querySelector('[data-testid="kb-overlay"]'),
  start: !!document.querySelector('[data-testid="kb-start-rect"]'),
  end: !!document.querySelector('[data-testid="kb-end-rect"]'),
  corners: ['tl', 'tr', 'bl', 'br'].every((c) => !!document.querySelector(`[data-testid="kb-corner-${c}"]`)),
  cross: !!document.querySelector('[data-testid="kb-cross"]'),
}));
check('overlay + start box + end box + 4 corners + crosshair all render',
  dom.overlay && dom.start && dom.end && dom.corners && dom.cross, JSON.stringify(dom));

// 2 ── geometry: end box is 1/zoom of the frame box, centred
const rects = await page.evaluate(() => {
  const g = (t) => { const r = document.querySelector(`[data-testid="${t}"]`).getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; };
  return { start: g('kb-start-rect'), end: g('kb-end-rect') };
});
const ratio = rects.end.w / rects.start.w;
check('end box = 1/endZoom of frame box', Math.abs(ratio - 1 / 1.25) < 0.02, `ratio ${ratio.toFixed(3)}`);
const cxOff = Math.abs((rects.end.x + rects.end.w / 2) - (rects.start.x + rects.start.w / 2));
check('end box centred on centred focus', cxOff < 3, `Δx ${cxOff.toFixed(1)}px`);

// Screenshot for visual QA (before dragging)
await page.screenshot({ path: `${SP}/kb-overlay-shot.png` });

// 3 ── drag the End box → focus follows, clip transform untouched
const startCx = rects.end.x + rects.end.w / 2;
const startCy = rects.end.y + rects.end.h / 2;
await page.mouse.move(startCx, startCy);
await page.mouse.down();
await page.mouse.move(startCx + 60, startCy + 25, { steps: 8 });
await page.mouse.up();
await sleep(400);
let st1 = await page.evaluate((id) => {
  const t = window.__videoEditorStore.getState().tracks.find((x) => x.id === id);
  return { kb: t.kenBurns, tf: t.textTransform ?? null };
}, clip.id);
const expDx = 60 / rects.start.w;
check('dragging End box moves the focus centre', st1.kb.endCenter.x > 0.5 + expDx * 0.5 && st1.kb.endCenter.y > 0.5,
  `x=${st1.kb.endCenter.x.toFixed(3)} y=${st1.kb.endCenter.y.toFixed(3)} (expected x≈${(0.5 + expDx).toFixed(3)})`);
check('clip transform untouched by the drag', JSON.stringify(st1.tf) === JSON.stringify(clip.tf));

// 4 ── clamp: drag far right — the window must never leave the frame
await page.evaluate((id) => {
  const st = window.__videoEditorStore.getState();
  const t = st.tracks.find((x) => x.id === id);
  st.updateTrack(id, { kenBurns: { ...t.kenBurns, endCenter: { x: 0.5, y: 0.5 } } });
  window.dispatchEvent(new CustomEvent('dividr:forceRender'));
}, clip.id);
await sleep(300);
await page.mouse.move(startCx, startCy);
await page.mouse.down();
await page.mouse.move(startCx + rects.start.w, startCy, { steps: 10 });
await page.mouse.up();
await sleep(400);
const clamped = await page.evaluate((id) => window.__videoEditorStore.getState().tracks.find((x) => x.id === id).kenBurns.endCenter, clip.id);
const maxCx = 1 - 0.5 / 1.25;
check('focus clamps so the window stays inside the frame', clamped.x <= maxCx + 1e-6, `x=${clamped.x.toFixed(3)} max=${maxCx.toFixed(3)}`);

// 5 ── corner drag resizes the end box (changes endZoom)
await page.evaluate((id) => {
  const st = window.__videoEditorStore.getState();
  const t = st.tracks.find((x) => x.id === id);
  st.updateTrack(id, { kenBurns: { ...t.kenBurns, endCenter: { x: 0.5, y: 0.5 }, endZoom: 1.25 } });
  window.dispatchEvent(new CustomEvent('dividr:forceRender'));
}, clip.id);
await sleep(400);
const br = await page.evaluate(() => {
  const r = document.querySelector('[data-testid="kb-corner-br"]').getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
});
await page.mouse.move(br.x, br.y);
await page.mouse.down();
await page.mouse.move(br.x - 60, br.y - 30, { steps: 8 });
await page.mouse.up();
await sleep(400);
const zoomAfter = await page.evaluate((id) => window.__videoEditorStore.getState().tracks.find((x) => x.id === id).kenBurns.endZoom, clip.id);
check('dragging a corner inward tightens the zoom', zoomAfter > 1.25 + 0.02, `endZoom ${zoomAfter.toFixed(3)}`);

// Screenshot after refocus/resize for visual QA
await page.screenshot({ path: `${SP}/kb-overlay-after-drag.png` });

// 6 ── hidden while playing, back when paused
const playKeys = await page.evaluate(() => {
  const st = window.__videoEditorStore.getState();
  return Object.keys(st).filter((k) => /play/i.test(k) && typeof st[k] === 'function');
});
let playChecked = false;
for (const cand of ['togglePlayback', 'setIsPlaying', 'play', 'startPlayback']) {
  if (!playKeys.includes(cand)) continue;
  // Playhead must be OFF the timeline end or play never starts (known gotcha)
  await page.evaluate(() => {
    const st = window.__videoEditorStore.getState();
    for (const fn of ['setCurrentFrame', 'seekToFrame', 'setPlayheadFrame'])
      if (typeof st[fn] === 'function') { st[fn](30); break; }
  });
  await sleep(300);
  await page.evaluate((fn) => { const st = window.__videoEditorStore.getState(); fn === 'setIsPlaying' ? st[fn](true) : st[fn](); }, cand);
  await sleep(600);
  const hidden = await page.evaluate(() => !document.querySelector('[data-testid="kb-overlay"]'));
  await page.evaluate((fn) => {
    const st = window.__videoEditorStore.getState();
    if (fn === 'setIsPlaying') st[fn](false);
    else if (fn === 'togglePlayback') st[fn]();
    else (st.pause ?? st.stopPlayback ?? st.togglePlayback)?.();
  }, cand);
  await sleep(600);
  const back = await page.evaluate(() => !!document.querySelector('[data-testid="kb-overlay"]'));
  check('overlay hides during playback, returns on pause', hidden && back, `hidden=${hidden} back=${back} via ${cand}`);
  playChecked = true;
  break;
}
if (!playChecked) check('overlay hides during playback', false, `no play fn found: ${playKeys.join(',')}`);

// 7 ── toggle off → overlay gone
await page.evaluate((id) => {
  const st = window.__videoEditorStore.getState();
  const t = st.tracks.find((x) => x.id === id);
  st.updateTrack(id, { kenBurns: { ...t.kenBurns, enabled: false } });
  window.dispatchEvent(new CustomEvent('dividr:forceRender'));
}, clip.id);
await sleep(500);
const gone = await page.evaluate(() => !document.querySelector('[data-testid="kb-overlay"]'));
check('overlay disappears when KB is toggled off', gone);

// restore for later tests
await page.evaluate((id) => {
  const st = window.__videoEditorStore.getState();
  const t = st.tracks.find((x) => x.id === id);
  st.updateTrack(id, { kenBurns: { ...t.kenBurns, enabled: true, endZoom: 1.25, endCenter: { x: 0.5, y: 0.5 } } });
  window.dispatchEvent(new CustomEvent('dividr:forceRender'));
}, clip.id);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
