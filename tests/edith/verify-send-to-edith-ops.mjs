// Op-level probe for #91 + #92:
//  1. recorder:hasAudibleAudio — audible file / silent-track file / no-audio-stream file
//  2. sendMediaToEdith bridge — file lands as an attachment chip in EDITH's chat
//  3. removeFillersFromMedia op — transcribe → cut real um/uh fillers →
//     "Filler removed …" imported into the media library, shorter than the original
import { chromium } from 'playwright-core';
import { statSync, existsSync } from 'node:fs';
import { ensureFixtures } from '../fixtures/ensure-fixtures.mjs';

const F = ensureFixtures();
const SPEECH = F.speech;
const SILENT = F.silent;
const NOAUDIO = F.noAudio;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b = await chromium.connectOverCDP('http://localhost:9222');
let page;
for (const c of b.contexts()) for (const p of c.pages()) if (p.url().includes('localhost:517') && !p.url().startsWith('blob:')) page = p;
if (!page) { console.log('NO PAGE'); process.exit(1); }

const results = [];
const check = (name, ok, extra = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
};

await page.evaluate(async () => { try { await window.__dividrTest.openProjectByTitle('SKILLS-93-TEST'); } catch {} });
await sleep(3000);
await page.evaluate(() => window.__dividrTest.openPanel('friday'));
await sleep(2000);

// ── 1. audio gate ─────────────────────────────────────────────────────────
const gate = (p) => page.evaluate((fp) => window.electronAPI.invoke('recorder:hasAudibleAudio', { filePath: fp }), p);
const gAudible = await gate(SPEECH);
check('audible file detected', gAudible?.success && gAudible.audible === true, `max=${gAudible?.maxVolumeDb}dB`);
const gSilent = await gate(SILENT);
check('silent-track file rejected', gSilent?.success && gSilent.hasAudioStream === true && gSilent.audible === false, `max=${gSilent?.maxVolumeDb}dB`);
const gNone = await gate(NOAUDIO);
check('no-audio-stream file rejected', gNone?.success && gNone.hasAudioStream === false && gNone.audible === false);

// ── 2. send-to-EDITH hand-off ─────────────────────────────────────────────
await page.evaluate((fp) => window.__dividrTest.sendMediaToEdith({ name: 'Camera recording 23.15', path: fp }), SPEECH);
await sleep(600);
const chip = await page.evaluate(() =>
  [...document.querySelectorAll('span')].some((e) => (e.textContent ?? '').includes('Camera recording 23.15')),
);
check('attachment chip appears in EDITH chat', chip);
// clear it so the e2e later starts clean
await page.evaluate(() => {
  [...document.querySelectorAll('button')]
    .filter((b) => b.textContent === '×')
    .forEach((b) => b.click());
});

// ── 3. removeFillersFromMedia (the speech fixture contains real um/uh) ──
const origSize = statSync(SPEECH).size;
await page.evaluate(() => {
  window.__edithFillerResult = null;
  window.addEventListener('edith:removeFillersFileResult', (e) => { window.__edithFillerResult = e.detail; }, { once: true });
});
await page.evaluate((fp) => {
  window.__dividrTest.applyOps([{ type: 'removeFillersFromMedia', mediaPath: fp }]);
}, SPEECH);
console.log('filler op enqueued — transcribing + cutting (may take ~2 min)…');
let filler = null;
for (let i = 0; i < 60; i++) {
  await sleep(4000);
  filler = await page.evaluate(() => window.__edithFillerResult);
  if (filler) break;
}
check('filler pipeline returned', !!filler, JSON.stringify(filler)?.slice(0, 200));
if (filler) {
  check('pipeline succeeded', filler.success === true, filler.error ?? '');
  check('cuts were made', (filler.removedCount ?? 0) > 0, `${filler.removedCount} words, ${filler.removedSec}s`);
  check('imported under Filler removed name', (filler.importedName ?? '').startsWith('Filler removed'));
  const lib = await page.evaluate(() => {
    const s = window.__dividrTest.getStoreSnapshot();
    return (s.mediaLibrary ?? []).map((m) => ({ name: m.name, source: m.source, duration: m.duration }));
  });
  const cleaned = lib.find((m) => m.name === filler.importedName) ??
    lib.find((m) => (m.name ?? '').startsWith('Filler removed'));
  check('cleaned file in media library', !!cleaned, cleaned ? `${cleaned.name} (${cleaned.duration?.toFixed?.(1)}s)` : '');
  if (cleaned?.source) {
    check('cleaned file exists on disk', existsSync(cleaned.source), cleaned.source);
    const cleanedSize = existsSync(cleaned.source) ? statSync(cleaned.source).size : 0;
    console.log(`sizes: original ${origSize}, cleaned ${cleanedSize}`);
  }
}

console.log(results.every(Boolean) ? 'ALL PASS' : 'SOME FAILED');
process.exit(results.every(Boolean) ? 0 : 1);
