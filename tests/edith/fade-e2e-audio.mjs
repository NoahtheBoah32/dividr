/**
 * Audio fade e2e — what you actually HEAR in the preview: the incoming clip's
 * volume ramps UP from ~0 instead of slamming in, and the outgoing clip eases
 * DOWN instead of stopping dead. Reads el.volume through __audioElsProbe while
 * playing (preview audio elements are off-DOM `new Audio()` — DOM queries find
 * nothing). Also proves the fades survive a full reload.
 *
 * Project-agnostic: resolves clips from the live store and matches audio
 * elements by previewUrl basename. Expects fade-e2e-panel.mjs to have left
 * fade-in 2s on the incoming audio and fade-out 2s on the outgoing audio.
 *
 * Volumes are normalised against the loudest sample in each window, so a
 * non-unity global preview volume can't skew the thresholds.
 * Run: node tests/edith/fade-e2e-audio.mjs ["Project Title"]
 */
import { chromium } from 'playwright-core';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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

// Reload: fresh modules AND the persistence proof (autosave round-trip).
await page.reload();
for (let i = 0; i < 30; i++) {
  const st = await page.evaluate(() => {
    const s = window.__videoEditorStore?.getState?.();
    return s ? { ready: (s.tracks || []).length > 0 } : { ready: false };
  }).catch(() => ({ ready: false }));
  if (st.ready) break;
  await page.evaluate(async (t) => {
    try { await window.__dividrTest.openProjectByTitle(t); } catch (e) {}
  }, TITLE).catch(() => {});
  await sleep(1000);
}

const base = (u) => decodeURIComponent(u || '').split(/[\\/]/).pop() || '';
const ctx = await page.evaluate(() => {
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
    fps: s.timeline?.fps ?? 30,
    a1: { id: a1.id, start: a1.startFrame, end: a1.endFrame, fo: a1.fadeOutDuration ?? 0, url: a1.previewUrl ?? '' },
    a2: { id: a2.id, start: a2.startFrame, end: a2.endFrame, fi: a2.fadeInDuration ?? 0, url: a2.previewUrl ?? '' },
  };
});
check('fades survived the full reload (autosave round-trip)',
  !!ctx && ctx.a2.fi === 2 && ctx.a1.fo === 2,
  ctx ? `incoming fadeIn=${ctx.a2.fi}s outgoing fadeOut=${ctx.a1.fo}s` : 'tracks missing');
if (!ctx) { console.log(`\n${pass} passed, ${fail} failed`); process.exit(1); }

const { fps } = ctx;
const A1_BASE = base(ctx.a1.url), A2_BASE = base(ctx.a2.url);

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
  return { frame: s.timeline?.currentFrame ?? -1, els: window.__audioElsProbe ? window.__audioElsProbe() : null };
});
const elFor = (p, wantBase) => p.els?.find((e) => {
  const k = decodeURIComponent(e.key || '').split(/[\\/]/).pop() || '';
  return k === wantBase;
});

/** Play from `fromFrame` to `toFrame`, sampling one audio element's volume. */
async function sampleWindow(fromFrame, toFrame, wantBase, maxSamples = 26) {
  await seek(fromFrame);
  await sleep(800);
  await play();
  const out = [];
  for (let i = 0; i < maxSamples; i++) {
    const p = await probe();
    const e = elFor(p, wantBase);
    if (e && e.paused === false) out.push({ frame: p.frame, vol: e.volume });
    if (p.frame > toFrame) break;
    await sleep(150);
  }
  await stop();
  return out;
}

