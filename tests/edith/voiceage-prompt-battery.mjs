// Voice Ager (Skill 3) — 20x EDITH reasoning battery.
//
// Same faithful harness as the surgery battery: drives EDITH's real brain
// (claude --print --model claude-opus-4-7) with the real edith-v2.md system prompt
// + an audio-bearing timeline context, and grades the OP: lines. Validates she picks
// ageVoice (with the right years) for age asks, and NEVER for clarity/volume/etc.
//
// Store-side correctness (the op ages the track + the DSP math) is covered by
// voiceAgeParams.test.ts. Run:  node tests/edith/voiceage-prompt-battery.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..', '..');
const OUT = path.join(REPO, 'tests', 'edith', 'voiceage-battery-results.json');
const CONCURRENCY = 5;

const systemPrompt = fs.readFileSync(
  path.join(REPO, 'src', 'backend', 'mycelium', 'prompts', 'edith-v2.md'),
  'utf8',
);

const contextBlock =
  `\n\n## Available Project Media\n` +
  `- [video] "interview.mp4" | 0:40 | path: C:/interview.mp4\n` +
  `  transcription:\n` +
  `    [00:00-00:40] So when I started out I never imagined it would grow like this.\n` +
  `\n\n## Timeline\n` +
  `canvas: 1920×1080 (16:9) | fps: 30 | playhead: 0.0s | duration: 40.0s\n` +
  `clips:\n` +
  `  - clip [video, layer 0] 0.0s–40.0s | interview.mp4 id:clip_v1\n` +
  `  - clip [audio, layer 0] 0.0s–40.0s | interview.mp4 (Audio) id:clip_a1\n`;

// want: 'age' (expect ageVoice; expYears optional) | 'control' (expect NO ageVoice)
const CASES = [
  // ── age with an explicit number → ageVoice with matching years ─────────────
  { want: 'age', expYears: 50, p: `make him sound like he's 50` },
  { want: 'age', expYears: 70, p: `age the voice to 70` },
  { want: 'age', expYears: 80, p: `make her sound 80 years old` },
  { want: 'age', expYears: 65, p: `give him a 65 year old voice` },
  { want: 'age', expBand: [40, 49], p: `make him sound like he's in his 40s` },
  { want: 'age', expYears: 30, p: `make the speaker sound 30` },
  // ── age generic (no number) → ageVoice, years optional ─────────────────────
  { want: 'age', p: `make him sound older` },
  { want: 'age', p: `age his voice` },
  { want: 'age', p: `make her sound elderly` },
  { want: 'age', p: `give him an old man voice` },
  { want: 'age', p: `make the voice sound younger` },
  { want: 'age', p: `make him sound ancient` },
  // ── control → must NOT emit ageVoice ───────────────────────────────────────
  { want: 'control', p: `isolate his voice` },
  { want: 'control', p: `remove the background noise` },
  { want: 'control', p: `make the voice clearer` },
  { want: 'control', p: `lower the volume by 6 db` },
  { want: 'control', p: `mute this clip` },
  { want: 'control', p: `separate voice and background into layers` },
  { want: 'control', p: `add a caption that says hello` },
  { want: 'control', p: `make the video brighter` },
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
  const age = ops.filter((o) => o.type === 'ageVoice');
  if (c.want === 'control') {
    return { pass: age.length === 0, reason: age.length === 0 ? 'no ageVoice (correct)' : `spurious ageVoice: ${types}` };
  }
  const extras = ops.filter((o) => o.type !== 'ageVoice');
  if (age.length !== 1 || extras.length) {
    return { pass: false, reason: `expected 1 ageVoice, got ${age.length}${extras.length ? `; extras ${extras.map((o) => o.type)}` : ''}` };
  }
  const yrs = age[0].years;
  if (c.expYears != null) {
    const ok = yrs === c.expYears;
    return { pass: ok, reason: ok ? `ageVoice years=${yrs}` : `years=${yrs} expected ${c.expYears}` };
  }
  if (c.expBand) {
    const ok = typeof yrs === 'number' && yrs >= c.expBand[0] && yrs <= c.expBand[1];
    return { pass: ok, reason: ok ? `ageVoice years=${yrs} in band` : `years=${yrs} not in ${c.expBand}` };
  }
  return { pass: true, reason: `ageVoice years=${yrs ?? '(default)'}` };
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
        ops: ops.map((o) => o.type), years: ops.find((o) => o.type === 'ageVoice')?.years ?? null,
        reason: timedOut ? 'timeout' : g.reason,
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
  console.log(`\n=== ${pass}/${results.length} passed  (age ${byKind('age')}, control ${byKind('control')}) ===`);
  console.log(`artifacts: ${OUT}`);
  process.exit(0);
}
main();
