// Transcript Surgery (Skill 1) — 20x EDITH reasoning battery.
//
// Drives EDITH's real brain the exact way agentRuntime.spawnEdith does:
//   claude --print --model claude-opus-4-7  <- systemPrompt + context + "User: …\nEDITH:"
// and parses the OP: lines she emits. No Electron/renderer needed — this isolates the
// one thing 20x-varied-phrasing tests actually validate: does she pick the RIGHT op
// (and ONLY it) across paraphrases, and never surgery when the intent is something else.
//
// Store-side correctness (that the op mutates the timeline right) is covered separately
// by transcriptSurgery.store.test.ts. Together = the full chain.
//
// Run:  node tests/edith/surgery-prompt-battery.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..', '..');
const OUT = path.join(REPO, 'tests', 'edith', 'surgery-battery-results.json');
const CONCURRENCY = 5;

const systemPrompt = fs.readFileSync(
  path.join(REPO, 'src', 'backend', 'mycelium', 'prompts', 'edith-v2.md'),
  'utf8',
);

const SENT =
  "He was going after me and I didn't know what to do He was really running after me it was very scary but I think now is a better time to relax";

const contextBlock =
  `\n\n## Available Project Media\n` +
  `- [video] "clip.mp4" | 0:12 | path: C:/clip.mp4\n` +
  `  transcription:\n` +
  `    [00:00-00:12] ${SENT}\n` +
  `\n\n## Timeline\n` +
  `canvas: 1280×720 (16:9) | fps: 30 | playhead: 0.0s | duration: 12.8s\n` +
  `clips:\n` +
  `  - clip [video, layer 0] 0.0s–12.8s | clip.mp4 id:clip_a1\n` +
  `  - clip [audio, layer 0] 0.0s–12.8s | clip.mp4 (Audio) id:clip_a2\n`;

// verdict: 'pull' | 'reorder' | 'control'
const CASES = [
  // ── PULL (copy) — expect exactly one pullPhrase ────────────────────────────
  { want: 'pull', p: `pull the scene where he says "a better time to relax" to the start` },
  { want: 'pull', p: `copy the part where he says "I didn't know what to do" and put it at the playhead` },
  { want: 'pull', p: `take the clip of "he was really running after me" and drop a copy at 2 seconds` },
  { want: 'pull', p: `duplicate the moment he says "it was very scary" to the front` },
  { want: 'pull', p: `I want the "now is a better time to relax" bit to also appear at the beginning` },
  { want: 'pull', p: `grab where he says "he was going after me" and paste it at 10 seconds` },
  { want: 'pull', p: `put a second copy of the "I think now is a better time" line at the end` },
  { want: 'pull', p: `clone the scene of him saying "what to do" to the start` },
  // ── REORDER (move) — expect exactly one reorderPhrase ──────────────────────
  { want: 'reorder', p: `move the "a better time to relax" scene to the very beginning` },
  { want: 'reorder', p: `reorder so that "he was going after me" comes first` },
  { want: 'reorder', p: `take "it was very scary" and move it to the front, don't leave the original behind` },
  { want: 'reorder', p: `bring the "now is a better time to relax" part to the start of the video` },
  { want: 'reorder', p: `rearrange so "I didn't know what to do" plays at 1 second instead` },
  { want: 'reorder', p: `shift the "he was really running after me" scene to the end` },
  // ── CONTROL — must emit NO surgery op (right op is something else, or a question) ──
  { want: 'control', p: `make the video brighter` },
  { want: 'control', p: `cut the first 3 seconds` },
  { want: 'control', p: `add a caption that says Hello` },
  { want: 'control', p: `zoom into his face at 5 seconds` },
  { want: 'control', p: `isolate his voice` },
  { want: 'control', p: `delete the part where he says "it was very scary"` }, // quoted phrase but DELETE intent
];

