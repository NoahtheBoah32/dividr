/**
 * Speed ramp end-to-end, against the real app and the real EDITH.
 *
 * Prereq: app running via `set "DIVIDR_CDP=9222" && npm start` (renderer on :5173).
 *
 * Six of the ten tests type into EDITH's chat box exactly as a user would; the
 * rest drive the panel with real pointer events, because the drag direction and
 * the smoothness of the resolved frames cannot be proven any other way.
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

async function gotoEditor() {
  await page.goto('http://localhost:5173/', {
    waitUntil: 'domcontentloaded',
    timeout: 70000,
  });
  await page.waitForFunction(() => typeof window.__dividrTest?.ping === 'function', {
    timeout: 40000,
  });
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
  await sleep(900);
}

async function capReset() {
  await page.evaluate(() => {
    window.__cap = { messages: [], ops: [], status: [], done: false };
    if (!window.__capHooked) {
      window.electronAPI.on('mycelium:message', (_e, d) => {
        if (d) window.__cap.messages.push(d);
      });
      window.electronAPI.on('mycelium:op', (_e, o) => {
        window.__cap.ops.push(typeof o === 'string' ? o : JSON.stringify(o));
      });
      window.electronAPI.on('mycelium:done', () => {
        window.__cap.done = true;
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

const cap = () =>
  page.evaluate(() => ({
    ops: window.__cap.ops.slice(),
    status: window.__cap.status.join(' | '),
  }));

/** Type into the real chat box and wait until `done(state)` is satisfied. */
async function ask(text, done, budgetMs = 110000) {
  let ta = page.locator('textarea[placeholder*="EDITH"]').first();
  if ((await ta.count()) === 0) ta = await openEdith();
  await capReset();
  await ta.fill(text);
  await ta.press('Enter');
  const t0 = Date.now();
  let opMs = null;
  while (Date.now() - t0 < budgetMs) {
    const st = await rampState();
    const c = await cap();
    if (opMs === null && c.ops.length > 0) opMs = Date.now() - t0;
    if (done(st, c)) return { st, c, ms: Date.now() - t0, opMs };
    await sleep(450);
  }
  return null;
}

/* ── panel geometry helpers ───────────────────────────────────────────────── */
/**
 * Applying an op clears the timeline selection, which unmounts the properties
 * panel. Re-select before any DOM work, exactly as clicking the clip would.
 */
async function ensurePanel() {
  await page.evaluate(() => {
    const st = window.__videoEditorStore.getState();
    if (!(st.timeline?.selectedTrackIds ?? []).includes('clip_sr1')) {
      st.setSelectedTracks(['clip_sr1']);
    }
  });
  // The ramp editor lives under Video → Advanced — click through if hidden.
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
  await page.locator('svg[data-sr-rig="1"]').first().waitFor({ timeout: 10000 });
  await page.locator('svg[data-sr-rig="1"]').first().scrollIntoViewIfNeeded();
  await sleep(250);
}

async function rigBox() {
  await ensurePanel();
  return page.locator('svg[data-sr-rig="1"]').first().boundingBox();
}

/** Screen point for a handle, taken from its own live SVG coordinates. */
async function handlePoint(sel, which = 0) {
  const box = await rigBox();
  const vb = await page.evaluate(
    ({ sel, which }) => {
      const els = [...document.querySelectorAll(`svg[data-sr-rig="1"] [data-sr="${sel}"]`)];
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
  return { x: box.x + vb.x * sc, y: box.y + vb.y * sc, sc };
}

async function dragBy(from, dx, dy, steps = 16) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++)
    await page.mouse.move(from.x + (dx * i) / steps, from.y + (dy * i) / steps);
  await page.mouse.up();
  await sleep(260);
}

const selRegion = async () =>
  page.evaluate(() => {
    const s = window.__dividrTest.getStoreSnapshot();
    const t = (s.tracks ?? []).find((x) => x.id === 'clip_sr1');
    return t?.speedRamp?.regions?.[0] ?? null;
  });

/* ── setup ────────────────────────────────────────────────────────────────── */
for (let attempt = 0; ; attempt++) {
  try {
    await gotoEditor();
    await openEdith();
    break;
  } catch (e) {
    if (attempt >= 6) throw e;
    console.log(`setup retry ${attempt + 1}: ${String(e).slice(0, 70)}`);
    await sleep(3500);
  }
}
await injectClip();
console.log(`\nclip: ${CLIP.split(/[\\/]/).pop()}  ${FRAMES}f @ ${FPS}fps = ${(FRAMES / FPS).toFixed(1)}s\n`);

