/**
 * Speed ramp — live preview and playback, against the real app and real EDITH.
 *
 * These are the tests the first pass was missing. That suite proved the
 * resolver returned warped source times, and it did; it never looked at the
 * picture, so it passed with the preview frozen solid. Everything here measures
 * the canvas the user actually sees, and the element drive behind it.
 *
 * Prereq: app running via `set "DIVIDR_CDP=9222" && npm start` (renderer :5173).
 */
import { chromium } from 'playwright-core';

const CLIP = 'C:\\Users\\User\\Downloads\\01_WINNER_b03.mp4';
const FPS = 30;
const FRAMES = 945; // 31.5s

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  ok ? pass++ : fail++;
  return ok;
};

const browser = await chromium.connectOverCDP('http://localhost:9222');
let page = null;
for (const ctx of browser.contexts())
  for (const p of ctx.pages()) if (/localhost:5173/.test(p.url())) page = p;
if (!page) {
  console.log('NO renderer page on :5173');
  process.exit(1);
}
await page.addInitScript(() => {
  window.__dividrTestMode = true;
  try {
    for (const k of ['default', 'null', 'undefined'])
      localStorage.setItem(`edith-consent-${k}`, 'true');
  } catch {}
});
page.on('dialog', (d) => d.accept().catch(() => {}));

/* ── harness ──────────────────────────────────────────────────────────────── */

async function gotoEditor() {
  await page.goto('http://localhost:5173/', {
    waitUntil: 'domcontentloaded',
    timeout: 70000,
  });
  await page.waitForFunction(
    () => typeof window.__dividrTest?.ping === 'function',
    { timeout: 40000 },
  );
  await page.evaluate(() => {
    window.location.hash = '#/video-editor';
  });
  await sleep(1600);
}

async function openEdith() {
  if ((await page.locator('textarea[placeholder*="EDITH"]').count()) === 0) {
    try {
      await page.locator('[title="E.D.I.T.H"]').first().click({ timeout: 5000 });
    } catch {}
    await sleep(700);
  }
  const agree = page.locator('button:has-text("Agree")');
  try {
    if ((await agree.count()) > 0) await agree.first().click({ timeout: 3000 });
  } catch {}
  const ta = page.locator('textarea[placeholder*="EDITH"]').first();
  await ta.waitFor({ state: 'visible', timeout: 12000 });
  return ta;
}

async function injectClip() {
  const pv = await page.evaluate(async (fp) => {
    try {
      const r = await window.electronAPI.createPreviewUrl(fp);
      return r && r.url ? r.url : typeof r === 'string' ? r : '';
    } catch {
      return '';
    }
  }, CLIP);
  await page.evaluate(
    ({ p, pv, fps, frames }) => {
      const name = p.split(/[\\/]/).pop();
      window.__dividrTest.setStoreState({
        tracks: [
          {
            id: 'clip_sr1',
            type: 'video',
            name,
            source: p,
            previewUrl: pv,
            startFrame: 0,
            endFrame: frames,
            duration: frames,
            sourceDuration: frames,
            sourceStartTime: 0,
            trackRowIndex: 0,
            mediaId: 'msr1',
            visible: true,
            locked: false,
            muted: false,
            color: '#4A90D9',
          },
        ],
        mediaLibrary: [
          {
            id: 'msr1',
            name,
            type: 'video',
            source: p,
            previewUrl: pv,
            duration: frames / fps,
          },
        ],
        preview: { canvasWidth: 1280, canvasHeight: 720 },
        timeline: { currentFrame: 8, fps, selectedTrackIds: ['clip_sr1'] },
      });
    },
    { p: CLIP, pv, fps: FPS, frames: FRAMES },
  );
  await sleep(1200);
}

async function capReset() {
  await page.evaluate(() => {
    window.__cap = { messages: [], ops: [], status: [], done: false };
    if (!window.__capHooked) {
      window.electronAPI.on('mycelium:op', (_e, o) => {
        window.__cap.ops.push(typeof o === 'string' ? o : JSON.stringify(o));
      });
      window.addEventListener('edith:status', (e) =>
        window.__cap?.status.push(e.detail?.text || ''),
      );
      window.__capHooked = true;
    }
  });
}

