/**
 * EDITH Test Harness
 * Constructs the exact same prompts Dividr sends EDITH, runs her via claude --print,
 * grades the output, and reports pass/fail per scenario.
 *
 * Usage: node src/backend/mycelium/edith-test.mjs [test-name]
 *   node src/backend/mycelium/edith-test.mjs          — run all tests
 *   node src/backend/mycelium/edith-test.mjs vague    — run one test by name
 */

import { spawn } from 'child_process';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SYSTEM_PROMPT = readFileSync(path.join(__dirname, 'prompts', 'edith.md'), 'utf8');

// ─── Context builders (mirrors agentRuntime.ts exactly) ──────────────────────

function formatDuration(s) {
  if (!s) return '';
  const m = Math.floor(s / 60), sec = Math.round(s % 60);
  return m > 0 ? `${m}m ${sec}s` : `${sec}s`;
}

function buildMediaContext(media = []) {
  if (!media.length) return '';
  const footage = media.filter(m => !m.isReference);
  const references = media.filter(m => m.isReference);
  let ctx = '\n\n## Available Project Media\nUse these paths in ops. Do not invent paths.\n';

  if (footage.length) {
    ctx += '\n### Footage\n';
    footage.forEach(m => {
      const dur = m.duration ? ` | ${formatDuration(m.duration)}` : '';
      ctx += `- [${m.type}] "${m.name}"${dur}\n  id: ${m.id}\n  path: ${m.path}\n`;
      if (m.transcription) {
        ctx += `  transcription:\n`;
        m.transcription.split('\n').forEach(line => { if (line.trim()) ctx += `    ${line}\n`; });
      } else {
        ctx += `  (no transcription yet — emit runWhisper with this id before referencing spoken content)\n`;
      }
    });
  }

  if (references.length) {
    ctx += '\n### Reference Videos\n';
    references.forEach(m => {
      const dur = m.duration ? ` | ${formatDuration(m.duration)}` : '';
      ctx += `- "${m.name}"${dur}\n  id: ${m.id}\n  path: ${m.path}\n`;
      if (m.referenceAnalysis) {
        const r = m.referenceAnalysis;
        ctx += `  caption style: ${JSON.stringify(r.captionStyle)}\n`;
        if (r.editing) ctx += `  editing style: ${JSON.stringify(r.editing)}\n`;
        if (r.structure) ctx += `  structure: ${JSON.stringify(r.structure)}\n`;
        if (r.colorGrade) ctx += `  color grade: ${JSON.stringify(r.colorGrade)}\n`;
        if (r.description) ctx += `  style note: ${r.description}\n`;
      } else {
        ctx += `  (not yet analyzed — emit analyzeReference with this id to extract the style)\n`;
      }
    });
  }
  return ctx;
}

function buildTimelineSection(snap) {
  if (!snap) return '';
  const { fps = 30, currentFrame, totalFrames, selectedClipIds = [], clips = [], canvasWidth, canvasHeight } = snap;
  const toSec = f => (f / fps).toFixed(2);
  let ctx = `\n\n## Current Timeline\n`;
  if (canvasWidth && canvasHeight) {
    const gcd = (a, b) => b === 0 ? a : gcd(b, a % b);
    const g = gcd(canvasWidth, canvasHeight);
    ctx += `canvas: ${canvasWidth}×${canvasHeight} (${canvasWidth / g}:${canvasHeight / g})\n`;
  }
  ctx += `fps: ${fps} | playhead: frame ${currentFrame} (${toSec(currentFrame)}s) | totalFrames: ${totalFrames} (${toSec(totalFrames)}s) | clipsOnTimeline: ${clips.length}\n`;
  if (selectedClipIds.length) ctx += `selectedClipIds: [${selectedClipIds.map(id => `"${id}"`).join(', ')}]\n`;
  ctx += '\n### Clips (in playback order)\n';
  if (!clips.length) { ctx += '(timeline is empty — insert media first before referencing clipIds)\n'; return ctx; }
  const sorted = [...clips].sort((a, b) => a.startFrame - b.startFrame || a.layer - b.layer);
  for (const c of sorted) {
    let line = `- ${c.id} [${c.type}, layer ${c.layer}] frames ${c.startFrame}–${c.endFrame} (${toSec(c.startFrame)}–${toSec(c.endFrame)}s) | media: "${c.mediaName}"`;
    if (c.sourcePath) line += ` | path: ${c.sourcePath}`;
    if (c.volume !== undefined) line += ` | volume: ${c.volume}dB`;
    if (c.muted) line += ` | muted`;
    if (c.letterboxBlur) line += ` | letterboxBlur: on`;
    if (c.captionText) line += ` | text: "${c.captionText}"`;
    ctx += line + '\n';
  }
  return ctx;
}

function buildPrompt(userMessage, media, timeline, history = []) {
  const mediaSection = buildMediaContext(media);
  const timelineSection = buildTimelineSection(timeline);
  const historyText = history.map(m => `${m.role === 'user' ? 'User' : 'EDITH'}: ${m.text}`).join('\n');
  return `${SYSTEM_PROMPT}${mediaSection}${timelineSection}\n\n${historyText ? historyText + '\n\n' : ''}User: ${userMessage}\n\nEDITH:`;
}

// ─── Runner ──────────────────────────────────────────────────────────────────

function runEdith(prompt, retries = 2) {
  return new Promise((resolve, reject) => {
    const attempt = (remaining) => {
      const proc = spawn('claude', ['--print', '--model', 'claude-opus-4-7', '--max-turns', '1'], {
        shell: true, stdio: ['pipe', 'pipe', 'pipe'],
      });
      let out = '', err = '';
      proc.stdout.on('data', d => { out += d.toString(); });
      proc.stderr.on('data', d => { err += d.toString(); });
      proc.on('close', code => {
        if (code !== 0 && !out.trim()) {
          if (remaining > 0) {
            // Brief pause before retry (rate limit / transient error)
            setTimeout(() => attempt(remaining - 1), 3000);
          } else {
            reject(new Error(`claude exited ${code}: ${err.slice(0, 200)}`));
          }
        } else {
          resolve(out.trim());
        }
      });
      proc.stdin.on('error', (e) => {
        // write EOF: process exited before reading stdin — retry
        if (remaining > 0) {
          setTimeout(() => attempt(remaining - 1), 5000);
        } else {
          reject(e);
        }
      });
      proc.stdin.write(prompt);
      proc.stdin.end();
    };
    attempt(retries);
  });
}

// ─── Output parser ───────────────────────────────────────────────────────────

