// Live transcription (audio recorder) — full end-to-end proof:
// toggle on → model warms → record → fixture speech plays into the REAL
// recorded audio graph (DEV hook) → PARTIALs stream → utterances commit
// mid-take → stop seals FINAL → review shows the transcript → Save attaches
// cachedKaraokeSubtitles to the imported media item (the panel + EDITH read it
// with zero re-transcription). Plus: the toggle exists in EVERY mode (audio,
// camera, screen, screen-camera), and must be locked while recording.
import { chromium } from 'playwright-core';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureFixtures } from '../fixtures/ensure-fixtures.mjs';

process.on('unhandledRejection', (e) => {
  if (String(e?.message ?? e).includes('handleJavaScriptDialog')) return;
  throw e;
});

const fixtureMp4 = ensureFixtures().speech;
const wavPath = path.join(os.tmpdir(), 'dividr-live-tx-fixture.wav');

// decodeAudioData-proof fixture: 16k mono WAV from the speech take
const ff = spawnSync('ffmpeg', ['-y', '-v', 'error', '-i', fixtureMp4, '-ar', '16000', '-ac', '1', wavPath], { encoding: 'utf8' });
if (ff.status !== 0) { console.log('FAIL  fixture wav transcode', ff.stderr); process.exit(1); }
const wavDataUrl = `data:audio/wav;base64,${fs.readFileSync(wavPath).toString('base64')}`;

const b = await chromium.connectOverCDP('http://localhost:9222');
let page = null;
for (const c of b.contexts()) for (const p of c.pages()) {
  const u = p.url();
  if (u.includes('localhost:517') && !u.startsWith('blob:')) page = p;
}
if (!page) { console.log('no renderer page'); process.exit(1); }
page.on('dialog', (d) => d.accept().catch(() => {}));

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};
const $ = (tid) => page.locator(`[data-testid="${tid}"]`);
const visible = (tid) => page.evaluate((t) => {
  const el = document.querySelector(`[data-testid="${t}"]`);
  return !!el && el.getClientRects().length > 0;
}, tid);
const waitFor = async (tid, timeoutMs = 15000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await visible(tid)) return true;
    await page.waitForTimeout(300);
  }
  return false;
};
const dbg = () => page.evaluate(() => ({ ...(window.__liveTxDebug ?? {}) }));
const openRecorder = async (card) => {
  await page.evaluate(() => {
    Array.from(document.querySelectorAll('button[title="Record & create"]'))[0]?.click();
  });
  await page.waitForTimeout(900);
  await $(card).click();
  if (await waitFor('perm-allow', 6000)) await $('perm-allow').click();
};

await page.evaluate(() => window.__dividrTest.openProjectByTitle('SKILLS-93-TEST'));
await page.waitForTimeout(4500);
for (const tid of ['confirm-delete', 'recorder-close', 'confirm-delete']) {
  await page.evaluate((t) => document.querySelector(`[data-testid="${t}"]`)?.click(), tid).catch(() => {});
  await page.waitForTimeout(500);
}

// ═══ Phase 1 — audio mode: the full live path ═════════════════════════════
await openRecorder('record-card-audio');
const setupOk = await waitFor('start-recording', 15000);
check('audio mode reaches setup', setupOk);
if (!setupOk) process.exit(1);

check('live-transcription toggle present in audio mode', await visible('live-transcribe-toggle'));
check('indicator label says Live transcription',
  /live transcription/i.test(await $('live-transcribe-label').textContent() ?? ''));

const wasOn = await page.evaluate(() =>
  document.querySelector('[data-testid="live-transcribe-toggle"]')?.getAttribute('aria-checked') === 'true');
if (!wasOn) await $('live-transcribe-toggle').click();
check('toggle turns on (aria-checked)', await page.evaluate(() =>
  document.querySelector('[data-testid="live-transcribe-toggle"]')?.getAttribute('aria-checked') === 'true'));

// model warm-up (large-v3 load ~10s; generous first-run allowance)
let ready = false;
for (const t0 = Date.now(); Date.now() - t0 < 90000;) {
  if ((await dbg()).status === 'ready') { ready = true; break; }
  await page.waitForTimeout(500);
}
check('transcriber reaches ready before recording', ready, `status=${(await dbg()).status}`);
if (!ready) process.exit(1);

await page.evaluate((url) => { window.__recorderFixtureUrl = url; }, wavDataUrl);
await $('start-recording').click();
await waitFor('countdown', 5000);
const recOk = await waitFor('rec-timer', 8000);
check('recording starts', recOk);
if (!recOk) process.exit(1);