const rampState = () =>
  page.evaluate(() => {
    const s = window.__dividrTest.getStoreSnapshot();
    const t = (s.tracks ?? []).find((x) => x.id === 'clip_sr1') ?? {};
    return {
      ramp: t.speedRamp ?? null,
      startFrame: t.startFrame,
      endFrame: t.endFrame,
    };
  });

/** Type into the real chat box, exactly as the user would. */
async function ask(text, done, budgetMs = 120000) {
  let ta = page.locator('textarea[placeholder*="EDITH"]').first();
  if ((await ta.count()) === 0) ta = await openEdith();
  await capReset();
  await ta.fill(text);
  await ta.press('Enter');
  const t0 = Date.now();
  while (Date.now() - t0 < budgetMs) {
    const st = await rampState();
    if (done(st)) return { st, ms: Date.now() - t0 };
    await sleep(700);
  }
  return { st: await rampState(), ms: budgetMs, timedOut: true };
}

/**
 * Fingerprint of the visible preview.
 *
 * The picture is the only honest witness here — the resolver can be perfectly
 * right while nothing reaches the screen. Downsampled to 32x18 so this can be
 * sampled many times a second without perturbing what it measures.
 */
const shot = () =>
  page.evaluate(() => {
    const c = document.querySelector('canvas[data-testid="preview-canvas"]');
    if (!c || !c.width || !c.height) return null;
    const s = document.createElement('canvas');
    s.width = 32;
    s.height = 18;
    const g = s.getContext('2d', { willReadFrequently: true });
    g.drawImage(c, 0, 0, 32, 18);
    let d;
    try {
      d = g.getImageData(0, 0, 32, 18).data;
    } catch {
      return null;
    }
    let h = 2166136261;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) {
      h ^= d[i];
      h = Math.imul(h, 16777619);
      h ^= d[i + 1];
      h = Math.imul(h, 16777619);
      sum += d[i] + d[i + 1] + d[i + 2];
    }
    return { h: h >>> 0, mean: sum / (32 * 18 * 3) };
  });

/** What the compositor's detached elements are actually doing. */
const drive = () =>
  page.evaluate(() => window.__dividrCompositor?.videos?.() ?? []);

const setFrame = async (f) => {
  await page.evaluate((n) => {
    window.__videoEditorStore.getState().setCurrentFrame(n);
  }, f);
  await sleep(700);
};

const setPlaying = async (on) => {
  await page.evaluate((v) => {
    const s = window.__videoEditorStore.getState();
    if (v) s.play?.();
    else s.pause?.();
  }, on);
};

async function ensurePanel() {
  await page.evaluate(() => {
    const st = window.__videoEditorStore.getState();
    if (!(st.timeline?.selectedTrackIds ?? []).includes('clip_sr1'))
      st.setSelectedTracks(['clip_sr1']);
  });
  // The ramp editor lives under Advanced now — click through if it isn't shown.
  if ((await page.locator('svg[data-sr-rig="1"]').count()) === 0) {
    for (const label of ['Video', 'Advanced']) {
      try {
        await page
          .locator(`button[role="tab"]:has-text("${label}")`)
          .first()
          .click({ timeout: 3000 });
      } catch {}
      await sleep(350);
    }
  }
  await page.locator('svg[data-sr-rig="1"]').first().waitFor({ timeout: 12000 });
  await page.locator('svg[data-sr-rig="1"]').first().scrollIntoViewIfNeeded();
  await sleep(250);
}

async function handlePoint(sel, which = 0) {
  await ensurePanel();
  const box = await page.locator('svg[data-sr-rig="1"]').first().boundingBox();
  const vb = await page.evaluate(
    ({ sel, which }) => {
      const els = [
        ...document.querySelectorAll(`svg[data-sr-rig="1"] [data-sr="${sel}"]`),
      ];
      const el = els[which];
      if (!el) return null;
      const x1 = +el.getAttribute('x1');
      const y1 = +el.getAttribute('y1');
      const x2 = +el.getAttribute('x2');
      const y2 = +el.getAttribute('y2');
      return { x: (x1 + x2) / 2, y: (y1 + y2) / 2 };
    },
    { sel, which },
  );
  if (!vb || !box) return null;
  const sc = box.width / 268;
  return { x: box.x + vb.x * sc, y: box.y + vb.y * sc };
}

/* ── setup ────────────────────────────────────────────────────────────────── */

