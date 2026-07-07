// Light Brush (Skill 4) — 20x EDITH reasoning battery.
//
// Same faithful harness as the other batteries: drives EDITH's real brain with the
// real edith-v2.md prompt + a video context, grades the OP: lines. Validates she picks
// detectLight / paintLight / clearLights for the right asks and NEVER for grade/voice/etc.
// Store/pixel correctness lives in paintedLightUtils.test.ts.
//
// Run:  node tests/edith/light-prompt-battery.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..', '..');
const OUT = path.join(REPO, 'tests', 'edith', 'light-battery-results.json');
const CONCURRENCY = 5;

const systemPrompt = fs.readFileSync(
  path.join(REPO, 'src', 'backend', 'mycelium', 'prompts', 'edith-v2.md'),
  'utf8',
);

const contextBlock =
  `\n\n## Available Project Media\n` +
  `- [video] "portrait.mp4" | 0:20 | path: C:/portrait.mp4\n` +
  `  (no transcription yet)\n` +
  `\n\n## Timeline\n` +
  `canvas: 1920×1080 (16:9) | fps: 30 | playhead: 2.0s | duration: 20.0s\n` +
  `clips:\n` +
  `  - clip [video, layer 0] 0.0s–20.0s | portrait.mp4 id:clip_v1\n`;

const LIGHT_OPS = new Set(['detectLight', 'paintLight', 'clearLights']);

// want: 'detect' | 'paint' | 'clear' | 'control'
const CASES = [
  { want: 'detect', p: `figure out where the light is coming from` },
  { want: 'detect', p: `detect the light source in this shot` },
  { want: 'detect', p: `match the lighting in this scene` },
  { want: 'detect', p: `relight this to match the scene` },
  { want: 'detect', p: `which direction is the light coming from` },
  { want: 'paint', p: `add a warm light from the left` },
  { want: 'paint', p: `brush a soft light on his face` },
  { want: 'paint', p: `add a blue rim light` },
  { want: 'paint', p: `add a soft fill light on the left side` },
  { want: 'paint', p: `add a golden key light` },
  { want: 'paint', p: `put a soft light in the top right` },
  { want: 'paint', p: `add a cool light behind him` },
  { want: 'clear', p: `remove the light` },
  { want: 'clear', p: `clear the lighting` },
  { want: 'clear', p: `undo the relight` },
  // control → NO light op
  { want: 'control', p: `increase the contrast` },
  { want: 'control', p: `isolate his voice` },
  { want: 'control', p: `add a caption that says hi` },
  { want: 'control', p: `cut the first 3 seconds` },
  { want: 'control', p: `zoom into his face` },
];

function runEdith(userMsg) {
  const fullPrompt = `${systemPrompt}${contextBlock}\n\nUser: ${userMsg}\n\nEDITH:`;
  return new Promise((resolve) => {
    const child = spawn('claude', ['--print', '--model', 'claude-opus-4-7', '--max-turns', '30'], {
      shell: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env },
    });
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
  for (const line of out.split('\n')) {
    const t = line.trim();
    if (t.startsWith('OP:')) { try { ops.push(JSON.parse(t.slice(3).trim())); } catch { ops.push({ type: '__unparseable__', raw: t }); } }
  }
  return ops;
}

function grade(c, ops) {
  const types = ops.map((o) => o.type);
  const lightOps = ops.filter((o) => LIGHT_OPS.has(o.type));
  if (c.want === 'control') {
    return { pass: lightOps.length === 0, reason: lightOps.length === 0 ? 'no light op (correct)' : `spurious ${types}` };
  }
  const target = c.want === 'detect' ? 'detectLight' : c.want === 'paint' ? 'paintLight' : 'clearLights';
  const asked = ops.filter((o) => o.type === target);
  const extras = ops.filter((o) => o.type !== target);
  const pass = asked.length === 1 && extras.length === 0;
  let reason = pass ? `exactly one ${target}` : '';
  if (!pass) {
    if (asked.length !== 1) reason += `expected 1 ${target}, got ${asked.length}; `;
    if (extras.length) reason += `extras ${extras.map((o) => o.type)}; `;
  }
  if (pass && c.want === 'paint' && asked[0].color) reason += ` color=${asked[0].color}`;
  return { pass, reason };
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
      results[i] = {
        n: i + 1, want: c.want, prompt: c.p,
        verdict: timedOut ? 'ERR' : g.pass ? 'PASS' : 'FAIL',
        ops: ops.map((o) => o.type), reason: timedOut ? 'timeout' : g.reason,
        err: err.trim() ? err.trim().slice(0, 160) : undefined,
      };
      const r = results[i];
      console.log(`[${r.verdict}] #${r.n} (${r.want}) ops=${JSON.stringify(r.ops)} — ${r.reason}`);
      fs.writeFileSync(OUT, JSON.stringify(results.filter(Boolean), null, 2));
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  const pass = results.filter((r) => r.verdict === 'PASS').length;
  const byKind = (k) => { const rs = results.filter((r) => r.want === k); return `${rs.filter((r) => r.verdict === 'PASS').length}/${rs.length}`; };
  console.log(`\n=== ${pass}/${results.length} passed  (detect ${byKind('detect')}, paint ${byKind('paint')}, clear ${byKind('clear')}, control ${byKind('control')}) ===`);
  console.log(`artifacts: ${OUT}`);
  process.exit(0);
}
main();
