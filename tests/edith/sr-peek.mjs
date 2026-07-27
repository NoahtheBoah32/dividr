/** Read-only: what is actually loaded in the running app right now. */
import { chromium } from 'playwright-core';
const b = await chromium.connectOverCDP('http://localhost:9222');
let page = null;
for (const c of b.contexts())
  for (const p of c.pages()) if (/5173/.test(p.url())) page = p;
if (!page) {
  console.log('NO RENDERER');
  process.exit(1);
}
const info = await page.evaluate(() => {
  const s = window.__videoEditorStore.getState();
  return {
    fps: s.timeline?.fps,
    tracks: (s.tracks || []).map((t) => ({
      id: t.id,
      type: t.type,
      name: t.name,
      src: (t.src || t.filePath || '').split(/[\\/]/).pop(),
      startFrame: t.startFrame,
      endFrame: t.endFrame,
      ramp: t.speedRamp
        ? {
            enabled: t.speedRamp.enabled,
            blend: t.speedRamp.blend,
            regions: (t.speedRamp.regions || []).map((r) => ({
              a: +r.a.toFixed(2),
              b: +r.b.toFixed(2),
              segs: r.segs,
              bounds: (r.bounds || []).map((x) => [
                +x.t0.toFixed(3),
                +x.t1.toFixed(3),
              ]),
            })),
          }
        : null,
    })),
  };
});
console.log(JSON.stringify(info, null, 1));
process.exit(0);
