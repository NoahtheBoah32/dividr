/**
 * Repro + fix-proof for the "Output with label 'audio' does not exist" render
 * crash: a linked audio track still backed by its source .mp4 (extraction
 * pending or failed), clip cut to the first 10s of an 15s source.
 *
 * Builds the REAL ffmpeg command through buildFfmpegCommand and RUNS it.
 */
import { execFileSync, execSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const SP = 'C:/Users/User/AppData/Local/Temp/claude/C--Users-User-Documents-AANG-V2/4b42243e-b537-438d-b50a-750efc6019b4/scratchpad';
const SRC = `${SP}/export-bug-src.mp4`;

// tsx runs the TS sources directly; silence the export pipeline's logging.
const origLog = console.log; console.log = () => {};
const { buildFfmpegCommand } = await import('../../src/backend/ffmpeg/export/commandBuilder.ts');
console.log = origLog;

let pass = 0, fail = 0;
const check = (n, ok, d='') => { console.log(`${ok?'PASS':'FAIL'}  ${n}${d?'  — '+d:''}`); ok?pass++:fail++; };

const base = {
  startTime: 0, duration: 10, timelineStartFrame: 0, timelineEndFrame: 300,
  visible: true, width: 640, height: 360, sourceFps: 30, effectiveFps: 30,
  volumeDb: 0,
};
const videoTrack = { ...base, path: SRC, trackType: 'video', muted: true, trackRowIndex: 0, layerIndex: 0 };
// THE BUG TRIGGER: an audio track whose path is the .mp4 itself.
const audioTrack = { ...base, path: SRC, trackType: 'audio', muted: false, trackRowIndex: 0, layerIndex: 0 };

async function build(inputs, out) {
  console.log = () => {};
  const args = await buildFfmpegCommand(
    // threads must be set: the builder emits `-threads undefined` (a string)
    // without it. The renderer always sets it, so only synthetic jobs hit that.
    { inputs, output: out, operations: { targetFrameRate: 30, threads: 2, useHardwareAcceleration: false }, videoDimensions: { width: 640, height: 360 } },
    undefined, 'ffmpeg',
  );
  console.log = origLog;
  return args;
}

function runFfmpeg(args) {
  try { execFileSync('ffmpeg', ['-y', ...args.filter(a=>a!=='ffmpeg')], { stdio: 'pipe' }); return { ok: true }; }
  catch (e) { return { ok: false, err: (e.stderr?.toString() ?? String(e)).split('\n').slice(-6).join('\n') }; }
}
const probe = (f, ent) => execSync(`ffprobe -v error -show_entries ${ent} -of csv=p=0 "${f}"`).toString().trim();

/* ── Scenario A: the user's exact crash — video + mp4-backed audio track ── */
{
  const out = `${SP}/export-bug-A.mp4`;
  const args = await build([videoTrack, audioTrack], out);
  const fc = args[args.indexOf('-filter_complex') + 1] ?? '';
  const mapsAudio = args.some((a,i)=>a==='-map'&&args[i+1]==='[audio]');
  check('A: filter graph DEFINES [audio]', /\[audio\]/.test(fc));
  check('A: command maps [audio]', mapsAudio);
  const r = runFfmpeg(args);
  check('A: ffmpeg exits 0 (was: hard crash)', r.ok, r.ok?'':r.err);
  if (r.ok) {
    const streams = probe(out, 'stream=codec_type');
    check('A: output HAS an audio stream', streams.includes('audio'), streams.replace(/\n/g,','));
    const dur = parseFloat(probe(out, 'format=duration'));
    check('A: output is ~10s (the cut length)', Math.abs(dur-10) < 0.6, `${dur.toFixed(2)}s`);
  } else { fail += 2; }
}

/* ── Scenario B: no audio track at all — must not map a label that isn't there ── */
{
  const out = `${SP}/export-bug-B.mp4`;
  const args = await build([videoTrack], out);
  const mapsAudio = args.some((a,i)=>a==='-map'&&args[i+1]==='[audio]');
  check('B: video-only export does NOT map [audio]', !mapsAudio);
  const r = runFfmpeg(args);
  check('B: ffmpeg exits 0', r.ok, r.ok?'':r.err);
}

/* ── Scenario C: extraction finished — audio track backed by a real .wav ── */
{
  const wav = `${SP}/export-bug-src.wav`;
  if (!existsSync(wav)) execSync(`ffmpeg -y -i "${SRC}" -vn -acodec pcm_s16le "${wav}"`, { stdio:'pipe' });
  const out = `${SP}/export-bug-C.mp4`;
  const args = await build([videoTrack, { ...audioTrack, path: wav }], out);
  const mapsAudio = args.some((a,i)=>a==='-map'&&args[i+1]==='[audio]');
  check('C: wav-backed audio still maps [audio]', mapsAudio);
  const r = runFfmpeg(args);
  check('C: ffmpeg exits 0', r.ok, r.ok?'':r.err);
  if (r.ok) check('C: output HAS an audio stream', probe(out,'stream=codec_type').includes('audio'));
  else fail++;
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
