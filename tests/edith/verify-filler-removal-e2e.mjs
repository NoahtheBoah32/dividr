// #91+#92 acceptance — the user's exact flow with real EDITH:
// recording handed to EDITH's chat (same path the recorder button takes) →
// "remove all the filler words" → she emits a FRESH removeFillersFromMedia op
// (tracked by op id, not string — leftover ops from earlier runs don't count),
// pipeline transcribes+cuts real um/uhs, "Filler removed quarterly-recap" lands
// in the media panel, and she never runs the transcription op separately.
import { chromium } from 'playwright-core';
import { ensureFixtures } from '../fixtures/ensure-fixtures.mjs';

const FIX = ensureFixtures().quarterly;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b = await chromium.connectOverCDP('http://localhost:9222');
let page;
for (const c of b.contexts()) for (const p of c.pages()) if (p.url().includes('localhost:517') && !p.url().startsWith('blob:')) page = p;
if (!page) { console.log('NO PAGE'); process.exit(1); }

await page.evaluate(async () => { try { await window.__dividrTest.openProjectByTitle('SKILLS-93-TEST'); } catch {} });
await sleep(3000);
await page.evaluate(() => window.__dividrTest.openPanel('friday'));
await sleep(2000);

// baseline: op ids already in the queue + capture the next result event
const preIds = await page.evaluate(() => {
  window.__e2eFillerResult = null;
  window.addEventListener('edith:removeFillersFileResult', (e) => { window.__e2eFillerResult = e.detail; }, { once: true });
  return window.__dividrTest.getOpQueue().map((o) => o.id);
});

// hand the file to EDITH exactly like the recorder button does
await page.evaluate((fp) => window.__dividrTest.sendMediaToEdith({ name: 'Camera recording 23.40', path: fp }), FIX);
await sleep(600);

await page.locator('[data-testid="edith-input"]').fill('In this recording, could you remove all the filler words — all the times I say um and uh?');
await page.locator('[data-testid="edith-input"]').press('Enter');
console.log('sent — watching for up to 8 min…');

const t0 = Date.now();
let freshOps = [];
let result = null;
while (Date.now() - t0 < 480000) {
  await sleep(5000);
  const state = await page.evaluate((pre) => {
    const q = window.__dividrTest.getOpQueue();
    return {
      fresh: q.filter((o) => !pre.includes(o.id)).map((o) => `${o.type}:${o.status}${o.error ? ':' + String(o.error).slice(0, 90) : ''}`),
      result: window.__e2eFillerResult,
    };
  }, preIds);
  for (const o of state.fresh) if (!freshOps.includes(o)) { freshOps.push(o); console.log('new op:', o); }
  if (state.result) { result = state.result; break; }
}

// give the continue-narration turn a moment, then read the chat tail
await sleep(20000);
const chatTail = await page.evaluate(() => {
  const els = [...document.querySelectorAll('div,p,span')].filter(
    (e) => e.childElementCount === 0 && (e.textContent || '').trim().length > 10,
  );
  return els.slice(-12).map((e) => e.textContent.trim().slice(0, 200));
});
console.log('--- chat tail ---\n' + chatTail.join('\n'));
console.log('result event:', JSON.stringify(result));

const lib = await page.evaluate(() => {
  const s = window.__dividrTest.getStoreSnapshot();
  return (s.mediaLibrary ?? []).filter((m) => (m.name ?? '').includes('quarterly-recap')).map((m) => m.name);
});
console.log('library quarterly items:', JSON.stringify(lib));

const opRan = freshOps.some((o) => o.startsWith('removeFillersFromMedia:applied'));
const usedWhisperOp = freshOps.some((o) => o.startsWith('runWhisper:'));
const cutsMade = !!result && result.success && result.removedCount > 0;
const imported = lib.some((n) => n.startsWith('Filler removed'));
console.log(opRan ? 'PASS fresh removeFillersFromMedia op ran' : 'FAIL she never emitted a fresh op');
console.log(!usedWhisperOp ? 'PASS no redundant runWhisper op' : 'FAIL she ran the transcription op separately');
console.log(cutsMade ? `PASS real cuts made (${result.removedCount} words, ${result.removedSec}s)` : 'FAIL no cuts');
console.log(imported ? 'PASS cleaned file imported under Filler removed name' : 'FAIL cleaned file not imported');
process.exit(opRan && !usedWhisperOp && cutsMade && imported ? 0 : 1);
