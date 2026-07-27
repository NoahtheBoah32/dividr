/**
 * J-cut e2e flow — on the user's real project (metro clip + Jesko clip from
 * the media library): places the two clips if the timeline is empty, applies
 * EDITH's jCut op through the real op queue, and proves the timeline surgery,
 * sync invariant, single-entry undo/redo, retime, revert, and that the lead
 * survives moving the clip. Run: node tests/edith/jcut-e2e-flow.mjs
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
if (!page) { console.log('FAIL  no dev app page'); process.exit(1); }

// Fresh modules (HMR socket dies in long-lived windows)
await page.reload();
for (let i = 0; i < 30; i++) {
  const ok = await page.evaluate(() => !!window.__videoEditorStore && !!window.__dividrTest).catch(() => false);
  if (ok) break;
  await sleep(1000);
}
// Reload may land on the project picker — keep retrying the reopen until the
// media library hydrates (the project list itself needs a moment after reload,
// so a single early openProjectByTitle can silently find nothing).
for (let i = 0; i < 30; i++) {
  const st = await page.evaluate(() => {
    const s = window.__videoEditorStore.getState();
    return {
      onEditor: location.hash.includes('video-editor'),
      ready: (s.mediaLibrary || []).length > 0 || (s.tracks || []).length > 0,
    };
  }).catch(() => ({ onEditor: false, ready: false }));
  if (st.ready) break;
  if (!st.onEditor) {
    await page.evaluate(async () => {
      try { await window.__dividrTest.openProjectByTitle('Untitled Project'); } catch (e) { /* list not ready yet */ }
    });
  }
  await sleep(1000);
}

// ── Place the user's two clips if the timeline is empty ──
const setup = await page.evaluate(async () => {
  const st = () => window.__videoEditorStore.getState();
  let s = st();
  const lib = (s.mediaLibrary || []).filter((m) => m.type === 'video');
  if (lib.length < 2) return { error: `need 2 library videos, found ${lib.length}` };
  // Deterministic stage: wipe whatever a previous run left, then place the
  // clips at explicit butted positions (placing both at 0 would OVERWRITE —
  // the timeline contract crushes whatever is underneath).
  for (const t of [...st().tracks].filter((t) => t.type === 'video')) st().removeTrack(t.id);
  for (const t of [...st().tracks]) st().removeTrack(t.id);
  // First clip = the metro one ("1st Clip..."), second = the Jesko
  const first = lib.find((m) => /1st|metro/i.test(m.name)) ?? lib[0];
  const second = lib.find((m) => m.id !== first.id && /jesko|koenig/i.test(m.name)) ?? lib.find((m) => m.id !== first.id);
  const v1id = await st().addTrackFromMediaLibrary(first.id, 0, 0, true);
  const v1t = st().tracks.find((t) => t.id === v1id);
  await st().addTrackFromMediaLibrary(second.id, v1t.endFrame, 0, true);
  s = st();
  const vids = s.tracks.filter((t) => t.type === 'video').sort((a, b) => a.startFrame - b.startFrame);
  const grab = (t) => t && {
    id: t.id, name: t.name, startFrame: t.startFrame, endFrame: t.endFrame,
    duration: t.duration, sourceStartTime: t.sourceStartTime ?? 0,
    row: t.trackRowIndex ?? 0, linkedTrackId: t.linkedTrackId ?? null,
  };
  const audioOf = (v) => grab(s.tracks.find((t) => t.id === v?.linkedTrackId && t.type === 'audio'));
  return {
    fps: s.timeline?.fps ?? 30,
    v1: grab(vids[0]), a1: audioOf(vids[0]),
    v2: grab(vids[1]), a2: audioOf(vids[1]),
    undoLen: (s.undoStack || []).length,
  };
});
if (setup.error) { console.log('FAIL  setup: ' + setup.error); process.exit(1); }
const { fps } = setup;
check('setup: two clips butted with linked audio pairs',
  !!setup.v1 && !!setup.v2 && !!setup.a2 && setup.v2.startFrame === setup.v1.endFrame,
  `v1 [${setup.v1?.startFrame},${setup.v1?.endFrame}] "${setup.v1?.name}" | v2 [${setup.v2?.startFrame},${setup.v2?.endFrame}] "${setup.v2?.name}" | a2 ${setup.a2 ? 'linked' : 'MISSING'}`);
if (!setup.a2) { console.log('FAIL  clip 2 has no linked audio — cannot J-cut'); process.exit(1); }

