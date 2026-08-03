// #77 Test A — download op with a direct `url` field flows through to yt-dlp and lands a file.
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dlDir = path.join(os.homedir(), 'Dividr Downloads');
// Idempotence: yt-dlp skips files that already exist, so clear prior runs' output first.
if (fs.existsSync(dlDir)) {
  for (const f of fs.readdirSync(dlDir)) {
    if (f.toLowerCase().startsWith('schlossbergbahn')) fs.rmSync(path.join(dlDir, f), { force: true });
  }
}
const before = new Set(fs.existsSync(dlDir) ? fs.readdirSync(dlDir) : []);

const b = await chromium.connectOverCDP('http://localhost:9222');
let page;
for (let i = 0; i < 40 && !page; i++) {
  for (const c of b.contexts()) for (const p of c.pages()) if (p.url().includes('localhost:5173')) page = p;
  if (!page) await sleep(2000);
}
if (!page) { console.log('NO PAGE'); process.exit(1); }
await sleep(5000);

await page.evaluate(async () => await window.__dividrTest.openProjectByTitle('Untitled Project'));
await sleep(4000);

console.log('emitting download op with direct url…');
const opResult = await page.evaluate(async () => {
  try {
    await window.__dividrTest.applyOps([{
      type: 'download',
      url: 'https://upload.wikimedia.org/wikipedia/commons/8/87/Schlossbergbahn.webm',
      query: 'schlossbergbahn funicular',
      verify: 'funicular railway car',
      isStockFootage: true,
    }]);
    return { ok: true };
  } catch (e) { return { ok: false, error: String(e) }; }
});
console.log('applyOps:', JSON.stringify(opResult));

// Poll for a new file in Dividr Downloads (4MB file, give it 3 min)
const t0 = Date.now();
let newFile = null;
while (Date.now() - t0 < 180000 && !newFile) {
  await sleep(5000);
  if (fs.existsSync(dlDir)) {
    for (const f of fs.readdirSync(dlDir)) {
      if (!before.has(f)) {
        const full = path.join(dlDir, f);
        const size = fs.statSync(full).size;
        if (size > 500000) newFile = { name: f, size };
      }
    }
  }
}
console.log(
  newFile
    ? `PASS  direct-url download landed: ${newFile.name} (${(newFile.size / 1e6).toFixed(1)} MB)`
    : 'FAIL  no new file in Dividr Downloads within 3 min',
);
process.exit(newFile ? 0 : 1);
