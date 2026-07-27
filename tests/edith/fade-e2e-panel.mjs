/**
 * Audio fade panel e2e — the Clipchamp-style Fade section in the audio panel:
 * sliders + seconds boxes, clamping, the green dot, undo/redo, and the EDITH
 * fadeIn op redirecting from a video clip name to its linked audio track.
 *
 * Project-agnostic: resolves the two clips from whatever project is loaded
 * (falls back to opening one by title), so it survives Joaquin re-staging his
 * timeline. Leaves a crossfade applied: incoming audio fade-in 2s, outgoing
 * audio fade-out 2s — fade-e2e-audio.mjs then measures those ramps.
 * Run: node tests/edith/fade-e2e-panel.mjs ["Project Title"]
 */
import { chromium } from 'playwright-core';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SP = 'C:/Users/User/AppData/Local/Temp/claude/C--Users-User-Documents-AANG-V2/4b42243e-b537-438d-b50a-750efc6019b4/scratchpad';
const TITLE = process.argv[2] || 'J-cut DEMO';

let pass = 0, fail = 0;
const check = (n, ok, d = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  — ' + d : ''}`); ok ? pass++ : fail++; };

const b = await chromium.connectOverCDP('http://localhost:9222');
let page = null;
for (const c of b.contexts()) for (const p of c.pages()) {
  const u = p.url();
  if (u.includes('localhost:5173') && !u.startsWith('blob:')) page = p;
}
if (!page) { console.log('FAIL  no dev app page'); process.exit(1); }
page.setDefaultTimeout(25000);

// Fresh modules (new FrameResolver + audioProperties). After a reload the app
// lands on the picker and the project list hydrates late — retry the open
// INSIDE the ready poll.
await page.reload();
for (let i = 0; i < 30; i++) {
  const st = await page.evaluate(() => {
    const s = window.__videoEditorStore?.getState?.();
    return s ? { onEditor: location.hash.includes('video-editor'), ready: (s.tracks || []).length > 0 } : { onEditor: false, ready: false };
  }).catch(() => ({ onEditor: false, ready: false }));
  if (st.ready) break;
  await page.evaluate(async (t) => {
    try { await window.__dividrTest.openProjectByTitle(t); } catch (e) {}
  }, TITLE).catch(() => {});
  await sleep(1000);
}

// Resolve the two storyline clips + their linked audio from the live store.
const ids = await page.evaluate(() => {
  const s = window.__videoEditorStore.getState();
  const vids = s.tracks
    .filter((t) => t.type === 'video' && t.linkedTrackId)
    .sort((a, b) => a.startFrame - b.startFrame);
  if (vids.length < 2) return null;
  const v1 = vids[0], v2 = vids[vids.length - 1];
  const audio = (id) => s.tracks.find((t) => t.id === id);
  const a1 = audio(v1.linkedTrackId), a2 = audio(v2.linkedTrackId);
  if (!a1 || !a2) return null;
  return {
    v1: { id: v1.id, name: v1.name }, a1: a1.id,
    v2: { id: v2.id, name: v2.name }, a2: a2.id,
  };
});
if (!ids) { console.log('FAIL  need two video clips with linked audio — open a staged project'); process.exit(1); }
console.log(`      stage: "${ids.v1.name}" → "${ids.v2.name}"`);

const select = (id) => page.evaluate((tid) => {
  const st = window.__videoEditorStore.getState();
  for (const f of ['setSelectedTrackIds', 'selectTracks', 'setSelectedTracks'])
    if (typeof st[f] === 'function') { st[f](tid ? [tid] : []); break; }
}, id);
const fadeOf = (id) => page.evaluate((tid) => {
  const t = window.__videoEditorStore.getState().tracks.find((x) => x.id === tid);
  return { fi: t?.fadeInDuration ?? 0, fo: t?.fadeOutDuration ?? 0 };
}, id);

// 1 ── the Fade section renders on an audio clip, both controls present
await select(ids.a2);
await sleep(800);
const dom = await page.evaluate(() => ({
  section: !!document.querySelector('[data-testid="audio-fade-section"]'),
  inSlider: !!document.querySelector('[data-testid="fade-in-slider"]'),
  outSlider: !!document.querySelector('[data-testid="fade-out-slider"]'),
  inInput: document.querySelector('[data-testid="fade-in-input"]')?.value ?? null,
  outInput: document.querySelector('[data-testid="fade-out-input"]')?.value ?? null,
}));
check('Fade section + both sliders + both boxes render', dom.section && dom.inSlider && dom.outSlider, JSON.stringify(dom));

// 2 ── type 2 in fade-in → store updated, green dot appears
await page.fill('[data-testid="fade-in-input"]', '2');
await page.press('[data-testid="fade-in-input"]', 'Enter');
await sleep(500);
let f = await fadeOf(ids.a2);
check('typing 2 sets fadeInDuration=2 on the audio track', f.fi === 2, `fi=${f.fi}`);
const dot = await page.evaluate(() => !!document.querySelector('[data-testid="audio-fade-section"] .bg-green-500'));
check('green dot appears once a fade is set', dot);

// 3 ── absurd 99 clamps to the 5s max
await page.fill('[data-testid="fade-in-input"]', '99');
await page.press('[data-testid="fade-in-input"]', 'Enter');
await sleep(500);
f = await fadeOf(ids.a2);
const shownAfterClamp = await page.evaluate(() => document.querySelector('[data-testid="fade-in-input"]')?.value);
check('typing 99 clamps to 5s (store + box agree)', f.fi === 5 && shownAfterClamp === '5.0', `fi=${f.fi} box=${shownAfterClamp}`);

// 4 ── garbage input resolves to 0 (off)
await page.fill('[data-testid="fade-in-input"]', 'abc');
await page.press('[data-testid="fade-in-input"]', 'Enter');
await sleep(500);
f = await fadeOf(ids.a2);
check('garbage input turns the fade off (0)', f.fi === 0, `fi=${f.fi}`);

// 5 ── EDITH op naming the VIDEO clip lands the fade on its LINKED AUDIO track
await page.evaluate(async ({ name }) => {
  await window.__dividrTest.applyOps([{ type: 'fadeIn', clipName: name, duration: 2 }]);
  await window.__dividrTest.waitForQueueDrained();
}, { name: ids.v2.name });
await sleep(500);
f = await fadeOf(ids.a2);
const onVideo = await fadeOf(ids.v2.id);
check('EDITH fadeIn on the video clip redirects to the linked audio', f.fi === 2, `audio fi=${f.fi}`);
check('…and does NOT sit uselessly on the video track', onVideo.fi === 0, `video fi=${onVideo.fi}`);

// 6 ── fade-out 2s on the outgoing clip's audio via its panel
await select(ids.a1);
await sleep(700);
await page.fill('[data-testid="fade-out-input"]', '2');
await page.press('[data-testid="fade-out-input"]', 'Enter');
await sleep(500);
const f1 = await fadeOf(ids.a1);
check('outgoing audio fade-out set to 2s', f1.fo === 2, `fo=${f1.fo}`);

// 7 ── undo/redo: the input commit is one history entry
await page.evaluate(() => window.__videoEditorStore.getState().undo());
await sleep(400);
const afterUndo = await fadeOf(ids.a1);
await page.evaluate(() => window.__videoEditorStore.getState().redo());
await sleep(400);
const afterRedo = await fadeOf(ids.a1);
check('undo removes the fade, redo restores it (single entry)',
  afterUndo.fo === 0 && afterRedo.fo === 2, `undo fo=${afterUndo.fo} redo fo=${afterRedo.fo}`);

await select(ids.a2);
await sleep(700);
await page.screenshot({ path: `${SP}/fade-panel-shot.png` });
await select(null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
