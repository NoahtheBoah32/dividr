import { chromium } from 'playwright-core';
const b = await chromium.connectOverCDP('http://localhost:9222');
let page = null;
for (const c of b.contexts()) for (const p of c.pages()) { const u = p.url(); if (u.includes('localhost:5173') && !u.startsWith('blob:')) page = p; }
await page.bringToFront();
await page.mouse.move(202, 356);
await page.waitForTimeout(600);
await page.mouse.click(202, 327);
for (let i = 0; i < 30; i++) {
  await page.waitForTimeout(1000);
  const s = await page.evaluate(() => ({ hash: location.hash, tracks: window.__videoEditorStore?.getState()?.tracks?.length ?? -1 }));
  if (s.hash.includes('video-editor') && s.tracks > 0) { console.log('opened', JSON.stringify(s)); process.exit(0); }
}
console.log('final', JSON.stringify(await page.evaluate(() => ({ hash: location.hash, tracks: window.__videoEditorStore?.getState()?.tracks?.length ?? -1 }))));
