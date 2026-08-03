/**
 * Reference Analysis e2e — full in-app chain on a staged project:
 *   import footage + reference → analyzeReference through the REAL op queue →
 *   live edith:reasoning events → reasoning card in the EDITH chat DOM →
 *   StyleProfile stored on the media item → edith:referenceAnalyzed →
 *   auto-continue fires a REAL EDITH turn that starts applying the style.
 * Prereq: app running via DIVIDR_CDP=9222 (renderer on :5173).
 * Run: node tests/edith/reference-e2e-stage.mjs [footagePath] [referencePath]
 */
import { chromium } from 'playwright-core';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const FOOTAGE = process.argv[2] || 'C:\\tmp\\dividr-demo-research\\raw_ramona.mp4';
const REFERENCE = process.argv[3] || 'C:\\tmp\\dividr-demo-research\\ref_vinh.mp4';

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

// ── Fresh isolated project ──
const projectId = await page.evaluate(async () => {
  return await window.__dividrTest.createAndOpenProject('Reference E2E ' + new Date().toISOString().slice(11, 19));
});
check('project created', !!projectId, projectId);
await sleep(2500);

// Consent pre-set so the EDITH panel goes straight to chat
await page.evaluate((pid) => localStorage.setItem(`edith-consent-${pid}`, 'true'), projectId);

// ── Import footage + reference via the real import recipe ──
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
  return { footageId, refId, libCount: st().mediaLibrary.length };
}, { footage: FOOTAGE, reference: REFERENCE });
check('footage + reference imported', !!staged.footageId && !!staged.refId, `lib=${staged.libCount}`);

const refTagged = await page.evaluate((id) =>
  window.__videoEditorStore.getState().mediaLibrary.find((m) => m.id === id)?.category, staged.refId);
check('reference tagged category=reference', refTagged === 'reference');

// ── Footage onto the timeline ──
await page.evaluate(async (id) => {
  await window.__videoEditorStore.getState().addTrackFromMediaLibrary(id, 0);
}, staged.footageId);
await sleep(1500);
const trackCount = await page.evaluate(() =>
  window.__videoEditorStore.getState().tracks.filter((t) => t.type === 'video').length);
check('footage placed on timeline', trackCount >= 1, `${trackCount} video track(s)`);

// ── Open the EDITH panel BEFORE analysis so the reasoning card catches the begin event ──
await page.evaluate(() => window.__dividrTest.openPanel('friday'));
await sleep(1200);

// ── Event capture, then fire analyzeReference through the real op queue ──
await page.evaluate(() => {
  window.__refEvents = [];
  for (const ch of ['edith:reasoning', 'edith:referenceAnalyzed', 'edith:status']) {
    window.addEventListener(ch, (e) => window.__refEvents.push({ t: Date.now(), ch, detail: e.detail }));
  }
});
const t0 = Date.now();
await page.evaluate((refId) => {
  window.__dividrTest.applyOps([{ type: 'analyzeReference', clipId: refId }]);
}, staged.refId);

// Poll until the finish event or timeout (analysis is 1–3 min)
let events = [];
for (let i = 0; i < 100; i++) {
  await sleep(3000);
  events = await page.evaluate(() => window.__refEvents);
  if (events.some((e) => e.ch === 'edith:reasoning' && e.detail?.finish)) break;
}
const elapsed = ((Date.now() - t0) / 1000).toFixed(0);

const reasoning = events.filter((e) => e.ch === 'edith:reasoning');
const begin = reasoning.find((e) => e.detail?.begin);
const finish = reasoning.find((e) => e.detail?.finish);
const stages = [...new Set(reasoning.map((e) => e.detail?.stage).filter(Boolean))];
check('begin event with title', !!begin && /Watching/.test(begin.detail.title || ''), begin?.detail?.title);
check('finish event, not failed', !!finish && !finish.detail.failed, `${elapsed}s`);
check('>=5 distinct live stages', stages.length >= 5, stages.join(' | '));
check('narrative-structure stage streamed', stages.some((s) => /narrative structure/i.test(s)));

// ── Profile stored on the media item ──
const stored = await page.evaluate((id) => {
  const m = window.__videoEditorStore.getState().mediaLibrary.find((x) => x.id === id);
  const p = m?.referenceAnalysis?.profile;
  return p ? {
    version: p.version, blocks: p.blocks?.length, rules: p.rules?.length,
    cuts: p.pacing?.cutTimes?.length, desc: (m.referenceAnalysis.description || '').slice(0, 60),
  } : null;
}, staged.refId);
check('StyleProfile stored (version 1)', stored?.version === 1);
check('blocks + rules synthesized', (stored?.blocks ?? 0) >= 2 && (stored?.rules ?? 0) >= 3,
  `blocks=${stored?.blocks} rules=${stored?.rules} cuts=${stored?.cuts}`);

const analyzed = events.find((e) => e.ch === 'edith:referenceAnalyzed');
check('referenceAnalyzed event fired', !!analyzed && analyzed.detail?.alreadyAnalyzed === false, analyzed?.detail?.name);

// ── Reasoning card visible in the chat DOM ──
const cardText = await page.evaluate(() => {
  const els = [...document.querySelectorAll('button')];
  const hit = els.find((el) => /Watched|Watching/.test(el.textContent || ''));
  return hit ? hit.textContent.trim().slice(0, 80) : null;
});
check('reasoning card rendered in chat', !!cardText, cardText ?? 'not found');

// ── Auto-continue: a real EDITH turn should start applying within ~2 min ──
let turn = null;
for (let i = 0; i < 40; i++) {
  await sleep(3000);
  turn = await page.evaluate(() => {
    const q = window.__dividrTest.getOpQueue();
    const applied = q.filter((o) => o.type !== 'analyzeReference');
    const statusEvts = (window.__refEvents || []).filter((e) => e.ch === 'edith:status');
    return { opCount: applied.length, opTypes: [...new Set(applied.map((o) => o.type))], statusCount: statusEvts.length };
  });
  if (turn.opCount > 0) break;
}
check('EDITH auto-continued into application (emitted ops)', (turn?.opCount ?? 0) > 0,
  `ops: ${turn?.opTypes?.join(', ') || 'none in 120s'}`);

// ── Skip path: re-analyzing must NOT re-run the pipeline ──
// The op queue is sequential — EDITH's application turn may have long ops
// (transcribe) running ahead of ours, so poll generously instead of 4s.
await page.evaluate((refId) => {
  window.__refEvents = [];
  window.__dividrTest.applyOps([{ type: 'analyzeReference', clipId: refId }]);
}, staged.refId);
let skipAnalyzed = null;
for (let i = 0; i < 60; i++) {
  await sleep(3000);
  const skipEvents = await page.evaluate(() => window.__refEvents);
  skipAnalyzed = skipEvents.find((e) => e.ch === 'edith:referenceAnalyzed');
  if (skipAnalyzed) break;
  // A full re-analysis (begin event) would also be a verdict — the skip failed
  if (skipEvents.some((e) => e.ch === 'edith:reasoning' && e.detail?.begin)) break;
}
check('second analyze skips (alreadyAnalyzed)', skipAnalyzed?.detail?.alreadyAnalyzed === true);

console.log(`\n${pass} passed, ${fail} failed  (project: Reference E2E, ref analysis ${elapsed}s)`);
await b.close();
process.exit(fail ? 1 : 0);
