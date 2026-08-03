import { chromium } from 'playwright-core';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const b = await chromium.connectOverCDP('http://localhost:9222');
let page;
for (let i = 0; i < 30 && !page; i++) {
  for (const c of b.contexts()) for (const p of c.pages()) if (p.url().includes('localhost:5173')) page = p;
  if (!page) await sleep(2000);
}
if (!page) { console.log('NO PAGE'); process.exit(1); }
await sleep(3000);

// Open the most recent project so the timeline has content
// Make the layout viewport tall enough that the timeline's bottom strip is
// on the input surface (Electron exposes no Browser.setWindowBounds over CDP)
try {
  await page.setViewportSize({ width: 1400, height: 1200 });
  await sleep(1000);
  console.log('viewport emulated at 1400x1200');
} catch (e) {
  console.log('viewport emulation failed (continuing):', e.message);
}

const opened = await page.evaluate(async () => {
  return await window.__dividrTest.openProjectByTitle('Untitled Project');
});
console.log('open:', JSON.stringify(opened).slice(0, 120));
await sleep(4000);

// Zoom in so the content overflows horizontally, then measure the bar
const probe = await page.evaluate(() => {
  const s = window.__videoEditorStore.getState();
  s.setZoom?.(3);
  return { zoom: 3, tracks: s.tracks.length };
});
console.log('probe:', JSON.stringify(probe));
await sleep(1500);

const bar = await page.evaluate(() => {
  const el = document.querySelector('[title="Scroll timeline"]');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const thumb = el.firstElementChild?.getBoundingClientRect();
  return { bar: { x: r.x, y: r.y, w: r.width, h: r.height }, thumb: thumb ? { x: thumb.x, w: thumb.width, h: thumb.height } : null };
});
console.log('bar:', JSON.stringify(bar));
if (!bar || !bar.thumb) { console.log('FAIL: scrollbar not rendered'); await page.screenshot({ path: 'C:/tmp/dividr-demo-research/hbar_fail.png' }); process.exit(1); }

// Drag the thumb right and confirm scrollX moves
const before = await page.evaluate(() => window.__videoEditorStore.getState().timeline.scrollX);
const startX = bar.thumb.x + bar.thumb.w / 2;
const y = bar.bar.y + bar.bar.h / 2;
await page.mouse.move(startX, y);
await page.mouse.down();
await page.mouse.move(startX + 150, y, { steps: 10 });
await page.mouse.up();
await sleep(500);
const after = await page.evaluate(() => window.__videoEditorStore.getState().timeline.scrollX);
console.log(`scrollX: ${before} -> ${after}`);
console.log(after > before + 50 ? 'PASS: thumb drag scrolls the timeline' : 'FAIL: drag did not scroll');

// Rail click jump
const railX = bar.bar.x + bar.bar.w * 0.8;
await page.mouse.click(railX, y);
await sleep(400);
const jumped = await page.evaluate(() => window.__videoEditorStore.getState().timeline.scrollX);
console.log(`rail click -> scrollX ${jumped}`);

await page.screenshot({ path: 'C:/tmp/dividr-demo-research/hbar_verify.png' });
console.log('shot: C:/tmp/dividr-demo-research/hbar_verify.png');
process.exit(0);