/* ════ T1 — EDITH applies a ramp from plain chat ════ */
const t1 = await ask(
  'Speed ramp this up to 3000% between 6 and 13 seconds',
  (st) => !!st.ramp?.appliedByEdith && !!st.ramp?.regions?.length,
);
const r1 = t1?.st.ramp?.regions?.[0];
check(
  'T1 EDITH "speed ramp up to 3000% between 6 and 13s" → ramp applied',
  !!t1 && !!r1 && Math.abs(r1.a - 6) < 1.5 && Math.abs(r1.b - 13) < 1.5 && Math.max(...r1.segs) >= 25,
  t1 ? `op in ${t1.opMs}ms, region ${r1.a.toFixed(1)}–${r1.b.toFixed(1)}s peak ${Math.max(...r1.segs).toFixed(0)}x` : 'timed out',
);

/* ════ T2 — the panel unlocks under Advanced, and nothing in Basic was lost ════ */
await ensurePanel();
const t2 = await page.evaluate(() => {
  const labels = [...document.querySelectorAll('label')].filter(
    (l) => l.textContent.trim() === 'Speed Ramp',
  );
  // The section header now follows Audio Ducking: a small green DOT while the
  // ramp is on, and no green text tag. The dot is required; a worded badge is
  // the thing that was removed, so they are checked separately.
  const header = labels[0]?.closest('div')?.parentElement;
  const greens = header
    ? [...header.querySelectorAll('*')].filter((el) => {
        const c = el.className?.baseVal ?? el.className ?? '';
        return typeof c === 'string' && /bg-green-|text-green-/.test(c);
      })
    : [];
  // A dot carries no text; a badge does.
  const greenDot = greens.some((el) => !(el.textContent || '').trim());
  const greenBadge = greens.some((el) => (el.textContent || '').trim());
  const tab = [...document.querySelectorAll('button[role="tab"]')].find(
    (b) => b.textContent.trim() === 'Advanced',
  );
  return {
    hasLabel: labels.length > 0,
    hasRig: !!document.querySelector('svg[data-sr-rig="1"]'),
    handles: document.querySelectorAll('svg[data-sr-rig="1"] [data-sr]').length,
    gate: [...document.querySelectorAll('p')].some((p) =>
      /ask EDITH to speed ramp/i.test(p.textContent || ''),
    ),
    greenBadge,
    greenDot,
    onAdvanced: tab?.getAttribute('data-state') === 'active',
  };
});
// Everything that was in Basic before must still be in Basic — the ramp was
// ADDED to Advanced, it did not displace anything.
await page
  .locator('button[role="tab"]:has-text("Basic")')
  .first()
  .click({ timeout: 5000 })
  .catch(() => {});
await sleep(500);
const t2basic = await page.evaluate(() => {
  const all = [...document.querySelectorAll('label')].map((l) =>
    l.textContent.trim(),
  );
  return {
    blur: all.includes('Motion Blur'),
    stab: all.includes('Stabilization'),
    rampMoved: !all.includes('Speed Ramp'),
  };
});
await ensurePanel();
check(
  'T2 panel unlocks under Advanced, green dot not text tag, Basic untouched',
  t2.hasLabel &&
    t2.hasRig &&
    t2.handles > 0 &&
    !t2.gate &&
    !t2.greenBadge &&
    t2.greenDot &&
    t2.onAdvanced &&
    t2basic.blur &&
    t2basic.stab &&
    t2basic.rampMoved,
  `handles=${t2.handles} greenDot=${t2.greenDot} greenTextTag=${t2.greenBadge} onAdvanced=${t2.onAdvanced}; Basic still has MotionBlur=${t2basic.blur} Stabilization=${t2basic.stab}, ramp no longer there=${t2basic.rampMoved}`,
);

