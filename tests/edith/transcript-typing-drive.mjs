// Live TYPING driver — types into the REAL transcript box in the running app and
// verifies both features end to end:
//   1. EVERY one of the 41 SFX, typed as *stem* inline → a green layer-1 clip appears.
//   2. 20 quotation cases, typed as "phrase" inline → the matching scene is duplicated
//      (a new green layer-0 video clip), everything ripples forward. Plus negatives:
//      an open quote and a non-matching quote place nothing.
//
// Prereq: app running via `DIVIDR_CDP=9222 npm start`. Run: node tests/edith/transcript-typing-drive.mjs
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const FPS = 30;
const GREEN = '#22c55e';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TEXT =
  "Imagine if the Earth and Moon were only one and a half inches away from each other. " +
  "In reality it's over a quarter of a million miles. " +
  "But that's the scale we used in order to visualize the 10 billion miles that Voyager 2 has traveled. " +
  "This month marks 40 years that the spacecraft has been traveling on its mission to reach " +
  "the giant planets of our solar system and maybe just maybe deliver this golden record " +
  "containing sounds and images of human life to any extraterrestrials it might encounter. " +
  "Since long ago it's been traveling through space at the rate of nearly fast speeds. " +
  "NASA even has a live tracker on their website that tells you just exactly how far it's gone. " +
  "But the distance is hard to wrap your head around.";
const WORDS = TEXT.trim().split(/\s+/);

const SFX = [
  'airport_ding','applause_clap','bass_drop','bell','boom_impact','bubble_pop','camera_shutter',
  'cash_register','click','coins','correct_ding','crickets','ding_notification','drum_roll',
  'error_buzzer','explosion','footsteps','game_over','glass_break','heartbeat','keyboard_typing',
  'laugh_track','level_up_chime','magic_transition','notification_pop','page_turn','pop','punch_whack',
  'record_scratch','rewind','riser','sad_trombone','slot_machine_win','sparkle_twinkle','suspense_sting',
  'swoosh_in','swoosh_out','typewriter','vine_boom','whoosh_transition','wrong_answer_buzz',
];

const QUOTES = [
  'the Earth and Moon','one and a half inches','a quarter of a million miles','the scale we used',
  'the 10 billion miles','Voyager 2 has traveled','This month marks 40 years','the spacecraft has been traveling',
  'on its mission to reach','the giant planets of our solar system','deliver this golden record',
  'containing sounds and images','of human life','to any extraterrestrials it might encounter',
  "it's been traveling through space",'at the rate of nearly','a live tracker on their website',
  'how far it\'s gone','hard to wrap your head around','the giant planets',
];

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
  try { for (const k of ['default','null','undefined']) localStorage.setItem(`edith-consent-${k}`, 'true'); } catch {}
});
page.on('dialog', (d) => d.accept().catch(() => {}));
await page.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded', timeout: 70000 });
await page.waitForFunction(() => typeof window.__dividrTest?.ping === 'function', { timeout: 40000 });
await page.evaluate(() => { window.location.hash = '#/video-editor'; });
await sleep(1500);

const totalFrames = Math.round(WORDS.length * 0.4 * FPS) + 30;
await page.evaluate(({ words, fps, totalFrames }) => {
  const wobjs = words.map((w, i) => ({ word: w, start: i * 0.4, end: i * 0.4 + 0.35 }));
  window.__dividrTest.setStoreState({
    tracks: [
      { id: 'clip_v1', type: 'video', name: 'voyager.mp4', source: 'C:/voyager.mp4', startFrame: 0, endFrame: totalFrames, duration: totalFrames, sourceStartTime: 0, trackRowIndex: 0, layer: 0, mediaId: 'm_v', linkedTrackId: 'clip_a1', isLinked: true, visible: true, muted: false, color: '#4A90D9' },
      { id: 'clip_a1', type: 'audio', name: 'voyager (Audio)', source: 'C:/voyager.mp4', startFrame: 0, endFrame: totalFrames, duration: totalFrames, sourceStartTime: 0, trackRowIndex: 0, layer: 0, mediaId: 'm_v', linkedTrackId: 'clip_v1', isLinked: true, visible: true, muted: false, color: '#4A90D9' },
    ],
    mediaLibrary: [{ id: 'm_v', name: 'voyager.mp4', type: 'video', source: 'C:/voyager.mp4', duration: totalFrames / fps,
      cachedKaraokeSubtitles: { transcriptionResult: { segments: [{ start: 0, end: words.length * 0.4, text: words.join(' '), words: wobjs }] } } }],
    preview: { canvasWidth: 1280, canvasHeight: 720 },
    timeline: { currentFrame: 0, fps, totalFrames, selectedTrackIds: ['clip_a1'] },
  });
}, { words: WORDS, fps: FPS, totalFrames });
await sleep(900);
try { await page.evaluate(() => window.__dividrTest.openPanel?.('friday')); } catch {}
await sleep(2500);

