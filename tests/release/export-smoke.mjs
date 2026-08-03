// Export smoke — the checklist's "export a short section to MP4" item, automated:
// stage a small timeline in a dedicated project, drive the REAL export UI
// (tests/edith/export-current-project.mjs), then ffprobe the file: streams,
// duration, and decodable to the last frame.
import { chromium } from 'playwright-core';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureFixtures } from '../fixtures/ensure-fixtures.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const F = ensureFixtures();
const NAME = 'release-export-smoke';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const b = await chromium.connectOverCDP('http://localhost:9222');
let page;
for (const c of b.contexts()) for (const p of c.pages()) if (p.url().includes('localhost:517') && !p.url().startsWith('blob:')) page = p;
if (!page) { console.log('NO PAGE'); process.exit(1); }

// stage: dedicated project with one 8s clip
const opened = await page.evaluate(async () => {
  const ok = await window.__dividrTest.openProjectByTitle('EXPORT-SMOKE');
  if (!ok) await window.__dividrTest.createAndOpenProject('EXPORT-SMOKE');
  return true;
});
await sleep(4000);
// idempotent staging: start from an empty timeline every run
await page.evaluate(() => window.__dividrTest.setStoreState({ tracks: [] }));
await sleep(500);
await page.evaluate((src) => {
  window.__dividrTest.applyOps([{ type: 'broll', src, from: 0, to: 8 }]);
}, F.speech);
await page.evaluate(() => window.__dividrTest.waitForQueueDrained());
await sleep(3000);
console.log('staged: EXPORT-SMOKE project with 8s clip', opened ? '' : '(new)');

// drive the real export UI
const r = spawnSync(process.execPath, ['tests/edith/export-current-project.mjs', NAME], {
  cwd: repoRoot, stdio: 'inherit', timeout: 16 * 60 * 1000,
});
if (r.status !== 0) { console.log('FAIL  export driver failed'); process.exit(1); }

// ffprobe the artifact
const out = `C:/Users/User/Downloads/${NAME}.mp4`;
const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-show_entries', 'stream=codec_type', '-of', 'json', out], { encoding: 'utf8' });
let ok = false;
try {
  const j = JSON.parse(probe.stdout);
  const types = (j.streams ?? []).map((s) => s.codec_type);
  const dur = parseFloat(j.format?.duration ?? '0');
  console.log(`probe: streams=[${types.join(',')}] duration=${dur.toFixed(2)}s`);
  ok = types.includes('video') && types.includes('audio') && dur > 6 && dur < 12;
} catch { /* fall through */ }
console.log(ok ? 'PASS  exported MP4 has video+audio and sane duration' : 'FAIL  export artifact malformed');

// decode-to-end check — catches truncated/corrupt tails players choke on
const dec = spawnSync('ffmpeg', ['-v', 'error', '-i', out, '-f', 'null', '-'], { encoding: 'utf8' });
const decOk = dec.status === 0 && !(dec.stderr ?? '').trim();
console.log(decOk ? 'PASS  file decodes cleanly to the end' : `FAIL  decode errors: ${(dec.stderr ?? '').slice(0, 200)}`);

process.exit(ok && decOk ? 0 : 1);
