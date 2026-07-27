/**
 * Every control in the Speed Ramp panel must actually change the clip.
 *
 * Each one is clicked the way a user clicks it, and the STORE is read back
 * afterwards. A button that renders but writes nothing fails here.
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
await page.bringToFront();

let pass = 0;
let fail = 0;
const check = (n, ok, d = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  — ' + d : ''}`);
  ok ? pass++ : fail++;
};

const clipId = await page.evaluate(() => {
  const s = window.__videoEditorStore.getState();
  const t = (s.tracks || []).find((x) => x.type === 'video');
  const fps = s.timeline?.fps ?? 30;
  // The UNTOUCHED source length, not the current span — endFrame may already be
  // shrunk by a ramp, and seeding from it makes the clip lose time every run.
  const srcSeconds = t.sourceDuration / (t.effectiveFps || fps);
  s.updateTrack(t.id, {
    speedRamp: {
      enabled: true,
      appliedByEdith: true,
      sourceDuration: srcSeconds,
      blend: 'blend',
      regions: [
        {
          a: 3,
          b: 11,
          shape: 'smooth',
          dir: 'forward',
          segs: [1, 6, 1],
          bounds: [
            { t0: 3.2, t1: 4.7 },
            { t0: 9.3, t1: 10.8 },
          ],
        },
      ],
    },
  });
  s.setSelectedTracks([t.id]);
  return t.id;
});
await sleep(900);

const ramp = () =>
  page.evaluate(
    (id) =>
      window.__videoEditorStore
        .getState()
        .tracks.find((t) => t.id === id)?.speedRamp ?? null,
    clipId,
  );
const track = () =>
  page.evaluate(
    (id) => {
      const t = window.__videoEditorStore
        .getState()
        .tracks.find((x) => x.id === id);
      return { startFrame: t.startFrame, endFrame: t.endFrame };
    },
    clipId,
  );

async function clickText(text, nth = 0) {
  const hit = await page.evaluate(
    ({ t, nth }) => {
      const els = [...document.querySelectorAll('button,[role="tab"]')].filter(
        (e) =>
          e.textContent?.trim() === t && e.getBoundingClientRect().width > 0,
      );
      const el = els[nth];
      if (!el) return null;
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    },
    { t: text, nth },
  );
  if (!hit) return false;
  await page.mouse.click(hit.x, hit.y);
  await sleep(600);
  return true;
}

await clickText('Video');
await clickText('Advanced');
await sleep(400);

/* ── shape buttons ────────────────────────────────────────────────────────── */
for (const shape of ['Whip', 'Snap', 'Linear', 'Smooth']) {
  const clicked = await clickText(shape);
  const r = await ramp();
  check(
    `shape "${shape}" writes to the region`,
    clicked && r?.regions?.[0]?.shape === shape.toLowerCase(),
    `clicked=${clicked} stored=${r?.regions?.[0]?.shape}`,
  );
}

/* ── direction ────────────────────────────────────────────────────────────── */
const beforeDir = (await ramp())?.regions?.[0]?.dir;
const revClicked = await clickText('reverse');
const afterRev = (await ramp())?.regions?.[0]?.dir;
check(
  'Reverse button flips the region direction',
  revClicked && afterRev === 'reverse' && beforeDir !== afterRev,
  `${beforeDir} → ${afterRev}`,
);

// and it must actually change the picture, not just the label
const revPixels = await page.evaluate(async () => {
  const grab = () => {
    const c = document.querySelector('canvas[data-testid="preview-canvas"]');
    if (!c) return null;
    const s = document.createElement('canvas');
    s.width = 32;
    s.height = 18;
    const g = s.getContext('2d', { willReadFrequently: true });
    g.drawImage(c, 0, 0, 32, 18);
    let h = 2166136261;
    for (const v of g.getImageData(0, 0, 32, 18).data) {
      h ^= v;
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  };
  const st = window.__videoEditorStore.getState();
  st.setCurrentFrame(150);
  await new Promise((r) => setTimeout(r, 1200));
  return grab();
});
await clickText('forward');
const fwdPixels = await page.evaluate(async () => {
  const grab = () => {
    const c = document.querySelector('canvas[data-testid="preview-canvas"]');
    const s = document.createElement('canvas');
    s.width = 32;
    s.height = 18;
    const g = s.getContext('2d', { willReadFrequently: true });
    g.drawImage(c, 0, 0, 32, 18);
    let h = 2166136261;
    for (const v of g.getImageData(0, 0, 32, 18).data) {
      h ^= v;
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  };
  window.__videoEditorStore.getState().setCurrentFrame(150);
  await new Promise((r) => setTimeout(r, 1200));
  return grab();
});
check(
  'Reverse actually changes the PICTURE, not just the label',
  revPixels !== null && fwdPixels !== null && revPixels !== fwdPixels,
  `reverse=${revPixels} forward=${fwdPixels}`,
);

/* ── add / remove hold ────────────────────────────────────────────────────── */
const holdsBefore = (await ramp())?.regions?.[0]?.segs?.length ?? 0;
await clickText('+ Add hold');
const holdsAfter = (await ramp())?.regions?.[0]?.segs?.length ?? 0;
check(
  'adding a hold adds a speed plateau',
  holdsAfter > holdsBefore,
  `segs ${holdsBefore} → ${holdsAfter}`,
);

/* ── add a second region ──────────────────────────────────────────────────── */
const regionsBefore = (await ramp())?.regions?.length ?? 0;
const lenBefore = await track();
const addClicked = await clickText('+ Add ramp');
const r2 = await ramp();
check(
  '"+ Add ramp" creates a second region',
  addClicked && (r2?.regions?.length ?? 0) > regionsBefore,
  `${regionsBefore} → ${r2?.regions?.length}`,
);
const lenAfter = await track();
check(
  'the second region changes the clip length on the timeline',
  lenAfter.endFrame !== lenBefore.endFrame,
  `${lenBefore.endFrame}f → ${lenAfter.endFrame}f`,
);

/* ── in-betweens (blend mode) ─────────────────────────────────────────────── */
const blendBefore = (await ramp())?.blend;
const flowClicked = await clickText('Optical flow');
const blendAfter = (await ramp())?.blend;
check(
  '"Optical flow" writes the blend mode',
  flowClicked && blendAfter === 'flow' && blendAfter !== blendBefore,
  `${blendBefore} → ${blendAfter}`,
);
const offClicked = await clickText('Off');
check(
  '"Off" writes the blend mode back',
  offClicked && (await ramp())?.blend === 'off',
  `now ${(await ramp())?.blend}`,
);
await clickText('Blend');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
