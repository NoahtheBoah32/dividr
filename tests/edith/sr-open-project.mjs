/** Reopen the Eiffel project after a reload, by name. */
import { chromium } from 'playwright-core';
const b = await chromium.connectOverCDP('http://localhost:9222');
let page = null;
for (const c of b.contexts())
  for (const p of c.pages()) {
    const u = p.url();
    if (u.includes('localhost:5173') && !u.startsWith('blob:')) page = p;
  }
if (!page) {
  console.log('no page');
  process.exit(1);
}
await page.bringToFront();
console.log('url:', await page.evaluate(() => location.hash));

const cards = await page.evaluate(() =>
  Array.from(document.querySelectorAll('div,article,li'))
    .filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 150 && r.width < 600 && r.height > 100 && r.height < 500;
    })
    .slice(0, 12)
    .map((el) => ({
      text: (el.textContent || '').trim().slice(0, 70),
      x: el.getBoundingClientRect().x + el.getBoundingClientRect().width / 2,
      y: el.getBoundingClientRect().y + el.getBoundingClientRect().height / 2,
    })),
);
console.log(JSON.stringify(cards.slice(0, 6), null, 1));

if (cards.length) {
  const t = cards[0];
  await page.mouse.dblclick(t.x, t.y);
  for (let i = 0; i < 25; i++) {
    await page.waitForTimeout(1000);
    const s = await page.evaluate(() => ({
      hash: location.hash,
      tracks: window.__videoEditorStore?.getState()?.tracks?.length ?? -1,
    }));
    if (s.hash.includes('video-editor') && s.tracks > 0) {
      console.log('opened:', JSON.stringify(s));
      process.exit(0);
    }
  }
}
console.log(
  'final:',
  JSON.stringify(
    await page.evaluate(() => ({
      hash: location.hash,
      tracks: window.__videoEditorStore?.getState()?.tracks?.length ?? -1,
    })),
  ),
);
process.exit(1);
