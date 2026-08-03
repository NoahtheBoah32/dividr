// edith-placement-regression — the EDITH placement ops that matter most, run through
// the REAL op pipeline against the new timeline contract:
//   broll     (explicitStart exact placement on lane 1, at 0:00 too)
//   placeSFX  (row-1 audio exact frame + push-up loop)
//   addCaption (subtitle exact placement)
//   deleteBroll (non-layer-0 lookup)
// Restores state and persists the restore.
import { chromium } from 'playwright-core';

const b = await chromium.connectOverCDP('http://localhost:9222');
let page = null;
for (const c of b.contexts()) for (const p of c.pages()) { const u = p.url(); if (u.includes('localhost:5173') && !u.startsWith('blob:')) page = p; }
if (!page) { console.log('FAIL: no page'); process.exit(1); }

// Deterministic stage: these assertions need a project whose library has real
// video media — open it explicitly instead of trusting whatever is ambient.
await page.evaluate(async () => { try { await window.__dividrTest.openProjectByTitle('SKILLS-93-TEST'); } catch {} });
await page.waitForTimeout(4500);

const results = [];
const check = (name, ok, detail) => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`); };
const consoleErrors = [];
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  const t = m.text();
  if (t.includes('is an invalid value for the') && t.includes('css style property')) return;
  consoleErrors.push(t);
});

const saved = await page.evaluate(() => JSON.parse(JSON.stringify(window.__dividrTest.getStoreSnapshot().tracks)));

// ── broll at 0:00 — explicitStart path: must land at frame 0 on lane 1 ─────
const broll = await page.evaluate(async () => {
  const s = window.__dividrTest.getStoreSnapshot();
  const src = s.tracks.find((t) => t.type === 'video')?.source;
  const before = new Set(s.tracks.map((t) => t.id));
  window.__dividrTest.applyOps([{ type: 'broll', src, from: 0, to: 3 }]);
  await window.__dividrTest.waitForQueueDrained();
  const s2 = window.__dividrTest.getStoreSnapshot();
  const nb = s2.tracks.find((t) => t.type === 'video' && !before.has(t.id));
  const main = s2.tracks.find((t) => t.type === 'video' && (t.trackRowIndex ?? 0) === 0);
  return {
    b: nb ? { row: nb.trackRowIndex, sf: nb.startFrame, ef: nb.endFrame, id: nb.id } : null,
    pip: main?.pipFrame?.style ?? null,
  };
});
check('EDITH broll at 0:00 lands at frame 0 on lane 1 (explicitStart)',
  broll.b && broll.b.sf === 0 && broll.b.row === 1, JSON.stringify(broll.b));
check('EDITH broll auto-enables PiP on main', !!broll.pip, `pip=${broll.pip}`);

// ── deleteBroll — finds the non-layer-0 clip at a time and removes it ───────
const delBroll = await page.evaluate(async (bId) => {
  window.__dividrTest.applyOps([{ type: 'deleteBroll', atSeconds: 1 }]);
  await window.__dividrTest.waitForQueueDrained();
  const s = window.__dividrTest.getStoreSnapshot();
  return { gone: !s.tracks.find((t) => t.id === bId) };
}, broll.b?.id);
check('EDITH deleteBroll removes the overlay clip', delBroll.gone, '');

// ── placeSFX — row-1 audio at exact frame ───────────────────────────────────
const sfx = await page.evaluate(async () => {
  const s = window.__dividrTest.getStoreSnapshot();
  const before = new Set(s.tracks.map((t) => t.id));
  window.__dividrTest.applyOps([{ type: 'placeSFX', file: 'whoosh_transition.mp3', atTime: 3, volume: -6, color: '#22c55e', trackName: 'contract-sfx' }]);
  await window.__dividrTest.waitForQueueDrained();
  await new Promise((r) => setTimeout(r, 2500)); // sfx may resolve/download async
  const s2 = window.__dividrTest.getStoreSnapshot();
  const fps = s2.timeline?.fps ?? 30;
  const nt = s2.tracks.find((t) => t.type === 'audio' && !before.has(t.id));
  return nt ? { row: nt.trackRowIndex, sf: nt.startFrame, expected: Math.round(3 * fps), id: nt.id } : null;
});
check('EDITH placeSFX lands on audio row 1 at the exact frame',
  sfx && sfx.row === 1 && Math.abs(sfx.sf - sfx.expected) <= 1,
  sfx ? `row=${sfx.row} sf=${sfx.sf} expected=${sfx.expected}` : 'no sfx track (op may need sfx library)');

// ── addCaption — subtitle exact placement ───────────────────────────────────
const cap = await page.evaluate(async () => {
  const s = window.__dividrTest.getStoreSnapshot();
  const before = new Set(s.tracks.map((t) => t.id));
  window.__dividrTest.applyOps([{ type: 'addCaption', text: 'contract test', startSeconds: 2, endSeconds: 4 }]);
  await window.__dividrTest.waitForQueueDrained();
  const s2 = window.__dividrTest.getStoreSnapshot();
  const fps = s2.timeline?.fps ?? 30;
  const nt = s2.tracks.find((t) => t.type === 'subtitle' && !before.has(t.id));
  return nt ? { sf: nt.startFrame, expected: Math.round(2 * fps) } : null;
});
check('EDITH addCaption lands at the exact frame',
  cap && cap.sf === cap.expected, cap ? `sf=${cap.sf} expected=${cap.expected}` : 'no caption');

// ── restore (persisted) ─────────────────────────────────────────────────────
await page.evaluate(async (tracks) => {
  window.__dividrTest.setStoreState({ tracks });
  const s = window.__dividrTest.getStoreSnapshot();
  s.markUnsavedChanges?.();
  s.triggerAutoSaveOnCommit?.();
  await new Promise((r) => setTimeout(r, 2000));
}, saved);
const restoredCount = await page.evaluate(() => window.__dividrTest.getStoreSnapshot().tracks.length);
check('original state restored', restoredCount === saved.length, `${restoredCount}/${saved.length}`);
check('no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '));

const failed = results.filter((r) => !r).length;
console.log(`\n${failed === 0 ? 'ALL PASS' : `${failed} FAILURES`}`);
process.exit(failed === 0 ? 0 : 1);
