// #81 acceptance — replay of the eBay failure: user asks for IMAGES off eBay.
// EDITH must source real eBay product photos (i.ebayimg.com, s-l1600), download
// them as images (not videos), and they must land in the media library.
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dlDir = path.join(os.homedir(), 'Dividr Downloads');
// Remove this test's leftovers from previous runs — an existing copy makes the
// downloader short-circuit and "new image landed" can never be satisfied.
if (fs.existsSync(dlDir)) {
  for (const f of fs.readdirSync(dlDir)) {
    if (/fender|stratocaster/i.test(f) && /\.(jpe?g|png|webp|gif|avif)$/i.test(f)) {
      fs.rmSync(path.join(dlDir, f), { force: true });
    }
  }
}
const before = new Set(fs.existsSync(dlDir) ? fs.readdirSync(dlDir) : []);
const IMG_EXT = /\.(jpe?g|png|webp)$/i;

const b = await chromium.connectOverCDP('http://localhost:9222');
let page;
for (let i = 0; i < 40 && !page; i++) {
  for (const c of b.contexts()) for (const p of c.pages()) if (p.url().includes('localhost:5173')) page = p;
  if (!page) await sleep(2000);
}
if (!page) { console.log('NO PAGE'); process.exit(1); }
for (let i = 0; i < 30; i++) {
  const ready = await page.evaluate(() => !!window.__dividrTest?.ping).catch(() => false);
  if (ready) break;
  await sleep(2000);
}

await page.evaluate(async () => await window.__dividrTest.openProjectByTitle('Untitled Project'));
await sleep(4000);
await page.evaluate(() => window.__dividrTest.openPanel('friday'));
await sleep(2500);

const mediaBefore = await page.evaluate(() =>
  (window.__videoEditorStore.getState().mediaLibrary || []).length);

await page.evaluate(async () => {
  await window.electronAPI.invoke('mycelium:sendMessage', {
    text:
      'Find me a high-quality image off eBay of a Fender Stratocaster electric guitar — ' +
      'an actual product photo from a real listing, high resolution, no watermarks.',
    mediaContext: [],
    timelineSnapshot: undefined,
    activeDownloads: [],
    sfxLibrary: [],
  });
});
console.log('sent — watching for image download + approval for up to 10 min…');

const t0 = Date.now();
let imgFile = null;
let approved = false;
let inLibrary = null;
let videoMistake = null;
while (Date.now() - t0 < 600000) {
  await sleep(6000);
  // approval modal → Allow anything (queue was left clean)
  await page.evaluate(() => {
    const modal = [...document.querySelectorAll('div')].find(
      (d) => /Allow EDITH to use this download/i.test(d.textContent || '')
        && d.querySelectorAll('button').length > 0 && d.querySelectorAll('button').length < 8,
    );
    if (!modal) return;
    const btn = [...modal.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Allow');
    if (btn) btn.click();
  }).then((r) => { if (r) approved = true; });
  if (fs.existsSync(dlDir)) {
    for (const f of fs.readdirSync(dlDir)) {
      if (before.has(f)) continue;
      const full = path.join(dlDir, f);
      const size = fs.statSync(full).size;
      if (IMG_EXT.test(f) && size > 20000 && !imgFile) imgFile = { name: f, kb: Math.round(size / 1024) };
      if (/\.(mp4|webm|mkv)$/i.test(f) && size > 100000) videoMistake = f;
    }
  }
  inLibrary = await page.evaluate((n) => {
    const lib = window.__videoEditorStore.getState().mediaLibrary || [];
    if (lib.length <= n) return null;
    const it = lib[lib.length - 1];
    return { name: it.name || (it.source || '').split(/[\\/]/).pop(), type: it.type || it.fileType };
  }, mediaBefore);
  if (imgFile && inLibrary) break;
}

console.log(imgFile ? `PASS  image file downloaded: ${imgFile.name} (${imgFile.kb} KB)` : 'FAIL  no image file downloaded');
console.log(videoMistake ? `FAIL  she downloaded a VIDEO (the old failure mode): ${videoMistake}` : 'PASS  no video downloaded for an image request');
console.log(inLibrary ? `PASS  media library gained: ${JSON.stringify(inLibrary)}` : 'FAIL  media library unchanged');
if (!imgFile || videoMistake) {
  const tail = await page.evaluate(() => {
    const els = [...document.querySelectorAll('div,p,span')].filter(
      (e) => e.childElementCount === 0 && (e.textContent || '').trim().length > 15);
    return els.slice(-10).map((e) => e.textContent.trim().slice(0, 200));
  });
  console.log('--- chat tail ---\n' + tail.join('\n'));
}
process.exit(imgFile && !videoMistake && inLibrary ? 0 : 1);