// The transcript editor must be mounted (word spans present).
let spans = [];
for (let i = 0; i < 10; i++) {
  spans = await page.evaluate(() => Array.from(document.querySelectorAll('[data-wid]')).map((s) => ({ wid: s.getAttribute('data-wid'), text: (s.textContent || '').trim() })));
  if (spans.length) break;
  await sleep(1000);
}
if (!spans.length) { console.log('TRANSCRIPT EDITOR not mounted — cannot type. (Audio panel must show the transcript.)'); process.exit(4); }
console.log(`transcript mounted: ${spans.length} word spans`);

// Wait for SFX library to be scanned (probe once).
let libReady = false;
for (let i = 0; i < 16 && !libReady; i++) {
  await sleep(1500);
  libReady = await page.evaluate(async () => {
    try {
      window.__dividrTest.applyOps([{ type: 'placeSFX', file: 'whoosh_transition.mp3', atTime: 9, volume: -9, color: '#22c55e', trackName: '__probe__' }]);
      await new Promise((r) => setTimeout(r, 800));
      const s = window.__dividrTest.getStoreSnapshot();
      const ok = s.tracks.some((t) => t.name === '__probe__');
      if (ok) window.__dividrTest.setStoreState({ tracks: s.tracks.filter((t) => t.name !== '__probe__') });
      return ok;
    } catch { return false; }
  });
}
if (!libReady) { console.log('SFX library not ready'); process.exit(2); }

function snap() {
  return page.evaluate(() => {
    const t = window.__dividrTest.getStoreSnapshot().tracks;
    return {
      l1audio: t.filter((x) => x.type === 'audio' && (x.trackRowIndex ?? 0) === 1).map((x) => ({ src: (x.source || '').split(/[\\/]/).pop(), color: x.color })),
      l0video: t.filter((x) => x.type === 'video' && (x.trackRowIndex ?? 0) === 0).map((x) => ({ start: x.startFrame, end: x.endFrame, color: x.color, ss: x.sourceStartTime })),
    };
  });
}
async function caretAtWordEnd(wid) {
  await page.evaluate((wid) => {
    const span = document.querySelector(`[data-wid="${wid}"]`);
    if (!span) return;
    span.scrollIntoView({ block: 'center' });
    const r = document.createRange(); r.selectNodeContents(span); r.collapse(false);
    const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
    span.closest('[contenteditable]')?.focus();
  }, wid);
  await sleep(60);
}
async function typeAt(wid, text) {
  await caretAtWordEnd(wid);
  await page.keyboard.type(text, { delay: 18 });
  // Cap the drain wait — quotations call pullPhrase directly (no op is enqueued),
  // so the queueDrained event never fires for them; we rely on polling afterwards.
  await Promise.race([
    page.evaluate(() => window.__dividrTest.waitForQueueDrained?.()).catch(() => {}),
    sleep(1400),
  ]);
  await sleep(400);
}
async function resetToBase() {
  await page.evaluate(({ totalFrames, fps }) => {
    window.__dividrTest.setStoreState({
      tracks: [
        { id: 'clip_v1', type: 'video', name: 'voyager.mp4', source: 'C:/voyager.mp4', startFrame: 0, endFrame: totalFrames, duration: totalFrames, sourceStartTime: 0, trackRowIndex: 0, layer: 0, mediaId: 'm_v', linkedTrackId: 'clip_a1', isLinked: true, visible: true, muted: false, color: '#4A90D9' },
        { id: 'clip_a1', type: 'audio', name: 'voyager (Audio)', source: 'C:/voyager.mp4', startFrame: 0, endFrame: totalFrames, duration: totalFrames, sourceStartTime: 0, trackRowIndex: 0, layer: 0, mediaId: 'm_v', linkedTrackId: 'clip_v1', isLinked: true, visible: true, muted: false, color: '#4A90D9' },
      ],
      timeline: { currentFrame: 0, fps, totalFrames, selectedTrackIds: ['clip_a1'] },
    });
  }, { totalFrames, fps: FPS });
  await sleep(350);
}
async function pollGreenL1(stem, tries = 10) {
  for (let i = 0; i < tries; i++) { const s = await snap(); if (s.l1audio.some((c) => c.src === `${stem}.mp3` && c.color === GREEN)) return true; await sleep(300); }
  return false;
}
async function pollGreenL0(tries = 12) {
  for (let i = 0; i < tries; i++) { const s = await snap(); if (s.l0video.some((c) => c.color === GREEN)) return true; await sleep(300); }
  return false;
}