function parseOutput(raw) {
  const lines = raw.split('\n');
  const ops = [];
  const plans = [];
  const questions = [];
  const text = [];
  let planLineIdx = -1, firstOpIdx = -1;

  lines.forEach((line, i) => {
    if (line.startsWith('OP:')) {
      try {
        const rawJson = line.slice(3).trim().replace(/^`|`$/g, '');  // strip optional backtick wrapping
        ops.push({ idx: i, op: JSON.parse(rawJson) });
      } catch { ops.push({ idx: i, op: null, raw: line }); }
      if (firstOpIdx === -1) firstOpIdx = i;
    } else if (line.startsWith('PLAN:')) {
      try { plans.push({ idx: i, steps: JSON.parse(line.slice(5).trim()) }); } catch { plans.push({ idx: i, steps: null }); }
      if (planLineIdx === -1) planLineIdx = i;
    } else if (line.startsWith('Q:')) {
      try { questions.push({ idx: i, q: JSON.parse(line.slice(2).trim()) }); } catch { questions.push({ idx: i, q: null }); }
    } else if (line.trim()) {
      text.push(line.trim());
    }
  });

  return { ops, plans, questions, text, planLineIdx, firstOpIdx, raw };
}

// ─── Grader ──────────────────────────────────────────────────────────────────

function grade(parsed, checks) {
  const results = [];
  for (const [label, fn] of Object.entries(checks)) {
    try {
      const result = fn(parsed);
      results.push({ label, pass: result === true, detail: result === true ? '' : String(result) });
    } catch (e) {
      results.push({ label, pass: false, detail: e.message });
    }
  }
  return results;
}

// ─── Test scenarios ──────────────────────────────────────────────────────────

const SAMPLE_TRANSCRIPTION = `[00:00-00:05] Marigold is one of the most important plants in permaculture.
[00:05-00:12] It repels pests, attracts pollinators, and fixes nitrogen in the soil.
[00:12-00:18] Our elders have been using it for generations, long before modern farming.
[00:18-00:25] Today I want to show you how we integrate it into the Baganihan food forest.
[00:25-00:32] The key is companion planting — put marigold next to every vegetable bed.
[00:32-00:40] In six months you will see the difference. No pesticides. No chemicals.
[00:40-00:48] This is the old way. This is the right way.`;

// Richer transcription for hook-selection tests
const HOOK_TRANSCRIPTION = `[00:00-00:06] Hello everyone, today I want to share something about our farm.
[00:06-00:12] You know, we have been farming this land for forty years.
[00:12-00:20] When I was young, the frogs were everywhere. You could hear them every night.
[00:20-00:28] Then the chemical companies came. And slowly, the frogs disappeared.
[00:28-00:35] When the frogs disappeared, I knew something was very wrong with our soil.
[00:35-00:44] No frogs means no insects. No insects means no pollinators. No pollinators means no harvest.
[00:44-00:52] That is when I stopped using chemicals and went back to the old ways.
[00:52-01:00] Today we have frogs again. Today our harvest is three times bigger.
[01:00-01:08] The old ways are not backward. They are the future.`;

const REFERENCE_ANALYSIS = {
  captionStyle: {
    fontSize: 44, fontFamily: 'Montserrat', isUppercase: true,
    fillColor: '#FFFFFF', highlightColor: '#FFD700',
    position: 0.68, isBold: true, wordsPerPhrase: 3,
  },
  editing: {
    avgClipLengthSeconds: 3.5, hookDurationSeconds: 3, silenceRemoved: true,
    usesLetterboxBlur: true,
  },
  structure: { openingSeconds: 5, bodySeconds: 45, ctaSeconds: 10 },
  colorGrade: { brightness: 1.05, contrast: 1.15, saturation: 1.3, hueRotate: -5 },
  description: 'Fast-paced permaculture reel, warm cinematic grade, bold white caps with gold highlight',
};

const FOOTAGE_ITEM = {
  id: 'media_001', name: 'marigold-interview.mp4', type: 'video',
  duration: 420, path: 'C:/Users/User/Videos/marigold-interview.mp4', isReference: false,
};

const REFERENCE_ITEM = {
  id: 'ref_001', name: 'reference-reel.mp4', type: 'video',
  duration: 60, path: 'C:/Users/User/Videos/reference-reel.mp4', isReference: true,
  referenceAnalysis: REFERENCE_ANALYSIS,
};

const TIMELINE_16x9 = {
  fps: 30, currentFrame: 0, totalFrames: 12600, selectedClipIds: ['clip_a1'],
  canvasWidth: 1920, canvasHeight: 1080,  // 16:9 — EDITH must fix this
  clips: [{
    id: 'clip_a1', mediaName: 'marigold-interview.mp4',
    sourcePath: 'C:/Users/User/Videos/marigold-interview.mp4',
    type: 'video', layer: 0, startFrame: 0, endFrame: 12600, volume: 0,
  }],
};

const TIMELINE_916 = { ...TIMELINE_16x9, canvasWidth: 1080, canvasHeight: 1920 };  // already 9:16

// ── Scenario definitions ──────────────────────────────────────────────────────

