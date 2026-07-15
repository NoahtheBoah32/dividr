// timeline-realdrag-e2e — REAL mouse drag through the actual pointer pipeline:
// drag a clip left onto another clip's tail, release, and verify:
//   - the clip lands where the pointer released it (no clamp, no push-back, no teleport)
//   - the clip underneath tail-trims (overwrite commit on release)
// Restores the original project state afterwards.
import { chromium } from 'playwright-core';

const b = await chromium.connectOverCDP('http://localhost:9222');
let page = null;
for (const c of b.contexts()) for (const p of c.pages()) { const u = p.url(); if (u.includes('localhost:5173') && !u.startsWith('blob:')) page = p; }
if (!page) { console.log('FAIL: no page'); process.exit(1); }

const results = [];
const check = (name, ok, detail) => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`); };
const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });

const saved = await page.evaluate(() => JSON.parse(JSON.stringify(window.__dividrTest.getStoreSnapshot().tracks)));

// Setup: main pair shrunk to [0,240]; clip D added at lane 0 [400,640].
const setup = await page.evaluate(async () => {
  const s = window.__dividrTest.getStoreSnapshot();
  const main = s.tracks.find((t) => t.type === 'video');
  const mainAudio = s.tracks.find((t) => t.id === main.linkedTrackId);
  s.updateTrack(main.id, { endFrame: 240, duration: 240 });
  if (mainAudio) s.updateTrack(mainAudio.id, { endFrame: 240, duration: 240 });
  const m = s.mediaLibrary.find((i) => i.type === 'video');
  const dId = await s.addTrackFromMediaLibrary(m.id, 400, 0, true);
  const s2 = window.__dividrTest.getStoreSnapshot();
  s2.updateTrack(dId, { endFrame: 640, duration: 240 });
  const dAudio = s2.tracks.find((t) => t.linkedTrackId === dId);
  if (dAudio) s2.updateTrack(dAudio.id, { startFrame: 400, endFrame: 640, duration: 240 });
  // make sure snapping can't be blamed either way — leave app setting as is, report it
  return { mainId: main.id, dId, snap: s2.timeline?.snapEnabled ?? false };
});
await page.waitForTimeout(600);

// Locate D on screen and measure px-per-frame from its rect.
const geo = await page.evaluate(({ dId }) => {
  const el = document.querySelector(`[data-edith-target="track-body:${dId}"]`);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
}, { dId: setup.dId });
if (!geo || geo.w < 10) { console.log('FAIL: clip D not visible on timeline', JSON.stringify(geo)); process.exit(1); }
const pxPerFrame = geo.w / 240;

// Real drag: D starts at frame 400; drag LEFT by 300 frames → target start 100,
// overlapping main [0,240]'s tail by 140 frames.
const dxPx = 300 * pxPerFrame;
await page.mouse.move(geo.cx, geo.cy);
await page.mouse.down();
// small first move to cross the 5px activation threshold, then glide
for (let i = 1; i <= 12; i++) {
  await page.mouse.move(geo.cx - (dxPx * i) / 12, geo.cy, { steps: 3 });
  await page.waitForTimeout(30);
}
await page.mouse.up();
await page.waitForTimeout(600);

const outcome = await page.evaluate(({ dId, mainId }) => {
  const s = window.__dividrTest.getStoreSnapshot();
  const d = s.tracks.find((t) => t.id === dId);
  const main = s.tracks.find((t) => t.id === mainId);
  return {
    d: d ? { sf: d.startFrame, ef: d.endFrame, row: d.trackRowIndex ?? 0 } : null,
    main: main ? { sf: main.startFrame, ef: main.endFrame } : null,
  };
}, { dId: setup.dId, mainId: setup.mainId });

// Tolerances: pointer→frame rounding ±3, snap (5 frames) could catch an edge.
const dLanded = outcome.d && Math.abs(outcome.d.sf - 100) <= 8 && outcome.d.row === 0;
check('real drag: clip lands where the pointer released it', dLanded,
  `D=${JSON.stringify(outcome.d)} (target sf≈100, snap=${setup.snap})`);
check('real drag: underlying clip tail-trimmed to the drop',
  outcome.main && outcome.d && outcome.main.ef === outcome.d.sf && outcome.main.sf === 0,
  `main=${JSON.stringify(outcome.main)}`);

// restore — and PERSIST the restore, otherwise a mid-test autosave (drag commit)
// leaves the mutated state in the project file
await page.evaluate(async (tracks) => {
  window.__dividrTest.setStoreState({ tracks });
  const s = window.__dividrTest.getStoreSnapshot();
  s.markUnsavedChanges?.();
  s.triggerAutoSaveOnCommit?.();
  await new Promise((r) => setTimeout(r, 2000));
}, saved);
await page.waitForTimeout(300);
const restoredCount = await page.evaluate(() => window.__dividrTest.getStoreSnapshot().tracks.length);
check('original state restored', restoredCount === saved.length, `${restoredCount}/${saved.length}`);
check('no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '));

const failed = results.filter((r) => !r).length;
console.log(`\n${failed === 0 ? 'ALL PASS' : `${failed} FAILURES`}`);
process.exit(failed === 0 ? 0 : 1);