function runEdith(userMsg) {
  const fullPrompt = `${systemPrompt}${contextBlock}\n\nUser: ${userMsg}\n\nEDITH:`;
  return new Promise((resolve) => {
    const child = spawn('claude', ['--print', '--model', 'claude-opus-4-7', '--max-turns', '30'], {
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      resolve({ out, err: err + '\n[timeout]', timedOut: true });
    }, 150000);
    child.stdout.on('data', (b) => (out += b.toString()));
    child.stderr.on('data', (b) => (err += b.toString()));
    child.on('close', () => { clearTimeout(timer); resolve({ out, err, timedOut: false }); });
    child.stdin.write(fullPrompt);
    child.stdin.end();
  });
}

function parseOps(out) {
  const ops = [];
  for (const line of out.split('\n')) {
    const t = line.trim();
    if (t.startsWith('OP:')) {
      try { ops.push(JSON.parse(t.slice(3).trim())); } catch { ops.push({ type: '__unparseable__', raw: t }); }
    }
  }
  return ops;
}

function grade(want, ops) {
  const types = ops.map((o) => o.type);
  const surgery = ops.filter((o) => o.type === 'pullPhrase' || o.type === 'reorderPhrase');
  if (want === 'control') {
    return { pass: surgery.length === 0, reason: surgery.length === 0 ? 'no surgery op (correct)' : `spurious surgery: ${types}` };
  }
  const target = want === 'pull' ? 'pullPhrase' : 'reorderPhrase';
  const asked = ops.filter((o) => o.type === target);
  const extras = ops.filter((o) => o.type !== target);
  const phraseOk = asked.length === 1 && typeof asked[0].phrase === 'string' && asked[0].phrase.trim().length > 0;
  const pass = asked.length === 1 && extras.length === 0 && phraseOk;
  let reason = pass ? `exactly one ${target}, phrase="${asked[0].phrase}"` : '';
  if (!pass) {
    if (asked.length !== 1) reason += `expected 1 ${target}, got ${asked.length}; `;
    if (extras.length) reason += `extra ops ${extras.map((o) => o.type)}; `;
    if (asked.length === 1 && !phraseOk) reason += `bad phrase; `;
  }
  return { pass, reason };
}

async function main() {
  const results = new Array(CASES.length);
  let idx = 0;
  async function worker(wid) {
    while (idx < CASES.length) {
      const i = idx++;
      const c = CASES[i];
      const { out, err, timedOut } = await runEdith(c.p);
      const ops = parseOps(out);
      const g = grade(c.want, ops);
      const natural = out.split('\n').filter((l) => l.trim() && !l.trim().startsWith('OP:') && !l.trim().startsWith('PLAN:')).join(' ').slice(0, 160);
      results[i] = {
        n: i + 1, want: c.want, prompt: c.p,
        verdict: timedOut ? 'ERR' : g.pass ? 'PASS' : 'FAIL',
        ops: ops.map((o) => o.type), phrase: ops.find((o) => /Phrase$/.test(o.type))?.phrase ?? null,
        reason: timedOut ? 'timeout' : g.reason, natural: natural || null,
        err: err.trim() ? err.trim().slice(0, 200) : undefined,
      };
      const r = results[i];
      console.log(`[${r.verdict}] #${r.n} (${r.want}) ops=${JSON.stringify(r.ops)} — ${r.reason}`);
      fs.writeFileSync(OUT, JSON.stringify(results.filter(Boolean), null, 2));
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, (_, w) => worker(w)));
  const pass = results.filter((r) => r.verdict === 'PASS').length;
  const byKind = (k) => {
    const rs = results.filter((r) => r.want === k);
    return `${rs.filter((r) => r.verdict === 'PASS').length}/${rs.length}`;
  };
  console.log(`\n=== ${pass}/${results.length} passed  (pull ${byKind('pull')}, reorder ${byKind('reorder')}, control ${byKind('control')}) ===`);
  console.log(`artifacts: ${OUT}`);
  process.exit(0);
}
main();
