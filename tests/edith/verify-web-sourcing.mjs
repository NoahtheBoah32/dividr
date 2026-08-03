// #77 Test B — full ladder: EDITH uses WebSearch/WebFetch to find CC footage on
// Wikimedia Commons and downloads it via the direct-url download op.
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dlDir = path.join(os.homedir(), 'Dividr Downloads');
const before = new Set(fs.existsSync(dlDir) ? fs.readdirSync(dlDir) : []);

const b = await chromium.connectOverCDP('http://localhost:9222');
let page;
for (const c of b.contexts()) for (const p of c.pages()) if (p.url().includes('localhost:5173')) page = p;
if (!page) { console.log('NO PAGE'); process.exit(1); }

// EDITH's replies/ops only land if the friday panel is mounted
await page.evaluate(() => window.__dividrTest.openPanel('friday'));
await sleep(3000);

await page.evaluate(async () => {
  await window.electronAPI.invoke('mycelium:sendMessage', {
    text:
      'Source ONE short b-roll clip of rice terraces in the Philippines from Wikimedia Commons — not Pixabay, not YouTube. ' +
      'Use your web search to find a public-domain or Creative Commons video, tell me the exact license, ' +
      'then emit the download op with the direct url. Do not place anything on the timeline yet.',
    mediaContext: [],
    timelineSnapshot: undefined,
    activeDownloads: [],
    sfxLibrary: [],
  });
});
console.log('sent — watching chat + Dividr Downloads for up to 8 min…');

const t0 = Date.now();
let sourcedMsg = null;
let newFile = null;
while (Date.now() - t0 < 480000) {
  await sleep(8000);
  if (!sourcedMsg) {
    sourcedMsg = await page.evaluate(() => {
      const els = [...document.querySelectorAll('div, p, span')];
      const hit = els.reverse().find(
        (e) => e.childElementCount === 0 && /wikimedia|commons|creative commons|public domain|cc[- ]by/i.test(e.textContent || ''),
      );
      return hit ? hit.textContent.trim().slice(0, 300) : null;
    });
    if (sourcedMsg) console.log('EDITH:', sourcedMsg);
  }
  if (fs.existsSync(dlDir)) {
    for (const f of fs.readdirSync(dlDir)) {
      if (!before.has(f) && !f.endsWith('.part') && !f.endsWith('.ytdl')) {
        const size = fs.statSync(path.join(dlDir, f)).size;
        if (size > 200000) newFile = { name: f, size };
      }
    }
  }
  if (sourcedMsg && newFile) break;
}
if (!sourcedMsg || !newFile) {
  const tail = await page.evaluate(() => {
    const els = [...document.querySelectorAll('div,p,span')].filter(
      (e) => e.childElementCount === 0 && (e.textContent || '').trim().length > 10,
    );
    return els.slice(-15).map((e) => e.textContent.trim().slice(0, 200));
  });
  console.log('--- chat tail ---\n' + tail.join('\n'));
}
console.log(sourcedMsg ? 'PASS  EDITH named a free/CC source' : 'FAIL  no source/license message');
console.log(
  newFile
    ? `PASS  web-sourced file downloaded: ${newFile.name} (${(newFile.size / 1e6).toFixed(1)} MB)`
    : 'FAIL  no downloaded file',
);
process.exit(sourcedMsg && newFile ? 0 : 1);
