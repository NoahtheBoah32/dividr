/**
 * Export driver — drives the REAL export UI over CDP (no reload, no store surgery).
 * Assumes the app is running with DIVIDR_CDP=9222 and a project with tracks is open.
 * Flow: click [data-export-button] → set #filename → click the modal's Export button
 * → wait for the ffmpeg render to finish → verify the file exists and print its path.
 * Also dumps the op queue (applied ops) to <name>_ops.json next to the export.
 * Run: node tests/edith/export-current-project.mjs [filename]
 */
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

const NAME = process.argv[2] || 'akimbo_edit_v1';

const browser = await chromium.connectOverCDP('http://localhost:9222');
const contexts = browser.contexts();
let page = null;
for (const ctx of contexts) {
  for (const p of ctx.pages()) {
    if (p.url().includes('localhost:5173')) { page = p; break; }
  }
}
if (!page) { console.log('FAIL: no localhost:5173 page found'); process.exit(1); }

// Sanity: project open, tracks present, queue idle
const pre = await page.evaluate(() => {
  const s = window.__videoEditorStore?.getState?.();
  const q = window.__dividrTest?.getOpQueue?.() ?? [];
  return {
    tracks: s?.tracks?.length ?? 0,
    rendering: s?.render?.isRendering ?? false,
    busy: q.filter((x) => x.status === 'pending' || x.status === 'running').map((x) => x.op?.type),
  };
});
console.log(`pre-check: tracks=${pre.tracks} rendering=${pre.rendering} busy=[${pre.busy.join(',')}]`);
if (!pre.tracks) { console.log('FAIL: no tracks on timeline'); process.exit(1); }
if (pre.rendering) { console.log('FAIL: a render is already running'); process.exit(1); }
if (pre.busy.length) {
  console.log(`WAIT: op queue busy (${pre.busy.join(',')}) — polling up to 10 min for drain`);
  const t0 = Date.now();
  for (;;) {
    await new Promise((r) => setTimeout(r, 5000));
    const busy = await page.evaluate(() =>
      (window.__dividrTest?.getOpQueue?.() ?? [])
        .filter((x) => x.status === 'pending' || x.status === 'running').length);
    if (!busy) break;
    if (Date.now() - t0 > 600000) { console.log('FAIL: queue never drained'); process.exit(1); }
  }
  console.log('queue drained');
}

// Dump applied ops for the Gemini verifier
const opsDump = await page.evaluate(() =>
  (window.__dividrTest?.getOpQueue?.() ?? []).map((x) => ({
    type: x.op?.type, status: x.status,
    params: (() => { try { const { type, ...rest } = x.op ?? {}; return rest; } catch { return {}; } })(),
  })));

// 0. Dismiss any leftover render dialog from a previous run (it overlays everything)
await page.evaluate(() => {
  const ad = document.querySelector('[data-slot="alert-dialog-content"]') || document.querySelector('[role="alertdialog"]');
  if (!ad) return;
  const close = [...ad.querySelectorAll('button')].find((b) => /^(close|done)$/i.test(b.textContent.trim()));
  if (close) close.click();
});
await page.waitForTimeout(800);

// 1. Open the export modal (skip the click if a previous run left it open)
const modalAlready = await page.evaluate(() => !!document.getElementById('filename'));
if (!modalAlready) await page.click('[data-export-button]');
await page.waitForSelector('#filename', { timeout: 10000 });
console.log('export modal open');

// 2. Set filename (React-controlled input needs the native setter)
await page.evaluate((name) => {
  const el = document.getElementById('filename');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(el, name);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}, NAME);
await page.waitForTimeout(500);

// Wait for the default output path to load (modal fetches Downloads dir async)
await page.waitForTimeout(1500);

// 3. Click the modal's confirm button (the footer Button whose text is exactly "Export")
const clicked = await page.evaluate(() => {
  const dialog = document.querySelector('[role="dialog"]');
  if (!dialog) return 'no-dialog';
  const btns = [...dialog.querySelectorAll('button')];
  const exp = btns.find((b) => /^Export( Video)?$/.test(b.textContent.trim()));
  if (!exp) return `no-export-btn (${btns.map((b) => b.textContent.trim()).join('|')})`;
  exp.click();
  return 'ok';
});
if (clicked !== 'ok') { console.log(`FAIL: ${clicked}`); process.exit(1); }
console.log('export started');

// 4. Wait for the render to start, then finish (poll store). Short renders can
// COMPLETE inside one poll interval — treat the completed dialog / status / the
// file on disk as success even if isRendering was never observed true.
let started = false;
const t0 = Date.now();
for (;;) {
  await new Promise((r) => setTimeout(r, 3000));
  const st = await page.evaluate(() => {
    const s = window.__videoEditorStore?.getState?.();
    const ad = document.querySelector('[data-slot="alert-dialog-content"]') || document.querySelector('[role="alertdialog"]');
    return {
      rendering: s?.render?.isRendering ?? false,
      progress: s?.render?.progress ?? 0,
      status: s?.render?.status ?? '',
      completeDialog: !!ad && /render complete|successfully exported/i.test(ad.textContent || ''),
    };
  });
  if (st.completeDialog || (!st.rendering && /complete/i.test(st.status))) { console.log('\nrender finished'); break; }
  if (st.rendering) { started = true; process.stdout.write(`\r  rendering ${st.progress.toFixed(0)}% ${st.status}        `); }
  if (started && !st.rendering) { console.log('\nrender finished'); break; }
  if (!started && Date.now() - t0 > 60000) { console.log('FAIL: render never started'); process.exit(1); }
  if (Date.now() - t0 > 900000) { console.log('\nFAIL: render did not finish in 15 min'); process.exit(1); }
}

// 5. Verify the file on disk (modal defaults to Downloads)
const outFile = path.join('C:/Users/User/Downloads', `${NAME}.mp4`);
await new Promise((r) => setTimeout(r, 2000));
if (!fs.existsSync(outFile)) { console.log(`FAIL: expected file missing: ${outFile}`); process.exit(1); }
const size = fs.statSync(outFile).size;
// floor catches truly-empty renders; callers that need stronger guarantees
// should ffprobe the artifact (see tests/release/export-smoke.mjs)
if (size < 20000) { console.log(`FAIL: file suspiciously small (${size} bytes)`); process.exit(1); }

const opsPath = path.join('C:/Users/User/Downloads', `${NAME}_ops.json`);
fs.writeFileSync(opsPath, JSON.stringify(opsDump, null, 1));

// 6. Close the completed-render dialog so the app is left clean (poll — the
// dialog flips to its completed state slightly after the store settles)
for (let i = 0; i < 10; i++) {
  const closed = await page.evaluate(() => {
    const ad = document.querySelector('[data-slot="alert-dialog-content"]') || document.querySelector('[role="alertdialog"]');
    if (!ad) return true;
    const close = [...ad.querySelectorAll('button')].find((b) => /^(close|done)$/i.test(b.textContent.trim()));
    if (close) { close.click(); return true; }
    return false;
  });
  if (closed) break;
  await new Promise((r) => setTimeout(r, 1000));
}

console.log(`PASS  export complete — ${outFile} (${(size / 1e6).toFixed(1)} MB)`);
console.log(`ops dump: ${opsPath} (${opsDump.length} ops)`);
process.exit(0);
