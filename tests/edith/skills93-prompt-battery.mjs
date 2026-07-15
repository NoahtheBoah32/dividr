// 93-skill batch — EDITH reasoning battery.
//
// Drives EDITH's real brain (claude CLI, same model as the app) with the real
// edith-v2.md prompt + a project context, and grades the OP: lines for the new
// skills: setClipColor, applyLook, setCurves, adjust.grain, stinger, beatSync,
// rackFocus (incl. the dragged-clip token). Also guards against trail-off and
// false "done" claims (past-tense success with no op emitted).
//
// Run:  node tests/edith/skills93-prompt-battery.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..', '..');
const OUT = path.join(REPO, 'tests', 'edith', 'skills93-battery-results.json');
const CONCURRENCY = 4;

const systemPrompt = fs.readFileSync(
  path.join(REPO, 'src', 'backend', 'mycelium', 'prompts', 'edith-v2.md'),
  'utf8',
);

const contextBlock =
  `\n\n## Available Project Media\n` +
  `- [video] "hike.mp4" | 0:45 | path: C:/media/hike.mp4\n` +
  `  (no transcription yet)\n` +
  `- [audio] "lofi-track.mp3" | 0:40 | path: C:/media/lofi-track.mp3\n` +
  `\n\n## SFX Library\n` +
  `boom_impact.mp3 (1.9s), vine_boom.mp3 (1.2s), whoosh.mp3 (0.8s), dog_bark.mp3 (1.0s), ` +
  `applause_clap.mp3 (2.2s), thunder.mp3 (3.0s), bass_drop.mp3 (2.4s), click.mp3 (0.2s)\n` +
  `\n\n## Timeline\n` +
  `canvas: 1920×1080 (16:9) | fps: 30 | playhead: 5.0s | duration: 45.0s\n` +
  `clips:\n` +
  `  - clip [video, layer 0] 0.0s–45.0s | hike.mp4 id:clip_v1\n` +
  `  - clip [audio, row 0] 0.0s–40.0s | lofi-track.mp3 id:clip_a1\n`;

const NEW_OPS = new Set(['setClipColor', 'applyLook', 'setCurves', 'stinger', 'beatSync', 'rackFocus']);