await gotoEditor();
await openEdith();
await injectClip();
console.log('--- speed ramp: live preview + playback ---\n');

/* T1 — the user asks, in the chat box. */
const t1 = await ask(
  'Add an accelerating speed ramp from 6 to 13 seconds in this clip, up to 4x',
  (s) => !!s.ramp?.regions?.length,
);
const r0 = t1.st.ramp?.regions?.[0];
check(
  'T1  EDITH applies a ramp from the chat box',
  !!r0 && t1.st.endFrame !== FRAMES,
  r0
    ? `region ${r0.a.toFixed(1)}–${r0.b.toFixed(1)}s, clip ${FRAMES}f → ${t1.st.endFrame}f, ${(t1.ms / 1000).toFixed(1)}s`
    : 'no region',
);

/* T2 — the editor is under Advanced, and Basic no longer carries it. */
await ensurePanel();
const t2 = await page.evaluate(() => {
  const tabs = [...document.querySelectorAll('button[role="tab"]')].map((b) => ({
    label: (b.textContent || '').trim(),
    selected: b.getAttribute('data-state') === 'active',
    disabled: b.hasAttribute('disabled'),
  }));
  const adv = tabs.find((t) => t.label === 'Advanced');
  return {
    advExists: !!adv,
    advEnabled: !!adv && !adv.disabled,
    advActive: !!adv && adv.selected,
    rig: !!document.querySelector('svg[data-sr-rig="1"]'),
    handles: document.querySelectorAll('svg[data-sr-rig="1"] [data-sr]').length,
  };
});
check(
  'T2  ramp editor lives under Video → Advanced',
  t2.advExists && t2.advEnabled && t2.advActive && t2.rig && t2.handles > 0,
  `advanced enabled=${t2.advEnabled} active=${t2.advActive}, ${t2.handles} handles`,
);

/* T3 — paused, the ramp changes which frame is on screen. */
const probeFrame = Math.round((t1.st.endFrame ?? FRAMES) * 0.6);
await setFrame(probeFrame);
const withRamp = await shot();
await page.evaluate(() => {
  const s = window.__videoEditorStore.getState();
  const t = s.tracks.find((x) => x.id === 'clip_sr1');
  s.updateTrack('clip_sr1', { speedRamp: { ...t.speedRamp, enabled: false } });
  window.dispatchEvent(new CustomEvent('dividr:forceRender'));
});
await sleep(900);
const withoutRamp = await shot();
await page.evaluate(() => {
  const s = window.__videoEditorStore.getState();
  const t = s.tracks.find((x) => x.id === 'clip_sr1');
  s.updateTrack('clip_sr1', { speedRamp: { ...t.speedRamp, enabled: true } });
  window.dispatchEvent(new CustomEvent('dividr:forceRender'));
});
await sleep(900);
const backOn = await shot();
check(
  'T3  paused: the ramp changes the picture, and toggling back restores it',
  !!withRamp &&
    !!withoutRamp &&
    withRamp.h !== withoutRamp.h &&
    backOn.h === withRamp.h,
  `on=${withRamp?.h} off=${withoutRamp?.h} on again=${backOn?.h}`,
);

/* T4 — THE ONE THAT MATTERS: playing a ramped clip is not a frozen picture. */
await setFrame(Math.round(6.5 * FPS));
await setPlaying(true);
await sleep(400);
const frames = [];
for (let i = 0; i < 20; i++) {
  frames.push(await shot());
  await sleep(130);
}
await setPlaying(false);
const good = frames.filter(Boolean);
const distinct = new Set(good.map((f) => f.h)).size;
const allBlack = good.every((f) => f.mean < 2);
check(
  'T4  playing a ramped clip: the picture keeps moving (not frozen)',
  distinct >= 8 && !allBlack,
  `${distinct}/${good.length} distinct frames over ~2.6s, mean luma ${(good.reduce((a, f) => a + f.mean, 0) / Math.max(1, good.length)).toFixed(1)}`,
);

