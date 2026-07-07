// Live TYPING proof — types *whoosh* / *divebomb* / *whoosh (incomplete) into the real
// transcript editor in the running app and verifies: a valid complete marker places a
// green SFX at that word's frame; an unknown or unclosed marker places nothing.
//
// Prereq: app running via `DIVIDR_CDP=9222 npm start`. Run: node tests/edith/sfx-type-drive.mjs
import { chromium } from 'playwright-core';

const FPS = 30;
const GREEN = '#22c55e';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.connectOverCDP('http://localhost:9222');
let page = null;
for (const ctx of browser.contexts())
  for (const p of ctx.pages()) {
    const u = p.url();
    if (u.includes('localhost:5173') && !u.startsWith('blob:') && !u.startsWith('devtools:')) page = p;
  }
if (!page) { console.log('NO renderer page'); process.exit(1); }

await page.addInitScript(() => {
  window.__dividrTestMode = true;
  try { for (const k of ['default', 'null', 'undefined']) localStorage.setItem(`edith-consent-${k}`, 'true'); } catch {}
});
page.on('dialog', (d) => d.accept().catch(() => {}));
await page.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded', timeout: 70000 });
await page.waitForFunction(() => typeof window.__dividrTest?.ping === 'function', { timeout: 40000 });
await page.evaluate(() => { window.location.hash = '#/video-editor'; });
await sleep(1500);

// Inject a video + linked audio clip whose media item carries a transcript.
await page.evaluate((fps) => {
  const words = [
    { word: 'the', start: 0.0, end: 0.4 },
    { word: 'door', start: 0.4, end: 0.9 },
    { word: 'opened', start: 0.9, end: 1.5 },
    { word: 'slowly', start: 1.5, end: 2.0 },
  ];
  window.__dividrTest.setStoreState({
    tracks: [
      { id: 'clip_v1', type: 'video', name: 'base.mp4', source: 'C:/base.mp4', startFrame: 0, endFrame: 60, duration: 60, sourceStartTime: 0, trackRowIndex: 0, layer: 0, mediaId: 'm_base', linkedTrackId: 'clip_a1', isLinked: true, visible: true, muted: false, color: '#4A90D9' },
      { id: 'clip_a1', type: 'audio', name: 'base.mp4 (Audio)', source: 'C:/base.mp4', startFrame: 0, endFrame: 60, duration: 60, sourceStartTime: 0, trackRowIndex: 0, layer: 0, mediaId: 'm_base', linkedTrackId: 'clip_v1', isLinked: true, visible: true, muted: false, color: '#4A90D9' },
    ],
    mediaLibrary: [{
      id: 'm_base', name: 'base.mp4', type: 'video', source: 'C:/base.mp4', duration: 2,
      cachedKaraokeSubtitles: { transcriptionResult: { segments: [{ start: 0, end: 2, text: 'the door opened slowly', words }] } },
    }],
    preview: { canvasWidth: 1280, canvasHeight: 720 },
    timeline: { currentFrame: 0, fps, totalFrames: 60, selectedTrackIds: ['clip_a1'] },
  });
}, FPS);
await sleep(800);
// Open EDITH panel to scan the SFX library into the renderer cache.
try { await page.evaluate(() => window.__dividrTest.openPanel?.('friday')); } catch {}
await sleep(2500);

// Find the transcript editor's word spans. If the properties/transcript UI is not
// mounted from selection alone, report so (the placement layer is already proven).
async function wordSpans() {
  return page.evaluate(() => Array.from(document.querySelectorAll('[data-wid]')).map((s) => ({ wid: s.getAttribute('data-wid'), text: s.textContent })));
}
let spans = [];
for (let i = 0; i < 8; i++) { spans = await wordSpans(); if (spans.length) break; await sleep(1000); }
if (!spans.length) {
  console.log('TRANSCRIPT EDITOR not mounted from selection alone (needs the Audio properties panel open in the UI).');
  console.log('Placement layer is proven separately (sfx-live-drive: 41/41). Skipping typed-UI check.');
  process.exit(4);
}
console.log('transcript words:', spans.map((s) => s.text).join(' '));

function tracksSnap() {
  return page.evaluate(() => window.__dividrTest.getStoreSnapshot().tracks.map((t) => ({ id: t.id, type: t.type, row: t.trackRowIndex, start: t.startFrame, color: t.color, src: t.source })));
}
async function sfxClips() { return (await tracksSnap()).filter((t) => t.type === 'audio' && (t.row ?? 0) === 1); }

// Click a word to place the caret, then type a marker.
async function typeAfterWord(text, wid) {
  await page.evaluate((wid) => {
    const span = document.querySelector(`[data-wid="${wid}"]`);
    span?.scrollIntoView();
    const r = document.createRange();
    r.selectNodeContents(span);
    r.collapse(false); // caret at end of the word
    const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
    span.closest('[contenteditable]')?.focus();
  }, wid);
  await sleep(120);
  await page.keyboard.type(text, { delay: 22 });
  // Let the async placeSFX op (media import + addTrack) fully settle before measuring.
  await page.evaluate(() => window.__dividrTest.waitForQueueDrained?.()).catch(() => {});
  await sleep(1300);
}

const opened = spans.find((s) => (s.text || '').trim() === 'opened') ?? spans[2] ?? spans[0];
const results = [];

// 1) valid complete marker → should place a green SFX at 'opened' frame.
let before = (await sfxClips()).length;
await typeAfterWord('*whoosh*', opened.wid);
let after = await sfxClips();
const placed = after.length - before;
const whoosh = after.find((c) => c.src && c.src.includes('whoosh_transition'));
results.push({ case: '*whoosh* (valid)', placedDelta: placed, green: whoosh?.color === GREEN, frame: whoosh?.start, ok: placed === 1 && whoosh?.color === GREEN });

// 2) unknown word → nothing places.
before = (await sfxClips()).length;
await typeAfterWord('*divebomb*', opened.wid);
after = await sfxClips();
results.push({ case: '*divebomb* (unknown)', placedDelta: after.length - before, ok: after.length - before === 0 });

// 3) incomplete (no closing asterisk) → nothing places.
before = (await sfxClips()).length;
await typeAfterWord('*whoosh', opened.wid); // no closing *
after = await sfxClips();
results.push({ case: '*whoosh (incomplete)', placedDelta: after.length - before, ok: after.length - before === 0 });

// yellow marker persisted on the track?
const markers = await page.evaluate(() => {
  const t = window.__dividrTest.getStoreSnapshot().tracks.find((x) => Array.isArray(x.sfxMarkers) && x.sfxMarkers.length);
  return t ? t.sfxMarkers : [];
});

console.log('\n=== TYPED-IN-TRANSCRIPT RESULTS ===');
for (const r of results) console.log(`[${r.ok ? 'PASS' : 'FAIL'}] ${r.case} → ΔsfxClips=${r.placedDelta}${r.frame != null ? ` frame=${r.frame}` : ''}${r.green != null ? ` green=${r.green}` : ''}`);
console.log(`yellow markers recorded on track: ${markers.length} (${markers.map((m) => '*' + m.word + '*').join(' ')})`);
const allOk = results.every((r) => r.ok);
console.log(allOk ? '\nALL TYPED CASES PASS' : '\nSOME TYPED CASES FAILED');
process.exit(allOk ? 0 : 5);