// ── 1. INCOMING clip: audio must ease in, not slam ──
const inStart = ctx.a2.start;
const inEnd = inStart + Math.round((ctx.a2.fi + 0.8) * fps);
const rampIn = await sampleWindow(Math.max(0, inStart - Math.round(1.0 * fps)), inEnd, A2_BASE);
check('probe captured the fade-in ramp', rampIn.length >= 5, `${rampIn.length} samples of "${A2_BASE}"`);
if (rampIn.length >= 5) {
  const maxV = Math.max(...rampIn.map((s) => s.vol));
  const first = rampIn[0], last = rampIn[rampIn.length - 1];
  const early = rampIn.filter((s) => s.frame < inStart + Math.round(0.6 * fps));
  const late = rampIn.filter((s) => s.frame > inStart + Math.round(ctx.a2.fi * fps));
  check('incoming audio STARTS quiet (progressive entry, no slam)',
    early.length > 0 && early[0].vol < 0.4 * maxV,
    early.length ? `first vol=${early[0].vol.toFixed(3)} (max ${maxV.toFixed(3)}) @frame ${early[0].frame}` : 'no early sample');
  check('…and reaches full volume after the ramp',
    late.length > 0 && late[late.length - 1].vol > 0.85 * maxV,
    late.length ? `late vol=${late[late.length - 1].vol.toFixed(3)} of max ${maxV.toFixed(3)}` : 'no post-ramp sample');
  let rising = true;
  for (let i = 1; i < rampIn.length; i++) if (rampIn[i].vol < rampIn[i - 1].vol - 0.08 * maxV) rising = false;
  check('volume only ramps upward (no jumps back)', rising, rampIn.map((s) => s.vol.toFixed(2)).join(','));
  check('the ramp spans most of the range (not a step)',
    last.vol - first.vol > 0.5 * maxV, `${first.vol.toFixed(3)} → ${last.vol.toFixed(3)}`);
}

// ── 2. OUTGOING clip: audio must ease out before its end ──
const outEnd = ctx.a1.end;
const rampOut = await sampleWindow(outEnd - Math.round((ctx.a1.fo + 1.2) * fps), outEnd, A1_BASE);
check('probe captured the fade-out ramp', rampOut.length >= 5, `${rampOut.length} samples of "${A1_BASE}"`);
if (rampOut.length >= 5) {
  const maxV = Math.max(...rampOut.map((s) => s.vol));
  const preRamp = rampOut.filter((s) => s.frame < outEnd - Math.round(ctx.a1.fo * fps));
  const tail = rampOut.filter((s) => s.frame > outEnd - Math.round(0.7 * fps));
  check('outgoing audio is at full volume before the ramp',
    preRamp.length > 0 && preRamp[preRamp.length - 1].vol > 0.85 * maxV,
    preRamp.length ? `pre-ramp vol=${preRamp[preRamp.length - 1].vol.toFixed(3)}` : 'no pre-ramp sample');
  check('…then eases DOWN toward silence at the clip end',
    tail.length > 0 && tail[tail.length - 1].vol < 0.4 * maxV,
    tail.length ? `tail vol=${tail[tail.length - 1].vol.toFixed(3)} of max ${maxV.toFixed(3)}` : 'no tail sample');
}

// ── 3. Negative control: fades off → the same head plays at full volume ──
await page.evaluate(({ a2, a1 }) => {
  const st = window.__videoEditorStore.getState();
  st.updateTrack(a2, { fadeInDuration: 0 });
  st.updateTrack(a1, { fadeOutDuration: 0 });
}, { a2: ctx.a2.id, a1: ctx.a1.id });
await sleep(500);
// Start just INSIDE the clip so its element is the one under the playhead,
// then poll for the first audible moment — a fresh element buffers ~250ms
// before it plays, so asserting instantly would read a paused element.
await seek(inStart + 2);
await sleep(800);
await play();
const ctl = [];
for (let i = 0; i < 24; i++) {
  const p = await probe();
  const e = elFor(p, A2_BASE);
  if (e && e.paused === false) ctl.push({ frame: p.frame, vol: e.volume });
  if (p.frame > inStart + Math.round((ctx.a2.fi + 0.6) * fps)) break;
  await sleep(150);
}
await stop();
{
  const maxV = ctl.length ? Math.max(...ctl.map((s) => s.vol)) : 0;
  const first = ctl[0];
  check('control (fades off): incoming audio slams in at full volume again',
    !!first && first.vol > 0.85 * maxV && first.frame < inStart + Math.round(ctx.a2.fi * fps),
    first ? `first vol=${first.vol.toFixed(3)} of max ${maxV.toFixed(3)} @frame ${first.frame} (ramp would end at ${inStart + Math.round(ctx.a2.fi * fps)})` : `no audible control sample (${ctl.length})`);
}

// restore the crossfade Joaquin should hear
await page.evaluate(({ a2, a1 }) => {
  const st = window.__videoEditorStore.getState();
  st.updateTrack(a2, { fadeInDuration: 2 });
  st.updateTrack(a1, { fadeOutDuration: 2 });
}, { a2: ctx.a2.id, a1: ctx.a1.id });
await sleep(400);
await seek(0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
