/**
 * Measures the ramp on the clip that is CURRENTLY open — the user's own drone
 * footage, his own kind of shot.
 *
 * The method: install a ramp with a known shape, park the playhead at the head
 * of the ramped span, play, and trace every PRESENTED frame losslessly out of
 * the compositor's own requestVideoFrameCallback. Then walk that trace from the
 * moment media time enters the region to the moment it leaves.
 *
 * What comes out of it:
 *  · outSecs   — how long the ramped span actually lasts on the timeline. This
 *                is the number that explains "instantaneous cut": an 8s span at
 *                25x is 0.4s of output, which is twelve frames. No drive can
 *                make twelve frames feel like a drone climbing.
 *  · shown     — frames actually presented across that span.
 *  · stride    — source seconds per presented frame. Perfectly smooth motion has
 *                a CONSTANT stride; choppy motion is irregular.
 *  · cv        — std/mean of stride. This is the real smoothness score, and it
 *                is scale-free, so 3x and 25x are directly comparable.
 *  · stalls    — presentations that advanced nothing. Visible freezes.
 *  · judder    — mean |second difference of log stride|; catches acceleration
 *                that arrives in steps rather than as a curve.
 */
import { chromium } from 'playwright-core';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b = await chromium.connectOverCDP('http://localhost:9222');
let page = null;
for (const c of b.contexts())
  for (const p of c.pages()) if (/5173/.test(p.url())) page = p;
if (!page) {
  console.log('no renderer');
  process.exit(1);
}

const REGION_A = 3;
const REGION_B = 11;

const clip = await page.evaluate(() => {
  const st = window.__videoEditorStore.getState();
  const t = (st.tracks || []).find((x) => x.type === 'video');
  return t ? { id: t.id, name: t.name } : null;
});
if (!clip) {
  console.log('no video clip');
  process.exit(1);
}
// An occluded/backgrounded Electron window has its rAF throttled, which shows
// up as a canvas that repaints ~16 times a second no matter what the ramp does.
// Every number below is meaningless unless the window is actually on screen.
await page.bringToFront();
const vis = await page.evaluate(() => document.visibilityState);
console.log(`clip: ${clip.name}   visibility=${vis}\n`);

const setPlaying = (on) =>
  page.evaluate((v) => {
    const s = window.__videoEditorStore.getState();
    if (v) s.play?.();
    else s.pause?.();
  }, on);

const install = (peak, rampSecs, blend) =>
  page.evaluate(
    ({ id, peak, rampSecs, blend, a, b }) => {
      const s = window.__videoEditorStore.getState();
      const t = s.tracks.find((x) => x.id === id);
      const fps = s.timeline?.fps ?? 30;
      const dur = (t.endFrame - t.startFrame) / fps;
      s.updateTrack(id, {
        speedRamp: {
          enabled: true,
          appliedByEdith: true,
          sourceDuration: dur,
          blend,
          regions: [
            {
              a,
              b,
              shape: 'smooth',
              dir: 'forward',
              segs: [1, peak, 1],
              bounds: [
                { t0: a + 0.2, t1: a + 0.2 + rampSecs },
                { t0: b - 0.2 - rampSecs, t1: b - 0.2 },
              ],
            },
          ],
        },
      });
      window.dispatchEvent(new CustomEvent('dividr:forceRender'));
    },
    { id: clip.id, peak, rampSecs, blend, a: REGION_A, b: REGION_B },
  );

const stats = (xs) => {
  const n = xs.length;
  if (!n) return { mean: 0, sd: 0 };
  const mean = xs.reduce((a, x) => a + x, 0) / n;
  const sd = Math.sqrt(
    xs.reduce((a, x) => a + (x - mean) ** 2, 0) / Math.max(1, n),
  );
  return { mean, sd };
};

