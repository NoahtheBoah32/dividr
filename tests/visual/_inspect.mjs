import { chromium } from 'playwright-core';
const b = await chromium.connectOverCDP('http://localhost:9222');
let page = null;
for (const c of b.contexts()) for (const p of c.pages()) if (/localhost:5173/.test(p.url())) page = p;
if (!page) { console.log('no 5173 page'); process.exit(1); }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
await page.addInitScript(() => {
  window.__dividrTestMode = true;
  try { for (const k of ['default', 'null', 'undefined']) localStorage.setItem(`edith-consent-${k}`, 'true'); } catch {}
});

// 1) base load
await page.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof window.__dividrTest?.ping === 'function', { timeout: 20000 });
console.log('1) base loaded, url=', page.url());

// 2) inject a clip
await page.evaluate(() => {
  window.__dividrTest.setStoreState({
    tracks: [{ id: 'clip_a1', type: 'video', name: 'walk2.mp4', source: 'C:/tmp/skills-test/walk2.mp4',
      startFrame: 0, endFrame: 175, duration: 175, sourceStartTime: 0, trackRowIndex: 0, mediaId: 'm1',
      visible: true, locked: false, muted: false, color: '#4A90D9' }],
    timeline: { currentFrame: 8, fps: 25, selectedTrackIds: ['clip_a1'] },
    preview: { canvasWidth: 1280, canvasHeight: 720 },
  });
});

// 3) hash-nav to editor
await page.evaluate(() => { window.location.hash = '#/video-editor'; });
await sleep(1800);
const step3 = await page.evaluate(() => ({
  url: location.href,
  isEditor: !/Your Projects|projects/i.test((document.body.innerText || '').slice(0, 60)),
  bodyHead: (document.body.innerText || '').slice(0, 90).replace(/\n+/g, ' / '),
  edithBtns: [...document.querySelectorAll('button,[role=button],[title]')]
    .filter(e => /E\.?D\.?I\.?T\.?H/i.test((e.getAttribute('title') || '') + (e.getAttribute('aria-label') || '') + (e.textContent || '')))
    .map(e => (e.getAttribute('title') || e.textContent || '').trim().slice(0, 20)),
  textareas: [...document.querySelectorAll('textarea')].map(t => t.placeholder),
}));
console.log('3) after hash-nav:', JSON.stringify(step3, null, 1));

// 4) click the E.D.I.T.H toolbar button
const clicked = await page.evaluate(() => {
  const btn = [...document.querySelectorAll('button,[role=button],[title]')]
    .find(e => /E\.?D\.?I\.?T\.?H/i.test((e.getAttribute('title') || '') + (e.textContent || '')));
  if (btn) { btn.click(); return 'clicked ' + (btn.getAttribute('title') || btn.textContent || '').slice(0, 20); }
  return 'no edith button found';
});
console.log('4) edith btn:', clicked);
await sleep(1200);
// pass consent
const agreeClicked = await page.evaluate(() => {
  const a = [...document.querySelectorAll('button')].find(b => /^agree$/i.test((b.textContent || '').trim()));
  if (a) { a.click(); return 'agreed'; } return 'no-agree';
});
console.log('   consent:', agreeClicked);
await sleep(1200);
const final = await page.evaluate(() => ({
  textareas: [...document.querySelectorAll('textarea')].map(t => ({ ph: t.placeholder, vis: t.offsetParent !== null })),
}));
console.log('5) FINAL textareas:', JSON.stringify(final));
process.exit(0);
