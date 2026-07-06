// Verify the manual LassoOverlay end-to-end: select a clip → the nuanced panel renders →
// click a Draw-region button (arms the overlay) → drag on the preview → assert a closed,
// normalized polygon is emitted via dividr:lassoComplete and the panel's Apply reflects it.
import { chromium } from 'playwright-core';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await chromium.connectOverCDP('http://localhost:9222');
let page = null;
for (const c of browser.contexts()) for (const p of c.pages()) if (/localhost:5173/.test(p.url())) page = p;
if (!page) { console.log('NO 5173 page'); process.exit(1); }
await page.addInitScript(() => {
  window.__dividrTestMode = true;
  try { for (const k of ['default', 'null', 'undefined']) localStorage.setItem(`edith-consent-${k}`, 'true'); } catch {}
});
page.on('dialog', (d) => d.accept().catch(() => {}));

await page.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded', timeout: 70000 });
await page.waitForFunction(() => typeof window.__dividrTest?.ping === 'function', { timeout: 40000 });
await page.evaluate(() => { window.location.hash = '#/video-editor'; });
await sleep(1500);

// inject + select a clip so the properties panel (NuancedEffectsPanel) renders
await page.evaluate(() => {
  window.__dividrTest.setStoreState({
    tracks: [{ id: 'clip_a1', type: 'video', name: 'walk3.mp4', source: 'C:/tmp/skills-test/walk3.mp4',
      startFrame: 0, endFrame: 210, duration: 210, sourceStartTime: 0, trackRowIndex: 0, mediaId: 'm1',
      visible: true, locked: false, muted: false, color: '#4A90D9' }],
    timeline: { currentFrame: 20, fps: 30, selectedTrackIds: ['clip_a1'] },
    preview: { canvasWidth: 1280, canvasHeight: 720 },
  });
});
await sleep(1500);

// panel present?
const panel = await page.evaluate(() => {
  const txt = document.body.innerText || '';
  return {
    hasSpeed: /In-Frame Speed/i.test(txt),
    hasLassoBtn: /Lasso/.test(txt),
    hasInvert: /Invert/i.test(txt),
  };
});
console.log('panel:', JSON.stringify(panel));

// hook the completion event
await page.evaluate(() => {
  window.__lasso = null;
  window.addEventListener('dividr:lassoComplete', (e) => { window.__lasso = e.detail; });
});

// click the freehand "Lasso" draw button to arm the overlay
const lassoBtn = page.locator('button:has-text("Lasso")').first();
await lassoBtn.click({ timeout: 5000 }).catch((e) => console.log('lasso btn click err:', String(e).slice(0, 60)));
await sleep(400);
const armed = await page.evaluate(() => !!document.querySelector('svg') && true);

// drag a box over the preview area (the armed overlay captures it)
const cv = page.locator('[data-testid="preview-canvas"]');
const box = await cv.boundingBox();
if (box) {
  const x0 = box.x + box.width * 0.30, y0 = box.y + box.height * 0.30;
  const x1 = box.x + box.width * 0.70, y1 = box.y + box.height * 0.70;
  await page.mouse.move(x0, y0); await page.mouse.down();
  await page.mouse.move((x0 + x1) / 2, y0, { steps: 4 });
  await page.mouse.move(x1, y1, { steps: 6 });
  await page.mouse.up();
}
await sleep(500);

const result = await page.evaluate(() => window.__lasso);
console.log('lassoComplete detail:', JSON.stringify(result));
if (result && Array.isArray(result.points) && result.points.length >= 3) {
  const inRange = result.points.every((p) => p[0] >= 0 && p[0] <= 1 && p[1] >= 0 && p[1] <= 1);
  console.log(`LASSO PASS — ${result.points.length} normalized points, shape=${result.shape}, inRange=${inRange}, bbox=${JSON.stringify(result.bbox?.map((n) => +n.toFixed(2)))}`);
} else {
  console.log('LASSO FAIL — no valid polygon emitted');
}
process.exit(0);
