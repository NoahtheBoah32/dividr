/**
 * Does a ramp with TWO plateaus actually play at two different speeds?
 *
 * Installs 1x -> 3x -> 15x -> 1x in one region, plays it, and measures the
 * instantaneous speed from the drawn pictures (delta source / delta wall). If
 * the second plateau works, the trace has a stretch near 3 and a stretch near
 * 15. If only the first ramp works, it never leaves 3.
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

const clipId = await page.evaluate(() => {
  const st = window.__videoEditorStore.getState();
  return (st.tracks || []).find((x) => x.type === 'video')?.id ?? null;
});

const A = 3;
const B = 11;

async function run(label, segs, bounds, dir) {
  await page.evaluate(
    ({ id, segs, bounds, dir, A, B }) => {
      const s = window.__videoEditorStore.getState();
      const t = s.tracks.find((x) => x.id === id);
      const fps = s.timeline?.fps ?? 30;
      s.updateTrack(id, {
        speedRamp: {
          enabled: true,
          appliedByEdith: true,
          sourceDuration: (t.endFrame - t.startFrame) / fps,
          blend: 'blend',
          regions: [{ a: A, b: B, shape: 'smooth', dir, segs, bounds }],
        },
      });
      window.dispatchEvent(new CustomEvent('dividr:forceRender'));
    },
    { id: clipId, segs, bounds, dir, A, B },
  );
  await sleep(400);
  await page.evaluate((f) => {
    window.__videoEditorStore.getState().setCurrentFrame(f);
  }, Math.round((A - 1.2) * 30));
  await sleep(900);

  await page.evaluate(() => {
    window.__srDraw = [];
    const s = window.__videoEditorStore.getState();
    s.play?.();
    const t0 = performance.now();
    const iv = setInterval(() => {
      if (performance.now() - t0 > 8000) {
        clearInterval(iv);
        window.__videoEditorStore.getState().pause?.();
      }
    }, 100);
  });
  await sleep(8600);
  const draw = await page.evaluate(() => {
    const d = window.__srDraw ?? [];
    delete window.__srDraw;
    return d.filter((r) => r[1] !== -1);
  });

  // Distinct pictures only: consecutive draws showing the same source time are
  // the same picture held, which is what the eye sees as a hold, not a frame.
  const rows = [];
  for (const r of draw) {
    if (r[1] < A - 0.3 || r[1] > B + 0.3) {
      if (rows.length) break;
      continue;
    }
    if (!rows.length || Math.abs(r[1] - rows[rows.length - 1][1]) > 1e-4)
      rows.push(r);
  }
  if (rows.length < 3) {
    console.log(`${label}\n   only ${rows.length} pictures\n`);
    return;
  }
  const outSecs = (rows[rows.length - 1][0] - rows[0][0]) / 1000;
  const strides = [];
  const gaps = [];
  for (let i = 1; i < rows.length; i++) {
    strides.push(rows[i][1] - rows[i - 1][1]);
    gaps.push(rows[i][0] - rows[i - 1][0]);
  }
  const mean = (v) => v.reduce((a, x) => a + x, 0) / Math.max(1, v.length);
  const sd = (v) => {
    const m = mean(v);
    return Math.sqrt(mean(v.map((x) => (x - m) ** 2)));
  };
  console.log(
    `${label}\n   pictures=${rows.length} over ${outSecs.toFixed(2)}s = ${(rows.length / outSecs).toFixed(1)}/s   ` +
      `src ${rows[0][1].toFixed(2)}->${rows[rows.length - 1][1].toFixed(2)}\n` +
      `   stride mean=${mean(strides).toFixed(3)}s  cv=${(sd(strides) / Math.abs(mean(strides) || 1)).toFixed(2)}  ` +
      `wall gap mean=${mean(gaps).toFixed(0)}ms max=${Math.max(...gaps).toFixed(0)}ms\n` +
      `   first 14 strides: ${strides.slice(0, 14).map((s) => s.toFixed(2)).join(' ')}\n`,
  );
}

console.log('--- one plateau (control): 1 -> 3 -> 1 ---');
await run(
  'expect ~3x through the middle',
  [1, 3, 1],
  [
    { t0: 3.2, t1: 4.7 },
    { t0: 9.3, t1: 10.8 },
  ],
  'forward',
);

console.log('--- two plateaus: 1 -> 3 -> 15 -> 1 ---');
await run(
  'expect ~3x then ~15x',
  [1, 3, 15, 1],
  [
    { t0: 3.2, t1: 4.4 },
    { t0: 5.4, t1: 6.6 },
    { t0: 9.6, t1: 10.8 },
  ],
  'forward',
);

console.log('--- same curve, REVERSE direction ---');
await run(
  'expect the span to play backward',
  [1, 3, 15, 1],
  [
    { t0: 3.2, t1: 4.4 },
    { t0: 5.4, t1: 6.6 },
    { t0: 9.6, t1: 10.8 },
  ],
  'reverse',
);
process.exit(0);
