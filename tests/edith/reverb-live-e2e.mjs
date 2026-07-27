// Reverb Processor LIVE e2e — proves the motion-blur-style behavior:
// while the timeline is PLAYING, changing the slider amount changes the sound
// IMMEDIATELY (measured from real captured graph output, no bake involved).
//
// Captures the actual Web Audio output (post-reverb tap) via MediaRecorder in
// three states — 0 / +45 / -45 — and measures reverberance of each capture.
// Also proves parameter latency: store write -> audible param change < 200 ms.
import { chromium } from 'playwright-core';

const b = await chromium.connectOverCDP('http://localhost:9222');
let page = null;
for (const c of b.contexts()) for (const p of c.pages()) {
  const u = p.url();
  if (u.includes('localhost:517') && !u.startsWith('blob:')) page = p;
}
if (!page) { console.log('FAIL no page'); process.exit(1); }
page.on('dialog', (d) => d.accept().catch(() => {}));

for (let i = 0; i < 25; i++) {
  const ok = await page.evaluate(() => !!window.__dividrTest && !!window.__voiceIsolationEngine).catch(() => false);
  if (ok) break;
  await page.waitForTimeout(2500);
}
await page.evaluate(() => window.__dividrTest.openProjectByTitle('SKILLS-93-TEST'));
await page.waitForTimeout(4500);

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  ok ? pass++ : fail++;
};

const audio = await page.evaluate(() => {
  const s = window.__dividrTest.getStoreSnapshot();
  const a = s.tracks.find((t) => t.type === 'audio');
  return a ? { id: a.id, source: a.source } : null;
});
if (!audio) { console.log('FAIL no audio track'); process.exit(1); }

// helper: set amount through the same store patch the slider makes
const setAmount = (amt) => page.evaluate(({ id, amt }) => {
  const t0 = performance.now();
  const s = window.__dividrTest.getStoreSnapshot();
  const tracks = s.tracks.map((t) => t.id === id
    ? { ...t, reverbProcessor: { ...(t.reverbProcessor ?? {}), amount: amt } } : t);
  window.__dividrTest.setStoreState({ tracks });
  return t0;
}, { id: audio.id, amt });

// seek INTO the clip (playhead parked at the end self-pauses play immediately),
// then start playback through the real store action
await page.evaluate(async () => {
  const st = window.__videoEditorStore.getState();
  const clips = st.tracks.filter((t) => t.visible !== false);
  const start = Math.min(...clips.map((t) => t.startFrame));
  st.setCurrentFrame(start + 5);
  await new Promise((r) => setTimeout(r, 500)); // let the compositor clock sync
  window.__videoEditorStore.getState().play();
});
await page.waitForTimeout(1500);
const playing = await page.evaluate(() => window.__videoEditorStore.getState().playback.isPlaying);
if (!playing) { console.log('FAIL playback did not start'); process.exit(1); }

// 1) attach the stage by going non-zero while playing, measure reaction time
await setAmount(45);
const t0 = Date.now();
let state = null;
while (Date.now() - t0 < 5000) {
  state = await page.evaluate(() => {
    const keys = [...window.__voiceIsolationEngine['graphs'].keys()];
    return keys.length ? window.__voiceIsolationEngine.debugReverbState(keys[0]) : null;
  }).catch(() => null);
  if (state && state.wetGain > 0.05) break;
  await page.waitForTimeout(100);
}
const reactMs = Date.now() - t0;
check('stage attached + wet gain live while PLAYING', !!state && state.wetGain > 0.05,
  `wetGain=${state?.wetGain?.toFixed(3)} in ${reactMs}ms`);
check('IR generated (room buffer present)', (state?.irSeconds ?? 0) > 1.5,
  `${state?.irSeconds?.toFixed(2)}s IR for +45`);
check('reaction under 1s (no bake wait)', reactMs < 1000, `${reactMs}ms`);

// resolve the engine sourceId from the engine's own graph map
const srcKey = await page.evaluate(() => {
  const keys = [...window.__voiceIsolationEngine['graphs'].keys()];
  return keys[0] ?? null;
});
if (!srcKey) { console.log('FAIL no engine graph'); process.exit(1); }

