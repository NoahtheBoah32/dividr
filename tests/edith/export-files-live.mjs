// Live verification of the FILE-WRITING export ops (need the new main-process
// 'write-subtitle-file' handler): exportChapters and exportSrt.
// Creates a marker, exports both files to Downloads, verifies contents on
// disk, then removes the files and the marker.
import { chromium } from 'playwright-core';
import fs from 'fs';
import path from 'path';
import os from 'os';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const b = await chromium.connectOverCDP('http://localhost:9222');
let page = null;
for (const c of b.contexts()) for (const p of c.pages()) {
  const u = p.url();
  if (u.includes('localhost:517') && !u.startsWith('blob:')) page = p;
}
if (!page) { console.log('no page'); process.exit(1); }

const inEditor = await page.evaluate(() => location.hash.includes('video-editor'));
if (!inEditor) { console.log('SKIP: no project open — run skill-ops-live.mjs first'); process.exit(1); }

const dl = path.join(os.homedir(), 'Downloads');
const chapFile = path.join(dl, 'dividr-live-check-chapters.txt');
const srtFile = path.join(dl, 'dividr-live-check.srt');
for (const f of [chapFile, srtFile]) if (fs.existsSync(f)) fs.unlinkSync(f);

const runOps = async (ops) => page.evaluate(async (o) => {
  window.__dividrTest.applyOps(o);
  await window.__dividrTest.waitForQueueDrained();
}, ops);

// ── chapters: marker → export → file on disk ──
await runOps([{ type: 'addMarker', atSeconds: 12, label: 'Live chapter' }]);
await runOps([{ type: 'exportChapters', filename: 'dividr-live-check-chapters.txt' }]);
await page.waitForTimeout(1000);
const chapExists = fs.existsSync(chapFile);
const chapContent = chapExists ? fs.readFileSync(chapFile, 'utf8') : '';
check('exportChapters writes the file to Downloads', chapExists, chapFile);
check('chapter text correct', chapContent.includes('0:00 Intro') && chapContent.includes('0:12 Live chapter'), JSON.stringify(chapContent));

// ── srt: uses subtitle tracks or cached transcript; skip cleanly if neither ──
const hasSource = await page.evaluate(() => {
  const s = window.__dividrTest.getStoreSnapshot();
  const subs = s.tracks.some((t) => t.type === 'subtitle' && t.visible && t.subtitleText);
  const cached = (s.mediaLibrary ?? []).some((m) => m?.cachedKaraokeSubtitles?.transcriptionResult?.segments?.length);
  return { subs, cached };
});
if (hasSource.subs || hasSource.cached) {
  await runOps([{ type: 'exportSrt', filename: 'dividr-live-check.srt' }]);
  await page.waitForTimeout(1000);
  const srtExists = fs.existsSync(srtFile);
  const srtContent = srtExists ? fs.readFileSync(srtFile, 'utf8') : '';
  check('exportSrt writes the file to Downloads', srtExists, `source: ${hasSource.subs ? 'subtitle tracks' : 'cached transcript'}`);
  check('srt content shaped correctly', /\d+\n\d{2}:\d{2}:\d{2},\d{3} --> \d{2}:\d{2}:\d{2},\d{3}\n/.test(srtContent), srtContent.slice(0, 80).replace(/\n/g, '\\n'));
} else {
  console.log('SKIP  exportSrt — this project has no subtitles or cached transcript');
}

// ── expected failure path: exportChapters with no markers after cleanup ──
await page.evaluate(() => {
  const st = window.__dividrTest.getStoreSnapshot();
  for (const m of st.timeline?.timelineMarkers ?? []) {
    if (m.label === 'Live chapter') st.removeTimelineMarker(m.id);
  }
});

// cleanup files
for (const f of [chapFile, srtFile]) if (fs.existsSync(f)) fs.unlinkSync(f);
const markersLeft = await page.evaluate(() =>
  (window.__dividrTest.getStoreSnapshot().timeline?.timelineMarkers ?? [])
    .filter((m) => m.label === 'Live chapter').length,
);
check('cleanup: marker + files removed', markersLeft === 0 && !fs.existsSync(chapFile) && !fs.existsSync(srtFile));

const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\n${failed.length} FAILED` : '\nALL PASS');
process.exit(failed.length ? 1 : 0);
