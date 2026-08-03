// Stabilization + filler-word e2e against the REAL running DiviDr (CDP 9222).
//
// Stabilization (5 tests, measured):
//   S1  ask real EDITH "Stabilize my video" → analysis runs, track.stabilization lands
//   S2  toggle off/on through the op path — both must be near-instant (cached offsets)
//   S3  live counter-motion: __stabApplied advances every frame while PLAYING, stops when off
//   S4  the manual Switch exists in the Video panel and physically flips the state
//   S5  offsets sidecar written by the app is valid JSON with per-frame offsets (export
//       pre-pass input) — measured shake numbers come from the bake step run after this suite
//
// Filler words (3 tests):
//   F1  transcribe the TTS clip in-app → transcript contains um/uh tokens
//   F2  removeFillers op → timeline shortens, status reports the count
//   F3  ask real EDITH "remove all the filler words" → she emits removeFillers
import { chromium } from 'playwright-core';

const STAB_CLIP = 'C:\\Users\\User\\Downloads\\Unstable video - sagar pandey (360p).mp4';
const STAB_FPS = 25, STAB_FRAMES = 246;
const FILLER_CLIP = 'C:\\tmp\\stab-test\\filler_speech.mp4';
const FILLER_FPS = 30, FILLER_FRAMES = 238;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  ok ? pass++ : fail++;
};

const browser = await chromium.connectOverCDP('http://localhost:9222');
let page = null;
for (const ctx of browser.contexts()) for (const p of ctx.pages()) if (/localhost:5173/.test(p.url())) page = p;
if (!page) { console.log('NO renderer page'); process.exit(1); }
await page.addInitScript(() => {
  window.__dividrTestMode = true;
  try { for (const k of ['default', 'null', 'undefined']) localStorage.setItem(`edith-consent-${k}`, 'true'); } catch {}
});
page.on('dialog', (d) => { d.accept().catch(() => {}); });

async function gotoEditor() {
  await page.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded', timeout: 70000 });
  await page.waitForFunction(() => typeof window.__dividrTest?.ping === 'function', { timeout: 40000 });
  await page.evaluate(() => { window.location.hash = '#/video-editor'; });
  await sleep(1400);
}
async function openEdith() {
  if (await page.locator('textarea[placeholder*="EDITH"]').count() === 0) {
    try { await page.locator('[title="E.D.I.T.H"]').first().click({ timeout: 5000 }); } catch {}
    await sleep(600);
  }
  const agree = page.locator('button:has-text("Agree")');
  try { if (await agree.count() > 0) await agree.first().click({ timeout: 3000 }); } catch {}
  const ta = page.locator('textarea[placeholder*="EDITH"]').first();
  await ta.waitFor({ state: 'visible', timeout: 12000 });
  return ta;
}
async function injectClip(p, fps, frames, extraMedia = {}) {
  const pv = await page.evaluate(async (fp) => {
    try { const r = await window.electronAPI.createPreviewUrl(fp); return (r && r.url) ? r.url : (typeof r === 'string' ? r : ''); }
    catch { return ''; }
  }, p);
  await page.evaluate(({ p, pv, fps, frames, extraMedia }) => {
    const name = p.split(/[\\/]/).pop();
    window.__dividrTest.setStoreState({
      tracks: [{
        id: 'clip_s1', type: 'video', name, source: p, previewUrl: pv,
        startFrame: 0, endFrame: frames, duration: frames, sourceStartTime: 0,
        trackRowIndex: 0, mediaId: 'm1', visible: true, locked: false, muted: false, color: '#4A90D9',
      }],
      mediaLibrary: [{ id: 'm1', name, type: 'video', source: p, previewUrl: pv, duration: frames / fps, ...extraMedia }],
      preview: { canvasWidth: 1280, canvasHeight: 720 },
      timeline: { currentFrame: 8, fps, selectedTrackIds: ['clip_s1'] },
    });
  }, { p, pv, fps, frames, extraMedia });
}
async function capReset() {
  await page.evaluate(() => {
    window.__cap = { messages: [], ops: [], status: [], done: false };
    if (!window.__capHooked) {
      window.electronAPI.on('mycelium:message', (_e, d) => { if (d) window.__cap.messages.push(d); });
      window.electronAPI.on('mycelium:op', (_e, o) => { window.__cap.ops.push(typeof o === 'string' ? o : JSON.stringify(o)); });
      window.electronAPI.on('mycelium:done', () => { window.__cap.done = true; });
      window.addEventListener('edith:status', (e) => window.__cap?.status.push(e.detail?.text || ''));
      window.__capHooked = true;
    }
  });
}
const trackState = () => page.evaluate(() => {
  const s = window.__dividrTest.getStoreSnapshot();
  const t = (s.tracks ?? []).find((x) => x.trackRowIndex === 0 && x.type === 'video') ?? {};
  return {
    stab: t.stabilization ?? null,
    startFrame: t.startFrame, endFrame: t.endFrame,
    tracksN: (s.tracks ?? []).length,
    videoFrames: (s.tracks ?? []).filter((x) => x.type === 'video' && (x.trackRowIndex ?? 0) === 0)
      .reduce((a, x) => a + (x.endFrame - x.startFrame), 0),
  };
});
const applyOps = (ops) => page.evaluate(async (o) => {
  await window.__dividrTest.applyOps(o);
  await window.__dividrTest.waitForQueueDrained?.();
}, ops);
async function ensurePlaying() {
  await page.evaluate(async () => {
    const store = window.__videoEditorStore;
    const st = store.getState();
    const clips = st.tracks.filter((t) => t.visible !== false);
    const start = Math.min(...clips.map((t) => t.startFrame));
    st.setCurrentFrame(start + 5);
    await new Promise((r) => setTimeout(r, 500));
    if (!store.getState().playback.isPlaying) store.getState().play();
  });
  await sleep(800);
}

