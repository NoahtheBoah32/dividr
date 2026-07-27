/** Counts real store notifications per second during playback. */
import { chromium } from 'playwright-core';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b = await chromium.connectOverCDP('http://localhost:9222');
let page = null;
for (const c of b.contexts())
  for (const p of c.pages()) if (/5173/.test(p.url())) page = p;
await page.bringToFront();

const r = await (async () => {
  await page.evaluate(() => {
    const store = window.__videoEditorStore;
    let notifies = 0;
    let tlChanges = 0;
    let frameChanges = 0;
    let prevTl = store.getState().timeline;
    let prevFrame = prevTl.currentFrame;
    window.__unsub = store.subscribe((s) => {
      notifies++;
      if (s.timeline !== prevTl) {
        tlChanges++;
        prevTl = s.timeline;
      }
      if (s.timeline.currentFrame !== prevFrame) {
        frameChanges++;
        prevFrame = s.timeline.currentFrame;
      }
    });
    window.__counts = () => ({ notifies, tlChanges, frameChanges });
    store.getState().play?.();
    setTimeout(() => window.__videoEditorStore.getState().pause?.(), 3000);
  });
  await sleep(3500);
  return page.evaluate(() => {
    const c = window.__counts();
    window.__unsub?.();
    delete window.__unsub;
    delete window.__counts;
    return c;
  });
})();

console.log(
  `over 3s of playback:  store notifies=${r.notifies}  new timeline objects=${r.tlChanges}  distinct currentFrame values=${r.frameChanges}`,
);
console.log(
  r.tlChanges > r.frameChanges * 1.5
    ? '=> dedupe is NOT live (more objects than distinct values)'
    : '=> dedupe IS live',
);
process.exit(0);
