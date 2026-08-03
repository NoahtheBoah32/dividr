// Resets EDITH to a fresh conversation between deep-gate scripts. Live tests
// share one app instance; without this, every test inherits the full history
// of everything before it and turns get slower and less deterministic.
import { chromium } from 'playwright-core';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b = await chromium.connectOverCDP('http://localhost:9222');
let page;
for (const c of b.contexts()) for (const p of c.pages()) if (p.url().includes('localhost:517') && !p.url().startsWith('blob:')) page = p;
if (!page) { console.log('NO PAGE'); process.exit(1); }

// Make sure we're inside a project — a renderer reload lands on the home screen,
// where the EDITH panel doesn't exist.
const inEditor = await page.evaluate(() => window.location.hash.includes('video-editor'));
if (!inEditor) {
  await page.evaluate(async () => { try { await window.__dividrTest.openProjectByTitle('SKILLS-93-TEST'); } catch {} });
  await sleep(3500);
}
await page.evaluate(() => window.__dividrTest?.openPanel('friday'));
await sleep(1200);
const clicked = await page.evaluate(() => {
  const btn = document.querySelector('button[title="Clear conversation"]');
  if (!btn) return false;
  btn.click();
  return true;
});
if (!clicked) {
  // fall back to the IPC the button ultimately calls
  await page.evaluate(() => window.electronAPI.invoke('mycelium:clearHistory'));
}
await sleep(1500);
console.log(clicked ? 'history cleared via UI button' : 'history cleared via IPC fallback');
process.exit(0);