// ── setup ──
let ta;
for (let attempt = 0; ; attempt++) {
  try { await gotoEditor(); ta = await openEdith(); break; }
  catch (e) {
    if (attempt >= 6) throw e;
    console.log(`setup retry ${attempt + 1}: ${String(e).slice(0, 70)}`);
    await sleep(3500);
  }
}

// ════ S1: real EDITH chat → stabilization on ════
await injectClip(STAB_CLIP, STAB_FPS, STAB_FRAMES);
await capReset();
const t0 = Date.now();
await ta.fill('Stabilize my video');
await ta.press('Enter');
let s1 = null, opMs = null, effectMs = null;
while (Date.now() - t0 < 90000) {
  const st = await trackState();
  const cap = await page.evaluate(() => ({ ops: window.__cap.ops.length, status: window.__cap.status.join(' | ') }));
  if (opMs === null && cap.ops > 0) opMs = Date.now() - t0;
  if (st.stab?.enabled && st.stab?.offsetsPath) { s1 = { st, cap }; effectMs = Date.now() - t0; break; }
  await sleep(400);
}
check('S1 EDITH "Stabilize my video" → stabilization enabled', !!s1,
  s1 ? `op in ${opMs}ms, applied in ${effectMs}ms, offsets=${s1.st.stab.offsetsPath.split(/[\\/]/).pop()}` : 'timed out');
check('S1 analysis reported measured shake numbers',
  !!s1 && s1.st.stab.shakeBefore > 0 && s1.st.stab.shakeAfter < s1.st.stab.shakeBefore,
  s1 ? `before=${s1.st.stab.shakeBefore}px/f after=${s1.st.stab.shakeAfter}px/f (${Math.round((1 - s1.st.stab.shakeAfter / s1.st.stab.shakeBefore) * 100)}% steadier)` : '');
const offsetsPath = s1?.st.stab.offsetsPath ?? null;

// ════ S2: instant off / instant on — the DIRECT store path the manual Switch uses ════
const s2 = await page.evaluate(async () => {
  const store = window.__videoEditorStore;
  const trackOf = () => store.getState().tracks.find((x) => x.trackRowIndex === 0 && x.type === 'video');
  const n0 = window.__cap.status.length;
  const flip = (enabled) => {
    const t = trackOf();
    const t0 = performance.now();
    store.getState().updateTrack(t.id, { stabilization: { ...(t.stabilization ?? {}), enabled } });
    window.dispatchEvent(new CustomEvent('dividr:forceRender'));
    const ms = performance.now() - t0;
    return { ms: Math.round(ms * 100) / 100, enabled: trackOf().stabilization?.enabled };
  };
  const off = flip(false);
  const on = flip(true);
  const reMeasured = window.__cap.status.slice(n0).some((s) => /Measuring camera/i.test(s));
  return { off, on, reMeasured };
});
check('S2 toggle OFF instant', s2.off.enabled === false && s2.off.ms < 100, `${s2.off.ms}ms store-applied`);
check('S2 toggle ON instant from cache (no re-analysis)', s2.on.enabled === true && s2.on.ms < 100 && !s2.reMeasured,
  `${s2.on.ms}ms store-applied, re-analyzed=${s2.reMeasured}`);

