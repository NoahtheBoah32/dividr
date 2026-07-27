import { chromium } from 'playwright-core';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TITLE = process.argv[2] || 'J-cut DEMO';
const b = await chromium.connectOverCDP('http://localhost:9222');
let page = null;
for (const c of b.contexts()) for (const p of c.pages()) {
  const u = p.url();
  if (u.includes('localhost:5173') && !u.startsWith('blob:')) page = p;
}
if (!page) { console.log('no page'); process.exit(1); }
page.setDefaultTimeout(25000);

await page.evaluate(async (t) => {
  try { await window.__dividrTest.openProjectByTitle(t); } catch (e) {}
}, TITLE);
for (let i = 0; i < 25; i++) {
  const n = await page.evaluate(() => (window.__videoEditorStore?.getState?.()?.tracks || []).length).catch(() => 0);
  if (n > 0) break;
  await sleep(1000);
}

const out = await page.evaluate(() => {
  const s = window.__videoEditorStore?.getState?.();
  if (!s) return { err: 'no store' };
  return {
    title: s.projectTitle ?? s.currentProject?.title ?? null,
    fps: s.timeline?.fps,
    tracks: s.tracks.map((t) => ({
      id: t.id.slice(0, 8), type: t.type, name: (t.name || '').slice(0, 36),
      row: t.trackRowIndex ?? 0, start: t.startFrame, end: t.endFrame,
      linked: t.linkedTrackId ? t.linkedTrackId.slice(0, 8) : null,
      jCutLead: t.jCut?.appliedLeadFrames,
      fi: t.fadeInDuration, fo: t.fadeOutDuration,
      prev: (t.previewUrl || '').split(/[\\/]/).pop()?.slice(0, 38),
    })),
  };
});
console.log(JSON.stringify(out, null, 1));
process.exit(0);
