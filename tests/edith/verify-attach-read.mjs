import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const dir = path.join(os.tmpdir(), 'edith-attachments');
const scriptFile = fs.readdirSync(dir).filter((f) => f.includes('demo script')).pop();
if (!scriptFile) { console.log('no demo script in temp'); process.exit(1); }
const full = path.join(dir, scriptFile);
console.log('attaching:', full);

const b = await chromium.connectOverCDP('http://localhost:9222');
let page;
for (const c of b.contexts()) for (const p of c.pages()) if (p.url().includes('localhost:5173')) page = p;

await page.evaluate(async (p) => {
  await window.electronAPI.invoke('mycelium:sendMessage', {
    text:
      'What is the FIRST line of the attached file? Reply with exactly that line and nothing else. Do not emit any ops.\n\n[Attached: ' +
      p + ']',
    mediaContext: [],
    timelineSnapshot: undefined,
    activeDownloads: [],
    sfxLibrary: [],
  });
}, full);
console.log('sent — waiting for her reply…');

const t0 = Date.now();
let reply = null;
while (Date.now() - t0 < 180000) {
  await new Promise((r) => setTimeout(r, 5000));
  reply = await page.evaluate(() => {
    const els = [...document.querySelectorAll('div, p, span')];
    const hit = els.reverse().find(
      (e) => e.childElementCount === 0 && /INT\. GARAGE/i.test(e.textContent || ''),
    );
    return hit ? hit.textContent.trim().slice(0, 120) : null;
  });
  if (reply) break;
}
console.log(
  reply
    ? 'PASS  EDITH read the attachment: ' + JSON.stringify(reply)
    : 'FAIL  no reply quoting the file within 3 min',
);
process.exit(reply ? 0 : 1);