// ════ S3: live counter-motion while playing ════
await ensurePlaying();
const samples = await page.evaluate(async () => {
  const out = [];
  for (let i = 0; i < 12; i++) {
    out.push(window.__stabApplied ? { dx: window.__stabApplied.dx, dy: window.__stabApplied.dy, at: window.__stabApplied.at } : null);
    await new Promise((r) => setTimeout(r, 130));
  }
  return out;
});
const live = samples.filter(Boolean);
const distinct = new Set(live.map((s) => `${s.dx.toFixed(1)},${s.dy.toFixed(1)}`)).size;
const advancing = live.length >= 2 && live[live.length - 1].at > live[0].at;
check('S3 counter-offsets applied EVERY frame while playing', live.length >= 8 && distinct >= 4 && advancing,
  `${live.length}/12 samples, ${distinct} distinct offsets, span ${(live.length ? (live[live.length - 1].at - live[0].at) : 0).toFixed(0)}ms`);
await ensurePlaying(); // the short clip may have run out during sampling — restart from the head
const s3b = await page.evaluate(async () => {
  // The manual toggle's direct path: flip mid-playback, no queue, no choreography.
  const zzz = (ms) => new Promise((r) => setTimeout(r, ms));
  const store = window.__videoEditorStore;
  const t = store.getState().tracks.find((x) => x.trackRowIndex === 0 && x.type === 'video');
  store.getState().updateTrack(t.id, { stabilization: { ...(t.stabilization ?? {}), enabled: false } });
  window.dispatchEvent(new CustomEvent('dividr:forceRender'));
  await zzz(350);
  const frozenAt = window.__stabApplied?.at ?? 0;
  await zzz(700);
  return {
    playing: store.getState().playback.isPlaying,
    frozen: (window.__stabApplied?.at ?? 0) === frozenAt,
  };
});
check('S3 toggle OFF stops compensation instantly (video still playing)', s3b.playing && s3b.frozen,
  `playing=${s3b.playing}, __stabApplied frozen for 700ms=${s3b.frozen}`);
await page.evaluate(() => window.__videoEditorStore.getState().pause?.());

// ════ S4: manual Switch in the Video panel ════
await page.evaluate(() => window.__dividrTest.setStoreState({ timeline: { selectedTrackIds: ['clip_s1'] } }));
await sleep(800);
const stabLabel = page.locator('label:has-text("Stabilization")').first();
let uiOk = false, uiDetail = '';
try {
  await stabLabel.waitFor({ state: 'visible', timeout: 8000 });
  // The Switch is the justify-between row's other child — anchor on the row that
  // CONTAINS the Stabilization label, then take its switch.
  const sw = page
    .locator('div.justify-between:has(label:text-is("Stabilization")) button[role="switch"]')
    .first();
  await sw.waitFor({ state: 'visible', timeout: 5000 });
  await sw.scrollIntoViewIfNeeded();
  const before = (await trackState()).stab?.enabled ?? false;
  await sw.click();
  await sleep(250); // direct store write — no queue to drain
  const mid = (await trackState()).stab?.enabled ?? false;
  await sw.click();
  await sleep(250);
  const after = (await trackState()).stab?.enabled ?? false;
  uiOk = mid === !before && after === before;
  uiDetail = `switch flipped ${before} → ${mid} → ${after} (direct store path)`;
} catch (e) { uiDetail = String(e).slice(0, 160); }
check('S4 Video-panel Stabilization toggle exists and flips state', uiOk, uiDetail);

// ════ S5: offsets sidecar valid (export pre-pass input) ════
const sidecar = await page.evaluate(async (p) => {
  const r = await window.electronAPI.invoke('media:stabilizeLoadOffsets', { offsetsPath: p });
  return r?.success ? { n: r.offsets.length, fps: r.fps, sample: r.offsets[100] } : null;
}, offsetsPath);
check('S5 offsets sidecar on disk, one offset per frame', !!sidecar && sidecar.n === STAB_FRAMES,
  sidecar ? `${sidecar.n} offsets @ ${sidecar.fps}fps, f100=[${sidecar.sample}]` : 'load failed');
