/**
 * Ken Burns export bake — builds the REAL ffmpeg command through
 * buildFfmpegCommand with kenBurns params on the video track, RUNS it, and
 * proves the picture actually pushes in: the first frames of the KB export
 * and a control export are near-identical (zoom ≈ 1), the last frames differ
 * hard (zoom = 1.35 crop). Run: npx tsx tests/edith/kb-export.mjs
 */
import { execFileSync, execSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const SP = 'C:/Users/User/AppData/Local/Temp/claude/C--Users-User-Documents-AANG-V2/4b42243e-b537-438d-b50a-750efc6019b4/scratchpad';
const SRC = `${SP}/export-bug-src.mp4`; // 640x360 30fps 15s testsrc2+sine

const origLog = console.log; console.log = () => {};
const { buildFfmpegCommand } = await import('../../src/backend/ffmpeg/export/commandBuilder.ts');
console.log = origLog;

let pass = 0, fail = 0;
const check = (n, ok, d = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  — ' + d : ''}`); ok ? pass++ : fail++; };

if (!existsSync(SRC)) {
  execSync(`ffmpeg -y -f lavfi -i "testsrc2=size=640x360:rate=30" -f lavfi -i "sine=frequency=440" -t 15 -c:v libx264 -pix_fmt yuv420p -c:a aac "${SRC}"`, { stdio: 'pipe' });
}

const base = {
  startTime: 0, duration: 10, timelineStartFrame: 0, timelineEndFrame: 300,
  visible: true, width: 640, height: 360, sourceFps: 30, effectiveFps: 30,
  volumeDb: 0, muted: true, trackRowIndex: 0, layerIndex: 0,
  path: SRC, trackType: 'video',
};

async function build(track, out) {
  console.log = () => {};
  const args = await buildFfmpegCommand(
    { inputs: [track], output: out, operations: { targetFrameRate: 30, threads: 2, useHardwareAcceleration: false }, videoDimensions: { width: 640, height: 360 } },
    undefined, 'ffmpeg',
  );
  console.log = origLog;
  return args;
}
function runFfmpeg(args) {
  try { execFileSync('ffmpeg', ['-y', ...args.filter(a => a !== 'ffmpeg')], { stdio: 'pipe' }); return { ok: true }; }
  catch (e) { return { ok: false, err: (e.stderr?.toString() ?? String(e)).split('\n').slice(-6).join('\n') }; }
}
const probe = (f, ent) => execSync(`ffprobe -v error -show_entries ${ent} -of csv=p=0 "${f}"`).toString().trim();
const grabFrame = (mp4, t, png) => execSync(`ffmpeg -y -ss ${t} -i "${mp4}" -vframes 1 "${png}"`, { stdio: 'pipe' });
const psnr = (a, b) => {
  try {
    execFileSync('ffmpeg', ['-i', a, '-i', b, '-lavfi', 'psnr', '-f', 'null', '-'], { stdio: 'pipe' });
  } catch { /* psnr writes to stderr and exits 0; catch just in case */ }
  const out = execSync(`ffmpeg -i "${a}" -i "${b}" -lavfi psnr -f null - 2>&1`).toString();
  const m = out.match(/average:([\d.]+|inf)/);
  return m ? (m[1] === 'inf' ? 99 : parseFloat(m[1])) : NaN;
};

/* ── Build both exports ── */
const kbOut = `${SP}/kb-export.mp4`;
const ctlOut = `${SP}/kb-control.mp4`;
const kbArgs = await build({ ...base, kenBurns: { endZoom: 1.35, cx: 0.5, cy: 0.5, frames: 300 } }, kbOut);
const ctlArgs = await build({ ...base }, ctlOut);

const fc = kbArgs[kbArgs.indexOf('-filter_complex') + 1] ?? '';
check('KB command contains zoompan', fc.includes('zoompan'), fc.includes('zoompan') ? '' : fc.slice(0, 200));
check('KB zoompan is supersampled ×2', fc.includes('s=1280x720'));
check('control command has NO zoompan', !(ctlArgs[ctlArgs.indexOf('-filter_complex') + 1] ?? '').includes('zoompan'));

const r1 = runFfmpeg(kbArgs);
check('KB export exits 0', r1.ok, r1.ok ? '' : r1.err);
const r2 = runFfmpeg(ctlArgs);
check('control export exits 0', r2.ok, r2.ok ? '' : r2.err);

if (r1.ok && r2.ok) {
  const dKb = parseFloat(probe(kbOut, 'format=duration'));
  const dCtl = parseFloat(probe(ctlOut, 'format=duration'));
  check('KB duration matches control (~10s)', Math.abs(dKb - 10) < 0.6 && Math.abs(dKb - dCtl) < 0.3,
    `${dKb.toFixed(2)}s vs ${dCtl.toFixed(2)}s`);

  const frames = parseInt(probe(kbOut, 'stream=nb_frames').split('\n')[0], 10);
  check('KB frame count intact (~300)', Math.abs(frames - 300) <= 3, `${frames}`);

  grabFrame(kbOut, 0.05, `${SP}/kb-first.png`);
  grabFrame(ctlOut, 0.05, `${SP}/ctl-first.png`);
  grabFrame(kbOut, 9.8, `${SP}/kb-last.png`);
  grabFrame(ctlOut, 9.8, `${SP}/ctl-last.png`);

  const firstPsnr = psnr(`${SP}/kb-first.png`, `${SP}/ctl-first.png`);
  const lastPsnr = psnr(`${SP}/kb-last.png`, `${SP}/ctl-last.png`);
  check('first frames near-identical (zoom≈1)', firstPsnr > 28, `PSNR ${firstPsnr.toFixed(1)}dB`);
  check('last frames differ hard (zoomed 35%)', lastPsnr < 22, `PSNR ${lastPsnr.toFixed(1)}dB`);
} else {
  fail += 4;
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
