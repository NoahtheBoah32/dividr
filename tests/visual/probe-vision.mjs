// Validate the frame-referencing (Claude vision) build end-to-end through the REAL app:
//   1) FIND an open-vocab subject ("the man walking") -> contact sheet -> jump
//   2) FREEZE world + vision-target the subject ("keep the man walking") -> bake -> swap
import { chromium } from 'playwright-core';
import fs from 'node:fs';
const OUT = 'C:/tmp/skills-test/real-run';
const CLIP = 'C:/tmp/skills-test/clean_walk.mp4';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await chromium.connectOverCDP('http://localhost:9222');
let page = null;
for (const ctx of browser.contexts()) for (const p of ctx.pages()) if (/localhost:5173/.test(p.url())) page = p;
if (!page) { console.log('NO 5173 page'); process.exit(1); }
await page.addInitScript(() => { window.__dividrTestMode = true; });

async function gotoEditor() {
  await page.goto('http://localhost:5173/#/video-editor', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof window.__dividrTest?.ping === 'function', { timeout: 20000 });
}
async function inject() {
  const pv = await page.evaluate(async (p) => { try { const r = await window.electronAPI.createPreviewUrl(p); return r?.url || (typeof r === 'string' ? r : ''); } catch { return ''; } }, CLIP);
  await page.evaluate(({ p, pv }) => {
    window.__dividrTest.setStoreState({
      tracks: [{ id: 'clip_a1', type: 'video', name: 'clean_walk.mp4', source: p, previewUrl: pv, startFrame: 0, endFrame: 150, duration: 150, sourceStartTime: 0, trackRowIndex: 0, mediaId: 'm1', visible: true, locked: false, muted: false, color: '#4A90D9' }],
      mediaLibrary: [{ id: 'm1', name: 'clean_walk.mp4', type: 'video', source: p, previewUrl: pv, duration: 5 }],
      preview: { canvasWidth: 1280, canvasHeight: 720 },
      timeline: { currentFrame: 8, fps: 30, selectedTrackIds: ['clip_a1'] },
    });
  }, { p: CLIP, pv });
}
async function capReset() {
  await page.evaluate(() => {
    window.__cap = { messages: [], ops: [], status: [], find: null, done: false };
    if (!window.__capHooked) {
      window.electronAPI.on('mycelium:message', (_e, d) => { if (d) window.__cap.messages.push(d?.text ?? ''); });
      window.electronAPI.on('mycelium:op', (_e, o) => window.__cap.ops.push(typeof o === 'string' ? o : JSON.stringify(o)));
      window.electronAPI.on('mycelium:done', () => { window.__cap.done = true; });
      window.addEventListener('edith:status', (e) => window.__cap?.status.push(e.detail?.text || ''));
      window.addEventListener('edith:findMomentResult', (e) => { if (window.__cap) window.__cap.find = e.detail; });
      window.__capHooked = true;
    }
  });
}
async function openEdith() {
  if (await page.locator('textarea[placeholder*="EDITH"]').count() === 0) { try { await page.locator('[title="E.D.I.T.H"]').first().click({ timeout: 5000 }); } catch {} }
  const ta = page.locator('textarea[placeholder*="EDITH"]').first();
  await ta.waitFor({ state: 'visible', timeout: 12000 }); return ta;
}
async function snap() { return page.evaluate(() => { const t = window.__dividrTest.getStoreSnapshot().tracks?.[0] || {}; return { source: t.source, sf: t.selectiveFreeze || null }; }); }

async function run(prompt, kind, maxMs) {
  await gotoEditor(); await inject(); const ta = await openEdith(); await capReset(); await sleep(500);
  const before = await snap(); const t0 = Date.now();
  await ta.fill(prompt); await ta.press('Enter');
  let effectMs = null;
  while (Date.now() - t0 < maxMs) {
    const st = await page.evaluate(() => { const t = window.__dividrTest.getStoreSnapshot().tracks?.[0] || {}; return { src: t.source, status: (window.__cap.status || []).join(' | '), find: window.__cap.find, done: window.__cap.done }; });
    const done = kind === 'find' ? (st.find != null || /Jumped to|Couldn.?t/i.test(st.status)) : (st.src && st.src !== before.source);
    if (done) { effectMs = Date.now() - t0; break; }
    await sleep(500);
  }
  await sleep(800);
  const cap = await page.evaluate(() => window.__cap); const after = await snap();
  const edith = (cap.messages || []).filter(Boolean).join(' | ');
  const status = (cap.status || []).join(' | ');
  let shot = 0;
  if (kind === 'freeze') { try { await page.evaluate(() => window.__dividrTest.setStoreState({ timeline: { currentFrame: 70 } })); await sleep(900); const b = await page.locator('[data-testid="preview-canvas"]').screenshot({ path: `${OUT}/_vis_freeze_after.png` }); shot = b.length; } catch {} }
  return { prompt, effectMs, edith: edith.slice(0, 200), status: status.slice(0, 160), find: cap.find, swapped: after.source !== before.source, sfMode: after.sf?.mode };
}

const r1 = await run('find the man walking', 'find', 60000);
console.log('\n=== FIND (open-vocab vision) ===');
console.log(JSON.stringify(r1, null, 2));
const r2 = await run('freeze the world but keep the man walking, from 0 to 4 seconds', 'freeze', 90000);
console.log('\n=== FREEZE + vision target ===');
console.log(JSON.stringify(r2, null, 2));
fs.writeFileSync(`${OUT}/results-vision.json`, JSON.stringify({ find: r1, freeze: r2 }, null, 2));
process.exit(0);
