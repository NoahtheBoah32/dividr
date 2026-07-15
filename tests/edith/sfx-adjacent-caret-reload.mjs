// Hard-reload the renderer (forces the CURRENT bundle — HMR in this app is
// unreliable), reopen the project, navigate back to the transcript panel, then
// re-run the adjacent-SFX caret repro: click the *sfx* token, type one char,
// assert the buffer spawns right after the token. Escape cleans up.
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

// Reopen the project if the picker is showing.
let opened = false;
for (let i = 0; i < 6 && !opened; i++) {
  opened = await page.evaluate(() => {
    const s = window.__dividrTest?.getStoreSnapshot?.();
    return location.hash.includes('video-editor') &&
      (s?.tracks?.filter((t) => t.type === 'video').length ?? 0) >= 1;
  }).catch(() => false);
  if (opened) break;
  await page.evaluate(() => {
    const open = Array.from(document.querySelectorAll('button')).find(
      (x) => x.textContent?.trim() === 'Open',
    );
    open?.click();
  }).catch(() => {});
  await page.waitForTimeout(5000);
}
if (!opened) { console.log('FAILED: could not reopen a project'); process.exit(1); }
await page.waitForTimeout(3000);

// Select the main video track through the store so the properties panel shows it.
const selInfo = await page.evaluate(() => {
  const st = window.__dividrTest.getStoreSnapshot();
  const main = st.tracks.find((t) => t.type === 'video' && (t.trackRowIndex ?? 0) === 0)
    ?? st.tracks.find((t) => t.type === 'video');
  if (!main) return { ok: false, why: 'no video track' };
  const actions = Object.keys(st).filter((k) => /select/i.test(k) && typeof st[k] === 'function');
  for (const name of ['setSelectedTrack', 'selectTrack', 'setSelectedTrackId', 'setSelectedTracks']) {
    if (typeof st[name] === 'function') {
      try { st[name](name.endsWith('s') ? [main.id] : main.id); return { ok: true, used: name, actions }; } catch {}
    }
  }
  return { ok: false, why: 'no selection action', actions };
});
console.log('select:', JSON.stringify(selInfo));
await page.waitForTimeout(1500);

// Make sure the transcript section is on screen; click a Transcript/Audio tab if needed.
for (let i = 0; i < 4; i++) {
  const visible = await page.evaluate(() => !!document.querySelector('[data-transcript-help]'));
  if (visible) break;
  const clicked = await page.evaluate(() => {
    const cands = Array.from(document.querySelectorAll('button,[role="tab"]'))
      .filter((x) => /^(transcript|audio)$/i.test((x.textContent ?? '').trim()));
    const pick = cands.find((x) => /transcript/i.test(x.textContent ?? '')) ?? cands[0];
    if (!pick) return null;
    pick.click();
    return pick.textContent?.trim();
  });
  console.log('opened tab:', clicked);
  await page.waitForTimeout(1200);
  if (!clicked) break;
}

const pre = await page.evaluate(() => ({
  markers: document.querySelectorAll('[data-mk-sfx]').length,
  editorOpen: !!document.querySelector('[data-transcript-help]'),
}));
console.log('pre:', JSON.stringify(pre));
if (!pre.markers) { console.log('BLOCKED: transcript panel/marker not reachable after reload'); process.exit(2); }

await page.locator('[data-mk-sfx]').first().scrollIntoViewIfNeeded().catch(() => {});
await page.locator('[data-mk-sfx]').first().click({ position: { x: 8, y: 6 } });
await page.waitForTimeout(300);
await page.keyboard.type('z');
await page.waitForTimeout(400);

const result = await page.evaluate(() => {
  const t = document.querySelector('[data-typing]');
  if (!t) return { spawned: false };
  const prev = t.previousElementSibling;
  let n = t, word = null;
  while (n) {
    n = n.previousElementSibling;
    if (n?.hasAttribute?.('data-wid')) { word = n.textContent; break; }
  }
  return {
    spawned: true,
    bufferText: t.textContent,
    prevIsMarker: !!prev?.hasAttribute?.('data-mk-sfx'),
    nearestWordBefore: word,
  };
});
console.log('typing buffer:', JSON.stringify(result));

await page.keyboard.press('Escape');
await page.waitForTimeout(200);

const ok = result.spawned && result.prevIsMarker;
console.log(ok ? 'PASS — buffer spawned right after the *sfx* token' : 'FAIL — buffer landed elsewhere');
process.exit(ok ? 0 : 1);
