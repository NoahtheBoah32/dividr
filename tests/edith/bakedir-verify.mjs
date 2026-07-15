// Verify baked outputs now land in app storage (userData/baked), not Downloads.
import { chromium } from 'playwright-core';

const b = await chromium.connectOverCDP('http://localhost:9222');
let page = null;
for (const c of b.contexts()) for (const p of c.pages()) {
  const u = p.url();
  if (u.includes('localhost:517') && !u.startsWith('blob:')) page = p;
}
if (!page) { console.log('no page'); process.exit(1); }

for (let i = 0; i < 20; i++) {
  const ok = await page.evaluate(() => !!window.__dividrTest).catch(() => false);
  if (ok) break;
  await page.waitForTimeout(2500);
}
await page.evaluate(() => window.__dividrTest.openProjectByTitle('SKILLS-93-TEST'));
await page.waitForTimeout(4500);

const clip = await page.evaluate(() => {
  const s = window.__dividrTest.getStoreSnapshot();
  const v = s.tracks.find((t) => t.type === 'video');
  return v ? { id: v.id, source: v.source } : null;
});
if (!clip) { console.log('no clip'); process.exit(1); }
console.log('clip source before:', clip.source);

await page.evaluate((clipId) => {
  window.__dividrTest.applyOps([{ type: 'rackFocus', clipId, direction: 'near-to-far', strength: 60 }]);
}, clip.id);

let after = null;
const t0 = Date.now();
while (Date.now() - t0 < 240000) {
  after = await page.evaluate((clipId) => {
    const v = window.__dividrTest.getStoreSnapshot().tracks.find((t) => t.id === clipId);
    const src = v?.source ?? '';
    // fresh bake = a rackfocus_ file newer than when we started (source changes)
    return src;
  }, clip.id).catch(() => null);
  if (after && after !== clip.source && /rackfocus_\d+/.test(after)) break;
  await page.waitForTimeout(4000);
}
console.log('clip source after: ', after);
const inBaked = /AppData[\\/]Roaming[\\/]Dividr[\\/]baked[\\/]rackfocus_\d+\.mp4$/i.test(after ?? '');
const inDownloads = /Downloads/i.test(after ?? '');
console.log(inBaked && !inDownloads ? 'PASS  bake landed in app storage' : 'FAIL  bake path wrong');
process.exit(inBaked && !inDownloads ? 0 : 1);
