/**
 * Prints the actual per-picture stride SEQUENCE through a ramp, so the shape of
 * the choppiness is visible rather than averaged away. "Smooth at first then
 * cutty" should show up as a clean run followed by a ragged one.
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

const REGION_A = 3;
const REGION_B = 11;
const clip = await page.evaluate(() => {
  const st = window.__videoEditorStore.getState();
  const t = (st.tracks || []).find((x) => x.type === 'video');
  return t ? { id: t.id, name: t.name } : null;
});

const install = (peak, rampSecs, blend) =>
  page.evaluate(
    ({ id, peak, rampSecs, blend, a, b }) => {
      const s = window.__videoEditorStore.getState();
      const t = s.tracks.find((x) => x.id === id);
      const fps = s.timeline?.fps ?? 30;
      s.updateTrack(id, {
        speedRamp: {
          enabled: true,
          appliedByEdith: true,
          sourceDuration: (t.endFrame - t.startFrame) / fps,
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

async function seq(label, peak, rampSecs, blend) {
  await install(peak, rampSecs, blend);
  await sleep(350);
  await page.evaluate((f) => {
    window.__videoEditorStore.getState().setCurrentFrame(f);
  }, Math.round((REGION_A - 1.2) * 30));
  await sleep(900);
  await page.evaluate((end) => {
    window.__srDraw = [];
    const s = window.__videoEditorStore.getState();
    s.play?.();
    const t0 = performance.now();
    const iv = setInterval(() => {
      const d = window.__srDraw ?? [];
      const last = d.length ? d[d.length - 1][1] : 0;
      if (last > end || performance.now() - t0 > 9000) {
        clearInterval(iv);
        window.__videoEditorStore.getState().pause?.();
      }
    }, 60);
  }, REGION_B + 0.3);
  await sleep(9600);

  const draw = await page.evaluate(() => {
    const d = window.__srDraw ?? [];
    delete window.__srDraw;
    return d;
  });
  const win = [];
  for (const row of draw) {
    if (row[1] === -1) {
      if (win.length) win.push(row);
      continue;
    }
    if (row[1] >= REGION_A && row[1] <= REGION_B) win.push(row);
    else if (win.length) break;
  }
  console.log(`\n=== ${label} — ${win.length} pictures ===`);
  // src time | wall gap ms | source stride
  let prev = null;
  const out = [];
  for (const row of win) {
    if (row[1] === -1) {
      out.push('  REPEAT');
      continue;
    }
    if (prev)
      out.push(
        `t=${row[1].toFixed(2)}  dt=${(row[0] - prev[0]).toFixed(0)}ms  stride=${(row[1] - prev[1]).toFixed(3)}s`,
      );
    prev = row;
  }
  console.log(out.join('\n'));
}

await seq('1x control', 1, 1.5, 'off');
process.exit(0);
