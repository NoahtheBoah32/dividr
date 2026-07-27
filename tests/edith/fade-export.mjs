/**
 * Audio fade export — builds the REAL ffmpeg command through buildFfmpegCommand
 * with fades on a DELAYED segment (starts at 5s) and RUNS it. This is the exact
 * case the old filter order got wrong: afade after adelay ramps the leading
 * silence, so a delayed clip never audibly faded. Now afade runs before adelay.
 * Proves: the ramp is audible on the clip's own head/tail, and the filter graph
 * places afade before adelay.
 * Run: npx tsx tests/edith/fade-export.mjs
 */
import { execFileSync, execSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const SP = 'C:/Users/User/AppData/Local/Temp/claude/C--Users-User-Documents-AANG-V2/4b42243e-b537-438d-b50a-750efc6019b4/scratchpad';
const SRC1 = `${SP}/jcut-src1.mp4`; // testsrc + 440Hz, 10s
const SRC2 = `${SP}/jcut-src2.mp4`; // testsrc2 + 880Hz, 10s

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

// Clip 1 fills 0–5s (video only). Clip 2 sits at 5–15s — a DELAYED audio
// segment with a 2s fade-in and a 2s fade-out.
const mkTracks = (withFades) => [
  { ...vbase, path: SRC1, startTime: 0, duration: 5, timelineStartFrame: 0, timelineEndFrame: 150 },
  { ...vbase, path: SRC2, startTime: 0, duration: 10, timelineStartFrame: 150, timelineEndFrame: 450 },
  {
    ...abase, path: SRC2, startTime: 0, duration: 10, timelineStartFrame: 150, timelineEndFrame: 450,
    ...(withFades ? { fadeInDuration: 2, fadeOutDuration: 2 } : {}),
  },
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
const meanVol = (mp4, ss, t) => {
  const out = execSync(`ffmpeg -ss ${ss} -t ${t} -i "${mp4}" -af "volumedetect" -f null - 2>&1`).toString();
  const m = out.match(/mean_volume:\s*(-?[\d.]+)/);
  return m ? parseFloat(m[1]) : NaN;
};

const fOut = `${SP}/fade-export.mp4`;
const cOut = `${SP}/fade-control.mp4`;
const fArgs = await build(mkTracks(true), fOut);
const cArgs = await build(mkTracks(false), cOut);

// ── white-box: afade sits BEFORE adelay in the filter graph ──
const graph = fArgs.join(' ');
const fadeIdx = graph.indexOf('afade=t=in');
const delayIdx = graph.indexOf('adelay=');
check('filter graph contains the fade-in', fadeIdx !== -1);
check('afade runs BEFORE adelay (ramps the clip, not the silence)',
  fadeIdx !== -1 && delayIdx !== -1 && fadeIdx < delayIdx,
  `afade@${fadeIdx} adelay@${delayIdx}`);
check('fade-out st is clip-local (8s of a 10s clip)', graph.includes('afade=t=out:st=8.00:d=2.00'));

const r1 = runFfmpeg(fArgs);
check('fade export exits 0', r1.ok, r1.ok ? '' : r1.err);
const r2 = runFfmpeg(cArgs);
check('control export exits 0', r2.ok, r2.ok ? '' : r2.err);

if (r1.ok && r2.ok) {
  // Head ramp: 5.1–5.7s should be much quieter than full volume at 8–10s
  const headF = meanVol(fOut, 5.1, 0.6);
  const midF = meanVol(fOut, 8.0, 2.0);
  const headC = meanVol(cOut, 5.1, 0.6);
  const midC = meanVol(cOut, 8.0, 2.0);
  check('faded head is quiet, then ramps to full volume',
    headF < midF - 8, `head ${headF}dB vs mid ${midF}dB`);
  check('control head is NOT quiet (fade really did this)',
    headC > midC - 3, `head ${headC}dB vs mid ${midC}dB`);

  // Tail ramp: 14.3–14.9s quieter than mid
  const tailF = meanVol(fOut, 14.3, 0.6);
  const tailC = meanVol(cOut, 14.3, 0.6);
  check('faded tail eases out', tailF < midF - 8, `tail ${tailF}dB vs mid ${midF}dB`);
  check('control tail stays loud', tailC > midC - 3, `tail ${tailC}dB`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