const SCENARIOS = [
  {
    name: 'vague-request',
    desc: 'Vague "edit this" → must ask Q, no ops',
    prompt: buildPrompt(
      'edit this',
      [FOOTAGE_ITEM],
      TIMELINE_16x9,
    ),
    checks: {
      'asks exactly one question': p => p.questions.length === 1 || `got ${p.questions.length} questions`,
      'question has 3 options': p => p.questions[0]?.q?.options?.length === 3 || 'not 3 options',
      'no ops emitted': p => p.ops.length === 0 || `emitted ${p.ops.length} ops alongside Q`,
      'no plan emitted': p => p.plans.length === 0 || 'plan emitted with question',
    },
  },

  {
    name: 'aspect-ratio-first',
    desc: 'Any edit on 16:9 canvas → setAspectRatio must be first op',
    prompt: buildPrompt(
      'cut the silences',
      [FOOTAGE_ITEM],
      TIMELINE_16x9,
    ),
    checks: {
      'emits ops': p => p.ops.length > 0 || 'no ops emitted',
      'setAspectRatio is first op': p => p.ops[0]?.op?.type === 'setAspectRatio' || `first op is "${p.ops[0]?.op?.type}"`,
      'setAspectRatio is 9:16': p => p.ops[0]?.op?.ratio === '9:16' || `ratio is ${p.ops[0]?.op?.ratio}`,
      'setAspectRatio emitted exactly once': p => p.ops.filter(o => o.op?.type === 'setAspectRatio').length === 1 || 'setAspectRatio emitted multiple times',
      'plan before ops': p => p.plans.length > 0 && p.planLineIdx < p.firstOpIdx || 'plan missing or after ops',
    },
  },

  {
    name: 'cut-silence-specific',
    desc: '"Cut the silences" → cutSilence op using correct clip ID',
    prompt: buildPrompt(
      'cut the silences',
      [FOOTAGE_ITEM],
      TIMELINE_16x9,
    ),
    checks: {
      'emits cutSilence': p => p.ops.some(o => o.op?.type === 'cutSilence') || 'no cutSilence op',
      'cutSilence uses real clipId': p => {
        const op = p.ops.find(o => o.op?.type === 'cutSilence');
        return op?.op?.clipId === 'clip_a1' || `clipId is "${op?.op?.clipId}"`;
      },
    },
  },

  {
    name: 'add-captions-no-transcription',
    desc: '"Add captions" with no transcription → must emit runWhisper, not addCaption',
    prompt: buildPrompt(
      'add captions',
      [FOOTAGE_ITEM], // no transcription field
      TIMELINE_16x9,
    ),
    checks: {
      'emits runWhisper': p => p.ops.some(o => o.op?.type === 'runWhisper') || 'no runWhisper op',
      'no addCaption ops (transcription unavailable)': p => p.ops.filter(o => o.op?.type === 'addCaption').length === 0 || 'addCaption emitted without transcription',
      'runWhisper uses a real ID (media or clip)': p => {
        const op = p.ops.find(o => o.op?.type === 'runWhisper');
        const id = op?.op?.clipId;
        // runWhisper may reference the media item ID (media_001) or the timeline clip ID (clip_a1) — both are valid
        return id === 'clip_a1' || id === 'media_001' || `clipId is "${id}" — expected clip_a1 or media_001`;
      },
    },
  },

  {
    name: 'add-captions-with-transcription',
    desc: '"Add captions" with transcription → addCaption from real transcript text',
    prompt: buildPrompt(
      'add captions',
      [{ ...FOOTAGE_ITEM, transcription: SAMPLE_TRANSCRIPTION }],
      TIMELINE_16x9,
    ),
    checks: {
      'emits addCaption ops': p => p.ops.filter(o => o.op?.type === 'addCaption').length >= 3 || `only ${p.ops.filter(o => o.op?.type === 'addCaption').length} captions`,
      'no runWhisper (transcription present)': p => p.ops.filter(o => o.op?.type === 'runWhisper').length === 0 || 'runWhisper emitted when transcription exists',
      'captions from transcription text': p => {
        const transcriptWords = SAMPLE_TRANSCRIPTION.toLowerCase().replace(/\[.*?\]/g, '').split(/\s+/);
        const captions = p.ops.filter(o => o.op?.type === 'addCaption');
        // CTA captions are allowed to contain @handles, "FOLLOW", "MYCELIUM" etc.
        // The last caption is always the CTA — skip it in the transcript check.
        const bodyCapt = captions.slice(0, -1);
        const invented = bodyCapt.filter(c => {
          const words = c.op.text.toLowerCase().split(/\s+/);
          return !words.every(w => transcriptWords.some(tw => tw.includes(w.replace(/[^a-z]/g, ''))));
        });
        return invented.length === 0 || `${invented.length} captions may be invented: ${invented.map(c => '"' + c.op.text + '"').join(', ')}`;
      },
      'captions are uppercase': p => {
        const caps = p.ops.filter(o => o.op?.type === 'addCaption');
        const notUpper = caps.filter(c => c.op.text !== c.op.text.toUpperCase());
        return notUpper.length === 0 || `${notUpper.length} captions not uppercase`;
      },
      'captions have timing': p => {
        const caps = p.ops.filter(o => o.op?.type === 'addCaption');
        const noTime = caps.filter(c => c.op.startSeconds == null || c.op.endSeconds == null);
        return noTime.length === 0 || `${noTime.length} captions missing timing`;
      },
    },
  },

  {
    name: 'make-reel-with-reference',
    desc: '"Make a 60s reel" with reference (Step 0 pre-answered) → applies reference caption style',
    // geminiEdit is DISABLED in edith.md — EDITH must use manual workflow (trimClip + colorGrade + captions from reference style)
    prompt: buildPrompt(
      'continue',
      [{ ...FOOTAGE_ITEM, transcription: SAMPLE_TRANSCRIPTION }, REFERENCE_ITEM],
      TIMELINE_16x9,
      [
        { role: 'user', text: 'make a 60 second reel about the importance of marigolds in permaculture' },
        { role: 'edith', text: 'Q: {"question":"Should I pick the best 60s or use the first 60s?","options":["Pick the best 60s","Use the first 60s","Pick the companion planting segment"]}' },
        { role: 'user', text: 'use the first 60 seconds' },
      ],
    ),
    checks: {
      'no geminiEdit (disabled)': p => !p.ops.some(o => o.op?.type === 'geminiEdit') || 'geminiEdit emitted — it is DISABLED in edith.md',
      'emits trimClip (manual workflow)': p => p.ops.some(o => o.op?.type === 'trimClip') || 'no trimClip — should trim to 60s with manual workflow',
      'emits colorGrade applying reference grade': p => p.ops.some(o => o.op?.type === 'colorGrade') || 'no colorGrade — should apply reference color grade',
      'emits captions': p => p.ops.filter(o => o.op?.type === 'addCaption').length >= 3 || `only ${p.ops.filter(o => o.op?.type === 'addCaption').length} captions`,
      'setAspectRatio first': p => p.ops[0]?.op?.type === 'setAspectRatio' || `first op is "${p.ops[0]?.op?.type}"`,
    },
  },

  {
    name: 'make-reel-no-reference',
    desc: '"Make a 45s reel" (no reference, Step 0 pre-answered) → manual trimClip workflow',
    prompt: buildPrompt(
      'continue',
      [{ ...FOOTAGE_ITEM, transcription: SAMPLE_TRANSCRIPTION }],
      TIMELINE_16x9,
      [
        { role: 'user', text: 'make a 45 second reel about marigolds' },
        { role: 'edith', text: 'Q: {"question":"Should I pick the best 45s or use the first 45s?","options":["Pick the best 45s","Use the first 45s","I\'ll choose the payoff moment"]}' },
        { role: 'user', text: 'use the first 45 seconds' },
      ],
    ),
    checks: {
      'no geminiEdit (no reference)': p => !p.ops.some(o => o.op?.type === 'geminiEdit') || 'geminiEdit used without reference — needs real referenceId',
      'emits trimClip': p => p.ops.some(o => o.op?.type === 'trimClip') || 'no trimClip',
      'trimClip on real clipId': p => {
        const op = p.ops.find(o => o.op?.type === 'trimClip');
        return op?.op?.clipId === 'clip_a1' || `clipId is "${op?.op?.clipId}"`;
      },
      'setAspectRatio first': p => p.ops[0]?.op?.type === 'setAspectRatio' || `first op is "${p.ops[0]?.op?.type}"`,
    },
  },

  {
    name: 'reference-caption-style-applied',
    desc: 'After geminiEdit continue → captions must use reference style, not Mycelium defaults',
    // Simulate: geminiEdit ran, we got "continue", now EDITH should add captions
    prompt: buildPrompt(
      'continue',
      [
        { ...FOOTAGE_ITEM, transcription: SAMPLE_TRANSCRIPTION },
        REFERENCE_ITEM,
      ],
      {
        ...TIMELINE_16x9,
        // Timeline after geminiEdit: clip is trimmed to 60s
        clips: [{
          id: 'clip_a1', mediaName: 'marigold-interview.mp4',
          sourcePath: 'C:/Users/User/Videos/marigold-interview.mp4',
          type: 'video', layer: 0, startFrame: 0, endFrame: 1800, volume: 0,
        }],
        totalFrames: 1800,
      },
      [
        { role: 'user', text: 'make a 60 second reel about the importance of marigolds in permaculture' },
        { role: 'edith', text: 'PLAN: [{"id":"1","step":"Set aspect ratio"},{"id":"2","step":"GeminiEdit with reference"},{"id":"3","step":"Add captions from transcript"},{"id":"4","step":"Mycelium CTA"}]' },
        { role: 'edith', text: 'OP: {"type":"setAspectRatio","ratio":"9:16","stepId":"1"}' },
        { role: 'edith', text: 'OP: {"type":"geminiEdit","userClipId":"clip_a1","referenceId":"ref_001","userRequest":"make a 60 second reel about marigolds","targetDurationSeconds":60,"stepId":"2"}' },
        { role: 'edith', text: 'Transcribing now…' },
      ],
    ),
    checks: {
      'emits addCaption ops': p => p.ops.filter(o => o.op?.type === 'addCaption').length >= 3 || `only ${p.ops.filter(o => o.op?.type === 'addCaption').length} captions`,
      'captions use reference fontSize (44)': p => {
        const caps = p.ops.filter(o => o.op?.type === 'addCaption');
        const wrong = caps.filter(c => c.op.style?.fontSize !== 44);
        return wrong.length === 0 || `${wrong.length}/${caps.length} captions missing reference fontSize 44`;
      },
      'captions use reference fontFamily (Montserrat)': p => {
        const caps = p.ops.filter(o => o.op?.type === 'addCaption');
        const wrong = caps.filter(c => c.op.style?.fontFamily !== 'Montserrat');
        return wrong.length === 0 || `${wrong.length}/${caps.length} captions missing reference fontFamily "Montserrat"`;
      },
      'captions use reference highlightColor (#FFD700)': p => {
        const caps = p.ops.filter(o => o.op?.type === 'addCaption');
        const wrong = caps.filter(c => c.op.style?.highlightColor !== '#FFD700');
        return wrong.length === 0 || `${wrong.length}/${caps.length} captions missing highlightColor`;
      },
      'no setAspectRatio re-emitted': p => {
        const ar = p.ops.filter(o => o.op?.type === 'setAspectRatio');
        return ar.length === 0 || `setAspectRatio re-emitted ${ar.length} time(s)`;
      },
    },
  },

  {
    name: 'silence-cut-interview-with-reference',
    desc: 'silenceRemoved:true in reference (Step 0 pre-answered) → cutSilence before trim',
    prompt: buildPrompt(
      'continue',
      [{ ...FOOTAGE_ITEM, transcription: SAMPLE_TRANSCRIPTION }, REFERENCE_ITEM],
      TIMELINE_16x9,
      [
        { role: 'user', text: 'make a 60 second reel' },
        { role: 'edith', text: 'Q: {"question":"Should I pick the best 60s or use the first 60s?","options":["Pick the best 60s","Use the first 60s","I\'ll find the hook"]}' },
        { role: 'user', text: 'use the first 60 seconds' },
      ],
    ),
    checks: {
      'emits cutSilence': p => p.ops.some(o => o.op?.type === 'cutSilence') || 'no cutSilence — reference has silenceRemoved:true',
      'cutSilence before geminiEdit': p => {
        const csIdx = p.ops.findIndex(o => o.op?.type === 'cutSilence');
        const geIdx = p.ops.findIndex(o => o.op?.type === 'geminiEdit');
        if (csIdx === -1) return 'cutSilence not present';
        if (geIdx === -1) return true; // geminiEdit is slow-op, may be in next turn
        return csIdx < geIdx || `cutSilence at pos ${csIdx}, geminiEdit at pos ${geIdx}`;
      },
    },
  },

  {
    name: 'no-aspect-ratio-when-916',
    desc: 'Canvas already 9:16 → EDITH must NOT re-emit setAspectRatio',
    prompt: buildPrompt(
      'cut the silences',
      [FOOTAGE_ITEM],
      TIMELINE_916,
    ),
    checks: {
      'no setAspectRatio emitted': p => p.ops.filter(o => o.op?.type === 'setAspectRatio').length === 0 || 'setAspectRatio emitted on already-9:16 canvas — wastes a step',
      'emits cutSilence': p => p.ops.some(o => o.op?.type === 'cutSilence') || 'no cutSilence',
    },
  },

  {
    name: 'no-question-with-duration-and-topic',
    desc: '"Make a 60s reel" → Step 0 asks at most 1 trim Q, not multiple unnecessary questions',
    prompt: buildPrompt(
      'make a 60 second reel about marigolds and companion planting',
      [{ ...FOOTAGE_ITEM, transcription: SAMPLE_TRANSCRIPTION }],
      TIMELINE_16x9,
    ),
    checks: {
      'at most one Q (Step 0 trim question only)': p => p.questions.length <= 1 || `asked ${p.questions.length} questions — should ask at most 1 (trim segment) when duration + topic are given`,
      'Q or ops emitted (not silent)': p => p.questions.length > 0 || p.ops.length > 0 || 'EDITH was completely silent — should either ask trim Q or proceed with ops',
    },
  },

  {
    name: 'cta-appended',
    desc: 'Reel must end with a Mycelium CTA caption (Step 0 pre-answered)',
    prompt: buildPrompt(
      'continue',
      [{ ...FOOTAGE_ITEM, transcription: SAMPLE_TRANSCRIPTION }],
      TIMELINE_16x9,
      [
        { role: 'user', text: 'make a 45 second reel about marigolds' },
        { role: 'edith', text: 'Q: {"question":"Should I pick the best 45s or use the first 45s?","options":["Pick the best 45s","Use the first 45s","I\'ll pick the payoff"]}' },
        { role: 'user', text: 'use the first 45 seconds' },
      ],
    ),
    checks: {
      'emits captions': p => p.ops.filter(o => o.op?.type === 'addCaption').length > 0 || 'no captions',
      'last caption is CTA': p => {
        const caps = p.ops.filter(o => o.op?.type === 'addCaption');
        if (!caps.length) return 'no captions';
        const last = caps[caps.length - 1];
        const ctaTerms = ['mycelium', 'follow', 'join', 'learn', 'subscribe', 'link', 'bio'];
        const hasCtaTerm = ctaTerms.some(t => last.op.text.toLowerCase().includes(t));
        return hasCtaTerm || `last caption "${last.op.text}" doesn't look like a CTA`;
      },
    },
  },

  {
    name: 'color-grade-applied',
    desc: 'Reel without reference → Mycelium default color grade must be applied (Step 0 pre-answered)',
    prompt: buildPrompt(
      'continue',
      [{ ...FOOTAGE_ITEM, transcription: SAMPLE_TRANSCRIPTION }],
      TIMELINE_16x9,
      [
        { role: 'user', text: 'make a 45 second reel about marigolds' },
        { role: 'edith', text: 'Q: {"question":"Should I pick the best 45s or use the first 45s?","options":["Pick the best 45s","Use the first 45s","I\'ll find the best moment"]}' },
        { role: 'user', text: 'use the first 45 seconds' },
      ],
    ),
    checks: {
      'emits colorGrade': p => p.ops.some(o => o.op?.type === 'colorGrade') || 'no colorGrade op — should apply Mycelium default warm grade',
      'colorGrade on correct clip': p => {
        const op = p.ops.find(o => o.op?.type === 'colorGrade');
        return op?.op?.clipId === 'clip_a1' || `colorGrade clipId is "${op?.op?.clipId}"`;
      },
      'colorGrade has brightness': p => {
        const op = p.ops.find(o => o.op?.type === 'colorGrade');
        return op?.op?.brightness != null || 'colorGrade missing brightness';
      },
    },
  },

  {
    name: 'caption-style-complete',
    desc: 'Captions must include fontSize and fontFamily in the style object',
    prompt: buildPrompt(
      'add captions',
      [{ ...FOOTAGE_ITEM, transcription: SAMPLE_TRANSCRIPTION }],
      TIMELINE_16x9,
    ),
    checks: {
      'emits addCaption ops': p => p.ops.filter(o => o.op?.type === 'addCaption').length > 0 || 'no captions',
      'all captions have fontSize': p => {
        const caps = p.ops.filter(o => o.op?.type === 'addCaption');
        const missing = caps.filter(c => !c.op.style?.fontSize);
        return missing.length === 0 || `${missing.length}/${caps.length} captions missing fontSize`;
      },
      'all captions have fontFamily': p => {
        const caps = p.ops.filter(o => o.op?.type === 'addCaption');
        const missing = caps.filter(c => !c.op.style?.fontFamily);
        return missing.length === 0 || `${missing.length}/${caps.length} captions missing fontFamily`;
      },
    },
  },

  {
    name: 'honor-specified-hook',
    desc: 'When user specifies a hook moment, first caption must use that moment (Step 0: frogs = hook, skip start Q)',
    prompt: buildPrompt(
      'make a 45 second reel about how modern farming hurt indigenous knowledge. the frogs disappearing is the hook.',
      [{ ...FOOTAGE_ITEM, transcription: HOOK_TRANSCRIPTION }],
      TIMELINE_16x9,
      [
        { role: 'edith', text: 'Q: {"question":"Should I start from the frogs moment or use the first 45s?","options":["Start from the frogs moment (0:12)","Use the first 45s","Find the strongest 45s"]}' },
        { role: 'user', text: 'start from the frogs moment' },
      ],
    ),
    checks: {
      'emits ops': p => p.ops.length > 0 || 'no ops',
      'first caption contains frogs': p => {
        const caps = p.ops.filter(o => o.op?.type === 'addCaption');
        if (!caps.length) return 'no captions';
        const firstFew = caps.slice(0, 3);
        const hasFrogs = firstFew.some(c => c.op.text.toLowerCase().includes('frog'));
        return hasFrogs || `first 3 captions: ${firstFew.map(c => '"' + c.op.text + '"').join(', ')} — none mention frogs`;
      },
      'hook caption starts near 0s': p => {
        const caps = p.ops.filter(o => o.op?.type === 'addCaption');
        const frogsCap = caps.find(c => c.op.text.toLowerCase().includes('frog'));
        if (!frogsCap) return 'no frogs caption found';
        return frogsCap.op.startSeconds <= 4 || `frogs caption starts at ${frogsCap.op.startSeconds}s — hook should be at beginning of the trimmed clip (0-4s)`;
      },
      'does not start with greeting': p => {
        const caps = p.ops.filter(o => o.op?.type === 'addCaption');
        if (!caps.length) return 'no captions';
        const greetings = ['hello', 'hi', 'good morning', 'today i want'];
        const firstCap = caps[0].op.text.toLowerCase();
        const isGreeting = greetings.some(g => firstCap.includes(g));
        return !isGreeting || `first caption "${caps[0].op.text}" is a greeting — should start at hook moment`;
      },
    },
  },

  {
    name: 'broll-after-captions',
    desc: 'After captioning, EDITH should proactively emit b-roll downloadMedia ops (Step 0 pre-answered)',
    prompt: buildPrompt(
      'continue',
      [{ ...FOOTAGE_ITEM, transcription: SAMPLE_TRANSCRIPTION }],
      TIMELINE_916,  // already 9:16 so no aspect ratio op
      [
        { role: 'user', text: 'make a 45 second reel about marigolds in permaculture' },
        { role: 'edith', text: 'Q: {"question":"Should I pick the best 45s or use the first 45s?","options":["Pick the best 45s","Use the first 45s","Pick the companion planting segment"]}' },
        { role: 'user', text: 'use the first 45 seconds' },
      ],
    ),
    checks: {
      'emits downloadMedia for b-roll': p => {
        const downloads = p.ops.filter(o => o.op?.type === 'downloadMedia');
        return downloads.length >= 1 || 'no downloadMedia ops — should proactively suggest b-roll';
      },
      'b-roll is Pixabay': p => {
        const downloads = p.ops.filter(o => o.op?.type === 'downloadMedia');
        const pixabay = downloads.filter(d => d.op.url?.startsWith('pixabaysearch:'));
        return pixabay.length >= 1 || 'no Pixabay downloads — should prefer Pixabay for generic b-roll';
      },
    },
  },

  {
    name: 'caption-timing-quality',
    desc: 'Captions should vary in duration — not all identical length',
    prompt: buildPrompt(
      'add captions',
      [{ ...FOOTAGE_ITEM, transcription: SAMPLE_TRANSCRIPTION }],
      TIMELINE_916,
    ),
    checks: {
      'emits enough captions': p => p.ops.filter(o => o.op?.type === 'addCaption').length >= 5 || 'too few captions',
      'caption durations vary': p => {
        const caps = p.ops.filter(o => o.op?.type === 'addCaption');
        const durations = caps.map(c => (c.op.endSeconds - c.op.startSeconds));
        const min = Math.min(...durations), max = Math.max(...durations);
        return (max - min) > 0.4 || `all captions are same length (min:${min.toFixed(1)}s max:${max.toFixed(1)}s) — should vary with speech rhythm`;
      },
      'no caption over 4 seconds': p => {
        const caps = p.ops.filter(o => o.op?.type === 'addCaption');
        const tooLong = caps.filter(c => (c.op.endSeconds - c.op.startSeconds) > 4);
        return tooLong.length === 0 || `${tooLong.length} captions over 4s: ${tooLong.map(c => '"'+c.op.text+'"').join(', ')}`;
      },
    },
  },

  {
    name: 'multi-reel-planning',
    desc: '"Find 3 reels" → EDITH names all 3 segments, then makes reel 1 (the frogs hook)',
    prompt: buildPrompt(
      'start with the frogs hook reel',
      [{
        ...FOOTAGE_ITEM, duration: 1200,
        transcription: `[00:00-00:06] Hello everyone, today I want to share something about our farm.
[00:06-00:12] You know, we have been farming this land for forty years.
[00:12-00:20] When I was young, the frogs were everywhere. You could hear them every night.
[00:20-00:28] Then the chemical companies came. And slowly, the frogs disappeared.
[00:28-00:35] When the frogs disappeared, I knew something was very wrong with our soil.
[00:35-00:44] No frogs means no insects. No insects means no pollinators. No pollinators means no harvest.
[00:44-00:52] That is when I stopped using chemicals and went back to the old ways.
[00:52-01:00] Today we have frogs again. Today our harvest is three times bigger.
[01:00-01:08] The old ways are not backward. They are the future.
[01:30-01:38] Now let me show you how we make compost from kitchen scraps.
[01:38-01:45] Everything goes in — banana peels, coconut shells, coffee grounds.
[01:45-01:55] In forty days, this becomes the richest soil you have ever seen.
[01:55-02:05] We used to buy fertilizer for twelve thousand pesos a bag. Now: zero.
[02:05-02:15] Your garbage becomes your gold. That is permaculture.
[03:00-03:08] The third thing I want to share is about water.
[03:08-03:18] We built swales on the hillside. Contour lines that catch the rain.
[03:18-03:28] Before the swales, during typhoon season, we lost topsoil every year.
[03:28-03:38] After the swales? The water stays. The soil stays. The trees grow faster.
[03:38-03:48] One week of work saved thirty years of erosion. That is the math of nature.`,
      }],
      TIMELINE_916,
      [
        { role: 'user', text: 'find 3 different 30-second reels from this interview and make them all' },
        { role: 'edith', text: 'Here are 3 segments:\n1. Frogs hook (0:12–0:44) — "When the frogs disappeared, I knew…"\n2. Compost gold (1:30–2:15) — "Your garbage becomes your gold"\n3. Swales (3:00–3:48) — "One week of work saved thirty years of erosion"\nQ: {"question":"Which reel should I make first?","options":["Reel 1 — frogs hook","Reel 2 — compost gold","Reel 3 — swales"]}' },
      ],
    ),
    checks: {
      'emits ops': p => p.ops.length > 0 || 'no ops emitted',
      'emits trimClip for the segment': p => p.ops.some(o => o.op?.type === 'trimClip') || 'no trimClip — should trim to 30s for the chosen segment',
      'emits captions': p => p.ops.filter(o => o.op?.type === 'addCaption').length >= 3 || `only ${p.ops.filter(o => o.op?.type === 'addCaption').length} captions — should add captions for the reel`,
      'has plan': p => p.plans.length > 0 || 'no plan',
    },
  },

  {
    name: 'no-silence-on-continue',
    desc: 'On "continue" after geminiEdit, EDITH must NOT re-emit setAspectRatio or cutSilence',
    prompt: buildPrompt(
      'continue',
      [
        { ...FOOTAGE_ITEM, transcription: SAMPLE_TRANSCRIPTION },
        { ...REFERENCE_ITEM },
      ],
      { ...TIMELINE_916, clips: [{ id: 'clip_a1', mediaName: 'trimmed-reel.mp4', type: 'video', layer: 0, startFrame: 0, endFrame: 1800, volume: 0 }] },
      [
        { role: 'user', text: 'make a 60 second reel matching the reference' },
        { role: 'assistant', text: 'PLAN: [{"id":"1","step":"Set aspect ratio"},{"id":"2","step":"Cut silences"},{"id":"3","step":"geminiEdit"}]\nOP: {"type":"setAspectRatio","ratio":"9:16","stepId":"1"}\nOP: {"type":"cutSilence","clipId":"clip_a1","stepId":"2"}\nOP: {"type":"geminiEdit","userClipId":"clip_a1","referenceId":"ref_001","userRequest":"make a 60 second reel","targetDurationSeconds":60,"stepId":"3"}\nGemini edit running...' },
        { role: 'user', text: 'continue' },
      ],
    ),
    checks: {
      'no setAspectRatio on continue': p => p.ops.filter(o => o.op?.type === 'setAspectRatio').length === 0 || 'setAspectRatio re-emitted on continue turn',
      'no cutSilence on continue': p => p.ops.filter(o => o.op?.type === 'cutSilence').length === 0 || 'cutSilence re-emitted on continue turn',
      'emits captions': p => p.ops.filter(o => o.op?.type === 'addCaption').length > 0 || 'no captions on continue — should add captions after geminiEdit',
    },
  },
];

