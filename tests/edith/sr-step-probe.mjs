import { chromium } from 'playwright-core';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b = await chromium.connectOverCDP('http://localhost:9222');
let page = null;
for (const c of b.contexts()) for (const p of c.pages()) if (/5173/.test(p.url())) page = p;
await page.bringToFront();
const clipId = await page.evaluate(() => (window.__videoEditorStore.getState().tracks || []).find((x) => x.type === 'video')?.id);
await page.evaluate(({ id }) => {
  const s = window.__videoEditorStore.getState();
  const t = s.tracks.find((x) => x.id === id);
  const fps = s.timeline?.fps ?? 30;
  s.updateTrack(id, { speedRamp: { enabled: true, appliedByEdith: true,
    sourceDuration: (t.endFrame - t.startFrame) / fps, blend: 'blend',
    regions: [{ a: 3, b: 11, shape: 'smooth', dir: 'forward', segs: [1, 15, 1],
      bounds: [{ t0: 3.2, t1: 4.4 }, { t0: 9.6, t1: 10.8 }] }] } });
  window.dispatchEvent(new CustomEvent('dividr:forceRender'));
}, { id: clipId });
await sleep(400);
await page.evaluate(() => window.__videoEditorStore.getState().setCurrentFrame(54));
await sleep(900);
await page.evaluate(() => {
  window.__srStep = {};
  window.__srDraw = [];
  window.__videoEditorStore.getState().play?.();
  setTimeout(() => window.__videoEditorStore.getState().pause?.(), 4000);
});
await sleep(4600);
const r = await page.evaluate(() => {
  const s = window.__srStep; const d = window.__srDraw ?? [];
  delete window.__srStep; delete window.__srDraw;
  return { s, draws: d.length, real: d.filter(x => x[1] !== -1).length };
});
console.log(JSON.stringify(r, null, 1));

process.exit(0);