/* ════ T3 — the preview actually time-warps ════ */
const t3 = await page.evaluate(
  async ({ fps }) => {
    const m = await import(
      '/src/frontend/features/editor/preview/services/FrameResolver.ts'
    );
    const s = window.__dividrTest.getStoreSnapshot();
    const track = (s.tracks ?? []).find((x) => x.id === 'clip_sr1');
    const clip = m.extractClipMetadata(track, fps);
    const at = (f) => m.calculateSourceTime(f, clip, fps);
    return {
      before: at(Math.round(3 * fps)),
      mid: at(Math.round(9 * fps)),
      end: at(track.endFrame - 1),
      ramped: m.clipHasActiveRamp(clip),
      endFrame: track.endFrame,
    };
  },
  { fps: FPS },
);
check(
  'T3 preview resolves warped source time (not 1:1)',
  t3.ramped && Math.abs(t3.before - 3) < 0.05 && t3.mid > 11 && t3.end > 30,
  `t=3s→${t3.before.toFixed(2)}s (1:1), t=9s→${t3.mid.toFixed(2)}s (warped), end→${t3.end.toFixed(1)}s`,
);

/* ════ T4 — the drone standard: smooth, progressive, never a step ════ */
const t4 = await page.evaluate(
  async ({ fps }) => {
    const m = await import(
      '/src/frontend/features/editor/preview/services/FrameResolver.ts'
    );
    const s = window.__dividrTest.getStoreSnapshot();
    const track = (s.tracks ?? []).find((x) => x.id === 'clip_sr1');
    const clip = m.extractClipMetadata(track, fps);
    const n = track.endFrame - track.startFrame;
    const src = [];
    for (let f = 0; f < n; f++) src.push(m.calculateSourceTime(f, clip, fps));
    const stride = [];
    for (let i = 1; i < src.length; i++) stride.push(src[i] - src[i - 1]);
    const backwards = stride.filter((v) => v <= 0).length;
    // Second difference of log-stride: the scale-free measure of how abruptly
    // the acceleration itself changes. A cut or a stepped ramp spikes here.
    const ls = stride.map(Math.log);
    let jerk = 0;
    for (let i = 1; i < ls.length - 1; i++)
      jerk = Math.max(jerk, Math.abs(ls[i + 1] - 2 * ls[i] + ls[i - 1]));
    // Biggest single-frame change in stride. A cut from 1x straight to 30x
    // shows up here as 30; a smooth climb stays low single digits.
    let maxRatio = 1;
    for (let i = 1; i < stride.length; i++)
      maxRatio = Math.max(maxRatio, stride[i] / stride[i - 1]);
    // Distinct intermediate speeds the ramp actually passes through on the way
    // up — proof the acceleration is progressive rather than instantaneous.
    const passed = new Set();
    for (const v of stride) {
      const sp = v * fps;
      if (sp > 1.2 && sp < 29) passed.add(Math.round(sp));
    }
    return {
      frames: n,
      backwards,
      jerk,
      maxRatio,
      passed: passed.size,
      minStride: Math.min(...stride),
      maxStride: Math.max(...stride),
    };
  },
  { fps: FPS },
);
check(
  'T4 acceleration is smooth and progressive on every rendered frame',
  // A stepped/cut implementation scores jerk >= 3.4 and maxRatio >= 30 here.
  t4.backwards === 0 && t4.jerk < 1.5 && t4.maxRatio < 4 && t4.passed >= 6,
  `${t4.frames} frames, 0 backwards, jerk ${t4.jerk.toFixed(3)} (<1.5), max stride step ${t4.maxRatio.toFixed(2)}x (<4), ${t4.passed} intermediate speeds, stride ${t4.minStride.toFixed(4)}→${t4.maxStride.toFixed(3)}s`,
);

/* ════ T5 — dragging a plateau is NOT inverted (vertical) ════ */
const beforeUp = await selRegion();
const segPt = await handlePoint('seg', 0);
let t5 = { ok: false, detail: 'handle not found' };
if (segPt) {
  await dragBy(segPt, 0, -28); // pull UP
  const afterUp = await selRegion();
  const segPt2 = await handlePoint('seg', 0);
  await dragBy(segPt2, 0, 34); // push DOWN
  const afterDown = await selRegion();
  const v0 = beforeUp.segs[1];
  const v1 = afterUp.segs[1];
  const v2 = afterDown.segs[1];
  t5 = {
    ok: v1 > v0 && v2 < v1,
    detail: `${v0.toFixed(1)}x --up--> ${v1.toFixed(1)}x --down--> ${v2.toFixed(1)}x`,
  };
}
check('T5 plateau drag follows the pointer vertically (up = faster)', t5.ok, t5.detail);

