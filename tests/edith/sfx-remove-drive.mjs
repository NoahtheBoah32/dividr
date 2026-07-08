// Verify a committed *sfx* marker can be taken back: the × button and a backspace
// right after the marker each remove BOTH the yellow marker and its placed clip.
import { chromium } from 'playwright-core';
const FPS = 30;
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

const WORDS = 'make sure to check out these photos everyone chose to show the world today'.split(' ');
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
await sleep(1200);

let spans = [];
for (let i = 0; i < 10; i++) { spans = await page.evaluate(() => Array.from(document.querySelectorAll('[data-wid]')).map((s) => s.getAttribute('data-wid'))); if (spans.length) break; await sleep(1000); }
if (!spans.length) { console.log('transcript not mounted'); process.exit(4); }
await sleep(3000); // self-load scan

const overlays = () => page.evaluate(() => window.__dividrTest.getStoreSnapshot().tracks.filter(t => t.type === 'audio' && (t.trackRowIndex ?? 0) >= 1).map(t => (t.source||'').split(/[\\/]/).pop()));
const markerWords = () => page.evaluate(() => { const t = window.__dividrTest.getStoreSnapshot().tracks.find(x => Array.isArray(x.sfxMarkers) && x.sfxMarkers.length); return t ? t.sfxMarkers.map(m => m.word) : []; });
async function typeAt(wid, text) {
  await page.evaluate((wid) => { const s = document.querySelector(`[data-wid="${wid}"]`); const r = document.createRange(); r.selectNodeContents(s); r.collapse(false); const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r); s.closest('[contenteditable]')?.focus(); }, wid);
  await sleep(80);
  await page.keyboard.type(text, { delay: 22 });
  await sleep(2200);
}
async function caretAtStartOf(wid) {
  await page.evaluate((wid) => {
    const s = document.querySelector(`[data-wid="${wid}"]`);
    const tn = s.firstChild; const r = document.createRange();
    r.setStart(tn, 0); r.collapse(true);
    const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
    s.closest('[contenteditable]')?.focus();
  }, wid);
  await sleep(120);
}

const results = [];
function check(name, cond) { results.push({ name, ok: cond }); console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}`); }

// --- 1. place, then remove via the × button ---------------------------------
await typeAt(spans[0], '*applause*');
check('applause placed (1 overlay)', (await overlays()).filter(x => x === 'applause_clap.mp3').length === 1);
check('applause marker recorded', (await markerWords()).includes('applause'));
const beforeX = (await overlays()).length;
await page.evaluate(() => { const btn = document.querySelector('[data-mk-sfx] button'); btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); });
await sleep(900);
check('× removed the clip', (await overlays()).length === beforeX - 1);
check('× removed the marker', !(await markerWords()).includes('applause'));

// --- 2. place, then remove via backspace right after the marker -------------
await typeAt(spans[2], '*whoosh*');
check('whoosh placed', (await overlays()).some(x => x === 'whoosh_transition.mp3'));
check('whoosh marker recorded', (await markerWords()).includes('whoosh'));
const beforeBk = (await overlays()).length;
// caret at the very start of the NEXT word (marker sits immediately to its left)
await caretAtStartOf(spans[3]);
await page.keyboard.press('Backspace');
await sleep(900);
check('backspace removed the clip', (await overlays()).length === beforeBk - 1);
check('backspace removed the marker', !(await markerWords()).includes('whoosh'));

// --- 3. regression: a normal backspace (no marker left of caret) still edits words
const wordCountBefore = spans.length;
await caretAtStartOf(spans[6]); // start of a plain word, previous is a plain word
await page.keyboard.press('Backspace');
await sleep(500);
// no crash, overlays unchanged (0), markers empty
check('normal backspace left overlays untouched', (await overlays()).length === 0);

const allOk = results.every(r => r.ok);
console.log(`\n=== ${results.filter(r=>r.ok).length}/${results.length} — ${allOk ? 'SFX REMOVAL WORKS' : 'FAIL'} ===`);
process.exit(allOk ? 0 : 3);
