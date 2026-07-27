/**
 * J-cut export — builds the REAL ffmpeg command through buildFfmpegCommand
 * with J-cut timeline geometry (audio slid left, picture head-trimmed) and
 * RUNS it. Two synthetic clips with distinct tones make the claim measurable:
 *   clip 1 = testsrc  + 440Hz sine (10s)
 *   clip 2 = testsrc2 + 880Hz sine (10s), J-cut lead 3s
 * Proves: total duration shrinks to 17s, the 880Hz tone is audible from ~7s
 * (3s BEFORE its picture), the 440Hz stays underneath (the mix), the picture
 * still cuts at 10s, and the incoming picture joins 3s in (sync at export).
 * Run: npx tsx tests/edith/jcut-export.mjs
 */
import { execFileSync, execSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const SP = 'C:/Users/User/AppData/Local/Temp/claude/C--Users-User-Documents-AANG-V2/4b42243e-b537-438d-b50a-750efc6019b4/scratchpad';
const SRC1 = `${SP}/jcut-src1.mp4`;
const SRC2 = `${SP}/jcut-src2.mp4`;

const origLog = console.log; console.log = () => {};
const { buildFfmpegCommand } = await import('../../src/backend/ffmpeg/export/commandBuilder.ts');
console.log = origLog;

let pass = 0, fail = 0;
const check = (n, ok, d = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  — ' + d : ''}`); ok ? pass++ : fail++; };

if (!existsSync(SRC1)) {
  execSync(`ffmpeg -y -f lavfi -i "testsrc=size=640x360:rate=30" -f lavfi -i "sine=frequency=440" -t 10 -c:v libx264 -pix_fmt yuv420p -c:a aac "${SRC1}"`, { stdio: 'pipe' });
}
if (!existsSync(SRC2)) {
  execSync(`ffmpeg -y -f lavfi -i "testsrc2=size=640x360:rate=30" -f lavfi -i "sine=frequency=880" -t 10 -c:v libx264 -pix_fmt yuv420p -c:a aac "${SRC2}"`, { stdio: 'pipe' });
}

const vbase = {
  visible: true, width: 640, height: 360, sourceFps: 30, effectiveFps: 30,
  volumeDb: 0, muted: true, trackRowIndex: 0, layerIndex: 0, trackType: 'video',
};
const abase = {
  visible: true, width: 0, height: 0, sourceFps: 30, effectiveFps: 30,
  volumeDb: 0, muted: false, trackRowIndex: 0, layerIndex: 0, trackType: 'audio',
};

// J-cut geometry (lead 3s = 90f): audio slid left, picture head-trimmed
const jcutTracks = [
  { ...vbase, path: SRC1, startTime: 0, duration: 10, timelineStartFrame: 0, timelineEndFrame: 300 },
  { ...abase, path: SRC1, startTime: 0, duration: 10, timelineStartFrame: 0, timelineEndFrame: 300 },
  { ...vbase, path: SRC2, startTime: 3, duration: 7, timelineStartFrame: 300, timelineEndFrame: 510 },
  { ...abase, path: SRC2, startTime: 0, duration: 10, timelineStartFrame: 210, timelineEndFrame: 510, trackRowIndex: 1 },
];
// Control: plain hard cut
const ctlTracks = [
  { ...vbase, path: SRC1, startTime: 0, duration: 10, timelineStartFrame: 0, timelineEndFrame: 300 },
  { ...abase, path: SRC1, startTime: 0, duration: 10, timelineStartFrame: 0, timelineEndFrame: 300 },
  { ...vbase, path: SRC2, startTime: 0, duration: 10, timelineStartFrame: 300, timelineEndFrame: 600 },
  { ...abase, path: SRC2, startTime: 0, duration: 10, timelineStartFrame: 300, timelineEndFrame: 600 },
];

async function build(tracks, out) {
  console.log = () => {};
  const args = await buildFfmpegCommand(
    { inputs: tracks, output: out, operations: { targetFrameRate: 30, threads: 2, useHardwareAcceleration: false }, videoDimensions: { width: 640, height: 360 } },
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
  const out = execSync(`ffmpeg -i "${a}" -i "${b}" -lavfi psnr -f null - 2>&1`).toString();
  const m = out.match(/average:([\d.]+|inf)/);
  return m ? (m[1] === 'inf' ? 99 : parseFloat(m[1])) : NaN;
};
// Mean volume (dB) of a time window through a filter — how we hear each tone.
const meanVol = (mp4, ss, t, af) => {
  const out = execSync(`ffmpeg -ss ${ss} -t ${t} -i "${mp4}" -af "${af},volumedetect" -f null - 2>&1`).toString();
  const m = out.match(/mean_volume:\s*(-?[\d.]+)/);
  return m ? parseFloat(m[1]) : NaN;
};
const HP880 = 'highpass=f=660:poles=2,highpass=f=660:poles=2'; // isolates the 880 tone
const LP440 = 'lowpass=f=550:poles=2,lowpass=f=550:poles=2';   // isolates the 440 tone

const jOut = `${SP}/jcut-export.mp4`;
const cOut = `${SP}/jcut-control.mp4`;
const jArgs = await build(jcutTracks, jOut);
const cArgs = await build(ctlTracks, cOut);

const r1 = runFfmpeg(jArgs);
check('J-cut export exits 0', r1.ok, r1.ok ? '' : r1.err);
const r2 = runFfmpeg(cArgs);
check('control export exits 0', r2.ok, r2.ok ? '' : r2.err);

if (r1.ok && r2.ok) {
  const dJ = parseFloat(probe(jOut, 'format=duration'));
  const dC = parseFloat(probe(cOut, 'format=duration'));
  check('J-cut total is 17s (lost the 3s picture head), control 20s',
    Math.abs(dJ - 17) < 0.4 && Math.abs(dC - 20) < 0.4, `${dJ.toFixed(2)}s vs ${dC.toFixed(2)}s`);

  // ── the LEAK: 880Hz audible at 7.3–9.6s in the J-cut, absent in control ──
  const leakJ = meanVol(jOut, 7.3, 2.3, HP880);
  const leakC = meanVol(cOut, 7.3, 2.3, HP880);
  check('incoming audio audible 3s BEFORE its picture (export)',
    leakJ > leakC + 8, `880Hz in [7.3,9.6]: jcut ${leakJ}dB vs control ${leakC}dB`);

  // ── no premature leak: quiet at 660+ before the lead window ──
  const earlyJ = meanVol(jOut, 4.0, 2.5, HP880);
  check('nothing leaks before the lead window', earlyJ < leakJ - 8,
    `880Hz in [4,6.5]: ${earlyJ}dB vs leak ${leakJ}dB`);

  // ── the MIX: clip 1's 440Hz still underneath during the overlap ──
  const mixJ = meanVol(jOut, 7.3, 2.3, LP440);
  const mix440Ref = meanVol(jOut, 4.0, 2.5, LP440);
  check('previous clip audio keeps playing under the leak (the mix)',
    mixJ > mix440Ref - 6, `440Hz in overlap ${mixJ}dB vs before ${mix440Ref}dB`);

  // ── picture: still clip 1 just before the cut, in BOTH exports ──
  grabFrame(jOut, 9.8, `${SP}/jcut-f-precut.png`);
  grabFrame(cOut, 9.8, `${SP}/ctl-f-precut.png`);
  const pre = psnr(`${SP}/jcut-f-precut.png`, `${SP}/ctl-f-precut.png`);
  check('picture before the cut identical to control (still clip 1)', pre > 28, `PSNR ${pre.toFixed(1)}dB`);

  // ── sync: after the cut the J-cut picture runs 3s AHEAD of control ──
  grabFrame(jOut, 10.5, `${SP}/jcut-f-postcut.png`);
  grabFrame(cOut, 10.5, `${SP}/ctl-f-postcut.png`);
  grabFrame(cOut, 13.5, `${SP}/ctl-f-postcut-plus3.png`);
  const drift = psnr(`${SP}/jcut-f-postcut.png`, `${SP}/ctl-f-postcut.png`);
  const sync = psnr(`${SP}/jcut-f-postcut.png`, `${SP}/ctl-f-postcut-plus3.png`);
  check('incoming picture joins 3s in (differs from control at same instant)', drift < 24, `PSNR ${drift.toFixed(1)}dB`);
  check('…and matches control exactly 3s later (source-time sync)', sync > 26, `PSNR ${sync.toFixed(1)}dB`);
} else {
  fail += 7;
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