// ─── Trim / duration scenarios (Step 0) ─────────────────────────────────────

const LONG_TRANSCRIPTION = `[00:00-00:06] Hello everyone. Today we are at the Baganihan food forest.
[00:06-00:12] I have been farming this land for over thirty years.
[00:12-00:20] What you see behind me took five years to grow from bare hillside.
[00:20-00:28] People asked me — why waste money on this? Why not grow rice?
[00:28-00:36] I told them: watch. In five years, watch what happens to the land.
[00:36-00:45] Today I want to show you the three principles that changed everything for us.
[00:45-00:55] First principle: respect the soil. Second: respect the water. Third: respect the forest.
[01:00-01:10] The soil is alive. Every handful of healthy soil has more organisms than people on earth.
[01:10-01:20] When you pour chemicals on it, you kill those organisms. Then the soil becomes dead.
[01:20-01:30] We stopped all chemicals in 2019. For two years, the harvest was small. People laughed.
[01:30-01:40] By 2021, the soil came back. The insects came back. The birds came back.
[01:40-01:50] Our harvest tripled. Without spending a single peso on fertilizer.
[02:00-02:10] Now let me show you this tree. This is moringa. We planted it seven years ago.
[02:10-02:20] Today it provides medicine, food, livestock feed, and nitrogen for the soil.
[02:20-02:30] This single tree replaced three products we used to buy from the market.
[02:30-02:40] That is what permaculture means: one element performs many functions.
[03:00-03:12] The second principle is water. In the Philippines we have two seasons — flood and drought.
[03:12-03:22] Most farmers fight the flood, then fight the drought. We decided to stop fighting.
[03:22-03:35] We built swales — shallow trenches on contour lines — to slow the water down.
[03:35-03:48] During typhoon Odette, our neighbors lost topsoil. We lost nothing. The swales held everything.
[04:00-04:12] The third principle is the forest itself. Forests are not just trees.
[04:12-04:25] A forest is a community. Tall trees, medium trees, shrubs, ground cover, roots.
[04:25-04:38] When we design our food forest we copy that structure but with edible plants at every layer.
[04:38-04:50] Coconut on top. Banana in the middle. Sweet potato on the ground. Ginger in the roots.
[05:00-05:10] Now I want to talk about something people do not discuss enough. Community.
[05:10-05:22] Permaculture is not just about plants. It is about how people relate to the land.
[05:22-05:35] The Baganihan Collective has forty families. We share labor. We share seeds. We share knowledge.
[05:35-05:48] No family has to do this alone. That is why we succeed where individual farmers struggle.
[06:00-06:12] Young people always ask me — is permaculture for old people? Is it too slow?
[06:12-06:25] Your generation has a phone in your hand with the knowledge of the whole world.
[06:25-06:38] Use it to learn what your grandparents knew. That knowledge did not disappear. It is waiting.
[06:38-06:50] The fastest way to heal the land is to combine indigenous wisdom with modern tools.
[07:00-07:22] This compost pile is what I am most proud of. Everything that comes from the farm goes back.
[07:22-07:35] In forty days, kitchen scraps become the richest soil amendment you can buy. Except you do not buy it.
[07:35-07:50] Last year we produced twenty tons of compost from what we used to throw away.
[08:00-08:12] The marigold you see at every bed boundary is not decorative. It is working.
[08:12-08:25] Marigold roots release a compound that kills nematodes attacking vegetable roots.
[08:25-08:38] At the same time, marigold flowers attract wasps that eat the caterpillars on our leaves.
[08:38-08:50] Two services. One plant. Free. That is companion planting.
[09:00-09:22] People ask what I would tell my younger self. I would say: slow down. We are in such a hurry.
[09:22-09:35] The tree you plant today will give its best fruit to your grandchildren. Plant it anyway.
[09:35-09:48] The best time to start was thirty years ago. The second best time is today.
[10:00-10:25] Before we finish, I want to thank the Mycelium Learning team for coming here today.
[10:25-10:38] Every video you make reaches Filipinos abroad who forgot where they came from. Bring them back.
[10:38-10:50] The land remembers even when the people forget. Our job is to help the people remember.
[10:50-11:00] Salamat. Mabuhay ang Pilipinas. Let us take care of our land.`;