if (offsetsPath) console.log(`OFFSETS_PATH=${offsetsPath}`);

// leave stabilization ON for the manual look
await applyOps([{ type: 'setStabilization', enabled: true }]);

// ════ F1: transcribe the TTS clip, fillers present ════
await injectClip(FILLER_CLIP, FILLER_FPS, FILLER_FRAMES);
await capReset();
await applyOps([{ type: 'runWhisper', clipId: 'clip_s1', streamCaptions: false }]);
let words = null;
const tw = Date.now();
while (Date.now() - tw < 180000) {
  words = await page.evaluate(() => {
    const s = window.__dividrTest.getStoreSnapshot();
    const m = (s.mediaLibrary ?? []).find((x) => x.id === 'm1');
    const segs = m?.cachedKaraokeSubtitles?.transcriptionResult?.segments;
    if (!segs?.length) return null;
    return segs.flatMap((seg) => (seg.words ?? []).map((w) => ({ w: w.word.trim(), s: w.start, e: w.end })));
  });
  if (words?.length) break;
  await sleep(1500);
}
const fillerRe = /^(u+h*m+|u+h+|e+r+m*|a+h+|h+m+)$/i;
const fillers = (words ?? []).filter((x) => fillerRe.test(x.w.toLowerCase().replace(/[^a-z]/g, '')));
check('F1 in-app transcription done, filler tokens present', !!words?.length && fillers.length >= 2,
  words ? `${words.length} words, ${fillers.length} fillers: ${fillers.map((f) => f.w).join(' ')}` : 'no transcript');
const cachedTranscription = await page.evaluate(() => {
  const s = window.__dividrTest.getStoreSnapshot();
  return (s.mediaLibrary ?? []).find((x) => x.id === 'm1')?.cachedKaraokeSubtitles ?? null;
});

// ════ F2: removeFillers op ════
const beforeF = await trackState();
await applyOps([{ type: 'removeFillers' }]);
await sleep(600);
const afterF = await trackState();
const statusF = await page.evaluate(() => window.__cap.status.join(' | '));
const fillerDur = fillers.reduce((a, f) => a + (f.e - f.s), 0);
const removedFrames = beforeF.videoFrames - afterF.videoFrames;
check('F2 removeFillers cut the filler frames from the timeline',
  removedFrames > 0 && /Removed \d+ filler/i.test(statusF),
  `timeline ${beforeF.videoFrames}f → ${afterF.videoFrames}f (−${removedFrames}f ≈ ${(removedFrames / FILLER_FPS).toFixed(2)}s; fillers total ${fillerDur.toFixed(2)}s) | ${statusF.match(/Removed \d+ filler[^|]*/i)?.[0] ?? ''}`);

// ════ F3: real EDITH chat → removeFillers ════
await injectClip(FILLER_CLIP, FILLER_FPS, FILLER_FRAMES, { cachedKaraokeSubtitles: cachedTranscription });
await capReset();
if (await page.locator('textarea[placeholder*="EDITH"]').count() === 0) ta = await openEdith();
const tF3 = Date.now();
await ta.fill('remove all the filler words from my video');
await ta.press('Enter');
let f3 = null;
while (Date.now() - tF3 < 60000) {
  const cap = await page.evaluate(() => ({ ops: window.__cap.ops, status: window.__cap.status.join(' | ') }));
  const emitted = cap.ops.some((o) => /removeFillers/.test(o));
  if (emitted && /Removed \d+ filler|No filler words/i.test(cap.status)) { f3 = { cap, ms: Date.now() - tF3 }; break; }
  await sleep(500);
}
const afterF3 = await trackState();
check('F3 EDITH "remove all the filler words" → removeFillers ran', !!f3 && afterF3.videoFrames < FILLER_FRAMES,
  f3 ? `in ${f3.ms}ms, timeline ${FILLER_FRAMES}f → ${afterF3.videoFrames}f | ${f3.cap.status.match(/Removed \d+ filler[^|]*/i)?.[0] ?? ''}` : 'timed out');

console.log(`\n${pass}/${pass + fail} PASS`);
process.exit(fail === 0 ? 0 : 1);