const before = setup;
const LEAD = Math.round(3 * fps);

// ── EDITH applies the J-cut through the real op queue ──
await page.evaluate(async () => {
  await window.__dividrTest.applyOps([{ type: 'jCut' }]);
  await window.__dividrTest.waitForQueueDrained();
});
await sleep(600);

const after = await page.evaluate(({ v2id, a2id, v1id, a1id }) => {
  const s = window.__videoEditorStore.getState();
  const grab = (id) => {
    const t = s.tracks.find((x) => x.id === id);
    return t && {
      startFrame: t.startFrame, endFrame: t.endFrame, duration: t.duration,
      sourceStartTime: t.sourceStartTime ?? 0, row: t.trackRowIndex ?? 0,
      jCut: t.jCut ?? null,
    };
  };
  return { v1: grab(v1id), a1: a1id ? grab(a1id) : null, v2: grab(v2id), a2: grab(a2id), undoLen: (s.undoStack || []).length };
}, { v2id: before.v2.id, a2id: before.a2.id, v1id: before.v1.id, a1id: before.a1?.id ?? null });

check('audio slides 3s left over clip 1',
  after.a2.startFrame === before.a2.startFrame - LEAD && after.a2.endFrame === before.a2.endFrame - LEAD,
  `a2 [${after.a2.startFrame},${after.a2.endFrame}] (was [${before.a2.startFrame},${before.a2.endFrame}])`);
check('video keeps its cut, joins 3s in, ends 3s early',
  after.v2.startFrame === before.v2.startFrame &&
  Math.abs(after.v2.sourceStartTime - (before.v2.sourceStartTime + 3)) < 1e-6 &&
  after.v2.endFrame === before.v2.endFrame - LEAD &&
  after.v2.duration === before.v2.duration - LEAD,
  `v2 start=${after.v2.startFrame} src=${after.v2.sourceStartTime} end=${after.v2.endFrame} dur=${after.v2.duration}`);
check('sync at the cut: audio source time == video in-point',
  Math.abs((before.v2.startFrame - after.a2.startFrame) / fps - after.v2.sourceStartTime) < 1e-6);
check('clip 1 pair untouched',
  after.v1.startFrame === before.v1.startFrame && after.v1.endFrame === before.v1.endFrame &&
  (!before.a1 || (after.a1.startFrame === before.a1.startFrame && after.a1.endFrame === before.a1.endFrame)));
check('audio parked on its own lane while leading',
  !before.a1 || after.a2.row !== before.a1.row,
  `a2 row ${after.a2.row}${before.a1 ? ` vs a1 row ${before.a1.row}` : ''}`);
check('jCut state + panel unlock flag on the clip',
  !!after.v2.jCut && after.v2.jCut.enabled === true && after.v2.jCut.appliedLeadFrames === LEAD && after.v2.jCut.appliedByEdith === true,
  JSON.stringify(after.v2.jCut));
check('whole surgery is ONE undo entry', after.undoLen === before.undoLen + 1,
  `undo stack ${before.undoLen} → ${after.undoLen}`);

// ── one undo reverts EVERYTHING, redo brings it back ──
await page.evaluate(() => window.__videoEditorStore.getState().undo());
await sleep(400);
const undone = await page.evaluate(({ v2id, a2id }) => {
  const s = window.__videoEditorStore.getState();
  const v2 = s.tracks.find((x) => x.id === v2id), a2 = s.tracks.find((x) => x.id === a2id);
  return { v2: { src: v2.sourceStartTime ?? 0, end: v2.endFrame, jCut: v2.jCut ?? null }, a2: { start: a2.startFrame, row: a2.trackRowIndex ?? 0 } };
}, { v2id: before.v2.id, a2id: before.a2.id });
check('single undo restores picture, audio, lane',
  Math.abs(undone.v2.src - before.v2.sourceStartTime) < 1e-6 && undone.v2.end === before.v2.endFrame &&
  undone.a2.start === before.a2.startFrame && undone.a2.row === before.a2.row,
  `v2 src=${undone.v2.src} end=${undone.v2.end}, a2 start=${undone.a2.start} row=${undone.a2.row}`);