const FOOTAGE_ITEM_LONG = {
  id: 'media_002', name: 'baganihan-interview.mp4', type: 'video',
  duration: 660, path: 'C:/Users/User/Videos/baganihan-interview.mp4', isReference: false,
  transcription: LONG_TRANSCRIPTION,
};

const TIMELINE_16x9_LONG = {
  fps: 30, currentFrame: 0, totalFrames: 19800, selectedClipIds: ['clip_b1'],
  canvasWidth: 1920, canvasHeight: 1080,
  clips: [{
    id: 'clip_b1', mediaName: 'baganihan-interview.mp4',
    sourcePath: 'C:/Users/User/Videos/baganihan-interview.mp4',
    type: 'video', layer: 0, startFrame: 0, endFrame: 19800, volume: 0,
  }],
};

const TIMELINE_16x9_SHORT = {
  fps: 30, currentFrame: 0, totalFrames: 600, selectedClipIds: ['clip_s1'],
  canvasWidth: 1920, canvasHeight: 1080,
  clips: [{
    id: 'clip_s1', mediaName: 'short-clip.mp4',
    sourcePath: 'C:/Users/User/Videos/short-clip.mp4',
    type: 'video', layer: 0, startFrame: 0, endFrame: 600, volume: 0,
  }],
};

