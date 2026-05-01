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

function runEdith(prompt) {
  return new Promise((resolve, reject) => {
    const proc = spawn('claude', ['--print', '--model', 'claude-sonnet-4-6', '--max-turns', '1'], {
      shell: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '', err = '';
    proc.stdout.on('data', d => { out += d.toString(); });
    proc.stderr.on('data', d => { err += d.toString(); });
    proc.on('close', code => {
      if (code !== 0 && !out.trim()) reject(new Error(`claude exited ${code}: ${err.slice(0, 200)}`));
      else resolve(out.trim());
    });
    proc.stdin.write(prompt);
    proc.stdin.end();
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
      'runWhisper uses real clipId': p => {
        const op = p.ops.find(o => o.op?.type === 'runWhisper');
        return op?.op?.clipId === 'clip_a1' || `clipId is "${op?.op?.clipId}"`;
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
    desc: '"Make a 60s reel" with reference analyzed → geminiEdit as primary op',
    prompt: buildPrompt(
      'make a 60 second reel about the importance of marigolds in permaculture',
      [{ ...FOOTAGE_ITEM, transcription: SAMPLE_TRANSCRIPTION }, REFERENCE_ITEM],
      TIMELINE_16x9,
    ),
    checks: {
      'emits geminiEdit': p => p.ops.some(o => o.op?.type === 'geminiEdit') || 'no geminiEdit op — should use geminiEdit when reference present',
      'geminiEdit uses correct userClipId': p => {
        const op = p.ops.find(o => o.op?.type === 'geminiEdit');
        return op?.op?.userClipId === 'clip_a1' || `userClipId is "${op?.op?.userClipId}"`;
      },
      'geminiEdit uses correct referenceId': p => {
        const op = p.ops.find(o => o.op?.type === 'geminiEdit');
        return op?.op?.referenceId === 'ref_001' || `referenceId is "${op?.op?.referenceId}"`;
      },
      'geminiEdit has targetDurationSeconds': p => {
        const op = p.ops.find(o => o.op?.type === 'geminiEdit');
        return op?.op?.targetDurationSeconds > 0 || 'targetDurationSeconds missing or zero';
      },
      'setAspectRatio before geminiEdit': p => {
        const arIdx = p.ops.findIndex(o => o.op?.type === 'setAspectRatio');
        const geIdx = p.ops.findIndex(o => o.op?.type === 'geminiEdit');
        return arIdx < geIdx || `aspect ratio at pos ${arIdx}, geminiEdit at pos ${geIdx}`;
      },
      'no manual trimClip (geminiEdit handles it)': p => {
        const trims = p.ops.filter(o => o.op?.type === 'trimClip');
        return trims.length === 0 || `emitted ${trims.length} trimClip ops alongside geminiEdit`;
      },
    },
  },

  {
    name: 'make-reel-no-reference',
    desc: '"Make a 45s reel" with NO reference → manual trimClip workflow',
    prompt: buildPrompt(
      'make a 45 second reel about marigolds',
      [{ ...FOOTAGE_ITEM, transcription: SAMPLE_TRANSCRIPTION }],
      TIMELINE_16x9,
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
    desc: 'silenceRemoved:true in reference → cutSilence before trim',
    prompt: buildPrompt(
      'make a 60 second reel',
      [{ ...FOOTAGE_ITEM, transcription: SAMPLE_TRANSCRIPTION }, REFERENCE_ITEM],
      TIMELINE_16x9,
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
    desc: '"Make a 60s reel about marigolds" is specific — EDITH must proceed, not ask',
    prompt: buildPrompt(
      'make a 60 second reel about marigolds and companion planting',
      [{ ...FOOTAGE_ITEM, transcription: SAMPLE_TRANSCRIPTION }],
      TIMELINE_16x9,
    ),
    checks: {
      'no question asked': p => p.questions.length === 0 || 'asked a question despite having duration + topic',
      'emits ops': p => p.ops.length > 0 || 'no ops — should proceed with duration + topic given',
    },
  },

  {
    name: 'cta-appended',
    desc: 'Reel must end with a Mycelium CTA caption',
    prompt: buildPrompt(
      'make a 45 second reel about marigolds',
      [{ ...FOOTAGE_ITEM, transcription: SAMPLE_TRANSCRIPTION }],
      TIMELINE_16x9,
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
    desc: 'Reel without reference → Mycelium default color grade must be applied',
    prompt: buildPrompt(
      'make a 45 second reel about marigolds',
      [{ ...FOOTAGE_ITEM, transcription: SAMPLE_TRANSCRIPTION }],
      TIMELINE_16x9,
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
    desc: 'When user specifies a hook moment, first caption must use that moment',
    prompt: buildPrompt(
      'make a 45 second reel about how modern farming hurt indigenous knowledge. the frogs disappearing is the hook.',
      [{ ...FOOTAGE_ITEM, transcription: HOOK_TRANSCRIPTION }],
      TIMELINE_16x9,
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
    desc: 'After captioning, EDITH should proactively emit b-roll downloadMedia ops',
    prompt: buildPrompt(
      'make a 45 second reel about marigolds in permaculture',
      [{ ...FOOTAGE_ITEM, transcription: SAMPLE_TRANSCRIPTION }],
      TIMELINE_916,  // already 9:16 so no aspect ratio op
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
    desc: '"Find 3 reels from this interview" → EDITH names segments and emits all ops',
    prompt: buildPrompt(
      'find 3 different 30-second reels from this interview and make them all',
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
    ),
    checks: {
      'emits ops': p => p.ops.length > 0 || 'no ops emitted',
      'uses insertClip or trimClip for multiple segments': p => {
        const trims = p.ops.filter(o => o.op?.type === 'trimClip');
        const inserts = p.ops.filter(o => o.op?.type === 'insertClip');
        // For multi-reel: clip 1 uses trimClip+updateClip, clips 2+ use insertClip from same source
        return (trims.length >= 1 || inserts.length >= 1) && (trims.length + inserts.length >= 2)
          || `only ${trims.length} trimClip + ${inserts.length} insertClip ops (need 2+ total for 3 reels)`;
      },
      'emits captions': p => p.ops.filter(o => o.op?.type === 'addCaption').length >= 6 || `only ${p.ops.filter(o => o.op?.type === 'addCaption').length} captions — need at least 6 for 3 reels`,
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
  console.log(`Model: claude-sonnet-4-6 | System prompt: edith.md`);

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
