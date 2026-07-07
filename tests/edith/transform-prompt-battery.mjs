// Non-negotiables (flip / rotate) — EDITH reasoning battery.
// Same harness as the skill batteries. Validates EDITH drives the newly-added
// standard transforms (flipClip / rotateClip) and never fires them spuriously.
// Run:  node tests/edith/transform-prompt-battery.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..', '..');
const OUT = path.join(REPO, 'tests', 'edith', 'transform-battery-results.json');
const CONCURRENCY = 5;
const systemPrompt = fs.readFileSync(path.join(REPO, 'src', 'backend', 'mycelium', 'prompts', 'edith-v2.md'), 'utf8');

const contextBlock =
  `\n\n## Available Project Media\n- [video] "clip.mp4" | 0:20 | path: C:/clip.mp4\n  (no transcription yet)\n` +
  `\n\n## Timeline\ncanvas: 1920×1080 (16:9) | fps: 30 | playhead: 1.0s | duration: 20.0s\nclips:\n  - clip [video, layer 0] 0.0s–20.0s | clip.mp4 id:clip_v1\n`;

const XFORM = new Set(['flipClip', 'rotateClip']);
const CASES = [
  { want: 'flip', p: `flip the video horizontally` },
  { want: 'flip', p: `mirror the clip` },
  { want: 'flip', p: `flip it` },
  { want: 'flip', p: `flip it vertically` },
  { want: 'flip', p: `make him face the other way` },
  { want: 'rotate', p: `rotate 90 degrees` },
  { want: 'rotate', p: `the video is sideways, rotate it` },
  { want: 'rotate', p: `turn it clockwise` },
  { want: 'control', p: `make it brighter` },
  { want: 'control', p: `cut the first 3 seconds` },
  { want: 'control', p: `zoom into his face` },
  { want: 'control', p: `add a caption that says hi` },
];

function runEdith(userMsg) {
  const fullPrompt = `${systemPrompt}${contextBlock}\n\nUser: ${userMsg}\n\nEDITH:`;
  return new Promise((resolve) => {
    const child = spawn('claude', ['--print', '--model', 'claude-opus-4-7', '--max-turns', '30'], { shell: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env } });
    let out = '', err = '';
    const timer = setTimeout(() => { try { child.kill(); } catch {} resolve({ out, err: err + '\n[timeout]', timedOut: true }); }, 150000);
    child.stdout.on('data', (b) => (out += b.toString()));
    child.stderr.on('data', (b) => (err += b.toString()));
    child.on('close', () => { clearTimeout(timer); resolve({ out, err, timedOut: false }); });
    child.stdin.write(fullPrompt); child.stdin.end();
  });
}
function parseOps(out) {
  const ops = [];
  for (const line of out.split('\n')) { const t = line.trim(); if (t.startsWith('OP:')) { try { ops.push(JSON.parse(t.slice(3).trim())); } catch { ops.push({ type: '__bad__' }); } } }
  return ops;
}
function grade(c, ops) {
  const x = ops.filter((o) => XFORM.has(o.type));
  if (c.want === 'control') return { pass: x.length === 0, reason: x.length === 0 ? 'no transform op (correct)' : `spurious ${ops.map((o) => o.type)}` };
  const target = c.want === 'flip' ? 'flipClip' : 'rotateClip';
  const asked = ops.filter((o) => o.type === target);
  const extras = ops.filter((o) => o.type !== target);
  const pass = asked.length === 1 && extras.length === 0;
  return { pass, reason: pass ? `exactly one ${target}${asked[0].axis ? ` axis=${asked[0].axis}` : ''}${asked[0].degrees != null ? ` deg=${asked[0].degrees}` : ''}` : `got ${asked.length} ${target}${extras.length ? `, extras ${extras.map((o) => o.type)}` : ''}` };
}
async function main() {
  const results = new Array(CASES.length);
  let idx = 0;
  async function worker() {
    while (idx < CASES.length) {
      const i = idx++;
      const c = CASES[i];
      const { out, err, timedOut } = await runEdith(c.p);
      const ops = parseOps(out);
      const g = grade(c, ops);
      results[i] = { n: i + 1, want: c.want, prompt: c.p, verdict: timedOut ? 'ERR' : g.pass ? 'PASS' : 'FAIL', ops: ops.map((o) => o.type), reason: timedOut ? 'timeout' : g.reason, err: err.trim() ? err.trim().slice(0, 140) : undefined };
      const r = results[i];
      console.log(`[${r.verdict}] #${r.n} (${r.want}) ops=${JSON.stringify(r.ops)} — ${r.reason}`);
      fs.writeFileSync(OUT, JSON.stringify(results.filter(Boolean), null, 2));
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  const pass = results.filter((r) => r.verdict === 'PASS').length;
  console.log(`\n=== ${pass}/${results.length} passed ===\nartifacts: ${OUT}`);
  process.exit(0);
}
main();