/* ════ T6 — dragging the right bracket is NOT inverted (horizontal) ════ */
const beforeR = await selRegion();
const wingR = await handlePoint('wingR', 0);
let t6 = { ok: false, detail: 'handle not found' };
if (wingR) {
  await dragBy(wingR, 26, 0); // pull RIGHT
  const afterR = await selRegion();
  const d0 = beforeR.bounds[0].t1;
  const d1 = afterR.bounds[0].t1;
  t6 = {
    ok: d1 > d0 + 0.05,
    detail: `right edge ${d0.toFixed(2)}s → ${d1.toFixed(2)}s (pointer moved right)`,
  };
}
check('T6 right bracket drags right when the pointer goes right', t6.ok, t6.detail);

/* ════ T7 — the left bracket owns its own edge, and does not mirror ════ */
const beforeL = await selRegion();
const wingL = await handlePoint('wingL', 0);
let t7 = { ok: false, detail: 'handle not found' };
if (wingL) {
  await dragBy(wingL, -24, 0); // pull LEFT
  const afterL = await selRegion();
  const l0 = beforeL.bounds[0].t0;
  const l1 = afterL.bounds[0].t0;
  const r0 = beforeL.bounds[0].t1;
  const r1 = afterL.bounds[0].t1;
  t7 = {
    // moves WITH the pointer, and the opposite edge stays put (no mirroring)
    ok: l1 < l0 - 0.05 && Math.abs(r1 - r0) < 0.05,
    detail: `left ${l0.toFixed(2)}→${l1.toFixed(2)}s (moved), right ${r0.toFixed(2)}→${r1.toFixed(2)}s (held)`,
  };
}
check('T7 left bracket moves with the pointer and does not mirror the right', t7.ok, t7.detail);

/* ════ T8 — a second EDITH ask ADDS a ramp, keeping the first ════ */
await sleep(1200);
const t8 = await ask(
  'Now also ramp the part between 20 and 26 seconds up to 8x',
  (st) => (st.ramp?.regions?.length ?? 0) >= 2,
);
const regs = t8?.st.ramp?.regions ?? [];
check(
  'T8 EDITH "also ramp 20 to 26 seconds" → second ramp added, first kept',
  !!t8 && regs.length >= 2 && regs[0].b < regs[1].a,
  t8
    ? `${regs.length} ramps: ${regs.map((r) => `${r.a.toFixed(1)}–${r.b.toFixed(1)}s`).join(', ')}`
    : 'timed out',
);

/* ════ T9 — EDITH can slow-mo, and the clip gets longer ════ */
await injectClip();
await sleep(1200);
const t9 = await ask(
  'Slow this down to 35% between 4 and 10 seconds, ease in and out',
  (st) => !!st.ramp?.enabled && (st.ramp?.regions?.length ?? 0) > 0,
);
const r9 = t9?.st.ramp?.regions?.[0];
const slower = t9 ? t9.st.endFrame - t9.st.startFrame > FRAMES : false;
check(
  'T9 EDITH "slow down to 35%" → slow-mo ramp, clip gets longer',
  !!t9 && !!r9 && Math.min(...r9.segs) < 0.6 && slower,
  t9
    ? `min ${Math.min(...r9.segs).toFixed(2)}x, timeline ${FRAMES}f → ${t9.st.endFrame - t9.st.startFrame}f`
    : 'timed out',
);

/* ════ T10 — EDITH removes the ramp and restores the length ════ */
await sleep(1200);
const t10 = await ask(
  'Take the speed ramp off, back to normal speed',
  (st) => st.ramp?.enabled === false,
);
check(
  'T10 EDITH "take the speed ramp off" → cleared, original length restored',
  !!t10 && Math.abs(t10.st.endFrame - t10.st.startFrame - FRAMES) <= 2,
  t10
    ? `enabled=${t10.st.ramp.enabled}, timeline back to ${t10.st.endFrame - t10.st.startFrame}f (was ${FRAMES}f)`
    : 'timed out',
);

console.log(`\n${pass}/${pass + fail} PASS`);
process.exit(fail === 0 ? 0 : 1);
