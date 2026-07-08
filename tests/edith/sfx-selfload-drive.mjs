// Reproduce the user's bug + verify the fix: type *applause* in the transcript WITHOUT
// ever opening the EDITH panel (which used to be the only thing that scanned the SFX
// library). With the self-load fix, the marker must still commit and place the sound.
import { chromium } from 'playwright-core';
const FPS = 30, GREEN = '#22c55e';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const b = await chromium.connectOverCDP('http://localhost:9222');
let page = null;
for (const c of b.contexts()) for (const p of c.pages()) { const u = p.url(); if (u.includes('localhost:5173') && !u.startsWith('blob:') && !u.startsWith('devtools:')) page = p; }
if (!page) { console.log('no renderer'); process.exit(1); }
await page.addInitScript(() => { window.__dividrTestMode = true; try { for (const k of ['default','null','undefined']) localStorage.setItem(`edith-consent-${k}`,'true'); } catch {} });
await page.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded', timeout: 70000 });
await page.waitForFunction(() => typeof window.__dividrTest?.ping === 'function', { timeout: 40000 });
await page.evaluate(() => { window.location.hash = '#/video-editor'; });
await sleep(1500);

const WORDS = 'make sure to check out this photos NASA chose to show aliens video here'.split(' ');
await page.evaluate(({ words, fps }) => {
  const wobjs = words.map((w, i) => ({ word: w, start: i * 0.4, end: i * 0.4 + 0.35 }));
  const tf = Math.round(words.length * 0.4 * fps) + 30;
  window.__dividrTest.setStoreState({
    tracks: [
      { id: 'clip_v1', type: 'video', name: 'v.mp4', source: 'C:/v.mp4', startFrame: 0, endFrame: tf, duration: tf, sourceStartTime: 0, trackRowIndex: 0, layer: 0, mediaId: 'm', linkedTrackId: 'clip_a1', isLinked: true, visible: true, muted: false, color: '#4A90D9' },
      { id: 'clip_a1', type: 'audio', name: 'v (Audio)', source: 'C:/v.mp4', startFrame: 0, endFrame: tf, duration: tf, sourceStartTime: 0, trackRowIndex: 0, layer: 0, mediaId: 'm', linkedTrackId: 'clip_v1', isLinked: true, visible: true, muted: false, color: '#4A90D9' },
    ],
    mediaLibrary: [{ id: 'm', name: 'v.mp4', type: 'video', source: 'C:/v.mp4', duration: tf / fps,
      cachedKaraokeSubtitles: { transcriptionResult: { segments: [{ start: 0, end: words.length * 0.4, text: words.join(' '), words: wobjs }] } } }],
    preview: { canvasWidth: 1280, canvasHeight: 720 },
    timeline: { currentFrame: 0, fps, totalFrames: tf, selectedTrackIds: ['clip_a1'] },
  });
}, { words: WORDS, fps: FPS });
await sleep(1000);

// IMPORTANT: do NOT open the friday/EDITH panel. The transcript editor must load the
// SFX library itself. Wait for its mount-time ensureSfxLibrary() scan.
let spans = [];
for (let i = 0; i < 10; i++) { spans = await page.evaluate(() => Array.from(document.querySelectorAll('[data-wid]')).map((s) => s.getAttribute('data-wid'))); if (spans.length) break; await sleep(1000); }
if (!spans.length) { console.log('transcript not mounted'); process.exit(4); }
console.log(`transcript mounted (${spans.length} words), EDITH panel NOT opened`);
await sleep(3500); // give the self-load scan time

async function l1() { return page.evaluate(() => window.__dividrTest.getStoreSnapshot().tracks.filter(t => t.type === 'audio' && (t.trackRowIndex ?? 0) >= 1).map(t => ({ src: (t.source || '').split(/[\\/]/).pop(), color: t.color }))); }
async function markers() { return page.evaluate(() => { const t = window.__dividrTest.getStoreSnapshot().tracks.find(x => Array.isArray(x.sfxMarkers) && x.sfxMarkers.length); return t ? t.sfxMarkers.map(m => m.word) : []; }); }
async function typeAt(wid, text, baseline) {
  await page.evaluate((wid) => { const s = document.querySelector(`[data-wid="${wid}"]`); const r = document.createRange(); r.selectNodeContents(s); r.collapse(false); const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r); s.closest('[contenteditable]')?.focus(); }, wid);
  await sleep(80);
  await page.keyboard.type(text, { delay: 22 });
  // wait until the layer-1 count grows past the pre-type baseline (not just > 0 — an
  // earlier SFX may already occupy a row), so we snapshot after THIS placement lands.
  for (let i = 0; i < 14; i++) { await sleep(300); if ((await l1()).length > baseline) break; }
  await sleep(600);
}

const cases = [
  { word: 'applause', file: 'applause_clap.mp3' },
  { word: 'whoosh', file: 'whoosh_transition.mp3' },
  { word: 'boom', file: 'boom_impact.mp3' },
];
const results = [];
for (let i = 0; i < cases.length; i++) {
  const c = cases[i];
  const before = (await l1()).length;
  await typeAt(spans[i * 2 % spans.length], `*${c.word}*`, before);
  const after = await l1();
  const placed = after.some((x) => x.src === c.file && x.color === GREEN);
  const markerHas = (await markers()).includes(c.word);
  const pass = placed && markerHas;
  results.push({ word: c.word, verdict: pass ? 'PASS' : 'FAIL', placed, markerHas });
  console.log(`[${pass ? 'PASS' : 'FAIL'}] *${c.word}* → placed=${placed} yellowMarker=${markerHas} (l1 ${before}→${after.length})`);
}
// negative — should neither place nor mark
const negBaseline = (await l1()).length;
await typeAt(spans[1], '*divebomb*', 999);
const divebombMarker = (await markers()).includes('divebomb');
const negGrew = (await l1()).length > negBaseline;
if (negGrew) console.log('[FAIL] *divebomb* placed a clip (should not)');
console.log(`[${!divebombMarker ? 'PASS' : 'FAIL'}] *divebomb* → no marker (${!divebombMarker})`);

const allOk = results.every((r) => r.verdict === 'PASS') && !divebombMarker && !negGrew;
console.log(`\n=== ${results.filter(r=>r.verdict==='PASS').length}/${results.length} valid placed + negative ${!divebombMarker?'ok':'FAIL'} — ${allOk ? 'SELF-LOAD WORKS' : 'FAIL'} ===`);
process.exit(allOk ? 0 : 3);
