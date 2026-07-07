// Live SFX placement proof — drives the REAL running DiviDr (CDP) to place EVERY
// library SFX on the timeline and verifies each lands as a green layer-1 audio clip
// at the exact frame. This exercises the real scanned SFX library + the real placeSFX
// op + the real timeline store.
//
// Prereq: app running via `DIVIDR_CDP=9222 npm start` (renderer on :5173).
// Run: node tests/edith/sfx-live-drive.mjs
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const FPS = 30;
const NAMES = [
  'airport_ding', 'applause_clap', 'bass_drop', 'bell', 'boom_impact', 'bubble_pop',
  'camera_shutter', 'cash_register', 'click', 'coins', 'correct_ding', 'crickets',
  'ding_notification', 'drum_roll', 'error_buzzer', 'explosion', 'footsteps', 'game_over',
  'glass_break', 'heartbeat', 'keyboard_typing', 'laugh_track', 'level_up_chime',
  'magic_transition', 'notification_pop', 'page_turn', 'pop', 'punch_whack',
  'record_scratch', 'rewind', 'riser', 'sad_trombone', 'slot_machine_win',
  'sparkle_twinkle', 'suspense_sting', 'swoosh_in', 'swoosh_out', 'typewriter',
  'vine_boom', 'whoosh_transition', 'wrong_answer_buzz',
].map((s) => `${s}.mp3`);
const GREEN = '#22c55e';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.connectOverCDP('http://localhost:9222');
let page = null;
for (const ctx of browser.contexts())
  for (const p of ctx.pages()) {
    const u = p.url();
    if (u.includes('localhost:5173') && !u.startsWith('blob:') && !u.startsWith('devtools:')) page = p;
  }
if (!page) { console.log('NO DiviDr renderer page on :5173'); process.exit(1); }

await page.addInitScript(() => {
  window.__dividrTestMode = true;
  try { for (const k of ['default', 'null', 'undefined']) localStorage.setItem(`edith-consent-${k}`, 'true'); } catch {}
});
page.on('dialog', (d) => d.accept().catch(() => {}));

await page.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded', timeout: 70000 });
await page.waitForFunction(() => typeof window.__dividrTest?.ping === 'function', { timeout: 40000 });
await page.evaluate(() => { window.location.hash = '#/video-editor'; });
await sleep(1500);

// Inject a base video clip + 30fps timeline so the SFX have a timeline to land on.
await page.evaluate((fps) => {
  window.__dividrTest.setStoreState({
    tracks: [{
      id: 'clip_v1', type: 'video', name: 'base.mp4', source: 'C:/base.mp4',
      startFrame: 0, endFrame: 1800, duration: 1800, sourceStartTime: 0,
      trackRowIndex: 0, layer: 0, mediaId: 'm_base', visible: true, muted: false, color: '#4A90D9',
    }],
    mediaLibrary: [{ id: 'm_base', name: 'base.mp4', type: 'video', source: 'C:/base.mp4', duration: 60 }],
    preview: { canvasWidth: 1280, canvasHeight: 720 },
    timeline: { currentFrame: 0, fps, totalFrames: 1800, selectedTrackIds: ['clip_v1'] },
  });
}, FPS);

// Open the EDITH (friday) panel so it scans the SFX library into the renderer cache.
try { await page.evaluate(() => window.__dividrTest.openPanel?.('friday')); } catch {}

// Wait until the SFX library is actually scanned — probe with one placeSFX and retry.
let libReady = false;
for (let i = 0; i < 20 && !libReady; i++) {
  await sleep(1500);
  const ok = await page.evaluate(async () => {
    try {
      const before = window.__dividrTest.getStoreSnapshot().tracks.length;
      window.__dividrTest.applyOps([{ type: 'placeSFX', file: 'whoosh_transition.mp3', atTime: 59, volume: -6, color: '#22c55e', trackName: '__probe__' }]);
      await new Promise((r) => setTimeout(r, 900));
      const s = window.__dividrTest.getStoreSnapshot();
      const placed = s.tracks.some((t) => t.name === '__probe__' || (t.type === 'audio' && t.source && t.source.includes('whoosh_transition')));
      return { placed, count: s.tracks.length, before };
    } catch (e) { return { err: String(e) }; }
  });
  if (ok.placed) libReady = true;
  console.log(`probe ${i + 1}: ${JSON.stringify(ok)}`);
}
if (!libReady) { console.log('SFX library never became ready (scan did not populate). Is SFX_LIBRARY_PATH set + FridayPanel mounted?'); process.exit(2); }

// Clean the probe + reset to just the base clip.
await page.evaluate(() => {
  const s = window.__dividrTest.getStoreSnapshot();
  const keep = s.tracks.filter((t) => t.id === 'clip_v1');
  window.__dividrTest.setStoreState({ tracks: keep });
});
await sleep(500);

// Place EVERY SFX at a distinct frame and verify.
const results = [];
for (let i = 0; i < NAMES.length; i++) {
  const file = NAMES[i];
  const stem = file.replace('.mp3', '');
  const atTime = 1 + i; // seconds → distinct frame per SFX
  const atFrame = Math.round(atTime * FPS);
  const r = await page.evaluate(async ({ file, stem, atTime, atFrame, GREEN }) => {
    const before = window.__dividrTest.getStoreSnapshot().tracks.map((t) => t.id);
    window.__dividrTest.applyOps([{ type: 'placeSFX', file, atTime, volume: -3, color: GREEN, trackName: stem }]);
    await (window.__dividrTest.waitForQueueDrained?.() ?? new Promise((r) => setTimeout(r, 600)));
    await new Promise((r) => setTimeout(r, 250));
    const s = window.__dividrTest.getStoreSnapshot();
    const added = s.tracks.filter((t) => !before.includes(t.id));
    const clip = added.find((t) => t.type === 'audio' && (t.trackRowIndex ?? 0) === 1);
    return {
      placed: !!clip,
      startFrame: clip?.startFrame ?? null,
      color: clip?.color ?? null,
      layer: clip?.trackRowIndex ?? null,
      srcOk: clip?.source ? clip.source.includes(stem) : false,
      addedCount: added.length,
      atFrame,
    };
  }, { file, stem, atTime, atFrame, GREEN });
  const pass = r.placed && r.startFrame === atFrame && r.color === GREEN && r.layer === 1 && r.srcOk;
  results.push({ n: i + 1, file, verdict: pass ? 'PASS' : 'FAIL', ...r });
  console.log(`[${pass ? 'PASS' : 'FAIL'}] #${i + 1} ${stem} → frame ${r.startFrame}/${atFrame} layer=${r.layer} green=${r.color === GREEN} src=${r.srcOk}`);
}

const pass = results.filter((r) => r.verdict === 'PASS').length;
fs.writeFileSync('C:/tmp/sfx-live-results.json', JSON.stringify(results, null, 2));
console.log(`\n=== ${pass}/${results.length} SFX placed on the REAL timeline at the exact frame, green ===`);
console.log('artifacts: C:/tmp/sfx-live-results.json');
process.exit(pass === results.length ? 0 : 3);