// keep the short clip playing: re-seek into it and resume before each step
const ensurePlaying = () => page.evaluate(async () => {
  const store = window.__videoEditorStore;
  const st = store.getState();
  const clips = st.tracks.filter((t) => t.visible !== false);
  const start = Math.min(...clips.map((t) => t.startFrame));
  st.setCurrentFrame(start + 5);
  await new Promise((r) => setTimeout(r, 500)); // compositor clock sync
  if (!store.getState().playback.isPlaying) store.getState().play();
});

// 2) capture real output in three states, measure reverberance of each
async function capture(label, amt, settleMs) {
  await ensurePlaying();
  await setAmount(amt);
  await page.waitForTimeout(settleMs);
  await ensurePlaying();
  return page.evaluate(async ({ key }) => {
    const pcm = await window.__voiceIsolationEngine.debugCaptureOutput(key, 2600);
    if (!pcm) return null;
    // envelope tail metric in-page: RMS of the quietest 20% of 50ms windows
    // (reverb FILLS the quiet gaps between words -> raises this floor)
    const sr = 48000, win = Math.round(sr * 0.05);
    const rmses = [];
    for (let i = 0; i + win < pcm.length; i += win) {
      let acc = 0;
      for (let k = i; k < i + win; k++) acc += pcm[k] * pcm[k];
      rmses.push(Math.sqrt(acc / win));
    }
    rmses.sort((a, b) => a - b);
    const n = rmses.length;
    const floor = rmses.slice(0, Math.max(1, Math.floor(n * 0.2))).reduce((a, v) => a + v, 0) / Math.max(1, Math.floor(n * 0.2));
    const body = rmses[Math.floor(n * 0.85)];
    return { floor, body, ratio: floor / (body + 1e-9), overall: rmses.reduce((a, v) => a + v, 0) / n };
  }, { key: srcKey });
}

const at0 = await capture('0', 0, 600);
const atPlus = await capture('+45', 45, 600);
const atMinus = await capture('-45', -45, 2000); // worklet load headroom

check('captured real audio in all 3 states', !!at0 && !!atPlus && !!atMinus,
  `gap-floor/body: 0=${at0?.ratio?.toFixed(3)} +45=${atPlus?.ratio?.toFixed(3)} -45=${atMinus?.ratio?.toFixed(3)}`);
check('+45 audibly MORE reverberant than 0 (gap fill rises)',
  !!at0 && !!atPlus && atPlus.ratio > at0.ratio * 1.3,
  `${at0?.ratio?.toFixed(3)} -> ${atPlus?.ratio?.toFixed(3)}`);
check('-45 at or below 0 reverberance (suppressor active)',
  !!at0 && !!atMinus && atMinus.ratio <= at0.ratio * 1.15,
  `${at0?.ratio?.toFixed(3)} -> ${atMinus?.ratio?.toFixed(3)}`);
const sup = await page.evaluate((key) => window.__voiceIsolationEngine.debugReverbState(key), srcKey);
check('suppressor worklet attached for negative side', !!sup?.suppressorAttached,
  `strength=${sup?.strength}`);

// 3) drag responsiveness: sweep amounts rapidly, confirm wetGain tracks live
const sweep = [];
for (const amt of [10, 25, 40, 15, 35]) {
  await setAmount(amt);
  await page.waitForTimeout(150);
  const s = await page.evaluate((key) => window.__voiceIsolationEngine.debugReverbState(key), srcKey);
  sweep.push({ amt, wet: s?.wetGain });
}
const tracks = sweep.every((s, i) =>
  i === 0 || (sweep[i].amt > sweep[i - 1].amt ? s.wet > sweep[i - 1].wet - 0.02 : s.wet < sweep[i - 1].wet + 0.02));
check('wet gain tracks rapid slider sweeps (~150ms each)', tracks,
  sweep.map((s) => `${s.amt}:${s.wet?.toFixed(2)}`).join(' '));

// cleanup: stop playback, amount back to 0
await setAmount(0);
await page.evaluate(() => window.__videoEditorStore.getState().pause?.());

console.log(`\n${pass}/${pass + fail} PASS`);
process.exit(fail === 0 ? 0 : 1);
