import { chromium } from 'playwright-core';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b = await chromium.connectOverCDP('http://localhost:9222');
let page = null;
for (const c of b.contexts()) for (const p of c.pages()) if (/localhost:5173/.test(p.url())) page = p;
if (!page) { console.log('no 5173 page'); process.exit(1); }
await page.addInitScript(() => { window.__dividrTestMode = true; });
await page.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded', timeout: 70000 });
await page.waitForFunction(() => typeof window.__dividrTest?.ping === 'function', { timeout: 40000 });
await page.evaluate(() => { window.location.hash = '#/video-editor'; });
await sleep(1500);
await page.evaluate(() => {
  window.__dividrTest.setStoreState({
    tracks: [{ id: 'clip_a1', type: 'video', name: 'walk3.mp4', source: 'C:/tmp/skills-test/walk3.mp4',
      startFrame: 0, endFrame: 210, duration: 210, sourceStartTime: 0, trackRowIndex: 0, mediaId: 'm1',
      visible: true, locked: false, muted: false, color: '#4A90D9', transform: { x: 0, y: 0, scale: 1, rotation: 0 }, opacity: 1, volume: 1 }],
    timeline: { currentFrame: 20, fps: 30, selectedTrackIds: ['clip_a1'] },
    preview: { canvasWidth: 1280, canvasHeight: 720 },
  });
});
await sleep(1500);
await page.locator('[role="tab"]:has-text("Effects"), button:has-text("Effects")').first().click({ timeout: 5000 }).catch(()=>{});
await sleep(700);
const r = await page.evaluate(() => {
  const t = document.body.innerText || '';
  return { hold: /Hold the World/i.test(t), speed: /In-Frame Speed/i.test(t), find: /Find a Moment/i.test(t),
           findInput: !!document.querySelector('[data-testid="find-input"]') };
});
console.log('Effects tab -> Hold the World:', r.hold, '| In-Frame Speed:', r.speed, '| Find a Moment:', r.find, '| find-input present:', r.findInput);
console.log(r.hold && r.speed && !r.find && !r.findInput ? 'PASS — Find UI removed, two skills intact' : 'CHECK');
process.exit(0);
