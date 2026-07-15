// Live repro of the adjacent-SFX caret bug: click a committed *sfx* token,
// type one char, and report WHERE the typing buffer spawned. Cleans up with
// Escape (unfinished buffers never commit anything).
import { chromium } from 'playwright-core';

const b = await chromium.connectOverCDP('http://localhost:9222');
let page = null;
for (const c of b.contexts()) for (const p of c.pages()) {
  const u = p.url();
  if (u.includes('localhost:517') && !u.startsWith('blob:')) page = p;
}
if (!page) { console.log('no renderer page'); process.exit(1); }

const state = await page.evaluate(() => ({
  markers: document.querySelectorAll('[data-mk-sfx]').length,
  editorOpen: !!document.querySelector('[data-transcript-help]'),
}));
console.log('pre:', JSON.stringify(state));
if (!state.markers) { console.log('SKIP: no committed *sfx* token on screen — open the transcript with one visible'); process.exit(1); }

// Click the first *sfx* token exactly like a user (its onClick parks the caret after it).
await page.locator('[data-mk-sfx]').first().click({ position: { x: 8, y: 6 } });
await page.waitForTimeout(300);

const sel0 = await page.evaluate(() => {
  const s = window.getSelection();
  const r = s && s.rangeCount ? s.getRangeAt(0) : null;
  return r
    ? { node: r.startContainer.nodeName, type: r.startContainer.nodeType, offset: r.startOffset,
        text: (r.startContainer.textContent ?? '').slice(0, 40) }
    : null;
});
console.log('caret after token click:', JSON.stringify(sel0));

await page.keyboard.type('z');
await page.waitForTimeout(400);

const result = await page.evaluate(() => {
  const t = document.querySelector('[data-typing]');
  if (!t) return { spawned: false };
  const prev = t.previousElementSibling;
  // walk back to the nearest word span to name the line it landed on
  let n = t;
  let word = null;
  while (n) {
    n = n.previousElementSibling;
    if (n?.hasAttribute?.('data-wid')) { word = n.textContent; break; }
  }
  return {
    spawned: true,
    bufferText: t.textContent,
    prevSibling: prev ? `${prev.tagName}${prev.hasAttribute('data-mk-sfx') ? '[data-mk-sfx]' : ''} "${(prev.textContent ?? '').slice(0, 24)}"` : null,
    nearestWordBefore: word,
  };
});
console.log('typing buffer:', JSON.stringify(result));

await page.keyboard.press('Escape');
await page.waitForTimeout(200);
const clean = await page.evaluate(() => !document.querySelector('[data-typing]'));
console.log('cleanup (buffer cancelled):', clean);

const ok = result.spawned && /data-mk-sfx/.test(result.prevSibling ?? '');
console.log(ok ? 'PASS — buffer spawned right after the *sfx* token' : 'FAIL — buffer landed elsewhere');
process.exit(ok ? 0 : 1);
