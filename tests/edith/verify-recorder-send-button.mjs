// #91 acceptance — recorder "Send to EDITH", both branches:
//  A. real screen take → review shows Retake | Send to EDITH | Save and edit →
//     click Send → outcome must match the file's actual audio (ground-truthed
//     with ffmpeg volumedetect from node): audible → modal closes, EDITH opens,
//     chip attached; silent → amber warning, modal stays.
//  B. audio-mode take with the mic muted at setup → file must be truly silent
//     (this regressed once: runCountdown's first-render closure of startRecording
//     ignored the mute) → warning shows, modal stays, retake cleans up via the
//     in-app confirm-delete dialog.
import { chromium } from 'playwright-core';
import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';

const REC_DIR = 'C:/Users/User/AppData/Roaming/Dividr/recordings';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const newestRec = () => {
  const files = readdirSync(REC_DIR)
    .filter((f) => f.startsWith('rec_'))
    .map((f) => ({ f, t: statSync(`${REC_DIR}/${f}`).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  return files[0] ? `${REC_DIR}/${files[0].f}` : null;
};
const maxVolumeDb = (p) => {
  const r = spawnSync('ffmpeg', ['-i', p, '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' });
  const m = ((r.stderr ?? '') + (r.stdout ?? '')).match(/max_volume: ([-\d.]+) dB/);
  return m ? parseFloat(m[1]) : null; // null = no audio stream
};

const b = await chromium.connectOverCDP('http://localhost:9222');
let page;
for (const c of b.contexts()) for (const p of c.pages()) if (p.url().includes('localhost:517') && !p.url().startsWith('blob:')) page = p;
if (!page) { console.log('NO PAGE'); process.exit(1); }
page.on('dialog', (d) => d.accept().catch(() => {}));

const results = [];
const check = (name, ok, extra = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`); };

const closeAnyModal = async () => {
  const confirm = page.locator('[data-testid="confirm-delete"]');
  if (await confirm.isVisible().catch(() => false)) { await confirm.click(); await sleep(2000); }
  const closeBtn = page.locator('[data-testid="recorder-close"]');
  if (await closeBtn.isVisible().catch(() => false)) { await closeBtn.click(); await sleep(800); }
};

await page.evaluate(async () => { try { await window.__dividrTest.openProjectByTitle('SKILLS-93-TEST'); } catch {} });
await sleep(3000);
await closeAnyModal();

// ══ Scenario A: screen take, outcome ground-truthed against the file ══════
await page.locator('button[title="Record & create"]').click();
await sleep(800);
await page.locator('[data-testid="record-card-screen"]').click();
const permA = page.locator('[data-testid="perm-allow"]');
if (await permA.waitFor({ timeout: 6000 }).then(() => true).catch(() => false)) await permA.click();
const startShare = page.locator('[data-testid="start-share"]');
await startShare.waitFor({ timeout: 12000 });
await startShare.click();
await page.locator('[data-testid="source-item"]').first().waitFor({ timeout: 8000 });
await page.locator('[data-testid="source-item"]').first().click();
await sleep(400);
await page.locator('[data-testid="source-share"]').click();
await page.locator('[data-testid="rec-timer"]').waitFor({ state: 'visible', timeout: 15000 });
await sleep(4000);
await page.locator('[data-testid="rec-stop"]').click();
await page.locator('[data-testid="review-media"]').waitFor({ state: 'visible', timeout: 20000 });
await sleep(1200);

const retake = page.locator('[data-testid="review-retake"]');
const sendBtn = page.locator('[data-testid="review-send-edith"]');
const save = page.locator('[data-testid="review-save"]');
check('A: Retake button visible', await retake.isVisible());
check('A: Send to EDITH button visible', await sendBtn.isVisible(), (await sendBtn.textContent())?.trim());
check('A: Save and edit button visible', await save.isVisible());
const [rb, sb, vb] = await Promise.all([retake.boundingBox(), sendBtn.boundingBox(), save.boundingBox()]);
check('A: Send button matches sibling height', !!sb && Math.abs(sb.height - rb.height) < 2 && Math.abs(sb.height - vb.height) < 2, `h=${sb?.height}`);

const takeA = newestRec();
const dbA = maxVolumeDb(takeA);
const audibleA = typeof dbA === 'number' && dbA > -50;
console.log(`A ground truth: ${takeA} max=${dbA}dB → expect ${audibleA ? 'SENT' : 'WARNED'}`);

await sendBtn.click();
let outcomeA = null;
for (let i = 0; i < 30; i++) {
  await sleep(500);
  const st = await page.evaluate(() => ({
    warn: document.querySelector('[data-testid="review-audio-warning"]')?.textContent?.trim() ?? '',
    modal: !!document.querySelector('[data-testid="recorder-modal"]'),
  }));
  if (st.warn.length > 5) { outcomeA = { kind: 'warned', warn: st.warn }; break; }
  if (!st.modal) { outcomeA = { kind: 'sent' }; break; }
}
check('A: outcome matches file ground truth', outcomeA?.kind === (audibleA ? 'sent' : 'warned'), `${outcomeA?.kind}`);
if (outcomeA?.kind === 'sent') {
  await sleep(1500);
  const after = await page.evaluate(() => ({
    chip: [...document.querySelectorAll('span')].some((e) => /Screen recording \d\d\.\d\d/.test(e.textContent ?? '')),
    input: !!document.querySelector('[data-testid="edith-input"]'),
  }));
  check('A: EDITH panel is open', after.input);
  check('A: recording attached as chip', after.chip);
  await page.evaluate(() => {
    [...document.querySelectorAll('button')].filter((x) => x.textContent === '×').forEach((x) => x.click());
  });
} else if (outcomeA?.kind === 'warned') {
  check('A: warning mentions the microphone', /microphone/i.test(outcomeA.warn));
  await retake.click();
  await sleep(800);
  await closeAnyModal();
}

// ══ Scenario B: audio mode, mic muted at setup → must warn ════════════════
await page.locator('button[title="Record & create"]').click();
await sleep(800);
await page.locator('[data-testid="record-card-audio"]').click();
const permB = page.locator('[data-testid="perm-allow"]');
if (await permB.waitFor({ timeout: 6000 }).then(() => true).catch(() => false)) await permB.click();
const startRec = page.locator('[data-testid="start-recording"]');
await startRec.waitFor({ timeout: 12000 });
await sleep(500);
await page.locator('[data-testid="mic-toggle"]').click();
await sleep(400);
const micTitle = await page.evaluate(() => document.querySelector('[data-testid="mic-toggle"]')?.getAttribute('title'));
check('B: mic toggle registered mute', /turn on/i.test(micTitle ?? ''), micTitle);
await startRec.click();
await page.locator('[data-testid="rec-timer"]').waitFor({ state: 'visible', timeout: 15000 });
await sleep(3000);
await page.locator('[data-testid="rec-stop"]').click();
await page.locator('[data-testid="review-media"]').waitFor({ state: 'visible', timeout: 20000 });
await sleep(1200);

const takeB = newestRec();
const dbB = maxVolumeDb(takeB);
check('B: muted take is truly silent on disk', dbB === null || dbB <= -50, `max=${dbB}dB`);

await page.locator('[data-testid="review-send-edith"]').click();
let warnB = '';
for (let i = 0; i < 24; i++) {
  await sleep(500);
  warnB = await page.evaluate(() => document.querySelector('[data-testid="review-audio-warning"]')?.textContent?.trim() ?? '');
  if (warnB.length > 5) break;
}
check('B: warning appears', warnB.length > 5, warnB);
check('B: warning mentions the microphone', /microphone/i.test(warnB));
check('B: modal stays open', await page.evaluate(() => !!document.querySelector('[data-testid="recorder-modal"]')));

// cleanup: retake (in-app confirm) then close
await page.locator('[data-testid="review-retake"]').click();
await sleep(800);
await closeAnyModal();
check('B: cleanup — modal closed', await page.evaluate(() => !document.querySelector('[data-testid="recorder-modal"]')));

console.log(results.every(Boolean) ? 'ALL PASS' : 'SOME FAILED');
process.exit(results.every(Boolean) ? 0 : 1);
