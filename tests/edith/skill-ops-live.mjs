// Live verification of the 2026-07-11 skill batch (renderer side):
//   adjust op (white balance / S-M-H / vignette / sharpen / blur preview),
//   addMarker / removeMarker (+ ruler tick), exportSettings (store).
// exportSrt/exportChapters and the codec/CRF/fps bake are main-process — they
// need an app restart and are covered by unit + ffmpeg CLI tests instead.
// Restores the project's exact prior grade/markers/exportSettings at the end.
import { chromium } from 'playwright-core';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const b = await chromium.connectOverCDP('http://localhost:9222');
let page = null;
for (const c of b.contexts()) for (const p of c.pages()) {
  const u = p.url();
  if (u.includes('localhost:5173') && !u.startsWith('blob:')) page = p;
}
if (!page) { console.log('no page'); process.exit(1); }

const consoleErrors = [];
let captureErrors = false; // armed after project open — reload-time 404s (stale thumbnails) are boot noise
page.on('console', (m) => {
  if (captureErrors && m.type() === 'error') consoleErrors.push(m.text().slice(0, 200));
});

// ── Reload to pick up the latest renderer bundle, then reopen the project
// if the picker comes up. ──
await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
await page.waitForTimeout(6000);

let opened = false;
for (let attempt = 0; attempt < 6 && !opened; attempt++) {
  opened = await page.evaluate(() => {
    const s = window.__dividrTest?.getStoreSnapshot?.();
    return location.hash.includes('video-editor') &&
      (s?.tracks?.filter((t) => t.type === 'video').length ?? 0) >= 1;
  }).catch(() => false);
  if (opened) break;
  // Programmatic click on the first "Open" button — works even minimized
  await page.evaluate(() => {
    const open = Array.from(document.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Open',
    );
    if (!open) return false;
    open.click();
    return true;
  }).catch(() => false);
  await page.waitForTimeout(6000);
}
if (!opened) { console.log('FAILED: could not open a project'); process.exit(1); }

// Wait for tracks + bridge to settle
await page.waitForTimeout(3000);
captureErrors = true;

// ── Baseline snapshot for restore ──
const pre = await page.evaluate(() => {
  const s = window.__dividrTest.getStoreSnapshot();
  const main = s.tracks.find((t) => t.type === 'video' && (t.trackRowIndex ?? 0) === 0)
    ?? s.tracks.find((t) => t.type === 'video');
  return {
    mainId: main?.id ?? null,
    colorGrade: main?.colorGrade ? JSON.parse(JSON.stringify(main.colorGrade)) : null,
    markers: JSON.parse(JSON.stringify(s.timeline?.timelineMarkers ?? [])),
    exportSettings: JSON.parse(JSON.stringify(s.exportSettings ?? {})),
    videoCount: s.tracks.filter((t) => t.type === 'video').length,
  };
});
console.log('baseline:', JSON.stringify({ ...pre, colorGrade: pre.colorGrade ? 'present' : null }));
check('project open with video track', !!pre.mainId, `${pre.videoCount} video tracks`);

const runOps = async (ops) => page.evaluate(async (o) => {
  window.__dividrTest.applyOps(o);
  await window.__dividrTest.waitForQueueDrained();
}, ops);

// ── 1. adjust op → preview filter + vignette overlay ──
await runOps([{ type: 'adjust', temperature: 40, shadows: 15, vignette: 50, sharpen: 30, blur: 10 }]);
await page.waitForTimeout(1200);

const gradeState = await page.evaluate(() => {
  const canvas = document.querySelector('canvas[data-testid="preview-canvas"]');
  const svg = document.getElementById('dividr-grade-filter-svg');
  const ovl = document.getElementById('dividr-vignette-overlay');
  const s = window.__dividrTest.getStoreSnapshot();
  const main = s.tracks.find((t) => t.type === 'video' && (t.trackRowIndex ?? 0) === 0);
  return {
    filter: canvas?.style.filter ?? '',
    hasBlurPrim: !!svg?.innerHTML.includes('feGaussianBlur'),
    hasSharpenPrim: !!svg?.innerHTML.includes('feConvolveMatrix'),
    overlayBg: ovl ? ovl.style.background.slice(0, 60) : null,
    cg: main?.colorGrade ?? null,
  };
});
check('adjust: store params set', gradeState.cg?.temperature === 40 && gradeState.cg?.vignette === 50 && gradeState.cg?.blur === 10, JSON.stringify({ t: gradeState.cg?.temperature, v: gradeState.cg?.vignette }));
check('adjust: canvas grade filter applied', gradeState.filter.includes('dividr-grade'), gradeState.filter);
check('adjust: sharpen + blur primitives in SVG', gradeState.hasSharpenPrim && gradeState.hasBlurPrim);
check('adjust: vignette overlay present (radial gradient)', !!gradeState.overlayBg && gradeState.overlayBg.includes('radial-gradient'), gradeState.overlayBg ?? 'missing');

