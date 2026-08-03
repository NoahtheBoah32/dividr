/**
 * Stages the three 3PM demo projects:
 *   "Reference Demo"        — footage on timeline, reference in library, NOT analyzed (the live show)
 *   "Reference Demo READY"  — same + reference ALREADY analyzed (parachute 1: skips to application)
 *   "Reference Demo RAMONA" — ramona fallback pair, not analyzed (parachute 3)
 * The app is left with "Reference Demo" open.
 * Prereq: app running via DIVIDR_CDP=9222. Run AFTER all rehearsals (reloads the page).
 * Run: node tests/edith/stage-demo-projects.mjs <referencePath>
 */
import { chromium } from 'playwright-core';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const REFERENCE = process.argv[2];
if (!REFERENCE) { console.log('usage: node stage-demo-projects.mjs <referencePath>'); process.exit(1); }
const FOOTAGE = 'C:\\tmp\\dividr-demo-research\\raw_akimbo_1080.mp4';
const RAMONA = 'C:\\tmp\\dividr-demo-research\\raw_ramona.mp4';

const b = await chromium.connectOverCDP('http://localhost:9222');
let page = null;
for (const c of b.contexts()) for (const p of c.pages()) {
  const u = p.url();
  if (u.includes('localhost:5173') && !u.startsWith('blob:')) page = p;
}
if (!page) { console.log('FAIL: no dev app page'); process.exit(1); }
await page.reload();
for (let i = 0; i < 30; i++) {
  const ok = await page.evaluate(() => !!window.__videoEditorStore && !!window.__dividrTest).catch(() => false);
  if (ok) break;
  await sleep(1000);
}

async function stage(title, footagePath, refPath, analyze) {
  const projectId = await page.evaluate(async (t) =>
    await window.__dividrTest.createAndOpenProject(t), title);
  await sleep(2500);
  await page.evaluate((pid) => localStorage.setItem(`edith-consent-${pid}`, 'true'), projectId);
  const staged = await page.evaluate(async ({ footage, reference }) => {
    const st = () => window.__videoEditorStore.getState();
    async function importByPath(path, name) {
      let duration = 30;
      try { duration = await window.electronAPI.getDuration(path); } catch {}
      let metadata = {};
      try {
        const dims = await window.electronAPI.getVideoDimensions(path);
        if (dims?.width) metadata = { width: dims.width, height: dims.height };
      } catch {}
      let previewUrl = path;
      try {
        const r = await window.electronAPI.createPreviewUrl(path);
        previewUrl = (r && typeof r === 'object' && r.url) ? r.url : (typeof r === 'string' ? r : path);
      } catch {}
      return st().addToMediaLibrary({
        name, type: 'video', source: path, tempFilePath: path, previewUrl,
        duration, size: 0, mimeType: 'video/mp4', metadata,
        spriteSheetDisabled: duration > 300,
      });
    }
    const footageId = await importByPath(footage, footage.split('\\').pop());
    const refId = await importByPath(reference, reference.split('\\').pop());
    st().updateMediaLibraryItem(refId, { category: 'reference' });
    await st().addTrackFromMediaLibrary(footageId, 0);
    return { footageId, refId };
  }, { footage: footagePath, reference: refPath });
  await sleep(1500);

  if (analyze) {
    await page.evaluate((refId) => {
      window.__dividrTest.applyOps([{ type: 'analyzeReference', clipId: refId }]);
    }, staged.refId);
    let done = false;
    for (let i = 0; i < 120; i++) {
      await sleep(3000);
      done = await page.evaluate((id) => {
        const m = window.__videoEditorStore.getState().mediaLibrary.find((x) => x.id === id);
        return m?.referenceAnalysis?.profile?.version === 1;
      }, staged.refId);
      if (done) break;
    }
    console.log(`${title}: staged, analyzed=${done}`);
    if (!done) process.exit(1);
    // Clear the reasoning card from chat history so the parachute project looks fresh:
    // leave it — the card reads "Watched <ref>" which is honest and fine on screen.
  } else {
    console.log(`${title}: staged (not analyzed)`);
  }
  return staged;
}

// Order matters: stage parachutes first, the LIVE project last so it's left open.
await stage('Reference Demo RAMONA', RAMONA, REFERENCE, false);
await stage('Reference Demo READY', FOOTAGE, REFERENCE, true);
await stage('Reference Demo', FOOTAGE, REFERENCE, false);

console.log('\nAll three demo projects staged. "Reference Demo" is open and live.');
await b.close();
process.exit(0);