const STEP0_ANSWERED_HISTORY = (durationText) => [
  { role: 'user', text: `make a ${durationText} reel` },
  { role: 'edith', text: `Q: {"question":"Should I pick the best ${durationText} from the source, or use the first ${durationText}?","options":[{"id":"A","text":"Pick the best segment"},{"id":"B","text":"Use the first ${durationText}"}]}` },
  { role: 'user', text: `use the first ${durationText}` },
];

const STEP0_NEW_SCENARIOS = [
  {
    name: 'trim-1min-from-11min',
    desc: '"make a 1 minute reel from 11-min clip" → Step 0 asks Q: first, no ops yet',
    prompt: buildPrompt(
      'make a 1 minute reel from this 11-minute clip',
      [FOOTAGE_ITEM_LONG],
      TIMELINE_16x9_LONG,
    ),
    checks: {
      'asks Q: before emitting ops (Step 0)': p => p.questions.length >= 1 || 'no Q: emitted — Step 0 requires asking best-vs-first before trimming',
      'no ops in Q: turn': p => p.ops.length === 0 || `emitted ${p.ops.length} ops alongside Q: — should wait for user answer first`,
      'Q has two options (best segment vs first N)': p => {
        const q = p.questions[0]?.q;
        if (!q) return 'no Q: found';
        const opts = q.options ?? q.choices ?? [];
        return opts.length >= 2 || `Q has ${opts.length} options — need at least 2`;
      },
      'no setLetterboxBlur before Q is answered': p => p.ops.filter(o => o.op?.type === 'setLetterboxBlur').length === 0 || 'setLetterboxBlur emitted before duration was decided',
    },
  },

  {
    name: 'trim-30s-explicit-start',
    desc: '"30 second clip starting at 2 minutes" → no Q for start (already given), ops fired',
    prompt: buildPrompt(
      'give me a 30 second clip starting at 2 minutes in',
      [FOOTAGE_ITEM_LONG],
      TIMELINE_16x9_LONG,
    ),
    checks: {
      'emits trimClip': p => p.ops.some(o => o.op?.type === 'trimClip') || 'no trimClip — should trim to 30s',
      'trimClip has correct endFrame (900)': p => {
        const op = p.ops.find(o => o.op?.type === 'trimClip');
        if (!op) return 'no trimClip found';
        const end = op.op.newEndFrame;
        return end === 900 || `newEndFrame is ${end}, expected 900 (30s × 30fps)`;
      },
      'emits updateClip with sourceStartTime 120': p => {
        // updateClip wraps changes in an "updates" object: {"type":"updateClip","clipId":"...","updates":{"sourceStartTime":120}}
        const op = p.ops.find(o => {
          if (o.op?.type !== 'updateClip') return false;
          const st = o.op?.sourceStartTime ?? o.op?.updates?.sourceStartTime;
          return st != null;
        });
        if (!op) return 'no updateClip with sourceStartTime — start at 2 min should set sourceStartTime: 120';
        const actual = op.op?.sourceStartTime ?? op.op?.updates?.sourceStartTime;
        return actual === 120 || `sourceStartTime is ${actual}, expected 120`;
      },
      'no Q asking for start (user already gave it)': p => p.questions.length === 0 || `asked ${p.questions.length} question(s) — start was already specified`,
    },
  },

  {
    name: 'trim-shorter-than-source',
    desc: '"30 second clip" from a 20-second source → EDITH flags mismatch, does not silently break',
    prompt: buildPrompt(
      'give me a 30 second clip',
      [{ ...FOOTAGE_ITEM, duration: 20 }],
      TIMELINE_16x9_SHORT,
    ),
    checks: {
      'asks Q or flags in text (does not silently trim past source end)': p => {
        if (p.questions.length > 0) return true;
        const rawLower = p.raw.toLowerCase();
        const flagged = rawLower.includes('only') || rawLower.includes('shorter') || rawLower.includes('20') || rawLower.includes('less than');
        return flagged || 'EDITH silently produced no mismatch warning — should detect target (30s) > source (20s) and ask or flag it';
      },
      'no trimClip beyond source (newEndFrame <= 600)': p => {
        const trims = p.ops.filter(o => o.op?.type === 'trimClip');
        const overrun = trims.filter(t => t.op.newEndFrame > 600);
        return overrun.length === 0 || `trimClip newEndFrame ${overrun[0].op.newEndFrame} exceeds source length 600`;
      },
    },
  },

  {
    name: 'no-duration-no-step0',
    desc: '"add captions to this" — no duration → Step 0 does NOT fire, no spurious trimClip',
    prompt: buildPrompt(
      'add captions to this',
      [{ ...FOOTAGE_ITEM, transcription: SAMPLE_TRANSCRIPTION }],
      TIMELINE_16x9,
    ),
    checks: {
      'no trimClip for duration': p => {
        // trimClip is only allowed for structural editing, not Step 0 duration enforcement
        const trims = p.ops.filter(o => o.op?.type === 'trimClip');
        // If trimClip fires with newEndFrame === current clip end (12600), that's a pass-through — acceptable
        const spurious = trims.filter(t => t.op.newEndFrame && t.op.newEndFrame !== 12600);
        return spurious.length === 0 || `trimClip emitted with newEndFrame ${spurious[0].op.newEndFrame} — Step 0 should not fire when no duration given`;
      },
      'emits addCaption ops': p => p.ops.filter(o => o.op?.type === 'addCaption').length >= 3 || `only ${p.ops.filter(o => o.op?.type === 'addCaption').length} captions — should add captions when requested`,
    },
  },

  {
    name: 'letterbox-blur-on-landscape-source',
    desc: '16:9 source, first edit → setLetterboxBlur must be emitted after setAspectRatio',
    prompt: buildPrompt(
      'add captions and make this a proper reel',
      [{ ...FOOTAGE_ITEM, transcription: SAMPLE_TRANSCRIPTION }],
      TIMELINE_16x9,
    ),
    checks: {
      'emits setLetterboxBlur': p => p.ops.some(o => o.op?.type === 'setLetterboxBlur') || 'no setLetterboxBlur — landscape source needs blur backdrop for 9:16 canvas',
      'setLetterboxBlur is enabled': p => {
        const op = p.ops.find(o => o.op?.type === 'setLetterboxBlur');
        if (!op) return 'no setLetterboxBlur found';
        return op.op.enabled === true || `setLetterboxBlur.enabled is ${op.op.enabled}`;
      },
      'setLetterboxBlur uses real clipId': p => {
        const op = p.ops.find(o => o.op?.type === 'setLetterboxBlur');
        if (!op) return 'no setLetterboxBlur found';
        return op.op.clipId === 'clip_a1' || `clipId is "${op.op.clipId}"`;
      },
      'setAspectRatio before setLetterboxBlur': p => {
        const arIdx = p.ops.findIndex(o => o.op?.type === 'setAspectRatio');
        const blurIdx = p.ops.findIndex(o => o.op?.type === 'setLetterboxBlur');
        if (arIdx === -1) return 'no setAspectRatio found';
        if (blurIdx === -1) return 'no setLetterboxBlur found';
        return arIdx < blurIdx || `setAspectRatio at pos ${arIdx}, setLetterboxBlur at pos ${blurIdx} — blur must come after ratio`;
      },
    },
  },
];

