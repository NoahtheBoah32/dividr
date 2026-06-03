/**
 * EDITH Token Cost Test — using claude CLI with --output-format json
 * Mirrors exactly what agentRuntime.ts does: fullPrompt piped to claude --print via stdin
 * The JSON output gives us real token counts and USD cost per call.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- Load EDITH system prompt (same path as agentRuntime.ts) ---
function loadSystemPrompt() {
  const p = path.join(__dirname, 'src', 'backend', 'mycelium', 'prompts', 'edith.md');
  return fs.readFileSync(p, 'utf8');
}

// --- Context builders (mirrors agentRuntime.ts) ---
function buildMediaContext_none() { return ''; }

function buildMediaContext_singleClipNoTranscript() {
  return `\n\n## Available Project Media\nUse these paths in ops. Do not invent paths.\n\n### Footage\n- [video] "interview-sir-hubert.mp4" | 20m 15s\n  id: clip_001\n  path: /Users/user/footage/interview-sir-hubert.mp4\n  (no transcription yet — emit runWhisper with this id before referencing spoken content)\n`;
}

function buildMediaContext_singleClipWithTranscript() {
  const transcript = `[00:00] Good morning. Today we're going to talk about natural farming and why it matters for our community here in Oriental Mindoro.
[00:08] I've been farming this land for forty years. Before, we used chemicals. We didn't know better. The yields were high at first, but the soil started to die.
[00:19] That's when I started learning about indigenous farming methods from my grandfather. He knew things that we forgot when the chemical companies came.
[00:31] Natural farming means working with what the forest gives you. You take the microorganisms from the forest floor, you cultivate them, you bring them to your fields.
[00:43] The most important thing is the Indigenous Microorganism — IMO. You collect it from the forest where the soil is healthiest, where the leaves decompose naturally.
[00:55] When you apply IMO to your rice fields, the soil comes alive again. You can see it — the color changes, the texture changes. The earthworms come back.
[01:07] We don't need to buy fertilizer anymore. Everything we need is already here. The forest is our laboratory.
[01:15] The young people ask me, why does this work? I tell them — the forest has been doing this for millions of years without us. We just need to learn from it.
[01:27] My rice yield this year was actually higher than when I used chemicals. And I didn't spend a single peso on inputs.
[01:36] The hardest part is convincing the neighbors. They see you not spraying, not buying bags of fertilizer, and they think you're crazy.
[01:47] But when they see your harvest, they start asking questions. That's how knowledge spreads in a farming community — through results, not lectures.
[01:58] I want to teach my children and grandchildren these methods before the knowledge is lost. That's why I'm here today.
[02:08] The Baganihan Collective started three years ago. We have fourteen families now. Every family that joins, we help them transition their first field.
[02:19] The first season is the hardest. The yields may drop a little as the soil recovers. But by the second season, you're back. By the third, you're better than before.
[02:31] We also make our own plant growth regulator from banana hearts and coconut water. It's free. It takes two weeks to ferment.
[02:41] The youth are the most important. They have energy, they have ideas, and they can learn fast. What I learned in forty years, they can learn in two if they're serious.
[02:52] Climate change is real here. Our rainfall patterns have changed. We get floods where we never had floods before. Natural farming actually helps with this.
[03:03] The organic matter in the soil holds water during dry season and drains during wet season. Chemical farming destroys that capacity.
[03:14] I believe that if we can get even thirty percent of Mindoro's farmers to convert to natural methods, we'll see the rivers running cleaner within five years.
[03:26] The fish in the rivers are coming back in areas where farmers stopped spraying. The connection is direct.
[03:34] My message to young Filipinos is this — the answers to our problems are already here, in our own land, in our own knowledge system. We don't need to import solutions.
[03:46] Farming is not backwards. Farming done right is the most sophisticated relationship between humans and the earth that exists.
[03:55] Thank you. Let's go see the fields now.`;

  return `\n\n## Available Project Media\nUse these paths in ops. Do not invent paths.\n\n### Footage\n- [video] "interview-sir-hubert.mp4" | 20m 15s\n  id: clip_001\n  path: /Users/user/footage/interview-sir-hubert.mp4\n  transcription:\n${transcript.split('\n').map(l => '    ' + l).join('\n')}\n`;
}

function buildMediaContext_full() {
  const mainClip = buildMediaContext_singleClipWithTranscript();
  return mainClip
    + `- [video] "broll-rice-fields.mp4" | 3m 45s\n  id: clip_002\n  path: /Users/user/footage/broll-rice-fields.mp4\n  (no transcription yet)\n`
    + `- [video] "broll-soil-closeup.mp4" | 2m 10s\n  id: clip_003\n  path: /Users/user/footage/broll-soil-closeup.mp4\n  (no transcription yet)\n`
    + `- [video] "broll-baganihan-harvest.mp4" | 5m 30s\n  id: clip_004\n  path: /Users/user/footage/broll-baganihan-harvest.mp4\n  (no transcription yet)\n`;
}

function buildTimeline_empty() {
  return `\n\n## Current Timeline\ncanvas: 1080×1920 (9:16)\nfps: 30 | playhead: frame 0 (0.00s) | totalFrames: 0 (0.00s) | clipsOnTimeline: 0\n\n### Clips (in playback order)\n(timeline is empty — insert media first before referencing clipIds)\n`;
}

function buildTimeline_loaded() {
  return `\n\n## Current Timeline\ncanvas: 1080×1920 (9:16)\nfps: 30 | playhead: frame 0 (0.00s) | totalFrames: 36450 (1215.00s) | clipsOnTimeline: 1\n\n### Clips (in playback order)\n[0] id: tclip_001 | source: clip_001 | start: 0.00s | end: 1215.00s | type: video\n`;
}

// --- Run claude CLI and capture JSON output ---
function runEdith(fullPrompt, maxTurns = 1) {
  return new Promise((resolve, reject) => {
    const claude = spawn(
      'claude',
      ['--print', '--output-format', 'json', '--model', 'claude-opus-4-7', '--max-turns', String(maxTurns)],
      { shell: true, stdio: ['pipe', 'pipe', 'pipe'] },
    );

    let stdout = '';
    let stderr = '';

    claude.stdout?.on('data', (chunk) => { stdout += chunk.toString(); });
    claude.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });

    claude.on('close', (code) => {
      try {
        const json = JSON.parse(stdout);
        resolve(json);
      } catch {
        reject(new Error(`Parse failed (exit ${code}): ${stdout.slice(0, 500)}\nSTDERR: ${stderr.slice(0, 500)}`));
      }
    });

    if (claude.stdin) {
      claude.stdin.write(fullPrompt);
      claude.stdin.end();
    }
  });
}

function fmt(usd) { return '$' + usd.toFixed(5); }
function fmtTok(n) { return (n ?? 0).toLocaleString(); }

async function runScenario(label, fullPrompt, maxTurns = 1) {
  process.stdout.write(`\nRunning: ${label}\n  → `);
  try {
    const result = await runEdith(fullPrompt, maxTurns);
    const u = result.usage ?? {};
    const inputTok = u.input_tokens ?? 0;
    const outputTok = u.output_tokens ?? 0;
    const cacheCreate = u.cache_creation_input_tokens ?? 0;
    const cacheRead = u.cache_read_input_tokens ?? 0;
    const costUSD = result.total_cost_usd ?? 0;

    console.log(`done (${result.duration_ms}ms)`);
    console.log(`  Input tokens:            ${fmtTok(inputTok)}`);
    console.log(`  Cache creation tokens:   ${fmtTok(cacheCreate)}`);
    console.log(`  Cache read tokens:       ${fmtTok(cacheRead)}`);
    console.log(`  Output tokens:           ${fmtTok(outputTok)}`);
    console.log(`  Total cost (USD):        ${fmt(costUSD)}`);
    if (maxTurns > 1 && result.result) {
      const preview = result.result.slice(0, 300).replace(/\n/g, ' ');
      console.log(`  Response preview:        ${preview}...`);
    }
    return { label, inputTok, outputTok, cacheCreate, cacheRead, costUSD, durationMs: result.duration_ms };
  } catch (err) {
    console.log(`FAILED: ${err.message}`);
    return { label, error: err.message };
  }
}

async function main() {
  console.log('EDITH Token Cost Test — ' + new Date().toISOString());
  console.log('='.repeat(60));

  const systemPrompt = loadSystemPrompt();
  console.log(`System prompt: ${systemPrompt.length} characters`);

  const userBrief = 'Edit this interview footage into a punchy 60-90 second Instagram Reel. Start with the strongest hook from the transcript, cut aggressively on energy, add captions, place B-roll where relevant.';

  const scenarios = [
    {
      label: 'S1: System prompt only (no media context, no timeline)',
      fullPrompt: `${systemPrompt}\n\nUser: ${userBrief}\n\nEDITH:`,
      maxTurns: 1,
    },
    {
      label: 'S2: System prompt + 1 clip, NO transcript',
      fullPrompt: `${systemPrompt}${buildMediaContext_singleClipNoTranscript()}${buildTimeline_empty()}\n\nUser: ${userBrief}\n\nEDITH:`,
      maxTurns: 1,
    },
    {
      label: 'S3: System prompt + 1 clip with full ~4min transcript (INPUT ONLY, max_turns:1)',
      fullPrompt: `${systemPrompt}${buildMediaContext_singleClipWithTranscript()}${buildTimeline_empty()}\n\nUser: ${userBrief}\n\nEDITH:`,
      maxTurns: 1,
    },
    {
      label: 'S4: System prompt + full session (interview + 3 B-roll + loaded timeline, INPUT ONLY)',
      fullPrompt: `${systemPrompt}${buildMediaContext_full()}${buildTimeline_loaded()}\n\nUser: ${userBrief}\n\nEDITH:`,
      maxTurns: 1,
    },
    {
      label: 'S5: FULL RUN — S3 context, real EDITH edit, max_turns:30 (measures actual output + cost)',
      fullPrompt: `${systemPrompt}${buildMediaContext_singleClipWithTranscript()}${buildTimeline_empty()}\n\nUser: ${userBrief}\n\nEDITH:`,
      maxTurns: 30,
    },
  ];

  const results = [];
  for (const s of scenarios) {
    const r = await runScenario(s.label, s.fullPrompt, s.maxTurns);
    results.push(r);
    // Pause between calls to avoid rate limit
    await new Promise(res => setTimeout(res, 3000));
  }

  // --- Summary ---
  console.log('\n' + '='.repeat(60));
  console.log('SUMMARY TABLE');
  console.log('='.repeat(60));
  console.log('Label                              | InputTok | CacheCreate | OutputTok | Cost USD');
  console.log('-'.repeat(90));
  for (const r of results) {
    if (r.error) {
      console.log(`${r.label.slice(0, 34).padEnd(34)} | ERROR: ${r.error.slice(0, 50)}`);
      continue;
    }
    const label = r.label.slice(0, 34).padEnd(34);
    console.log(`${label} | ${fmtTok(r.inputTok).padStart(8)} | ${fmtTok(r.cacheCreate).padStart(11)} | ${fmtTok(r.outputTok).padStart(9)} | ${fmt(r.costUSD)}`);
  }

  // --- Projections from full run ---
  const fullRun = results.find(r => r.label.startsWith('S5:') && !r.error);
  if (fullRun) {
    console.log('\n' + '='.repeat(60));
    console.log('COST PROJECTIONS (based on S5 full run)');
    console.log('='.repeat(60));
    const base = fullRun.costUSD;
    const reelMin = 1.5; // assume 90s reel average

    console.log(`\nBase cost per edit session:     ${fmt(base)}`);
    console.log(`Cost per minute of finished output: ${fmt(base / reelMin)}/min`);
    console.log(`\n10 reels (10 sessions):         ${fmt(base * 10)}`);
    console.log(`20 reels (batch from 1 source): ${fmt(base * 20)}`);
    console.log(`100 sessions/mo (small studio): ${fmt(base * 100)}/mo`);
    console.log(`300 sessions/mo (agency):       ${fmt(base * 300)}/mo`);
    console.log(`3000 sessions/mo (platform):    ${fmt(base * 3000)}/mo`);
  }

  // --- System prompt token analysis ---
  const s1 = results.find(r => r.label.startsWith('S1:') && !r.error);
  const s3 = results.find(r => r.label.startsWith('S3:') && !r.error);
  if (s1 && s3) {
    const transcriptTokens = (s3.inputTok + s3.cacheCreate) - (s1.inputTok + s1.cacheCreate);
    console.log('\n' + '='.repeat(60));
    console.log('TOKEN BREAKDOWN ANALYSIS');
    console.log('='.repeat(60));
    console.log(`System prompt tokens (approx):  ${fmtTok(s1.inputTok + s1.cacheCreate)}`);
    console.log(`~4min transcript adds:          ${fmtTok(transcriptTokens)} tokens`);
  }

  console.log('\n' + '='.repeat(60));
  console.log('NOTE: Costs include Claude Code system prompt overhead.');
  console.log('Direct API calls (via API key) skip this overhead.');
  console.log('='.repeat(60) + '\n');
}

main().catch(console.error);
