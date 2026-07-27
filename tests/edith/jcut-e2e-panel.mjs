/**
 * J-cut panel e2e — the manual controls EDITH unlocks: gating (absent on
 * clips she hasn't touched), toggle off/on with exact geometry restore, the
 * "Audio lead" seconds box (retime + clamp), and a screenshot for visual QA.
 * Expects jcut-e2e-flow.mjs to have left the 3s J-cut applied.
 * Run: node tests/edith/jcut-e2e-panel.mjs
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

const ids = await page.evaluate(() => {
  const s = window.__videoEditorStore.getState();
  const vids = s.tracks.filter((t) => t.type === 'video').sort((a, b) => a.startFrame - b.startFrame);
  const v2 = vids.find((t) => t.jCut) ?? vids[1];
  const v1 = vids.find((t) => t.id !== v2?.id);
  return v2 ? { v1: v1?.id ?? null, v2: v2.id, a2: v2.linkedTrackId ?? null, fps: s.timeline?.fps ?? 30 } : null;
});
if (!ids || !ids.a2) { console.log('FAIL  no J-cut clip — run jcut-e2e-flow.mjs first'); process.exit(1); }

const select = (id) => page.evaluate((tid) => {
  const st = window.__videoEditorStore.getState();
  for (const f of ['setSelectedTrackIds', 'selectTracks', 'setSelectedTracks'])
    if (typeof st[f] === 'function') { st[f](tid ? [tid] : []); break; }
}, id);
const geom = () => page.evaluate(({ v2, a2 }) => {
  const s = window.__videoEditorStore.getState();
  const v = s.tracks.find((t) => t.id === v2), a = s.tracks.find((t) => t.id === a2);
  return {
    vSrc: v.sourceStartTime ?? 0, vEnd: v.endFrame, vDur: v.duration,
    aStart: a.startFrame, aEnd: a.endFrame, aRow: a.trackRowIndex ?? 0,
    jCut: v.jCut ?? null,
  };
}, { v2: ids.v2, a2: ids.a2 });

// 1 ── gating: clip 1 (never J-cut by EDITH) shows NO section
if (ids.v1) {
  await select(ids.v1);
  await sleep(700);
  const absent = await page.evaluate(() => !document.querySelector('[data-testid="j-cut-section"]'));
  check('section absent on a clip EDITH has not J-cut', absent);
}

// 2 ── clip 2 shows the unlocked section with toggle ON + green dot
await select(ids.v2);
await sleep(700);
const dom = await page.evaluate(() => {
  const sec = document.querySelector('[data-testid="j-cut-section"]');
  const toggle = document.querySelector('[data-testid="j-cut-toggle"]');
  const input = document.querySelector('[data-testid="j-cut-lead-input"]');
  return {
    section: !!sec,
    toggleOn: toggle?.getAttribute('data-state') === 'checked' || toggle?.getAttribute('aria-checked') === 'true',
    inputVal: input ? input.value : null,
    dot: !!sec?.querySelector('.bg-green-500'),
  };
});
check('section + toggle ON + green dot + lead box render', dom.section && dom.toggleOn && dom.dot, JSON.stringify(dom));
check('lead box shows the applied 3.0s', dom.inputVal === '3', `value="${dom.inputVal}"`);
await page.screenshot({ path: `${SP}/jcut-panel-shot.png` });

const g3 = await geom();

// 3 ── toggle OFF via the real switch → geometry home, section stays
await page.click('[data-testid="j-cut-toggle"]');
await sleep(500);
const gOff = await geom();
check('toggle off: audio home, picture whole, lane restored',
  gOff.aStart === g3.aStart + g3.jCut.appliedLeadFrames &&
  Math.abs(gOff.vSrc - (g3.vSrc - g3.jCut.appliedLeadFrames / ids.fps)) < 1e-6 &&
  gOff.vEnd === g3.vEnd + g3.jCut.appliedLeadFrames &&
  gOff.jCut.enabled === false && gOff.jCut.appliedLeadFrames === 0,
  `aStart ${g3.aStart}→${gOff.aStart}, vEnd ${g3.vEnd}→${gOff.vEnd}, row ${gOff.aRow}`);
const stillThere = await page.evaluate(() => !!document.querySelector('[data-testid="j-cut-section"]'));
check('section survives toggling off (unlock is sticky)', stillThere);

// 4 ── toggle back ON → the 3s lead returns exactly
await page.click('[data-testid="j-cut-toggle"]');
await sleep(500);
const gOn = await geom();
check('toggle on: the 3s lead returns exactly',
  gOn.aStart === g3.aStart && Math.abs(gOn.vSrc - g3.vSrc) < 1e-6 && gOn.vEnd === g3.vEnd &&
  gOn.jCut.enabled === true && gOn.jCut.appliedLeadFrames === g3.jCut.appliedLeadFrames,
  `aStart=${gOn.aStart} vSrc=${gOn.vSrc} lead=${gOn.jCut.appliedLeadFrames}`);

// 5 ── type 5 in the lead box → retimes to 5s
await page.fill('[data-testid="j-cut-lead-input"]', '5');
await page.press('[data-testid="j-cut-lead-input"]', 'Enter');
await sleep(500);
const g5 = await geom();
const LEAD5 = Math.round(5 * ids.fps);
check('typing 5 retimes the lead to 5s',
  g5.jCut.appliedLeadFrames === LEAD5 && g5.aStart === gOff.aStart - LEAD5 &&
  Math.abs(g5.vSrc - (gOff.vSrc + 5)) < 1e-6,
  `lead=${g5.jCut.appliedLeadFrames}f aStart=${g5.aStart} vSrc=${g5.vSrc}`);

// 6 ── type an absurd 99 → clamped (max 10s pref, and the picture keeps ≥1s)
await page.fill('[data-testid="j-cut-lead-input"]', '99');
await page.press('[data-testid="j-cut-lead-input"]', 'Enter');
await sleep(500);
const g99 = await geom();
const clipFrames = gOff.vEnd - (g5.vEnd - g5.jCut.appliedLeadFrames === undefined ? 0 : 0); // full picture frames
const fullDur = gOff.vDur;
check('typing 99 clamps instead of eating the clip',
  g99.jCut.appliedLeadFrames <= Math.min(10 * ids.fps, fullDur - ids.fps) &&
  g99.vEnd - (g99.vEnd - g99.vDur) >= ids.fps &&
  g99.jCut.appliedLeadFrames > 0,
  `applied ${g99.jCut.appliedLeadFrames}f of full ${fullDur}f`);
check('clamped geometry stays consistent (audio/video end together)',
  g99.aEnd === g99.vEnd, `aEnd=${g99.aEnd} vEnd=${g99.vEnd}`);

// 7 ── sync invariant holds at every lead the panel produced
const cutFrame = await page.evaluate(({ v2 }) => window.__videoEditorStore.getState().tracks.find((t) => t.id === v2).startFrame, { v2: ids.v2 });
check('sync at the cut after panel edits',
  Math.abs((cutFrame - g99.aStart) / ids.fps - g99.vSrc) < 1e-6,
  `audio@cut=${((cutFrame - g99.aStart) / ids.fps).toFixed(3)}s vSrc=${g99.vSrc.toFixed(3)}s`);

// restore the baseline 3s for the audio/export tests
await page.fill('[data-testid="j-cut-lead-input"]', '3');
await page.press('[data-testid="j-cut-lead-input"]', 'Enter');
await sleep(400);
await select(null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
