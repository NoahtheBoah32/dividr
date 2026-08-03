/**
 * Typed-chat-path e2e — the EXACT demo interaction:
 * stage footage + reference, then TYPE the demo sentence into EDITH's chat and
 * click send. SHE must decide to emit analyzeReference herself (no applyOps
 * shortcut), the reasoning card must run, and application must follow.
 * Prereq: app running via DIVIDR_CDP=9222 (renderer on :5173).
 * Run: node tests/edith/reference-typed-chat.mjs [footagePath] [referencePath]
 */
import { chromium } from 'playwright-core';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const FOOTAGE = process.argv[2] || 'C:\\tmp\\dividr-demo-research\\raw_akimbo_1080.mp4';
const REFERENCE = process.argv[3] || 'C:\\tmp\\dividr-demo-research\\ref_vinh.mp4';
const MESSAGE = 'Watch the reference and edit my footage in its style.';

let pass = 0, fail = 0;
const check = (n, ok, d = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  — ' + d : ''}`); ok ? pass++ : fail++; };

const b = await chromium.connectOverCDP('http://localhost:9222');
let page = null;
for (const c of b.contexts()) for (const p of c.pages()) {
  const u = p.url();
  if (u.includes('localhost:5173') && !u.startsWith('blob:')) page = p;
}
if (!page) { console.log('FAIL  no dev app page'); process.exit(1); }

await page.reload();
for (let i = 0; i < 30; i++) {
  const ok = await page.evaluate(() => !!window.__videoEditorStore && !!window.__dividrTest).catch(() => false);
  if (ok) break;
  await sleep(1000);
}

const projectId = await page.evaluate(async () =>
  await window.__dividrTest.createAndOpenProject('Typed Chat E2E ' + new Date().toISOString().slice(11, 19)));
check('project created', !!projectId, projectId);
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
  return { footageId, refId };
}, { footage: FOOTAGE, reference: REFERENCE });
check('footage + reference imported', !!staged.footageId && !!staged.refId);

await page.evaluate(async (id) => {
  await window.__videoEditorStore.getState().addTrackFromMediaLibrary(id, 0);
}, staged.footageId);
await sleep(1500);

await page.evaluate(() => window.__dividrTest.openPanel('friday'));
await sleep(1500);

await page.evaluate(() => {
  window.__refEvents = [];
  for (const ch of ['edith:reasoning', 'edith:referenceAnalyzed', 'edith:status']) {
    window.addEventListener(ch, (e) => window.__refEvents.push({ t: Date.now(), ch, detail: e.detail }));
  }
});

// ── THE DEMO ACTION: type the sentence into her chat and hit send ──
const typed = await page.evaluate((msg) => {
  const tas = [...document.querySelectorAll('textarea')];
  const ta = tas.find((t) => /say something to edith/i.test(t.placeholder || ''));
  if (!ta) return 'no-textarea';
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  setter.call(ta, msg);
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  return 'ok';
}, MESSAGE);
check('chat textarea found + filled', typed === 'ok', typed);
await sleep(400);
const sent = await page.evaluate(() => {
  const tas = [...document.querySelectorAll('textarea')];
  const ta = tas.find((t) => /say something to edith/i.test(t.placeholder || ''));
  if (!ta) return 'no-textarea';
  const row = ta.parentElement;
  const send = [...row.querySelectorAll('button')].pop();
  if (!send || send.disabled) return `send-btn ${send ? 'disabled' : 'missing'}`;
  send.click();
  return 'ok';
});
check('send clicked', sent === 'ok', sent);

// ── She must emit analyzeReference HERSELF within ~2 min ──
const t0 = Date.now();
let sawAnalyze = false;
for (let i = 0; i < 40; i++) {
  await sleep(3000);
  sawAnalyze = await page.evaluate(() =>
    window.__dividrTest.getOpQueue().some((o) => o.type === 'analyzeReference'));
  if (sawAnalyze) break;
}
check('EDITH emitted analyzeReference from the typed message', sawAnalyze,
  `${((Date.now() - t0) / 1000).toFixed(0)}s`);

// ── Reasoning runs to finish ──
let events = [];
if (sawAnalyze) {
  for (let i = 0; i < 100; i++) {
    await sleep(3000);
    events = await page.evaluate(() => window.__refEvents);
    if (events.some((e) => e.ch === 'edith:reasoning' && e.detail?.finish)) break;
  }
}
const finish = events.find((e) => e.ch === 'edith:reasoning' && e.detail?.finish);
check('analysis finished, not failed', !!finish && !finish.detail.failed,
  `${((Date.now() - t0) / 1000).toFixed(0)}s total`);

const stored = await page.evaluate((id) => {
  const m = window.__videoEditorStore.getState().mediaLibrary.find((x) => x.id === id);
  return m?.referenceAnalysis?.profile?.version ?? null;
}, staged.refId);
check('StyleProfile stored', stored === 1);

// ── Application follows without any further typing ──
let appOps = [];
for (let i = 0; i < 60; i++) {
  await sleep(3000);
  appOps = await page.evaluate(() =>
    window.__dividrTest.getOpQueue().filter((o) => o.type !== 'analyzeReference').map((o) => `${o.type}:${o.status}`));
  if (appOps.length > 0) break;
}
check('application ops followed the typed message', appOps.length > 0, appOps.join(', ') || 'none');

console.log(`\n${pass} passed, ${fail} failed  (typed-chat path)`);
await b.close();
process.exit(fail ? 1 : 0);
