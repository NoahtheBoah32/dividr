// Selection tool probe — arm from the chat box, "click" a timeline clip (the same
// setSelectedTracks a real timeline click fires), assert the clip lands as an
// attachment card, single-shot auto-disarm, dedup, persistent mode, Esc exit.
import { chromium } from 'playwright-core';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b = await chromium.connectOverCDP('http://localhost:9222');
let page;
for (const c of b.contexts()) for (const p of c.pages()) if (p.url().includes('localhost:517') && !p.url().startsWith('blob:')) page = p;
if (!page) { console.log('NO PAGE'); process.exit(1); }

await page.evaluate(async () => { try { await window.__dividrTest.openProjectByTitle('SKILLS-93-TEST'); } catch {} });
await sleep(3000);
await page.evaluate(() => window.__dividrTest.openPanel('friday'));
await sleep(2000);

const results = [];
const check = (name, ok, extra = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
};

const tracks = await page.evaluate(() => {
  const s = window.__dividrTest.getStoreSnapshot();
  return (s.tracks ?? []).map((t) => ({ id: t.id, name: t.name, type: t.type }));
});
console.log(`tracks in project: ${tracks.length}`);
if (tracks.length === 0) { console.log('NO TRACKS — cannot test'); process.exit(1); }

const btn = page.locator('[data-testid="edith-selection-tool"]');
check('selection tool button exists', (await btn.count()) === 1);

const footerText = () => page.evaluate(() => {
  const els = [...document.querySelectorAll('p')].map((e) => e.textContent ?? '');
  return els.find((t) => t.includes('selection mode') || t.includes('send ·')) ?? '';
});
const cardCount = () => page.evaluate(
  () => [...document.querySelectorAll('p')].filter((e) => (e.textContent ?? '').includes('on timeline')).length,
);
// getStoreSnapshot() returns the live getState() object, actions included — this is
// the same setSelectedTracks a real timeline click fires.
const selectClip = (id) => page.evaluate((tid) => {
  window.__dividrTest.getStoreSnapshot().setSelectedTracks([tid]);
}, id);

// 1 — arm (single-shot)
await btn.click();
await sleep(300);
check('arming shows selection-mode hint', (await footerText()).includes('selection mode'));

// 2 — picking a clip attaches the card and auto-disarms
await selectClip(tracks[0].id);
await sleep(400);
check('clip attached as card', (await cardCount()) === 1, `cards=${await cardCount()}`);
check('single-shot auto-disarmed', !(await footerText()).includes('selection mode'));

// 3 — dedup: re-arm, pick the same clip again → still one card
await btn.click();
await sleep(200);
await selectClip(tracks[0].id);
await sleep(400);
check('same clip not attached twice', (await cardCount()) === 1, `cards=${await cardCount()}`);

// 4 — persistent mode via double-click; stays armed across picks
await page.evaluate(() => window.__dividrTest.openPanel('friday')); // re-assert vs stray clicks in the live app
await sleep(300);
await btn.dblclick();
await sleep(300);
check('persistent mode hint', (await footerText()).includes('stays on'));
if (tracks.length > 1) {
  await selectClip(tracks[1].id);
  await sleep(400);
  check('second clip attached in persistent mode', (await cardCount()) === 2, `cards=${await cardCount()}`);
  check('persistent stays armed after pick', (await footerText()).includes('stays on'));
} else {
  console.log('SKIP persistent-pick checks (single-track project)');
}

// 5 — Esc exits
await page.keyboard.press('Escape');
await sleep(300);
check('Esc disarms', !(await footerText()).includes('selection mode'));

// 6 — remove cards via ×, leave a clean slate
await page.evaluate(() => {
  document.querySelectorAll('[aria-label="Remove clip"]').forEach((el) => el.click());
});
await sleep(300);
check('cards removable', (await cardCount()) === 0, `cards=${await cardCount()}`);

console.log(results.every(Boolean) ? 'ALL PASS' : 'SOME FAILED');
process.exit(results.every(Boolean) ? 0 : 1);
