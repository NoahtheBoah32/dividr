/**
 * Judder probe — how much source time each PRESENTED frame advances.
 *
 * The trace is filled by the compositor's own requestVideoFrameCallback, so no
 * presentation is missed. Source-delta-per-presented-frame is the honest signal:
 * it comes from the media pipeline's own timestamps, so it does not care when
 * the probe happened to look.
 */
import { chromium } from 'playwright-core';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b = await chromium.connectOverCDP('http://localhost:9222');
let page = null;
for (const c of b.contexts())
  for (const p of c.pages()) if (/5173/.test(p.url())) page = p;

const setPlaying = (on) =>
  page.evaluate((v) => {
    const s = window.__videoEditorStore.getState();
    if (v) s.play?.();
    else s.pause?.();
  }, on);

const setRamp = (on) =>
  page.evaluate((v) => {
    const s = window.__videoEditorStore.getState();
    const t = s.tracks.find((x) => x.id === 'clip_sr1');
    if (!t?.speedRamp) return false;
    s.updateTrack('clip_sr1', { speedRamp: { ...t.speedRamp, enabled: v } });
    window.dispatchEvent(new CustomEvent('dividr:forceRender'));
    return true;
  }, on);

async function trace(startFrame, ms) {
  await page.evaluate((f) => {
    window.__videoEditorStore.getState().setCurrentFrame(f);
  }, startFrame);
  await sleep(800);
  await page.evaluate(() => {
    window.__srTrace = [];
  });
  await setPlaying(true);
  await sleep(ms);
  await setPlaying(false);
  const t = await page.evaluate(() => {
    const t = window.__srTrace;
    delete window.__srTrace;
    return t;
  });
  return t;
}

function stats(t, label) {
  const strides = [];
  for (let i = 1; i < t.length; i++) {
    const ds = t[i][1] - t[i - 1][1];
    if (ds > 0) strides.push(ds);
  }
  const logs = strides.map(Math.log);
  let j = 0;
  const spikes = [];
  for (let i = 2; i < logs.length; i++) {
    const d = Math.abs(logs[i] - 2 * logs[i - 1] + logs[i - 2]);
    if (d > j) j = d;
    if (d > 1.0) spikes.push([i, strides[i - 2], strides[i - 1], strides[i]]);
  }
  const back = t.slice(1).filter((p, i) => p[1] < t[i][1] - 1e-6).length;
  console.log(
    `${label}: ${t.length} presented, stride ${Math.min(...strides).toFixed(4)}..${Math.max(...strides).toFixed(4)}s, judder ${j.toFixed(2)}, ${back} reversals, ${spikes.length} spikes>1.0`,
  );
  // The big ones are what a viewer sees as a lurch; the 0.033/0.067 alternation
  // is this app's normal frame-drop pattern and shows up at 1x too.
  const big = strides
    .map((s, i) => [i, s])
    .filter(([, s]) => s > 0.25)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6);
  console.log(
    `   strides > 0.25s: ${strides.filter((s) => s > 0.25).length}` +
      (big.length
        ? '  biggest: ' + big.map(([i, s]) => `@${i}=${s.toFixed(2)}s`).join(' ')
        : ''),
  );
  return { j, back, n: t.length };
}

/** Install a known ramp so the measurement isn't at the mercy of leftover state. */
const installRamp = (peak) =>
  page.evaluate((v) => {
    const s = window.__videoEditorStore.getState();
    const t = s.tracks.find((x) => x.id === 'clip_sr1');
    const dur = 31.5;
    s.updateTrack('clip_sr1', {
      speedRamp: {
        enabled: true,
        appliedByEdith: true,
        sourceDuration: dur,
        regions: [
          {
            a: 6,
            b: 13,
            shape: 'smooth',
            dir: 'forward',
            segs: [1, v, 1],
            bounds: [
              { t0: 6.3, t1: 8.6 },
              { t0: 10.4, t1: 12.7 },
            ],
          },
        ],
      },
      endFrame: t.startFrame + 900,
    });
    window.dispatchEvent(new CustomEvent('dividr:forceRender'));
    return true;
  }, peak);

await installRamp(3);
await setRamp(false);
stats(await trace(180, 2800), 'plain 1x  ');
await setRamp(true);
stats(await trace(180, 2800), 'ramp 3x   ');
await installRamp(8);
stats(await trace(180, 2800), 'ramp 8x   ');
await installRamp(30);
stats(await trace(180, 2800), 'ramp 30x  ');
await installRamp(0.35);
stats(await trace(180, 2800), 'ramp 0.35x');
process.exit(0);
