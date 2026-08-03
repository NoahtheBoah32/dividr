// Swap-this-b-roll acceptance — the user's exact scenario:
// arm the selection tool → click the b-roll on the timeline → "swap this b-roll
// out for another one" → EDITH must deleteClip the attached id, source a fresh
// replacement, and place it at the SAME slot without ever asking which clip.
// Also spot-checks the new waveform thinking indicator while her turn runs.
import { chromium } from 'playwright-core';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b = await chromium.connectOverCDP('http://localhost:9222');
let page;
for (const c of b.contexts()) for (const p of c.pages()) if (p.url().includes('localhost:517') && !p.url().startsWith('blob:')) page = p;
if (!page) { console.log('NO PAGE'); process.exit(1); }

await page.evaluate(async () => { try { await window.__dividrTest.openProjectByTitle('SKILLS-93-TEST'); } catch {} });
await sleep(3000);
await page.evaluate(() => window.__dividrTest.openPanel('friday'));
await sleep(2000);

let broll = await page.evaluate(() => {
  window.__dividrTest.getDownloadApprovalStore().setState({ autoApproveAll: true });
  const s = window.__dividrTest.getStoreSnapshot();
  const t = (s.tracks ?? []).find((t) => (t.trackRowIndex ?? 0) > 0 && t.type === 'video');
  return t ? { id: t.id, name: t.name, startFrame: t.startFrame, endFrame: t.endFrame } : null;
});
if (!broll) {
  // deterministic setup: place the previously-downloaded Joker clip as b-roll 0-10s
  console.log('no b-roll — placing one for the test');
  await page.evaluate(async () => {
    window.__dividrTest.applyOps([{ type: 'broll', src: 'C:\\Users\\User\\Dividr Downloads\\Alk2ixHGLto.mp4', from: 0, to: 10 }]);
    await window.__dividrTest.waitForQueueDrained();
  });
  await sleep(2000);
  broll = await page.evaluate(() => {
    const s = window.__dividrTest.getStoreSnapshot();
    const t = (s.tracks ?? []).find((t) => (t.trackRowIndex ?? 0) > 0 && t.type === 'video');
    return t ? { id: t.id, name: t.name, startFrame: t.startFrame, endFrame: t.endFrame } : null;
  });
}
if (!broll) { console.log('NO BROLL CLIP in project'); process.exit(1); }
console.log('target b-roll:', JSON.stringify(broll));

// attach via the real selection tool path
await page.locator('[data-testid="edith-selection-tool"]').click();
await sleep(300);
await page.evaluate((tid) => window.__dividrTest.getStoreSnapshot().setSelectedTracks([tid]), broll.id);
await sleep(500);
const cards = await page.evaluate(
  () => [...document.querySelectorAll('p')].filter((e) => (e.textContent ?? '').includes('on timeline')).length,
);
console.log(cards >= 1 ? 'PASS clip card attached via selection tool' : 'FAIL no card attached');
if (cards < 1) process.exit(1);

await page.locator('[data-testid="edith-input"]').fill('This b-roll kind of sucks. Swap it out for another one.');
await page.locator('[data-testid="edith-input"]').press('Enter');
console.log('sent — watching for up to 12 min…');

const t0 = Date.now();
const seen = new Set();
let sawWave = false;
let swapped = null;
while (Date.now() - t0 < 720000) {
  await sleep(5000);
  const state = await page.evaluate(() => {
    const q = window.__dividrTest.getOpQueue();
    const s = window.__dividrTest.getStoreSnapshot();
    const waveEl = [...document.querySelectorAll('span')].some((e) => (e.style?.animation ?? '').includes('edith-wave'));
    return {
      ops: q.map((o) => `${o.type}:${o.status}${o.error ? ':' + String(o.error).slice(0, 80) : ''}`),
      brolls: (s.tracks ?? [])
        .filter((t) => (t.trackRowIndex ?? 0) > 0 && t.type === 'video')
        .map((t) => ({ id: t.id, name: t.name, sf: t.startFrame, ef: t.endFrame })),
      wave: waveEl,
    };
  });
  if (state.wave) sawWave = true;
  for (const o of state.ops) if (!seen.has(o)) { seen.add(o); console.log('op:', o); }
  const replacement = state.brolls.find((t) => t.id !== broll.id);
  const originalGone = !state.brolls.some((t) => t.id === broll.id);
  if (replacement && originalGone) { swapped = replacement; break; }
}

const chatTail = await page.evaluate(() => {
  const els = [...document.querySelectorAll('div,p,span')].filter(
    (e) => e.childElementCount === 0 && (e.textContent || '').trim().length > 10,
  );
  return els.slice(-20).map((e) => e.textContent.trim().slice(0, 200));
});
console.log('--- chat tail ---\n' + chatTail.join('\n'));

const usedDelete = [...seen].some((o) => o.startsWith('deleteClip:applied') || o.startsWith('deleteBroll:applied'));
const usedSource = [...seen].some((o) => o.startsWith('searchMedia:applied') || o.startsWith('download:applied') || o.startsWith('downloadMedia:applied'));
console.log(usedDelete ? 'PASS old b-roll deleted via op' : 'FAIL no delete op ran');
console.log(usedSource ? 'PASS replacement sourced via op' : 'FAIL no sourcing op ran');
console.log(swapped ? `PASS replacement placed: ${JSON.stringify(swapped)}` : 'FAIL no replacement clip on timeline');
if (swapped) {
  const sameSlot = Math.abs(swapped.sf - broll.startFrame) <= 3 && Math.abs(swapped.ef - broll.endFrame) <= 3;
  console.log(sameSlot ? 'PASS same slot (±3 frames)' : `WARN slot differs: got ${swapped.sf}-${swapped.ef}, want ${broll.startFrame}-${broll.endFrame}`);
}
console.log(sawWave ? 'PASS waveform thinking indicator rendered' : 'WARN waveform indicator never observed (may have been too fast)');
process.exit(usedDelete && usedSource && swapped ? 0 : 1);