SCENARIOS.push(...STEP0_NEW_SCENARIOS);

// ─── Runner ──────────────────────────────────────────────────────────────────

const PASS = '\x1b[32m✓\x1b[0m';
const FAIL = '\x1b[31m✗\x1b[0m';
const DIM  = '\x1b[2m';
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const YELLOW = '\x1b[33m';

async function runScenario(scenario) {
  console.log(`\n${BOLD}━━━ ${scenario.name} ${RESET}${DIM}— ${scenario.desc}${RESET}`);
  let raw;
  try {
    raw = await runEdith(scenario.prompt);
  } catch (e) {
    console.log(`  ${FAIL} RUNNER ERROR: ${e.message}`);
    return { name: scenario.name, passed: 0, total: Object.keys(scenario.checks).length, error: e.message };
  }

  const parsed = parseOutput(raw);

  // Show compact output preview
  const opTypes = parsed.ops.map(o => o.op?.type ?? '?').join(', ');
  const qCount = parsed.questions.length;
  console.log(`  ${DIM}ops: [${opTypes || 'none'}] | questions: ${qCount} | plan: ${parsed.plans.length > 0}${RESET}`);

  const results = grade(parsed, scenario.checks);
  let passed = 0;
  for (const r of results) {
    if (r.pass) {
      passed++;
      console.log(`  ${PASS} ${r.label}`);
    } else {
      console.log(`  ${FAIL} ${r.label}${r.detail ? ` ${DIM}(${r.detail})${RESET}` : ''}`);
    }
  }

  const pct = Math.round((passed / results.length) * 100);
  const color = pct === 100 ? '\x1b[32m' : pct >= 70 ? YELLOW : '\x1b[31m';
  console.log(`  ${color}${passed}/${results.length} checks passed (${pct}%)${RESET}`);

  // Show raw EDITH output on failure
  if (passed < results.length) {
    console.log(`\n  ${DIM}--- raw output ---`);
    raw.split('\n').forEach(l => console.log(`  ${l}`));
    console.log(`  ---${RESET}`);
  }

  return { name: scenario.name, passed, total: results.length };
}