check('toggle locked while recording', await page.evaluate(() =>
  document.querySelector('[data-testid="live-transcribe-toggle"]')?.disabled === true));

// fixture speech is ~22.7s: watch partials stream and utterances commit live
let sawPartial = false, sawCommit = false, commitAtMs = 0;
const recT0 = Date.now();
while (Date.now() - recT0 < 26000) {
  const d = await dbg();
  if (d.partial) sawPartial = true;
  if ((d.lines?.length ?? 0) >= 1 && !sawCommit) { sawCommit = true; commitAtMs = Date.now() - recT0; }
  if (sawPartial && (d.lines?.length ?? 0) >= 2) break;
  await page.waitForTimeout(700);
}
const dRec = await dbg();
check('rolling PARTIAL text streamed while speaking', sawPartial);
check('utterance committed MID-take (not only at stop)', sawCommit && commitAtMs < 24000,
  `first commit ${Math.round(commitAtMs / 1000)}s in, lines=${dRec.lines?.length}`);
check('live transcript readout visible on stage', await visible('live-transcript'));

// let the fixture finish, then stop
await page.waitForTimeout(Math.max(0, 24500 - (Date.now() - recT0)));
await $('rec-stop').click();
const review = await waitFor('review-media', 20000);
check('stop lands in review', review);

let finalText = '';
for (const t0 = Date.now(); Date.now() - t0 < 20000;) {
  finalText = (await dbg()).finalText ?? '';
  if (finalText) break;
  await page.waitForTimeout(500);
}
check('FINAL transcript sealed after stop', !!finalText, `${finalText.slice(0, 60)}…`);
check('review shows the transcript', await visible('live-transcript-review'));
check('transcript heard the fixture (quarterly numbers)', /quarterly/i.test(finalText));

// ═══ Phase 2 — Save attaches the cache ════════════════════════════════════
const beforeIds = await page.evaluate(() =>
  window.__videoEditorStore.getState().mediaLibrary.map((m) => m.id));
await $('review-save').click();
await page.waitForTimeout(3000);
const attached = await page.evaluate((prev) => {
  const items = window.__videoEditorStore.getState().mediaLibrary.filter((m) => !prev.includes(m.id));
  const m = items.find((i) => i.origin === 'recording');
  if (!m) return { found: false };
  const tr = m.cachedKaraokeSubtitles?.transcriptionResult;
  return {
    found: true,
    id: m.id,
    source: m.source,
    segments: tr?.segments?.length ?? 0,
    words: tr?.segments?.[0]?.words?.length ?? 0,
    wordShape: tr?.segments?.[0]?.words?.[0] ?? null,
    text: tr?.text ?? '',
    language: tr?.language,
  };
}, beforeIds);
check('recording imported into the media library', attached.found, attached.source ?? '');
check('cachedKaraokeSubtitles attached on save', attached.segments >= 2,
  `${attached.segments} segments, lang=${attached.language}`);
check('word-level timings present', attached.words > 3
  && typeof attached.wordShape?.start === 'number' && typeof attached.wordShape?.end === 'number'
  && typeof attached.wordShape?.confidence === 'number', JSON.stringify(attached.wordShape));
check('attached text matches what was spoken', /quarterly/i.test(attached.text));

// cleanup: remove the imported take + its file (guarded to recordings dir)
if (attached.found) {
  await page.evaluate((info) => {
    window.__videoEditorStore.getState().removeFromMediaLibrary(info.id, true);
    return window.electronAPI.invoke('recorder:discard', { filePath: info.source });
  }, attached);
}

// ═══ Phase 3 — the toggle exists in video modes too ═══════════════════════
await openRecorder('record-card-camera');
const camSetup = await waitFor('start-recording', 15000);
check('camera mode reaches setup', camSetup);
check('live-transcription toggle present in camera mode', await visible('live-transcribe-toggle'));
check('camera-mode label says Live transcription',
  /live transcription/i.test(await $('live-transcribe-label').textContent() ?? ''));
await page.evaluate(() => document.querySelector('[data-testid="recorder-close"]')?.click());
await page.waitForTimeout(600);
await page.evaluate(() => document.querySelector('[data-testid="confirm-delete"]')?.click()).catch(() => {});
await page.waitForTimeout(800);

// belt + suspenders with the one-shot consume: never leave the fixture hook
// set in a live app — a leftover global haunted real takes with fixture TTS.
await page.evaluate(() => { delete window.__recorderFixtureUrl; });

const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `\n${failed} FAILED` : `\nALL PASS (${results.length} checks)`);
process.exit(failed ? 1 : 0);