/* T5 — the element is being played, not left stuck mid-seek. */
await setFrame(Math.round(7 * FPS));
await setPlaying(true);
await sleep(900);
const samples = [];
for (let i = 0; i < 12; i++) {
  samples.push((await drive())[0] ?? null);
  await sleep(120);
}
await setPlaying(false);
const live = samples.filter(Boolean);
const everPlaying = live.filter((v) => !v.paused).length;
const alwaysSeeking = live.length > 0 && live.every((v) => v.seeking);
check(
  'T5  the element runs under play(), never wedged in a seek',
  everPlaying >= live.length * 0.7 && !alwaysSeeking,
  `playing on ${everPlaying}/${live.length} samples, permanently-seeking=${alwaysSeeking}`,
);

/* T6 — playbackRate is what carries the acceleration.
   Read while PAUSED: the compositor sets the rate on every composite, and a
   still playhead means the sample is taken at exactly the output second asked
   for. Sweeping matters because the ramp's window in OUTPUT time is compressed
   — source 6–13s lands in roughly output 6–8.8s once the clip is warped, so
   probing "output second 9" reads the 1x tail, not the ramp. */
const t6region = (await rampState()).ramp?.regions?.[0];
await setFrame(Math.round(1.5 * FPS)); // well before the ramp
const rateFlat = (await drive())[0]?.playbackRate ?? 0;
const sweep = [];
for (let o = t6region.a; o <= t6region.b; o += 0.25) {
  await page.evaluate((n) => {
    window.__videoEditorStore.getState().setCurrentFrame(n);
  }, Math.round(o * FPS));
  await sleep(150);
  sweep.push({ o, r: (await drive())[0]?.playbackRate ?? 0 });
}
const peak = sweep.reduce((m, s) => (s.r > m.r ? s : m), { o: 0, r: 0 });
check(
  'T6  playbackRate follows the curve rather than sitting at 1x',
  Math.abs(rateFlat - 1) < 0.25 && peak.r > 1.4,
  `flat=${rateFlat.toFixed(2)}x, peak=${peak.r.toFixed(2)}x at output ${peak.o.toFixed(2)}s`,
);

/* T7 — the acceleration itself, traced at 60Hz inside the page.
   Sampling over CDP tops out around 10Hz, which is too coarse to tell a smooth
   ramp from a stepped one. This runs a rAF loop in the renderer instead and
   reads the whole trace afterwards. Smoothness is judged on the second
   difference of log(stride): scale-free, so it does not punish the curve for
   legitimately covering a second of source in one output frame at 30x. */
/**
 * Trace the frames that actually reached the screen.
 *
 * Filled by the compositor's own requestVideoFrameCallback, because polling
 * `presentedMediaTime` from outside misses presentations, and every miss reads
 * as a doubled stride — judder that isn't there. Measured: polling reported a
 * baseline judder of 2.7 on a plain 1x clip that traces losslessly at 1.4.
 */
async function presentTrace(startFrame, ms) {
  await setFrame(startFrame);
  await page.evaluate(() => {
    window.__srTrace = [];
  });
  await setPlaying(true);
  await sleep(ms);
  await setPlaying(false);
  return page.evaluate(() => {
    const t = window.__srTrace ?? [];
    delete window.__srTrace;
    return t;
  });
}

/**
 * Motion quality of a presentation trace.
 *
 * `stride` is how much source time each presented frame advanced — it comes
 * from the media pipeline's own timestamps, so it is immune to when anything
 * looked. `judder` is the second difference of log(stride), which is scale-free
 * and so does not punish a ramp for legitimately covering more ground.
 */
function motion(trace) {
  const strides = [];
  for (let i = 1; i < trace.length; i++) strides.push(trace[i][1] - trace[i - 1][1]);
  const back = strides.filter((s) => s < -1e-6).length;
  const logs = strides.filter((s) => s > 1e-6).map(Math.log);
  let j = 0;
  for (let i = 2; i < logs.length; i++)
    j = Math.max(j, Math.abs(logs[i] - 2 * logs[i - 1] + logs[i - 2]));
  const covered = trace.length ? trace[trace.length - 1][1] - trace[0][1] : 0;
  const wall = trace.length
    ? (trace[trace.length - 1][0] - trace[0][0]) / 1000
    : 1;
  return {
    n: trace.length,
    back,
    j,
    covered,
    wall,
    maxStride: strides.length ? Math.max(...strides) : 0,
  };
}

