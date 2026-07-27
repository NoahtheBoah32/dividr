/**
 * The Speed Ramp section must TUCK AWAY when the toggle is off, the way Audio
 * Ducking does — not sit there greyed out. Driven through the real click path:
 * the switch is clicked, not the store.
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
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
  ok ? pass++ : fail++;
};

// Lay a ramp down and select the clip. Applying an op clears the selection, so
// the selection is set AFTER the track update.
const clipId = await page.evaluate(() => {
  const s = window.__videoEditorStore.getState();
  const t = (s.tracks || []).find((x) => x.type === 'video');
  const fps = s.timeline?.fps ?? 30;
  s.updateTrack(t.id, {
    speedRamp: {
      enabled: true,
      appliedByEdith: true,
      sourceDuration: (t.endFrame - t.startFrame) / fps,
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

/** Click a tab / button by its visible text. */
async function clickText(text) {
  const hit = await page.evaluate((t) => {
    const el = [...document.querySelectorAll('button,[role="tab"]')].find(
      (e) => e.textContent?.trim() === t && e.getBoundingClientRect().width > 0,
    );
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, text);
  if (!hit) return false;
  await page.mouse.click(hit.x, hit.y);
  await sleep(500);
  return true;
}

await clickText('Video');
await clickText('Advanced');
await sleep(400);

/** Is the curve editor present in the DOM at all? */
const curvePresent = () =>
  page.evaluate(() => {
    const txt = document.body.innerText;
    // "+ Add ramp" and the source/output readout only exist inside the editor.
    return {
      addRamp: txt.includes('Add ramp'),
      rampShape: txt.includes('Ramp shape'),
      label: txt.includes('Speed Ramp'),
      svgs: document.querySelectorAll('svg[data-sr-curve], svg').length,
    };
  });

const on1 = await curvePresent();
check('editor is visible while the ramp is ON', on1.addRamp && on1.rampShape);
check('section label is present', on1.label);

/** The Speed Ramp switch, found by walking up from the label. */
async function clickRampSwitch() {
  const hit = await page.evaluate(() => {
    const label = [...document.querySelectorAll('label,span,div')].find(
      (e) => e.textContent?.trim() === 'Speed Ramp',
    );
    if (!label) return null;
    let row = label.parentElement;
    for (let i = 0; i < 4 && row; i++) {
      const sw = row.querySelector('button[role="switch"]');
      if (sw) {
        const r = sw.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      }
      row = row.parentElement;
    }
    return null;
  });
  if (!hit) return false;
  await page.mouse.click(hit.x, hit.y);
  await sleep(700);
  return true;
}

check('found and clicked the Speed Ramp switch', await clickRampSwitch());

const off = await curvePresent();
check(
  'editor is GONE from the DOM when toggled off',
  !off.addRamp && !off.rampShape,
  `addRamp=${off.addRamp} rampShape=${off.rampShape}`,
);
check('label still visible when off (like Audio Ducking)', off.label);

await clickRampSwitch();
const on2 = await curvePresent();
check(
  'editor comes back when toggled on again',
  on2.addRamp && on2.rampShape,
  `addRamp=${on2.addRamp} rampShape=${on2.rampShape}`,
);

const stored = await page.evaluate(
  (id) =>
    !!window.__videoEditorStore
      .getState()
      .tracks.find((t) => t.id === id)?.speedRamp?.enabled,
  clipId,
);
check('store reflects the toggle', stored);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
