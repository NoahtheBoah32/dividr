// Reload the app (HMR socket is dead in this long-lived Electron window) and reopen
// the most recent project that has a REAL thumbnail (the working bedroom project).
import { chromium } from 'playwright-core';
const b = await chromium.connectOverCDP('http://localhost:9222');
let page = null;
for (const c of b.contexts()) for (const p of c.pages()) { const u = p.url(); if (u.includes('localhost:5173') && !u.startsWith('blob:')) page = p; }
if (!page) { console.log('no page'); process.exit(1); }

await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(5000);

// The working project is the MOST RECENT card (first in the grid) — prefer the
// card with a loaded thumbnail, but fall back to the first card so a slow
// thumbnail load (1 FPS app) can't strand us on the picker.
let target = null;
for (let i = 0; i < 8 && !target; i++) {
  target = await page.evaluate(() => {
    const imgs = Array.from(document.querySelectorAll('img')).filter(
      (img) => img.naturalWidth > 0 && img.getBoundingClientRect().width > 100,
    );
    if (imgs.length) {
      const r = imgs[0].getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }
    return null;
  });
  if (!target) await page.waitForTimeout(1500);
}
if (!target) {
  // Fallback: the first project card title
  target = await page.evaluate(() => {
    const title = Array.from(document.querySelectorAll('h1,h2,h3,p,span,div')).find(
      (el) => el.textContent?.trim() === 'Untitled Project' && el.getBoundingClientRect().width > 50,
    );
    if (!title) return null;
    const r = title.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y - 60 }; // thumbnail area above the title
  });
}
if (!target) { console.log('no project card with thumbnail'); process.exit(1); }

// Click and poll. Under heavy GPU load the app runs at ~1 FPS and drops fast
// clicks — hover first, slow down/up, then a double-click for good measure.
let state = null;
for (let attempt = 0; attempt < 3; attempt++) {
  await page.mouse.move(target.x, target.y);
  await page.waitForTimeout(500);
  await page.mouse.down();
  await page.waitForTimeout(150);
  await page.mouse.up();
  await page.waitForTimeout(500);
  await page.mouse.dblclick(target.x, target.y);
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(1000);
    state = await page.evaluate(() => {
      const s = window.__dividrTest?.getStoreSnapshot?.();
      return { url: location.hash, tracks: s?.tracks?.length ?? -1, video: s?.tracks?.filter((t) => t.type === 'video').length ?? -1 };
    });
    if (state.url.includes('video-editor') && state.video >= 1) {
      console.log(JSON.stringify(state));
      process.exit(0);
    }
  }
}
console.log(JSON.stringify(state));
process.exit(1);
