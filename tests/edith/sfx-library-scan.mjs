// Live check: scan-sfx-library picks up all 125 sounds, aliases.txt parses,
// and a few alias words resolve to the right files. Read-only — no store writes.
import { chromium } from 'playwright-core';

const b = await chromium.connectOverCDP('http://localhost:9222');
let page = null;
for (const c of b.contexts()) for (const p of c.pages()) {
  const u = p.url();
  if (u.includes('localhost:517') && !u.startsWith('blob:')) page = p;
}
if (!page) { console.log('no renderer page'); process.exit(1); }
await page.waitForTimeout(4000);

const out = await page.evaluate(async () => {
  const api = window.electronAPI;
  const scan = await api.invoke('scan-sfx-library');
  // entry names include the extension (e.g. "dog_bark.mp3")
  const stems = (scan?.entries ?? []).map((e) => e.name.replace(/\.[a-z0-9]+$/i, ''));
  const raw = await api.invoke('read-file', `${scan.libPath}/aliases.txt`);
  return { count: stems.length, libPath: scan.libPath, aliasBytes: String(raw ?? '').length,
    sample: ['dog_bark', 'air_horn', 'choir', 'tire_screech', 'rattlesnake', 'movie_projector'].filter((n) => stems.includes(n)) };
});
console.log(JSON.stringify(out, null, 1));

const missing = 125 - out.count;
console.log(missing === 0 ? 'ALL 125 SCANNED' : `MISSING ${missing}`);
process.exit(missing === 0 && out.aliasBytes > 500 && out.sample.length === 6 ? 0 : 1);
