/**
 * J-cut audio e2e — the point of the whole feature: during the overlap you
 * HEAR the incoming clip while still SEEING the previous one, and after the
 * cut the picture joins its own audio in sync. Reads what is actually audible
 * through the __audioElsProbe hook (the preview's audio elements never touch
 * the DOM). Also proves the J-cut survives a full reload (project autosave).
 * Expects the 3s J-cut applied (jcut-e2e-flow/panel leave it that way).
 * Run: node tests/edith/jcut-e2e-audio.mjs
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

// Reload for fresh modules (probe hook) AND to prove the J-cut persists.
await page.reload();
for (let i = 0; i < 30; i++) {
  const st = await page.evaluate(() => {
    const s = window.__videoEditorStore?.getState?.();
    return s ? {
      onEditor: location.hash.includes('video-editor'),
      ready: (s.tracks || []).length > 0,
    } : { onEditor: false, ready: false };
  }).catch(() => ({ onEditor: false, ready: false }));
  if (st.ready) break;
  if (!st.onEditor) {
    await page.evaluate(async () => {
      try { await window.__dividrTest.openProjectByTitle('Untitled Project'); } catch (e) {}
    });
  }
  await sleep(1000);
}

const ctx = await page.evaluate(() => {
  const s = window.__videoEditorStore.getState();
  const vids = s.tracks.filter((t) => t.type === 'video').sort((a, b) => a.startFrame - b.startFrame);
  const v2 = vids.find((t) => t.jCut?.enabled);
  if (!v2) return null;
  const v1 = vids.find((t) => t.id !== v2.id);
  const a2 = s.tracks.find((t) => t.id === v2.linkedTrackId);
  const a1 = v1 ? s.tracks.find((t) => t.id === v1.linkedTrackId) : null;
  return {
    fps: s.timeline?.fps ?? 30,
    cut: v2.startFrame,
    lead: v2.jCut.appliedLeadFrames,
    v2: { id: v2.id, src: v2.sourceStartTime ?? 0, end: v2.endFrame },
    a2: { id: a2.id, start: a2.startFrame, srcStart: a2.sourceStartTime ?? 0, url: a2.previewUrl ?? null },
    a1: a1 ? { id: a1.id, start: a1.startFrame, end: a1.endFrame } : null,
  };
});
check('J-cut survived the full reload (autosave round-trip)', !!ctx && ctx.lead > 0,
  ctx ? `lead ${ctx.lead}f, audio starts ${ctx.cut - ctx.a2.start}f before the cut` : 'no J-cut clip found');
if (!ctx) { console.log(`\n${pass} passed, ${fail + 1} failed`); process.exit(1); }

const { fps } = ctx;
const seek = (f) => page.evaluate((fr) => {
  const st = window.__videoEditorStore.getState();
  for (const fn of ['setCurrentFrame', 'seekToFrame', 'setPlayheadFrame'])
    if (typeof st[fn] === 'function') { st[fn](fr); break; }
  window.dispatchEvent(new CustomEvent('dividr:forceRender'));
}, f);
const play = () => page.evaluate(() => {
  const st = window.__videoEditorStore.getState();
  for (const fn of ['togglePlayback', 'setIsPlaying', 'play'])
    if (typeof st[fn] === 'function') { fn === 'setIsPlaying' ? st[fn](true) : st[fn](); break; }
});
const stop = () => page.evaluate(() => {
  const st = window.__videoEditorStore.getState();
  if (st.playback?.isPlaying) {
    for (const fn of ['togglePlayback', 'setIsPlaying', 'pause'])
      if (typeof st[fn] === 'function') { fn === 'setIsPlaying' ? st[fn](false) : st[fn](); break; }
  }
});
const probe = () => page.evaluate(() => {
  const s = window.__videoEditorStore.getState();
  return {
    frame: s.timeline?.currentFrame ?? -1,
    els: window.__audioElsProbe ? window.__audioElsProbe() : null,
  };
});
// Frame-driven audio elements are keyed by sourceId (decoded file path) — the
// extracted wav filenames identify each clip's audio unambiguously.
const elOf = (p, re) => p.els?.find((e) => re.test(decodeURIComponent(e.key || '')));
const A2_RE = /Koenigsegg[^/\\]*extracted/i;
const A1_RE = /1st[^/\\]*Clip[^/\\]*extracted/i;

// ── 1. BEFORE the lead window: incoming audio must be silent ──
await seek(Math.max(0, ctx.a2.start - Math.round(2.5 * fps)));
await sleep(700);
await play();
await sleep(1200);
let p1 = await probe();
await stop();
const a2el = (p) => elOf(p, A2_RE);
check('audio probe hook is live', Array.isArray(p1.els), p1.els ? `${p1.els.length} elements` : 'null');
{
  const e = a2el(p1);
  check('before the lead: incoming clip audio silent', !e || e.paused === true,
    e ? `paused=${e.paused} t=${e.currentTime.toFixed(2)}` : 'not created yet (fine)');
}

// ── 2. IN the overlap: you HEAR clip 2 while SEEING clip 1 ──
// Start a little before the lead window so the element (created lazily the
// moment the lead begins) has real playback time inside the overlap. Poll for
// the moment it becomes audible — a fresh element buffers briefly (readyState
// gate) the very first time, then plays.
const midOverlap = ctx.a2.start + Math.round(ctx.lead * 0.4);
await seek(midOverlap);
await sleep(700);
await play();
const t0 = Date.now();
let p2 = null;
for (let i = 0; i < 20; i++) {
  const p = await probe();
  const e = a2el(p);
  if (e && e.paused === false) { p2 = p; break; }
  if (p.frame >= ctx.cut - 2) break; // ran out of overlap
  await sleep(250);
}
const latencyMs = Date.now() - t0;
const p2final = p2 ?? await probe();
const shot2 = `${SP}/jcut-overlap-picture.png`;
await stop();
{
  const e = a2el(p2final);
  const expected = ctx.a2.srcStart + (p2final.frame - ctx.a2.start) / fps;
  check('overlap: incoming clip audio is PLAYING before its picture exists',
    !!e && e.paused === false && e.muted === false && e.volume > 0,
    e ? `paused=${e.paused} muted=${e.muted} vol=${e.volume}, audible after ${latencyMs}ms` : 'a2 element missing');
  check('overlap: it plays the RIGHT part (the head of clip 2)',
    !!e && Math.abs(e.currentTime - expected) < 0.6,
    e ? `t=${e.currentTime.toFixed(2)}s expected≈${expected.toFixed(2)}s (frame ${p2final.frame})` : '');
  const o1 = ctx.a1 && elOf(p2final, A1_RE);
  check('overlap: previous clip audio still playing underneath (the mix)',
    !ctx.a1 || (!!o1 && o1.paused === false),
    o1 ? `a1 paused=${o1.paused} t=${o1.currentTime.toFixed(2)}` : 'a1 element missing');
  check('overlap: playhead is still before the picture cut', p2final.frame < ctx.cut,
    `frame ${p2final.frame} < cut ${ctx.cut}`);
}
// paused picture proof for visual QA — still the PREVIOUS clip on screen
await seek(midOverlap);
await sleep(1100);
await page.screenshot({ path: shot2 });

// ── 3. AFTER the cut: picture joins in sync with its own audio ──
const afterCut = ctx.cut + Math.round(1.0 * fps);
await seek(afterCut);
await sleep(700);
await play();
await sleep(1400);
const p3 = await probe();
await stop();
{
  const e = a2el(p3);
  const audioSrcTime = e ? e.currentTime : NaN;
  const videoSrcTime = ctx.v2.src + (p3.frame - ctx.cut) / fps;
  check('after the cut: incoming audio still the one playing',
    !!e && e.paused === false, e ? `paused=${e.paused}` : 'missing');
  // Tolerance covers the store-frame read lagging the audio clock by up to a
  // couple of draw intervals — the geometry itself is frame-exact (unit suite).
  check('after the cut: PICTURE source time == AUDIO source time (sync)',
    !!e && Math.abs(audioSrcTime - videoSrcTime) < 0.75,
    `audio@${audioSrcTime.toFixed(2)}s vs picture@${videoSrcTime.toFixed(2)}s (frame ${p3.frame})`);
}
await seek(afterCut);
await sleep(1100);
await page.screenshot({ path: `${SP}/jcut-aftercut-picture.png` });

// ── 4. Negative control: J-cut off → no leak in the old overlap window ──
await page.evaluate(async () => {
  await window.__dividrTest.applyOps([{ type: 'jCut', enabled: false }]);
  await window.__dividrTest.waitForQueueDrained();
});
await sleep(500);
await seek(midOverlap);
await sleep(600);
await play();
await sleep(1200);
const p4 = await probe();
await stop();
{
  const e = a2el(p4);
  check('control (J-cut off): no incoming audio in that window anymore',
    !e || e.paused === true, e ? `paused=${e.paused}` : 'element gone');
}
// restore the baseline 3s J-cut
await page.evaluate(async () => {
  await window.__dividrTest.applyOps([{ type: 'jCut', seconds: 3 }]);
  await window.__dividrTest.waitForQueueDrained();
});
await sleep(400);
await seek(0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