/* T7 — the acceleration itself, on the frames that reached the screen.
   Two bars, both calibrated against a plain 1x run of the same clip on the same
   machine rather than guessed:
     · no LURCH — the biggest single step stays within what the peak speed can
       justify. This is what caught the real defect: correcting drift with a
       seek produced one 1.8s step between 0.13s neighbours.
     · judder no worse than normal playback. Plain 1x measures ~1.4 here (this
       app drops the odd frame on a 4K source even at normal speed), 3x measures
       2.2, 8x measures 1.8, and 0.35x slow motion measures 0.69. */
const t7peak = Math.max(
  ...((await rampState()).ramp?.regions?.[0]?.segs ?? [1]),
);
await page.evaluate(() => {
  const s = window.__videoEditorStore.getState();
  const t = s.tracks.find((x) => x.id === 'clip_sr1');
  s.updateTrack('clip_sr1', { speedRamp: { ...t.speedRamp, enabled: false } });
});
await sleep(700);
const base = motion(await presentTrace(Math.round(6 * FPS), 2600));
await page.evaluate(() => {
  const s = window.__videoEditorStore.getState();
  const t = s.tracks.find((x) => x.id === 'clip_sr1');
  s.updateTrack('clip_sr1', { speedRamp: { ...t.speedRamp, enabled: true } });
});
await sleep(700);
const ramped = motion(await presentTrace(Math.round(6 * FPS), 2600));
// An element that keeps up presents at worst ~15fps of real frames, so one
// step should never exceed peak/15 seconds of source.
const lurchBar = Math.max(0.15, t7peak / 15);
check(
  'T7  the acceleration is smooth, forward-only, and never lurches',
  ramped.back === 0 &&
    ramped.covered > ramped.wall * 1.15 &&
    ramped.n > 30 &&
    ramped.maxStride <= lurchBar &&
    ramped.j <= Math.max(2.8, base.j * 1.8),
  `${ramped.n} presented, ${ramped.covered.toFixed(2)}s in ${ramped.wall.toFixed(2)}s (${(ramped.covered / ramped.wall).toFixed(2)}x), ${ramped.back} reversals, biggest step ${ramped.maxStride.toFixed(3)}s (bar ${lurchBar.toFixed(3)} for ${t7peak}x), judder ${ramped.j.toFixed(2)} vs 1x baseline ${base.j.toFixed(2)}`,
);

/* T8 — dragging the curve moves the picture DURING the drag. */
await setFrame(probeFrame);
await sleep(600);
const seg = await handlePoint('seg', 0);
const beforeDrag = await shot();
const during = [];
if (seg) {
  await page.mouse.move(seg.x, seg.y);
  await page.mouse.down();
  for (let i = 1; i <= 4; i++) {
    await page.mouse.move(seg.x, seg.y - i * 9);
    await sleep(420); // long enough for the seek behind the drag to land
    during.push(await shot());
  }
}
const midDragDistinct = new Set(
  [beforeDrag, ...during].filter(Boolean).map((f) => f.h),
).size;
check(
  'T8  the preview follows the handle live, before the button comes up',
  !!seg && midDragDistinct >= 3,
  `${midDragDistinct} distinct frames across the drag`,
);

/* T9 — the store is written once, on release, not on every move. */
const midDragStore = await rampState();
await page.mouse.up();
await sleep(700);
const afterUpStore = await rampState();
const segBefore = midDragStore.ramp?.regions?.[0]?.segs?.join(',');
const segAfter = afterUpStore.ramp?.regions?.[0]?.segs?.join(',');
check(
  'T9  drag stays out of the store until release, then commits',
  segBefore !== undefined && segBefore !== segAfter,
  `during drag segs=[${segBefore}] → after release segs=[${segAfter}], clip ${midDragStore.endFrame}f → ${afterUpStore.endFrame}f`,
);

/* T10 — the user turns it off from the chat box; length and picture revert. */
await setFrame(probeFrame);
await sleep(500);
const rampedShot = await shot();
const t10 = await ask(
  'Actually remove the speed ramp from this clip',
  (s) => s.ramp?.enabled === false,
);
await sleep(900);
const plainShot = await shot();
check(
  'T10 removing the ramp restores the clip length and the 1:1 picture',
  t10.st.ramp?.enabled === false &&
    t10.st.endFrame === FRAMES &&
    rampedShot?.h !== plainShot?.h,
  `enabled=${t10.st.ramp?.enabled}, clip back to ${t10.st.endFrame}f (want ${FRAMES})`,
);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
