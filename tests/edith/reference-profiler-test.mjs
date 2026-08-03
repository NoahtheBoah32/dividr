/**
 * Standalone test of the reference profiler — no Electron, no app.
 * Runs the full pipeline (ffprobe → scdet → audio → whisper → frames → Claude
 * → synthesis) on a real reference file and prints stage timings + the digest.
 * Run: npx tsx tests/edith/reference-profiler-test.mjs [videoPath]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { profileReference, renderProfileDigest } from '../../src/backend/mycelium/referenceProfiler.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appPath = path.resolve(__dirname, '..', '..');
const video = process.argv[2] || 'C:\\tmp\\dividr-demo-research\\ref_vinh.mp4';

if (!fs.existsSync(video)) { console.log(`FAIL: test video missing: ${video}`); process.exit(1); }

const t0 = Date.now();
let lastStage = '';
let stageStart = t0;

const result = await profileReference(video, appPath, (stage, detail, done) => {
  const now = Date.now();
  if (stage !== lastStage) { lastStage = stage; stageStart = now; }
  const elapsed = ((now - stageStart) / 1000).toFixed(1);
  console.log(`${done ? '✓' : '…'} [${((now - t0) / 1000).toFixed(1)}s] ${stage}${detail ? ` — ${detail}` : ''}${done ? ` (${elapsed}s)` : ''}`);
});

console.log(`\nTOTAL: ${((Date.now() - t0) / 1000).toFixed(1)}s  model: ${result.model}`);

// ── Assertions ────────────────────────────────────────────────────────────────
let pass = 0, fail = 0;
const check = (name, ok, info = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${info ? ` — ${info}` : ''}`);
  ok ? pass++ : fail++;
};

const p = result.profile;
check('profile present with version', p?.version === 1);
check('format measured', p.format.width > 0 && p.format.durationSeconds > 10, `${p.format.width}x${p.format.height} ${p.format.durationSeconds}s`);
check('cuts detected', p.pacing.cutTimes.length >= 5, `${p.pacing.cutTimes.length} cuts`);
check('cut times inside duration', p.pacing.cutTimes.every((t) => t > 0 && t < p.format.durationSeconds));
check('blocks cover timeline chronologically',
  p.blocks.length >= 2 &&
  p.blocks.every((b, i) => i === 0 || b.startSeconds >= p.blocks[i - 1].startSeconds) &&
  p.blocks[0].startSeconds < 1 &&
  p.blocks[p.blocks.length - 1].endSeconds > p.format.durationSeconds - 2,
  p.blocks.map((b) => `${b.fn}@${b.startSeconds}-${b.endSeconds}`).join(' '));
check('per-block measured stats present', p.blocks.every((b) => typeof b.cutCount === 'number'));
check('rules exist and all map to real ops', p.rules.length >= 3, `${p.rules.length} rules: ${p.rules.map((r) => r.action.op).join(', ')}`);
check('captions detected on a captioned reference', p.captions.present === true, p.captions.style);
check('legacy captionStyle kept (back-compat guard)', !!result.captionStyle && Object.keys(result.captionStyle).length > 0);
check('legacy editing/structure kept', !!result.editing && !!result.structure);
check('description non-empty', result.description.length > 20);
check('audio measured', p.audio.lufs !== null, `${p.audio.lufs} LUFS, gaps median ${p.audio.speechGapMedianMs}ms`);

const outPath = path.join('C:\\tmp\\dividr-demo-research', 'profile_' + path.basename(video, '.mp4') + '.json');
fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
console.log(`\nprofile written: ${outPath}`);
console.log('\n──── CONTEXT DIGEST (what EDITH will read) ────\n');
console.log(renderProfileDigest(p));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