// ── 2. markers → store + ruler tick ──
await runOps([{ type: 'addMarker', atSeconds: 5, label: 'Live check', color: '#3F7A4E' }]);
await page.waitForTimeout(800);
const markerState = await page.evaluate(() => {
  const s = window.__dividrTest.getStoreSnapshot();
  const mk = (s.timeline?.timelineMarkers ?? []).filter((m) => m.label === 'Live check');
  const tick = document.querySelector('[data-timeline-marker]');
  return { count: mk.length, frame: mk[0]?.frame ?? -1, tickInDom: !!tick, tickLabel: tick?.textContent ?? '' };
});
check('addMarker: marker in store at display-fps frame', markerState.count === 1 && markerState.frame > 0, `frame ${markerState.frame}`);
check('addMarker: tick rendered on ruler', markerState.tickInDom && markerState.tickLabel.includes('Live check'), markerState.tickLabel);

// ── 3. exportSettings → store ──
await runOps([{ type: 'exportSettings', preset: 'tiktok', crf: 20 }]);
const es = await page.evaluate(() => window.__dividrTest.getStoreSnapshot().exportSettings);
check('exportSettings: preset + crf in store', es?.preset === 'tiktok' && es?.crf === 20, JSON.stringify(es));

// ── 4. undo integration: one Ctrl+Z removes the marker ── (store-level undo)
const undoWorks = await page.evaluate(() => {
  const st = window.__dividrTest.getStoreSnapshot();
  if (typeof st.undo !== 'function') return 'no-undo-fn';
  const before = (st.timeline?.timelineMarkers ?? []).length;
  st.undo();
  const after = (window.__dividrTest.getStoreSnapshot().timeline?.timelineMarkers ?? []).length;
  return { before, after };
});
check('undo removes the marker (recordAction wired)', typeof undoWorks === 'object' && undoWorks.after === undoWorks.before - 1, JSON.stringify(undoWorks));

// ── Cleanup / restore exact prior state ──
await page.evaluate((preState) => {
  const st = window.__dividrTest.getStoreSnapshot();
  // markers: back to baseline list
  const current = st.timeline?.timelineMarkers ?? [];
  for (const m of current) {
    if (!preState.markers.some((pm) => pm.id === m.id)) st.removeTimelineMarker(m.id);
  }
  // grade: restore the exact prior object on the main track
  if (preState.mainId) {
    st.updateTrack(preState.mainId, { colorGrade: preState.colorGrade ?? undefined });
  }
  // export settings: reset then re-apply baseline
  st.setExportSettings(null);
  if (Object.keys(preState.exportSettings).length) st.setExportSettings(preState.exportSettings);
  window.dispatchEvent(new CustomEvent('dividr:forceRender'));
}, pre);
await page.waitForTimeout(1200);

const post = await page.evaluate(() => {
  const s = window.__dividrTest.getStoreSnapshot();
  const main = s.tracks.find((t) => t.type === 'video' && (t.trackRowIndex ?? 0) === 0);
  const ovl = document.getElementById('dividr-vignette-overlay');
  return {
    cg: main?.colorGrade ?? null,
    markers: (s.timeline?.timelineMarkers ?? []).length,
    exportSettings: s.exportSettings ?? {},
    overlayGone: !ovl,
  };
});
const cgRestored = JSON.stringify(post.cg) === JSON.stringify(pre.colorGrade);
check('cleanup: grade restored exactly', cgRestored);
check('cleanup: markers back to baseline', post.markers === pre.markers.length, `${post.markers} vs ${pre.markers.length}`);
check('cleanup: exportSettings back to baseline', JSON.stringify(post.exportSettings) === JSON.stringify(pre.exportSettings));
check('cleanup: vignette overlay removed', post.overlayGone);

const newErrors = consoleErrors.filter((e) => !/favicon|DevTools|Autofill|net::ERR|ResizeObserver/i.test(e));
check('no new console errors', newErrors.length === 0, newErrors.slice(0, 3).join(' | '));

const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\n${failed.length} FAILED` : '\nALL PASS');
process.exit(failed.length ? 1 : 0);
