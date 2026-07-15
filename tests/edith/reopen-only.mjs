// Reopen the most recent project WITHOUT reloading (use after reload-reopen.mjs
// got the reload done but the click didn't land — the app runs ~1 FPS under load).
import { chromium } from 'playwright-core';
const b = await chromium.connectOverCDP('http://localhost:9222');
let page = null;
for (const c of b.contexts()) for (const p of c.pages()) { const u = p.url(); if (u.includes('localhost:5173') && !u.startsWith('blob:')) page = p; }
if (!page) { console.log('no page'); process.exit(1); }

for (let attempt = 0; attempt < 5; attempt++) {
  const already = await page.evaluate(() => {
    const s = window.__dividrTest?.getStoreSnapshot?.();
    return location.hash.includes('video-editor') && (s?.tracks?.filter((t) => t.type === 'video').length ?? 0) >= 1;
  });
  if (already) { console.log('already open'); process.exit(0); }
  const target = await page.evaluate(() => {
    const imgs = Array.from(document.querySelectorAll('img')).filter(
      (img) => img.naturalWidth > 0 && img.getBoundingClientRect().width > 100,
    );
    if (imgs.length) { const r = imgs[0].getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }
    const title = Array.from(document.querySelectorAll('h1,h2,h3,p,span,div')).find(
      (el) => el.textContent?.trim() === 'Untitled Project' && el.getBoundingClientRect().width > 50,
    );
    if (!title) return null;
    const r = title.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y - 60 };
  });
  if (!target) { await page.waitForTimeout(2000); continue; }
  await page.mouse.move(target.x, target.y);
  await page.waitForTimeout(600);
  await page.mouse.down();
  await page.waitForTimeout(200);
  await page.mouse.up();
  await page.waitForTimeout(600);
  await page.mouse.dblclick(target.x, target.y);
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(1000);
    const state = await page.evaluate(() => {
      const s = window.__dividrTest?.getStoreSnapshot?.();
      return { url: location.hash, video: s?.tracks?.filter((t) => t.type === 'video').length ?? -1 };
    });
    if (state.url.includes('video-editor') && state.video >= 1) {
      console.log(JSON.stringify(state));
      process.exit(0);
    }
  }
}
console.log('FAILED to reopen');
process.exit(1);