async function run(label, peak, rampSecs, blend) {
  await install(peak, rampSecs, blend);
  await sleep(350);
  // Park a little before the region so the element is already rolling when the
  // ramp starts — measuring the spin-up would measure the seek, not the ramp.
  await page.evaluate((f) => {
    window.__videoEditorStore.getState().setCurrentFrame(f);
  }, Math.round((REGION_A - 1.2) * 30));
  await sleep(900);
  // Everything runs IN the page: polling over CDP at 40Hz steals renderer time
  // and shows up as stalls that are the probe's fault, not the ramp's.
  await page.evaluate(
    (end) => {
      window.__srTrace = [];
      window.__srDraw = [];
      const s = window.__videoEditorStore.getState();
      s.play?.();
      const t0 = performance.now();
      const iv = setInterval(() => {
        const t = window.__srTrace ?? [];
        const last = t.length ? t[t.length - 1][1] : 0;
        if ((last != null && last > end) || performance.now() - t0 > 9000) {
          clearInterval(iv);
          window.__videoEditorStore.getState().pause?.();
        }
      }, 60);
    },
    REGION_B + 0.3,
  );
  // No polling at all — the in-page watchdog stops it. One quiet wait.
  await sleep(9600);
  await setPlaying(false);

  const draw = await page.evaluate(() => {
    const d = window.__srDraw ?? [];
    delete window.__srDraw;
    delete window.__srTrace;
    return d;
  });

  // Every canvas draw, in order, with the source time it showed. -1 rows are
  // repeats of the previous picture.
  const win = [];
  for (const row of draw) {
    const t = row[1];
    if (t === -1) {
      if (win.length) win.push(row);
      continue;
    }
    if (t >= REGION_A && t <= REGION_B) win.push(row);
    else if (win.length) break;
  }
  if (win.length < 4) {
    console.log(`${label.padEnd(22)} — only ${win.length} draws in span`);
    return;
  }
  const outSecs = (win[win.length - 1][0] - win[0][0]) / 1000;
  const repeats = win.filter((r) => r[1] === -1).length;

  // Stride between consecutive DISTINCT pictures. A repeat contributes a zero
  // stride, which is exactly what the eye reads as a hitch.
  const real = win.filter((r) => r[1] !== -1);
  const strides = [];
  for (let i = 1; i < real.length; i++) strides.push(real[i][1] - real[i - 1][1]);
  const pos = strides.filter((s) => s > 1e-4);
  const holds = strides.length - pos.length; // same picture drawn twice
  const { mean, sd } = stats(pos);

  const logs = pos.map((s) => Math.log(s));
  const jd = [];
  for (let i = 2; i < logs.length; i++)
    jd.push(Math.abs(logs[i] - 2 * logs[i - 1] + logs[i - 2]));
  const judder = jd.length ? jd.reduce((a, x) => a + x, 0) / jd.length : 0;

  console.log(
    `${label.padEnd(22)} outSecs=${outSecs.toFixed(2)} draws=${String(win.length).padStart(3)} ` +
      `newPics=${String(pos.length + 1).padStart(3)} (${((pos.length / Math.max(1, win.length)) * 100).toFixed(0)}%)  ` +
      `stride mean=${mean.toFixed(3)} max=${Math.max(...pos).toFixed(3)}  ` +
      `cv=${(sd / Math.max(1e-6, mean)).toFixed(2)} judder=${judder.toFixed(2)} ` +
      `holds=${holds} repeats=${repeats}`,
  );
}

console.log('-- negative control --');
await run('1x (no ramp effect)', 1, 1.5, 'off');
console.log('\n-- speed sweep, 1.5s transitions, blend on --');
await run('1.5x', 1.5, 1.5, 'blend');
await run('3x', 3, 1.5, 'blend');
await run('5x', 5, 1.5, 'blend');
await run('8x', 8, 1.5, 'blend');
await run('12x', 12, 1.5, 'blend');
await run('16x', 16, 1.5, 'blend');
await run('25x', 25, 1.5, 'blend');
console.log('\n-- slow motion --');
await run('0.35x', 0.35, 1.5, 'flow');

console.log('\n-- restoring an 8x / 1.5s / blend ramp --');
await install(8, 1.5, 'blend');
process.exit(0);
