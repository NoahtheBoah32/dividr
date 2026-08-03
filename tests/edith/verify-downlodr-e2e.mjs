// #83 acceptance — real EDITH sources the Joker clapping scene end-to-end:
// searchMedia (reason over candidates) → download (chosen url + verify) →
// contact-sheet verification → auto-approve import → broll placement on timeline.
import { chromium } from 'playwright-core';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b = await chromium.connectOverCDP('http://localhost:9222');
let page;
for (const c of b.contexts()) for (const p of c.pages()) if (p.url().includes('localhost:517') && !p.url().startsWith('blob:')) page = p;
if (!page) { console.log('NO PAGE'); process.exit(1); }

await page.evaluate(async () => { try { await window.__dividrTest.openProjectByTitle('SKILLS-93-TEST'); } catch {} });
await sleep(3000);
await page.evaluate(() => window.__dividrTest.openPanel('friday'));
await sleep(2500);

const baseline = await page.evaluate(() => {
  window.__dividrTest.getDownloadApprovalStore().setState({ autoApproveAll: true });
  const s = window.__dividrTest.getStoreSnapshot();
  return { tracks: (s.tracks ?? []).length, media: (s.mediaLibrary ?? s.mediaItems ?? []).length ?? 0 };
});
console.log('baseline:', JSON.stringify(baseline));

await page.evaluate(async () => {
  await window.electronAPI.invoke('mycelium:sendMessage', {
    text: 'Get me the Joker clapping scene from The Dark Knight and put it on my timeline at the current playhead.',
    mediaContext: [],
    timelineSnapshot: undefined,
    activeDownloads: [],
    sfxLibrary: [],
  });
});
console.log('sent — watching ops/timeline for up to 12 min…');

const t0 = Date.now();
const seen = new Set();
let placed = false;
while (Date.now() - t0 < 720000) {
  await sleep(6000);
  const state = await page.evaluate(() => {
    const q = window.__dividrTest.getOpQueue();
    const s = window.__dividrTest.getStoreSnapshot();
    return {
      ops: q.map((o) => `${o.type}:${o.status}${o.error ? ':' + String(o.error).slice(0, 80) : ''}`),
      tracks: (s.tracks ?? []).map((t) => ({ name: t.name, layer: t.trackRowIndex ?? 0, sf: t.startFrame, ef: t.endFrame })),
    };
  });
  for (const o of state.ops) if (!seen.has(o)) { seen.add(o); console.log('op:', o); }
  const brollTrack = state.tracks.find((t) => t.layer > 0);
  if (brollTrack && state.ops.some((o) => o.startsWith('broll:applied'))) {
    console.log('PLACED:', JSON.stringify(brollTrack));
    placed = true;
    break;
  }
}

const chatTail = await page.evaluate(() => {
  const els = [...document.querySelectorAll('div,p,span')].filter(
    (e) => e.childElementCount === 0 && (e.textContent || '').trim().length > 10,
  );
  return els.slice(-25).map((e) => e.textContent.trim().slice(0, 220));
});
console.log('--- chat tail ---\n' + chatTail.join('\n'));

const usedSearch = [...seen].some((o) => o.startsWith('searchMedia:applied'));
// the queue logs the V2 op name 'download'; the internal translation is 'downloadMedia'
const usedDownload = [...seen].some((o) => o.startsWith('download:applied') || o.startsWith('downloadMedia:applied'));
console.log(usedSearch ? 'PASS searchMedia op ran' : 'FAIL searchMedia op never ran');
console.log(usedDownload ? 'PASS download op ran' : 'FAIL download op never ran');
console.log(placed ? 'PASS clip placed on timeline' : 'FAIL nothing placed');
process.exit(usedSearch && usedDownload && placed ? 0 : 1);
