// Reload the renderer (HMR unreliable), reopen the project + transcript panel,
// then verify Ctrl+V routing: a synthetic paste must stream into the annotation
// buffer at the caret. Escape cleans up — nothing commits.
import { chromium } from 'playwright-core';

const b = await chromium.connectOverCDP('http://localhost:9222');
let page = null;
for (const c of b.contexts()) for (const p of c.pages()) {
  const u = p.url();
  if (u.includes('localhost:517') && !u.startsWith('blob:')) page = p;
}
if (!page) { console.log('no renderer page'); process.exit(1); }

await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
await page.waitForTimeout(6000);
let opened = false;
for (let i = 0; i < 6 && !opened; i++) {
  opened = await page.evaluate(() => {
    const s = window.__dividrTest?.getStoreSnapshot?.();
    return location.hash.includes('video-editor') &&
      (s?.tracks?.filter((t) => t.type === 'video').length ?? 0) >= 1;
  }).catch(() => false);
  if (opened) break;
  await page.evaluate(() => {
    Array.from(document.querySelectorAll('button')).find((x) => x.textContent?.trim() === 'Open')?.click();
  }).catch(() => {});
  await page.waitForTimeout(5000);
}
if (!opened) { console.log('FAILED: could not reopen project'); process.exit(1); }
await page.waitForTimeout(3000);

await page.evaluate(() => {
  const st = window.__dividrTest.getStoreSnapshot();
  const main = st.tracks.find((t) => t.type === 'video' && (t.trackRowIndex ?? 0) === 0)
    ?? st.tracks.find((t) => t.type === 'video');
  st.setSelectedTracks([main.id]);
});
await page.waitForTimeout(1500);
for (let i = 0; i < 4; i++) {
  if (await page.evaluate(() => !!document.querySelector('[data-transcript-help]'))) break;
  await page.evaluate(() => {
    const cands = Array.from(document.querySelectorAll('button,[role="tab"]'))
      .filter((x) => /^(transcript|audio)$/i.test((x.textContent ?? '').trim()));
    (cands.find((x) => /transcript/i.test(x.textContent ?? '')) ?? cands[0])?.click();
  });
  await page.waitForTimeout(1200);
}

// focus a word, then synthesize a paste (plain text, includes a newline to test flattening)
const ok = await page.evaluate(() => {
  const word = document.querySelector('[data-wid]');
  const editor = word?.closest('[contenteditable]');
  if (!word || !editor) return { ok: false, why: 'no editor' };
  editor.focus();
  const r = document.createRange();
  r.selectNodeContents(word);
  r.collapse(false);
  const s = window.getSelection();
  s.removeAllRanges();
  s.addRange(r);
  const dt = new DataTransfer();
  dt.setData('text/plain', 'hello\npasted');
  editor.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  return { ok: true };
});
console.log('paste dispatched:', JSON.stringify(ok));
await page.waitForTimeout(600);

const buf = await page.evaluate(() => document.querySelector('[data-typing]')?.textContent ?? null);
console.log('buffer after paste:', JSON.stringify(buf));
await page.keyboard.press('Escape');
await page.waitForTimeout(200);
const clean = await page.evaluate(() => !document.querySelector('[data-typing]'));

const pass = buf === 'hello pasted' && clean;
console.log(pass ? 'PASS — paste streams into the buffer (newline flattened), Escape cleans up' : 'FAIL');
process.exit(pass ? 0 : 1);
