/**
 * Observer — attaches to the RUNNING app (no reload, preserves EDITH's in-flight
 * turn) and records the application phase after analyzeReference: which ops she
 * emits, in what order, and whether she stalls after transcribe (the reported
 * continuity bug). Run right after reference-e2e-stage.mjs.
 * Run: node tests/edith/reference-observe-application.mjs [watchMinutes]
 */
import { chromium } from 'playwright-core';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WATCH_MIN = parseFloat(process.argv[2] || '8');

const b = await chromium.connectOverCDP('http://localhost:9222');
let page = null;
for (const c of b.contexts()) for (const p of c.pages()) {
  const u = p.url();
  if (u.includes('localhost:5173') && !u.startsWith('blob:')) page = p;
}
if (!page) { console.log('FAIL  no dev app page'); process.exit(1); }

const seen = new Map(); // opId -> {type,status}
let lastNewOpAt = Date.now();
let transcribeDoneAt = null;
const t0 = Date.now();

console.log(`observing for ${WATCH_MIN} min…`);
while (Date.now() - t0 < WATCH_MIN * 60_000) {
  const snap = await page.evaluate(() => {
    const q = window.__dividrTest.getOpQueue();
    const s = window.__videoEditorStore.getState();
    const main = s.tracks.find((t) => t.type === 'video' && (t.trackRowIndex ?? 0) === 0);
    return {
      queue: q,
      subtitles: s.tracks.filter((t) => t.type === 'subtitle').length,
      videoTracks: s.tracks.filter((t) => t.type === 'video').length,
      graded: !!(main && (main.colorGrade || main.adjustments || main.lutPath || main.referenceGrade)),
      zoomed: s.tracks.some((t) => !!t.zoomKeyframes || !!t.faceZoom || (t.effects ?? []).length > 0),
    };
  }).catch(() => null);
  if (!snap) { await sleep(3000); continue; }

  for (const q of snap.queue) {
    const prev = seen.get(q.id);
    if (!prev) {
      seen.set(q.id, { type: q.type, status: q.status });
      lastNewOpAt = Date.now();
      console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] NEW op: ${q.type} (${q.status})`);
    } else if (prev.status !== q.status) {
      seen.set(q.id, { type: q.type, status: q.status });
      console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${q.type}: ${prev.status} → ${q.status}${q.error ? ` (${q.error})` : ''}`);
      if ((q.type === 'runWhisper' || q.type === 'transcribe') && q.status === 'applied') transcribeDoneAt = Date.now();
    }
  }

  // Stall detector: transcribe finished but nothing new for 2.5 min = the continuity bug
  if (transcribeDoneAt && Date.now() - transcribeDoneAt > 150_000) {
    const opsAfter = [...seen.values()].filter((o) => !['runWhisper', 'transcribe', 'analyzeReference'].includes(o.type));
    if (opsAfter.length === 0) {
      console.log(`\nSTALL DETECTED: transcribe applied ${((Date.now() - transcribeDoneAt) / 1000).toFixed(0)}s ago, zero application ops since. The continuity bug reproduced.`);
      console.log(`state: subtitles=${snap.subtitles} graded=${snap.graded}`);
      process.exit(1);
    }
  }
  await sleep(3000);
}

const final = await page.evaluate(() => {
  const s = window.__videoEditorStore.getState();
  const main = s.tracks.find((t) => t.type === 'video' && (t.trackRowIndex ?? 0) === 0);
  return {
    subtitles: s.tracks.filter((t) => t.type === 'subtitle').length,
    tracks: s.tracks.length,
    graded: !!(main && (main.colorGrade || main.adjustments || main.lutPath || main.referenceGrade)),
  };
}).catch(() => ({}));

const opTypes = [...seen.values()].map((o) => `${o.type}:${o.status}`);
console.log(`\n──── SUMMARY after ${WATCH_MIN} min ────`);
console.log(`ops seen (${opTypes.length}): ${opTypes.join(', ')}`);
console.log(`timeline: ${final.tracks} tracks, ${final.subtitles} subtitle clips, graded=${final.graded}`);
const applicationOps = [...seen.values()].filter((o) => !['analyzeReference'].includes(o.type));
console.log(applicationOps.length >= 3 ? 'VERDICT: she applied the style — no stall.' : 'VERDICT: thin application — inspect manually.');
process.exit(0);