async function main() {
  const filter = process.argv[2];
  const toRun = filter ? SCENARIOS.filter(s => s.name.includes(filter)) : SCENARIOS;

  if (!toRun.length) {
    console.error(`No scenarios matching "${filter}"`);
    process.exit(1);
  }

  console.log(`${BOLD}\nEDITH Test Harness — ${toRun.length} scenario(s)${RESET}`);
  console.log(`Model: claude-opus-4-7 | System prompt: edith.md`);

  const summary = [];
  for (const s of toRun) {
    const result = await runScenario(s);
    summary.push(result);
  }

  const total = summary.reduce((a, s) => a + s.total, 0);
  const passed = summary.reduce((a, s) => a + s.passed, 0);
  const pct = Math.round((passed / total) * 100);
  const color = pct === 100 ? '\x1b[32m' : pct >= 70 ? YELLOW : '\x1b[31m';

  console.log(`\n${BOLD}━━━ SUMMARY ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}`);
  summary.forEach(s => {
    const icon = s.passed === s.total ? PASS : FAIL;
    console.log(`  ${icon} ${s.name.padEnd(40)} ${s.passed}/${s.total}`);
  });
  console.log(`  ${color}${BOLD}Total: ${passed}/${total} (${pct}%)${RESET}\n`);
}

main().catch(e => { console.error(e); process.exit(1); });