await page.evaluate(() => window.__videoEditorStore.getState().redo());
await sleep(400);
const redone = await page.evaluate(({ v2id, a2id }) => {
  const s = window.__videoEditorStore.getState();
  const v2 = s.tracks.find((x) => x.id === v2id), a2 = s.tracks.find((x) => x.id === a2id);
  return { src: v2.sourceStartTime ?? 0, end: v2.endFrame, aStart: a2.startFrame };
}, { v2id: before.v2.id, a2id: before.a2.id });
check('redo re-applies the J-cut',
  Math.abs(redone.src - (before.v2.sourceStartTime + 3)) < 1e-6 && redone.aStart === before.a2.startFrame - LEAD);

// ── retime via EDITH: 3s → 5s ──
await page.evaluate(async () => {
  await window.__dividrTest.applyOps([{ type: 'jCut', seconds: 5 }]);
  await window.__dividrTest.waitForQueueDrained();
});
await sleep(400);
const retimed = await page.evaluate(({ v2id, a2id }) => {
  const s = window.__videoEditorStore.getState();
  const v2 = s.tracks.find((x) => x.id === v2id), a2 = s.tracks.find((x) => x.id === a2id);
  return { src: v2.sourceStartTime ?? 0, end: v2.endFrame, lead: v2.jCut?.appliedLeadFrames, aStart: a2.startFrame };
}, { v2id: before.v2.id, a2id: before.a2.id });
const LEAD5 = Math.round(5 * fps);
check('EDITH retime to 5s lands exactly',
  retimed.lead === LEAD5 && retimed.aStart === before.a2.startFrame - LEAD5 &&
  Math.abs(retimed.src - (before.v2.sourceStartTime + 5)) < 1e-6 && retimed.end === before.v2.endFrame - LEAD5,
  `lead=${retimed.lead}f aStart=${retimed.aStart} src=${retimed.src}`);

// ── the lead survives moving the clip (linked pair moves by shared delta) ──
await page.evaluate(({ v2id }) => {
  const st = window.__videoEditorStore.getState();
  const v2 = st.tracks.find((x) => x.id === v2id);
  st.moveTrack(v2id, v2.startFrame + 120);
}, { v2id: before.v2.id });
await sleep(300);
const moved = await page.evaluate(({ v2id, a2id }) => {
  const s = window.__videoEditorStore.getState();
  const v2 = s.tracks.find((x) => x.id === v2id), a2 = s.tracks.find((x) => x.id === a2id);
  return { vStart: v2.startFrame, aStart: a2.startFrame };
}, { v2id: before.v2.id, a2id: before.a2.id });
check('moving the clip keeps the audio lead intact',
  moved.vStart - moved.aStart === LEAD5,
  `video ${moved.vStart}, audio ${moved.aStart}, gap ${moved.vStart - moved.aStart}f (want ${LEAD5})`);
await page.evaluate(({ v2id }) => {
  const st = window.__videoEditorStore.getState();
  const v2 = st.tracks.find((x) => x.id === v2id);
  st.moveTrack(v2id, v2.startFrame - 120);
}, { v2id: before.v2.id });
await sleep(300);

// ── EDITH turns it off → everything home ──
await page.evaluate(async () => {
  await window.__dividrTest.applyOps([{ type: 'jCut', enabled: false }]);
  await window.__dividrTest.waitForQueueDrained();
});
await sleep(400);
const off = await page.evaluate(({ v2id, a2id }) => {
  const s = window.__videoEditorStore.getState();
  const v2 = s.tracks.find((x) => x.id === v2id), a2 = s.tracks.find((x) => x.id === a2id);
  return { src: v2.sourceStartTime ?? 0, end: v2.endFrame, dur: v2.duration, jCut: v2.jCut ?? null, aStart: a2.startFrame, aRow: a2.trackRowIndex ?? 0 };
}, { v2id: before.v2.id, a2id: before.a2.id });
check('EDITH off: geometry fully restored, unlock flag kept',
  Math.abs(off.src - before.v2.sourceStartTime) < 1e-6 && off.end === before.v2.endFrame &&
  off.aStart === before.a2.startFrame && off.aRow === before.a2.row &&
  off.jCut && off.jCut.enabled === false && off.jCut.appliedLeadFrames === 0 && off.jCut.appliedByEdith === true,
  `src=${off.src} end=${off.end} aStart=${off.aStart} jCut=${JSON.stringify(off.jCut)}`);

// Leave the baseline 3s J-cut applied for the panel/audio/export tests
await page.evaluate(async () => {
  await window.__dividrTest.applyOps([{ type: 'jCut', seconds: 3 }]);
  await window.__dividrTest.waitForQueueDrained();
});
await sleep(300);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
