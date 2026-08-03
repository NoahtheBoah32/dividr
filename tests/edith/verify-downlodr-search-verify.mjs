// #83 Downlodr integration — op-level probe (temp, delete after run)
// 1. media:searchMedia returns reasoned-over-able candidates
// 2. media:downloadFromUrl with verify → contact-sheet verification passes on a real Joker clip
import { chromium } from 'playwright-core';

const b = await chromium.connectOverCDP('http://localhost:9222');
let page = null;
for (const c of b.contexts()) for (const p of c.pages()) {
  const u = p.url();
  if (u.includes('localhost:517') && !u.startsWith('blob:')) page = p;
}
if (!page) { console.log('FAIL: no app page'); process.exit(1); }

// Open a project so the full store is alive (fresh boot lands on the picker)
await page.evaluate(async () => {
  if (!document.querySelector('[data-testid], .timeline, canvas')) return;
});
const opened = await page.evaluate(async () => {
  const t = window.__dividrTest;
  if (!t) return 'no-bridge';
  try { await t.openProjectByTitle('SKILLS-93-TEST'); return 'opened'; } catch (e) { return 'open-skip: ' + e.message; }
});
console.log('project:', opened);
await page.waitForTimeout(3000);

// ── 1. searchMedia IPC ─────────────────────────────────────────────
const search = await page.evaluate(async () => {
  return await window.electronAPI.invoke('media:searchMedia', { query: 'the dark knight joker clapping scene', count: 6 });
});
const c0 = search?.candidates?.[0];
const searchOk = search?.success && search.candidates.length >= 3 && c0.title && c0.url && c0.durationSec != null;
console.log(searchOk ? 'PASS searchMedia' : 'FAIL searchMedia', JSON.stringify(search).slice(0, 400));
if (!searchOk) process.exit(1);

// Pick like EDITH would: shortest clip with >100k views mentioning "clapping"
const pick = search.candidates
  .filter((c) => /clapping/i.test(c.title) && (c.viewCount ?? 0) > 100000 && c.durationSec < 300)
  .sort((a, b) => (b.viewCount ?? 0) - (a.viewCount ?? 0))[0] ?? search.candidates[0];
console.log('picked:', pick.title, pick.url);

// ── 2. download + contact-sheet verify ─────────────────────────────
await page.evaluate(() => {
  window.__dlProbe = { brollCheck: null, msgs: [] };
  // preload's on() passes the raw ipc listener — first arg is the event, second the payload
  window.electronAPI.on('edith:brollCheck', (_e, d) => { window.__dlProbe.brollCheck = { passed: d.passed, reason: d.reason, hasFrame: !!d.frameBase64 }; });
  window.electronAPI.on('mycelium:message', (_e, d) => { window.__dlProbe.msgs.push(d.text); });
});

const dl = await page.evaluate(async (url) => {
  return await window.electronAPI.downloadFromUrl({
    jobId: 'probe-' + Date.now(),
    url,
    verify: 'the Joker with green hair and clown makeup behind bars',
    topic: 'joker clapping scene',
    isStockFootage: false,
  });
}, pick.url);

const probe = await page.evaluate(() => window.__dlProbe);
console.log('download:', JSON.stringify({ success: dl?.success, filePath: dl?.filePath, error: dl?.error }));
console.log('brollCheck:', JSON.stringify(probe.brollCheck));
console.log('pipeline messages:');
for (const m of probe.msgs) console.log('  |', m);

const verifyRan = probe.msgs.some((m) => /Frame-verifying the clip against/i.test(m));
const verifiedMsg = probe.msgs.find((m) => /^Verified:/.test(m));
const pass = dl?.success && dl.filePath && probe.brollCheck?.passed && verifyRan;
console.log(pass ? 'PASS download+contact-sheet-verify' : 'FAIL download+contact-sheet-verify');
if (verifiedMsg) console.log('verified-at:', verifiedMsg);
console.log('FILE:', dl?.filePath ?? 'none');
process.exit(pass ? 0 : 1);
