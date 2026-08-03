// #77 Test B step 3 — single self-contained turn: WebFetch a Commons file page,
// extract the original file URL, emit download op with direct url, file lands.
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

await page.evaluate(() => window.__dividrTest.openPanel('friday'));
await sleep(2000);

await page.evaluate(async () => {
  await window.electronAPI.invoke('mycelium:sendMessage', {
    text:
      'Download this exact Wikimedia Commons video: https://commons.wikimedia.org/wiki/File:RiceTerrace.theora.ogv ' +
      '— fetch that file page to get the direct original-file URL, then emit the download op with that url. ' +
      'Do not search for alternatives, do not ask questions, do not place anything on the timeline.',
    mediaContext: [],
    timelineSnapshot: undefined,
    activeDownloads: [],
    sfxLibrary: [],
  });
});
console.log('sent — watching op queue + Dividr Downloads for up to 8 min…');

const t0 = Date.now();
let newFile = null;
let opSeen = null;
while (Date.now() - t0 < 480000 && !newFile) {
  await sleep(8000);
  if (!opSeen) {
    opSeen = await page.evaluate(() => {
      const q = window.__dividrTest.getOpQueue();
      const hit = q.find((e) => e.op && typeof e.op.url === 'string' && /upload\.wikimedia\.org/i.test(e.op.url));
      return hit ? { url: hit.op.url.slice(0, 120), status: hit.status, error: hit.error && String(hit.error).slice(0, 150) } : null;
    });
    if (opSeen) console.log('download op enqueued:', JSON.stringify(opSeen));
  }
  if (fs.existsSync(dlDir)) {
    for (const f of fs.readdirSync(dlDir)) {
      if (!before.has(f) && !f.endsWith('.part') && !f.endsWith('.ytdl')) {
        const size = fs.statSync(path.join(dlDir, f)).size;
        if (size > 100000) newFile = { name: f, size };
      }
    }
  }
}
console.log(opSeen ? 'PASS  EDITH emitted download op with direct wikimedia url' : 'FAIL  no direct-url download op seen');
console.log(
  newFile
    ? `PASS  web-sourced file landed: ${newFile.name} (${(newFile.size / 1e6).toFixed(1)} MB)`
    : 'FAIL  no downloaded file within 8 min',
);
process.exit(opSeen && newFile ? 0 : 1);