const CASES = [
  // Labels / Colors
  { id: 'label-red', p: `label this clip red`, grade: (ops) => ops.some((o) => o.type === 'setClipColor' && /red|#/i.test(String(o.color))) },
  { id: 'label-broll', p: `color-code the hike footage teal so I can spot it`, grade: (ops) => ops.some((o) => o.type === 'setClipColor' && /teal|#/i.test(String(o.color))) },
  // Looks
  { id: 'look-bw', p: `make it black and white`, grade: (ops) => ops.some((o) => (o.type === 'applyLook' && /bw|black|noir|mono/i.test(String(o.look))) || (o.type === 'adjust' && o.saturation === 0)) },
  { id: 'look-teal-orange', p: `give it that cinematic teal and orange blockbuster look`, grade: (ops) => ops.some((o) => o.type === 'applyLook' && /teal/i.test(String(o.look))) },
  { id: 'look-vintage', p: `make this feel like faded 70s film`, grade: (ops) => ops.some((o) => o.type === 'applyLook' && /vintage|faded|retro|warm/i.test(String(o.look))) },
  // Curves
  { id: 'curves-s', p: `add an s-curve for contrast and crush the blacks a bit`, grade: (ops) => ops.some((o) => o.type === 'setCurves' && (o.master?.length || o.red?.length || o.green?.length || o.blue?.length)) },
  { id: 'curves-fade', p: `lift the blacks so the shadows look faded and matte`, grade: (ops) => ops.some((o) => (o.type === 'setCurves' && o.master?.length) || (o.type === 'adjust' && (o.shadows ?? 0) > 0)) },
  // Grain
  { id: 'grain', p: `add some film grain to the footage`, grade: (ops) => ops.some((o) => (o.type === 'adjust' && (o.grain ?? 0) > 0) || (o.type === 'applyLook' && /vintage|warm-film|film/i.test(String(o.look)))) },
  // Stinger
  { id: 'stinger-at', p: `drop a dramatic stinger at 12 seconds when the logo appears`, grade: (ops) => ops.some((o) => (o.type === 'stinger' && Math.abs((o.atSeconds ?? -99) - 12) < 0.6) || (o.type === 'placeSFX' && Math.abs((o.atTime ?? -99) - 12) < 0.6 && /boom|impact|thunder|bass/i.test(String(o.file)))) },
  { id: 'stinger-here', p: `punctuate this moment with a stinger`, grade: (ops) => ops.some((o) => o.type === 'stinger' || (o.type === 'placeSFX' && /boom|impact|thunder|bass/i.test(String(o.file)))) },
  // Beat sync
  { id: 'beats', p: `mark every beat of the music so I can cut on the drops`, grade: (ops) => ops.some((o) => o.type === 'beatSync') },
  { id: 'beats-2', p: `beat sync my edit to lofi-track`, grade: (ops) => ops.some((o) => o.type === 'beatSync') },
  // Rack focus
  { id: 'rack-range', p: `do a rack focus from me to the mountains between 4 and 9 seconds`, grade: (ops) => ops.some((o) => o.type === 'rackFocus' && (o.startSeconds ?? 0) >= 3 && (o.endSeconds ?? 99) <= 10) },
  { id: 'rack-drag', p: `[clip "hike.mp4" id:clip_v1 at 0.0s-45.0s on the timeline] apply a rack focus to this clip`, grade: (ops) => ops.some((o) => o.type === 'rackFocus' && (o.clipId === 'clip_v1' || /hike/i.test(String(o.clipName ?? '')))) },
  { id: 'rack-direction', p: `shift the focus from the background to my face up front`, grade: (ops) => ops.some((o) => o.type === 'rackFocus' && o.direction === 'far-to-near') },
  // Control — must NOT reach for the new ops
  { id: 'ctl-warm', p: `make it a bit warmer`, grade: (ops) => ops.some((o) => o.type === 'adjust' && (o.temperature ?? 0) > 0) && !ops.some((o) => o.type === 'applyLook') },
  { id: 'ctl-whoosh', p: `add a whoosh sound at 3 seconds`, grade: (ops) => ops.some((o) => o.type === 'placeSFX' && /whoosh/i.test(String(o.file))) && !ops.some((o) => o.type === 'stinger') },
  { id: 'ctl-cut', p: `cut the first 3 seconds off`, grade: (ops) => ops.some((o) => ['cut', 'trim', 'trimClip', 'deleteSegment'].includes(o.type)) && !ops.some((o) => NEW_OPS.has(o.type)) },
];

function runEdith(userMsg) {
  const fullPrompt = `${systemPrompt}${contextBlock}\n\nUser: ${userMsg}\n\nEDITH:`;
  return new Promise((resolve) => {
    const child = spawn('claude', ['--print', '--model', 'claude-opus-4-7', '--max-turns', '30'], {
      shell: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env },
    });
    let out = '', err = '';
    const timer = setTimeout(() => { try { child.kill(); } catch {} resolve({ out, err: err + '\n[timeout]', timedOut: true }); }, 180000);
    child.stdout.on('data', (b) => (out += b.toString()));
    child.stderr.on('data', (b) => (err += b.toString()));
    child.on('close', () => { clearTimeout(timer); resolve({ out, err, timedOut: false }); });
    child.stdin.write(fullPrompt); child.stdin.end();
  });
}

function parseOps(out) {
  const ops = [];
  for (const line of out.split('\n')) {
    const t = line.trim();
    if (t.startsWith('OP:')) { try { ops.push(JSON.parse(t.slice(3).trim())); } catch { ops.push({ type: '__unparseable__', raw: t }); } }
  }
  return ops;
}

// Trail-off / false-claim heuristics on the visible reply text
function integrityIssues(out, ops) {
  const text = out.split('\n').filter((l) => !l.trim().startsWith('OP:')).join(' ').trim();
  const issues = [];
  if (!text && ops.length === 0) issues.push('empty-response');
  if (/\b(applied|done|finished|racked|labeled|synced|added)\b/i.test(text) && ops.length === 0) {
    issues.push('claims-success-without-op');
  }
  if (/\.\.\.\s*$/.test(out.trim()) && ops.length === 0) issues.push('possible-trail-off');
  return issues;
}

const results = [];
let idx = 0;
async function worker() {
  while (idx < CASES.length) {
    const i = idx++;
    const c = CASES[i];
    const { out, timedOut } = await runEdith(c.p);
    const ops = parseOps(out);
    const pass = !timedOut && c.grade(ops);
    const issues = integrityIssues(out, ops);
    results.push({ id: c.id, prompt: c.p, pass, timedOut, ops, issues, reply: out.slice(0, 400) });
    console.log(`${pass && issues.length === 0 ? 'PASS' : 'FAIL'}  ${c.id}  ops=${JSON.stringify(ops.map((o) => o.type))}${issues.length ? ' issues=' + issues.join(',') : ''}`);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.pass || r.issues.length);
console.log(`\n${results.length - failed.length}/${results.length} passed → ${OUT}`);
process.exit(failed.length ? 1 : 0);