// ── PHASE 1: every SFX typed as *stem* → a green layer-1 clip ───────────────
const sfxResults = [];
if (!process.argv.includes('quotes-only')) {
  await resetToBase();
  for (let i = 0; i < SFX.length; i++) {
    const stem = SFX[i];
    const wid = spans[(i * 5) % spans.length].wid;
    await typeAt(wid, `*${stem}*`);
    const pass = await pollGreenL1(stem);
    sfxResults.push({ stem, verdict: pass ? 'PASS' : 'FAIL' });
    console.log(`[SFX ${pass ? 'PASS' : 'FAIL'}] *${stem}*`);
  }
}

// ── PHASE 2: 20 quotations (reset each) → a green layer-0 duplicated scene ──
const quoteResults = [];
for (let i = 0; i < QUOTES.length; i++) {
  const phrase = QUOTES[i];
  await resetToBase();
  const wid = spans[Math.min(spans.length - 1, 12 + i * 3)].wid;
  await typeAt(wid, `"${phrase}"`);
  const pass = await pollGreenL0();
  quoteResults.push({ phrase, verdict: pass ? 'PASS' : 'FAIL' });
  console.log(`[QUOTE ${pass ? 'PASS' : 'FAIL'}] "${phrase}"`);
}

// negatives — nothing may be placed
await resetToBase();
await typeAt(spans[5].wid, '"the giant planets'); // open quote, never closed
const negOpen = !(await pollGreenL0(4));
await page.keyboard.press('Escape'); // clear the dangling open-quote buffer before the next case
await sleep(200);
await resetToBase();
await typeAt(spans[5].wid, '"purple monkey dishwasher"'); // complete but not in the transcript
const negNomatch = !(await pollGreenL0(4));
console.log(`[NEG open-quote ${negOpen ? 'PASS' : 'FAIL'}] unfinished quote placed nothing`);
console.log(`[NEG no-match ${negNomatch ? 'PASS' : 'FAIL'}] unknown quote placed nothing`);

const sfxPass = sfxResults.filter((r) => r.verdict === 'PASS').length;
const qPass = quoteResults.filter((r) => r.verdict === 'PASS').length;
fs.writeFileSync('C:/tmp/transcript-typing-results.json', JSON.stringify({ sfxResults, quoteResults, negOpen, negNomatch }, null, 2));
console.log(`\n=== SFX ${sfxPass}/${SFX.length} · QUOTES ${qPass}/${QUOTES.length} · negatives ${(negOpen ? 1 : 0) + (negNomatch ? 1 : 0)}/2 ===`);
const quotesOnly = process.argv.includes('quotes-only');
const allOk = (quotesOnly || sfxPass === SFX.length) && qPass === QUOTES.length && negOpen && negNomatch;
process.exit(allOk ? 0 : 3);
