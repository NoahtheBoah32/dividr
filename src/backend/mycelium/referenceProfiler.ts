/**
 * Reference Profiler — EDITH's "watch the reference" organ.
 *
 * Measure first, interpret second:
 *   1. ffprobe        — format (resolution, fps, duration, aspect)
 *   2. ffmpeg scdet   — every cut, exact timestamps (adaptive threshold)
 *   3. ffmpeg audio   — integrated LUFS + speech-gap statistics (silencedetect)
 *   4. faster-whisper — timestamped transcript of the reference (best-effort)
 *   5. frame sampling — head/mid/tail per SHOT (never fixed-interval)
 *   6. one Claude call— narrative blocks + per-block skills + trigger→action rules
 *   7. synthesis      — measured numbers are authoritative; the model only labels.
 *
 * The result keeps the legacy ReferenceAnalysis fields (captionStyle/editing/
 * structure/colorGrade/description) so existing consumers and the re-analysis
 * guard keep working, and adds `profile` — the StyleProfile EDITH edits from.
 *
 * Deliberately electron-free: everything is spawned binaries + fetch, so the
 * whole pipeline runs standalone under `npx tsx` for testing.
 */
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ── Types ────────────────────────────────────────────────────────────────────

export type ProgressFn = (stage: string, detail?: string, done?: boolean) => void;

export interface ProfileBlock {
  fn: string;                 // hook | setup | body | escalation | reveal | payoff | cta | outro
  label: string;              // one-line human description of what happens
  startSeconds: number;
  endSeconds: number;
  // measured per block during synthesis:
  cutCount: number;
  avgShotSeconds: number | null;
  // interpreted per block:
  style: {
    captions?: string;
    punchIns?: string;
    broll?: string;
    sfx?: string;
    music?: string;
    notes?: string;
  };
}

export interface ProfileRule {
  trigger: string;            // e.g. "emphasized word (numerals, superlatives)"
  action: { op: string; params?: Record<string, unknown> };
  support: number;            // 0..1 — how often the trigger fires the action in the reference
  note?: string;
}

export interface StyleProfile {
  version: number;
  format: { width: number; height: number; fps: number; durationSeconds: number; aspect: string };
  pacing: {
    cutTimes: number[];
    shotCount: number;
    avgShotSeconds: number;
    medianShotSeconds: number;
    p10ShotSeconds: number;
    p90ShotSeconds: number;
    cutsPerMinute: number;
    firstThirdAvgShot: number | null;
    lastThirdAvgShot: number | null;
    sceneThresholdUsed: number;
  };
  audio: {
    lufs: number | null;
    speechGapCount: number | null;
    speechGapMedianMs: number | null;
    speechGapP90Ms: number | null;
  };
  transcriptAvailable: boolean;
  genre: string;
  blocks: ProfileBlock[];
  rules: ProfileRule[];
  captions: { present: boolean; style: string; description: string };
  grade: { look: string; description: string; useGradeReference: boolean };
  transitions: { hardCutDominant: boolean; observed: string[] };
  gaps: string[];
  description: string;
}

export interface ReferenceProfileResult {
  // legacy shape — kept verbatim so old consumers + the skip-guard still work
  captionStyle: Record<string, unknown>;
  editing: Record<string, unknown>;
  structure: Record<string, unknown>;
  colorGrade?: Record<string, unknown>;
  description: string;
  analyzedAt: number;
  model: string;
  // the new organ
  profile: StyleProfile;
}

export const PROFILE_VERSION = 1;

// ── Binary resolution ────────────────────────────────────────────────────────

function getFfmpegPath(): string {
  try { return require('ffmpeg-static') as string; } catch { return 'ffmpeg'; }
}
function getFfprobePath(): string {
  try {
    const p = require('ffprobe-static');
    return (p as any).path ?? (p as string);
  } catch { return 'ffprobe'; }
}
function getVenvPython(appPath: string): string {
  const isWin = process.platform === 'win32';
  const venv = path.join(appPath, 'src', 'backend', 'python', 'venv',
    isWin ? 'Scripts\\python.exe' : 'bin/python');
  return fs.existsSync(venv) ? venv : (isWin ? 'python' : 'python3');
}

function resolveAnthropicAuth(appPath: string): { header: string; value: string } | null {
  const envPath = path.join(appPath, '.env');
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const [k, v] = line.split('=');
      if (k?.trim() === 'ANTHROPIC_API_KEY' && v?.trim()) {
        return { header: 'x-api-key', value: v.trim() };
      }
    }
  }
  if (process.env.ANTHROPIC_API_KEY) return { header: 'x-api-key', value: process.env.ANTHROPIC_API_KEY };
  try {
    const credPath = path.join(os.homedir(), '.claude', '.credentials.json');
    if (fs.existsSync(credPath)) {
      const creds = JSON.parse(fs.readFileSync(credPath, 'utf8'));
      const token = creds?.claudeAiOauth?.accessToken;
      if (token) return { header: 'Authorization', value: `Bearer ${token}` };
    }
  } catch { /* fall through */ }
  return null;
}

// ── Small helpers ────────────────────────────────────────────────────────────

function runCapture(bin: string, args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    const proc = spawn(bin, args, { shell: false });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { try { proc.kill(); } catch {} }, timeoutMs);
    proc.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    proc.on('close', (code) => { clearTimeout(timer); resolve({ stdout, stderr, code }); });
    proc.on('error', () => { clearTimeout(timer); resolve({ stdout, stderr, code: null }); });
  });
}

function median(nums: number[]): number {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function percentile(nums: number[], p: number): number {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))));
  return s[idx];
}
const r2 = (n: number) => Math.round(n * 100) / 100;

// ── Stage 1: format ──────────────────────────────────────────────────────────

export interface FormatInfo { width: number; height: number; fps: number; durationSeconds: number; aspect: string }

export function probeFormat(filePath: string): FormatInfo {
  const out = execSync(
    `"${getFfprobePath()}" -v quiet -print_format json -show_streams -show_format "${filePath}"`,
    { encoding: 'utf8', timeout: 15000 },
  );
  const data = JSON.parse(out) as any;
  const v = data.streams?.find((s: any) => s.codec_type === 'video');
  if (!v) throw new Error('No video stream in reference');
  const [num, den] = String(v.r_frame_rate ?? '30/1').split('/').map(Number);
  const fps = den ? num / den : 30;
  const duration = parseFloat(v.duration ?? '0') || parseFloat(data.format?.duration ?? '0') || 0;
  if (!duration) throw new Error('Could not determine reference duration');
  const w = v.width ?? 0, h = v.height ?? 0;
  const ratio = w && h ? w / h : 16 / 9;
  const aspect = Math.abs(ratio - 16 / 9) < 0.05 ? '16:9'
    : Math.abs(ratio - 9 / 16) < 0.05 ? '9:16'
    : Math.abs(ratio - 1) < 0.05 ? '1:1'
    : `${w}:${h}`;
  return { width: w, height: h, fps: r2(fps), durationSeconds: r2(duration), aspect };
}

// ── Stage 2: shots (adaptive scdet) ──────────────────────────────────────────

async function detectCutsAt(filePath: string, threshold: number): Promise<number[]> {
  const { stderr } = await runCapture(
    getFfmpegPath(),
    ['-i', filePath, '-filter:v', `select='gt(scene,${threshold})',showinfo`, '-an', '-f', 'null', '-'],
    180000,
  );
  const times: number[] = [];
  const re = /pts_time:([\d.]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stderr))) times.push(parseFloat(m[1]));
  return times.filter((t, i, a) => i === 0 || t - a[i - 1] > 0.12); // collapse near-duplicates
}

export async function detectShots(filePath: string, durationSeconds: number): Promise<{ cutTimes: number[]; thresholdUsed: number }> {
  let threshold = 0.4;
  let cuts = await detectCutsAt(filePath, threshold);
  // Too few cuts on a clearly-edited video → the cuts are subtle; look closer.
  if (cuts.length < 3 && durationSeconds > 20) {
    threshold = 0.22;
    cuts = await detectCutsAt(filePath, threshold);
  }
  // Talking-head jump cuts land on near-identical framing and score BELOW 0.22
  // (measured: an olufemii-style edit read as 4 cuts/90s when it visibly cuts far
  // more). If the video still reads as near-uncut, probe once at 0.14 — but keep
  // the sensitive pass ONLY if its rate is sane; gesture motion can over-fire it.
  if (durationSeconds > 40 && (cuts.length / durationSeconds) * 60 < 6) {
    const sensitive = await detectCutsAt(filePath, 0.14);
    const rate = sensitive.length / Math.max(1, durationSeconds);
    if (sensitive.length > cuts.length * 2 && rate < 1.0) {
      threshold = 0.14;
      cuts = sensitive;
    }
  }
  // Over-firing (fast motion / grain triggers false boundaries) → back off.
  if (cuts.length / Math.max(1, durationSeconds) > 1.5) {
    threshold = 0.55;
    cuts = await detectCutsAt(filePath, threshold);
  }
  return { cutTimes: cuts.map(r2), thresholdUsed: threshold };
}

export function shotList(cutTimes: number[], durationSeconds: number): Array<{ index: number; start: number; end: number; duration: number }> {
  const bounds = [0, ...cutTimes.filter((t) => t > 0.05 && t < durationSeconds - 0.05), durationSeconds];
  const shots: Array<{ index: number; start: number; end: number; duration: number }> = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const start = bounds[i], end = bounds[i + 1];
    if (end - start < 0.08) continue;
    shots.push({ index: shots.length, start: r2(start), end: r2(end), duration: r2(end - start) });
  }
  return shots;
}

// ── Stage 3: audio ───────────────────────────────────────────────────────────

export async function measureAudio(filePath: string, durationSeconds: number): Promise<StyleProfile['audio']> {
  const ffmpeg = getFfmpegPath();
  let lufs: number | null = null;
  try {
    const { stderr } = await runCapture(ffmpeg, ['-i', filePath, '-af', 'ebur128', '-f', 'null', '-'], 120000);
    // ebur128 prints a running "I:" on every progress line — only the LAST one
    // (the end-of-stream summary) is the true integrated loudness.
    const ms = [...stderr.matchAll(/I:\s+(-?[\d.]+)\s+LUFS/g)];
    if (ms.length) lufs = parseFloat(ms[ms.length - 1][1]);
  } catch { /* audio-less reference is fine */ }

  let gapCount: number | null = null, gapMedianMs: number | null = null, gapP90Ms: number | null = null;
  try {
    const { stderr } = await runCapture(
      ffmpeg, ['-i', filePath, '-af', 'silencedetect=n=-35dB:d=0.12', '-f', 'null', '-'], 120000,
    );
    const durations: number[] = [];
    const starts = [...stderr.matchAll(/silence_start:\s*([\d.]+)/g)].map((m) => parseFloat(m[1]));
    const durs = [...stderr.matchAll(/silence_duration:\s*([\d.]+)/g)].map((m) => parseFloat(m[1]));
    for (let i = 0; i < durs.length; i++) {
      const start = starts[i] ?? 0;
      // head/tail padding is not a speech gap
      if (start < 0.3) continue;
      if (start + durs[i] > durationSeconds - 0.3) continue;
      durations.push(durs[i] * 1000);
    }
    gapCount = durations.length;
    gapMedianMs = durations.length ? Math.round(median(durations)) : null;
    gapP90Ms = durations.length ? Math.round(percentile(durations, 90)) : null;
  } catch { /* best-effort */ }

  return { lufs, speechGapCount: gapCount, speechGapMedianMs: gapMedianMs, speechGapP90Ms: gapP90Ms };
}

// ── Stage 4: transcript (best-effort, hard timeout) ──────────────────────────

export async function transcribeReference(
  filePath: string, appPath: string, tmpDir: string, timeoutMs = 180000,
): Promise<Array<{ start: number; end: number; text: string }> | null> {
  const wav = path.join(tmpDir, 'ref-audio.wav');
  const outJson = path.join(tmpDir, 'ref-transcript.json');
  try {
    const { code } = await runCapture(
      getFfmpegPath(), ['-y', '-i', filePath, '-vn', '-ac', '1', '-ar', '16000', wav], 60000,
    );
    if (code !== 0 || !fs.existsSync(wav)) return null;
    const script = path.join(appPath, 'src', 'backend', 'python', 'scripts', 'transcribe.py');
    if (!fs.existsSync(script)) return null;
    await runCapture(getVenvPython(appPath), [script, wav, '--model', 'large-v3', '--output', outJson], timeoutMs);
    if (!fs.existsSync(outJson)) return null;
    const result = JSON.parse(fs.readFileSync(outJson, 'utf8')) as any;
    const segments = (result?.segments ?? []) as any[];
    if (!segments.length) return null;
    return segments.map((s) => ({
      start: r2(Number(s.start) || 0),
      end: r2(Number(s.end) || 0),
      text: String(s.text ?? '').trim(),
    })).filter((s) => s.text);
  } catch {
    return null;
  }
}

// ── Stage 5: shot-aware frame sampling ───────────────────────────────────────

interface SampledFrame { path: string; shotIndex: number; t: number; pos: 'head' | 'mid' | 'tail' }

export function sampleFrames(
  filePath: string,
  shots: Array<{ index: number; start: number; end: number; duration: number }>,
  tmpDir: string,
  maxFrames = 28,
): SampledFrame[] {
  const ffmpeg = getFfmpegPath();
  const plan: Array<{ shotIndex: number; t: number; pos: SampledFrame['pos'] }> = [];
  // First 4 shots carry the hook — head+mid each. Everything after: mid only.
  for (const s of shots) {
    const head = s.start + Math.min(0.15 * s.duration, 0.5);
    const mid = s.start + 0.5 * s.duration;
    const tail = s.start + Math.max(0.85 * s.duration, s.duration - 0.5);
    if (s.index < 4) {
      plan.push({ shotIndex: s.index, t: head, pos: 'head' }, { shotIndex: s.index, t: mid, pos: 'mid' });
    } else {
      plan.push({ shotIndex: s.index, t: mid, pos: 'mid' });
    }
    // long shots may hide a slow push-in — bracket them
    if (s.duration > 6) plan.push({ shotIndex: s.index, t: tail, pos: 'tail' });
  }
  // Evenly thin the plan to the cap, always keeping the first 8 entries (hook).
  let chosen = plan;
  if (plan.length > maxFrames) {
    const headKeep = plan.slice(0, 8);
    const rest = plan.slice(8);
    const step = rest.length / (maxFrames - headKeep.length);
    const thinned: typeof plan = [];
    for (let i = 0; i < maxFrames - headKeep.length; i++) thinned.push(rest[Math.floor(i * step)]);
    chosen = [...headKeep, ...thinned];
  }
  const frames: SampledFrame[] = [];
  chosen.forEach((p, i) => {
    const out = path.join(tmpDir, `shot${p.shotIndex}_${p.pos}_${i}.jpg`);
    try {
      execSync(
        `"${ffmpeg}" -ss ${p.t.toFixed(3)} -i "${filePath}" -vframes 1 -q:v 3 -vf "scale=640:-1" -y "${out}"`,
        { timeout: 15000, stdio: 'ignore' },
      );
      if (fs.existsSync(out) && fs.statSync(out).size > 0) {
        frames.push({ path: out, shotIndex: p.shotIndex, t: r2(p.t), pos: p.pos });
      }
    } catch { /* skip failed frames */ }
  });
  return frames;
}

// ── Stage 6: interpretation (one Claude call) ────────────────────────────────

const INTERPRET_MODEL = 'claude-sonnet-5';
const FALLBACK_MODEL = 'claude-haiku-4-5-20251001';

/** Ops EDITH can actually fire — rules must resolve to these or go to gaps[]. */
const ALLOWED_RULE_OPS = new Set([
  'cut', 'deleteSegment', 'silence', 'removeFillers', 'trim',
  'buildCaptions', 'caption', 'trackedCaption',
  'kenBurns', 'zoomToFace', 'setMotionBlur',
  'gradeReference', 'applyLook', 'adjust', 'setCurves',
  'placeSFX', 'stinger', 'duck', 'fadeIn', 'fadeOut', 'beatSync',
  'jCut', 'addTransition', 'broll', 'download', 'letterbox',
  'setSpeed', 'speedRamp', 'rackFocus',
]);

function buildInterpretPrompt(
  format: FormatInfo,
  shots: Array<{ index: number; start: number; end: number; duration: number }>,
  pacing: StyleProfile['pacing'],
  audio: StyleProfile['audio'],
  transcript: Array<{ start: number; end: number; text: string }> | null,
  frameIndex: string,
): string {
  const shotTable = shots.map((s) => `  shot ${s.index}: ${s.start}s–${s.end}s (${s.duration}s)`).join('\n');
  const transcriptBlock = transcript
    ? transcript.map((s) => `  [${s.start}s–${s.end}s] ${s.text}`).join('\n')
    : '  (no speech transcript available — rely on frames and measurements)';
  return `You are a senior video editor reverse-engineering a reference edit so an AI editor (EDITH) can recreate its STYLE on different footage. You are given MEASURED data (authoritative — never contradict or re-estimate it) plus frames sampled from every shot.

## Measured format
${format.width}x${format.height} (${format.aspect}) @ ${format.fps}fps, ${format.durationSeconds}s total.

## Measured shots (from scene detection)
${shotTable}
Pacing: ${pacing.shotCount} shots, avg ${pacing.avgShotSeconds}s, median ${pacing.medianShotSeconds}s, ${pacing.cutsPerMinute} cuts/min. First third avg ${pacing.firstThirdAvgShot ?? 'n/a'}s vs last third ${pacing.lastThirdAvgShot ?? 'n/a'}s.

## Measured audio
Integrated loudness: ${audio.lufs ?? 'unknown'} LUFS. Speech gaps (>120ms silences): ${audio.speechGapCount ?? 'unknown'}, median ${audio.speechGapMedianMs ?? 'unknown'}ms, p90 ${audio.speechGapP90Ms ?? 'unknown'}ms. (A median under ~150ms means pauses/breaths were surgically removed.)

## Timestamped transcript
${transcriptBlock}

## Frames
${frameIndex}

## Your tasks
1. **Narrative blocks** — segment the FULL duration chronologically into functional blocks. Use only these fn values: hook, setup, body, escalation, reveal, payoff, cta, outro. Cover 0s to ${format.durationSeconds}s with no overlaps and no gaps. Most short edits have 3–5 blocks. Base boundaries on the transcript content + visible changes, aligned to shot boundaries where possible.
2. **Per-block style** — for each block describe ONLY what the frames/transcript/measurements support: caption behavior, punch-in/zoom behavior, b-roll/cutaway usage, SFX/music feel, anything notable. Do not invent numbers — pacing numbers are computed separately from the measured cuts.
3. **Rules** — the trigger→action policy of this edit, each mapped to ONE EDITH op from this exact list (op names verbatim): cut, deleteSegment, silence, removeFillers, buildCaptions, trackedCaption, kenBurns, zoomToFace, setMotionBlur, gradeReference, applyLook, adjust, setCurves, placeSFX, stinger, duck, fadeIn, fadeOut, beatSync, jCut, addTransition, broll, download, letterbox, setSpeed, rackFocus.
   Examples of well-formed rules: {"trigger":"speech gap longer than 150ms","action":{"op":"silence"},"support":0.9} · {"trigger":"emphasized word (numerals, superlatives)","action":{"op":"zoomToFace","params":{"zoomLevel":1.3}},"support":0.5} · {"trigger":"cut to b-roll","action":{"op":"placeSFX","params":{"sound":"whoosh","volume":-8}},"support":0.6} · {"trigger":"speech over music bed","action":{"op":"duck","params":{"targetDb":-12}},"support":1}.
   support = fraction of trigger occurrences that fire the action in THIS reference. 4–10 rules. Only claim a rule you can actually see/hear evidence for.
   Param notes: params are HINTS — the editor resolves exact params from its own op manual. zoomToFace zoomLevel range is 1.3 (subtle) to 3.5 (extreme). addTransition is ONLY for soft transitions (dissolve/dip/wipe/push/slide/zoom/whip) — a hard-cut rhythm is expressed through cut/deleteSegment/silence policy, never as addTransition.
4. **Captions** — describe the caption/text style precisely (or present:false if none).
5. **Grade** — describe the color grade look in plain words (the actual transfer will use a color-matching op, so describe, don't parameterize).
6. **Gaps** — style elements visibly present that a timeline editor CANNOT reproduce (animated infographics, 3D, motion-graphics scenes). Be specific.
7. **Genre** — one of: talking_head, vlog, documentary, montage_music, tutorial, gaming, product_ad, narrative_short, interview, podcast_clip, educational.

Return ONLY valid JSON, no markdown fences:
{
  "genre": "...",
  "blocks": [ { "fn": "hook", "label": "...", "startSeconds": 0, "endSeconds": 11.4,
      "style": { "captions": "...", "punchIns": "...", "broll": "...", "sfx": "...", "music": "...", "notes": "..." } } ],
  "rules": [ { "trigger": "...", "action": { "op": "...", "params": {} }, "support": 0.6, "note": "..." } ],
  "captions": { "present": true, "style": "word_pop|phrase|karaoke|none", "description": "..." },
  "captionStyle": { "position": 0.65, "fontSize": 90, "fontFamily": "Impact", "isUppercase": true, "isBold": false, "fillColor": "#FFFFFF", "highlightColor": "#FFD700", "highlightPattern": "key-noun", "strokeColor": "#000000", "strokeWidth": 2, "wordsPerPhrase": 3, "animationStyle": "word-by-word", "shadowEnabled": true, "backdropEnabled": false },
  "grade": { "look": "cinematic|warm|cool|raw|bright|moody|natural", "description": "..." },
  "colorGrade": { "brightness": 1.05, "contrast": 1.1, "saturation": 1.2, "hueRotate": 0, "warmth": "warm", "look": "cinematic" },
  "transitions": { "hardCutDominant": true, "observed": ["hard cut", "..."] },
  "editing": { "pacing": "fast", "avgClipLengthSeconds": ${pacing.avgShotSeconds}, "hookStyle": "...", "hookDurationSeconds": 3, "usesLetterboxBlur": false, "usesZoomCuts": true, "silenceRemoved": true, "musicBed": true, "brollStyle": "cutaway" },
  "structure": { "openingSeconds": 3, "bodySeconds": 25, "ctaSeconds": 3, "totalSeconds": ${format.durationSeconds} },
  "gaps": ["..."],
  "description": "2-3 sentences: the overall style, energy, and editing approach."
}`;
}

async function callClaude(
  auth: { header: string; value: string },
  model: string,
  imageBlocks: any[],
  prompt: string,
  timeoutMs = 110000,
): Promise<string> {
  // Hard timeout: midday API latency was measured stretching one interpretation
  // call past 5 minutes — for a live-demo feature that's a hang, not a wait.
  // Abort and let the caller fall back to the fast model instead.
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        [auth.header]: auth.value,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: 4000,
        messages: [{ role: 'user', content: [...imageBlocks, { type: 'text', text: prompt }] }],
      }),
      signal: ac.signal,
    });
  } catch (err) {
    if (ac.signal.aborted) throw new Error(`Anthropic call timed out after ${Math.round(timeoutMs / 1000)}s (${model})`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Anthropic API error ${res.status} (${model}): ${errText.slice(0, 300)}`);
  }
  const data = (await res.json()) as any;
  const text: string = data.content?.map((c: any) => c.text ?? '').join('') ?? '';
  if (!text) throw new Error('Claude returned an empty response');
  return text;
}

function extractJson(text: string): any {
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first === -1 || last <= first) throw new Error(`No JSON in interpretation response: ${text.slice(0, 200)}`);
  return JSON.parse(text.slice(first, last + 1));
}

// ── Stage 7: synthesis ───────────────────────────────────────────────────────

function computePacing(
  cutTimes: number[], durationSeconds: number, thresholdUsed: number,
): StyleProfile['pacing'] {
  const shots = shotList(cutTimes, durationSeconds);
  const durs = shots.map((s) => s.duration);
  const third = durationSeconds / 3;
  const firstThird = shots.filter((s) => s.start < third).map((s) => s.duration);
  const lastThird = shots.filter((s) => s.end > 2 * third).map((s) => s.duration);
  const avg = durs.length ? durs.reduce((a, b) => a + b, 0) / durs.length : durationSeconds;
  return {
    cutTimes,
    shotCount: shots.length,
    avgShotSeconds: r2(avg),
    medianShotSeconds: r2(median(durs)),
    p10ShotSeconds: r2(percentile(durs, 10)),
    p90ShotSeconds: r2(percentile(durs, 90)),
    cutsPerMinute: r2((cutTimes.length / Math.max(1, durationSeconds)) * 60),
    firstThirdAvgShot: firstThird.length ? r2(firstThird.reduce((a, b) => a + b, 0) / firstThird.length) : null,
    lastThirdAvgShot: lastThird.length ? r2(lastThird.reduce((a, b) => a + b, 0) / lastThird.length) : null,
    sceneThresholdUsed: thresholdUsed,
  };
}

function synthesizeBlocks(
  rawBlocks: any[], cutTimes: number[], durationSeconds: number,
): ProfileBlock[] {
  const blocks: ProfileBlock[] = [];
  const sorted = (Array.isArray(rawBlocks) ? rawBlocks : [])
    .map((b) => ({
      fn: String(b?.fn ?? 'body'),
      label: String(b?.label ?? ''),
      start: Math.max(0, Number(b?.startSeconds) || 0),
      end: Math.min(durationSeconds, Number(b?.endSeconds) || 0),
      style: (b?.style && typeof b.style === 'object') ? b.style : {},
    }))
    .filter((b) => b.end > b.start + 0.2)
    .sort((a, b) => a.start - b.start);
  for (const b of sorted) {
    const cutsIn = cutTimes.filter((t) => t >= b.start && t < b.end);
    const span = b.end - b.start;
    const shotCount = cutsIn.length + 1;
    blocks.push({
      fn: b.fn,
      label: b.label,
      startSeconds: r2(b.start),
      endSeconds: r2(b.end),
      cutCount: cutsIn.length,
      avgShotSeconds: shotCount > 0 ? r2(span / shotCount) : null,
      style: {
        captions: b.style.captions ? String(b.style.captions) : undefined,
        punchIns: b.style.punchIns ? String(b.style.punchIns) : undefined,
        broll: b.style.broll ? String(b.style.broll) : undefined,
        sfx: b.style.sfx ? String(b.style.sfx) : undefined,
        music: b.style.music ? String(b.style.music) : undefined,
        notes: b.style.notes ? String(b.style.notes) : undefined,
      },
    });
  }
  if (!blocks.length) {
    blocks.push({
      fn: 'body', label: 'full video', startSeconds: 0, endSeconds: r2(durationSeconds),
      cutCount: cutTimes.length,
      avgShotSeconds: r2(durationSeconds / Math.max(1, cutTimes.length + 1)),
      style: {},
    });
  }
  return blocks;
}

function synthesizeRules(rawRules: any[], gaps: string[]): ProfileRule[] {
  const rules: ProfileRule[] = [];
  for (const r of (Array.isArray(rawRules) ? rawRules : [])) {
    const op = String(r?.action?.op ?? '');
    const trigger = String(r?.trigger ?? '').trim();
    if (!trigger) continue;
    if (!ALLOWED_RULE_OPS.has(op)) {
      gaps.push(`rule dropped (no such op "${op}"): ${trigger}`);
      continue;
    }
    const support = Math.max(0, Math.min(1, Number(r?.support) || 0.5));
    rules.push({
      trigger,
      action: { op, params: (r?.action?.params && typeof r.action.params === 'object') ? r.action.params : undefined },
      support: r2(support),
      note: r?.note ? String(r.note) : undefined,
    });
  }
  return rules;
}

// ── The pipeline ─────────────────────────────────────────────────────────────

export async function profileReference(
  filePath: string,
  appPath: string,
  onProgress?: ProgressFn,
): Promise<ReferenceProfileResult> {
  const progress: ProgressFn = (stage, detail, done) => { try { onProgress?.(stage, detail, done); } catch {} };
  if (!fs.existsSync(filePath)) throw new Error(`Reference not found: ${filePath}`);
  const auth = resolveAnthropicAuth(appPath);
  if (!auth) throw new Error('No Anthropic auth — set ANTHROPIC_API_KEY or sign in to Claude Code');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'edith-profile-'));
  try {
    // 1 — format
    progress('Reading the reference');
    const format = probeFormat(filePath);
    progress('Reading the reference', `${format.width}×${format.height} · ${Math.round(format.durationSeconds)}s · ${Math.round(format.fps)}fps`, true);

    // 2 — shots (and 4 — transcript) run concurrently: scdet is CPU/ffmpeg, whisper is GPU
    progress('Detecting the cuts');
    const shotsPromise = detectShots(filePath, format.durationSeconds);
    const transcriptPromise = transcribeReference(filePath, appPath, tmpDir);

    const { cutTimes, thresholdUsed } = await shotsPromise;
    const pacing = computePacing(cutTimes, format.durationSeconds, thresholdUsed);
    const shots = shotList(cutTimes, format.durationSeconds);
    progress('Detecting the cuts', `${cutTimes.length} cuts · median shot ${pacing.medianShotSeconds}s`, true);

    // 3 — audio
    progress('Listening to the mix');
    const audio = await measureAudio(filePath, format.durationSeconds);
    const audioBits: string[] = [];
    if (audio.lufs !== null) audioBits.push(`${audio.lufs} LUFS`);
    if (audio.speechGapMedianMs !== null) audioBits.push(`median speech gap ${audio.speechGapMedianMs}ms`);
    progress('Listening to the mix', audioBits.join(' · ') || 'no audio track', true);

    // 4 — transcript joins here
    progress('Transcribing the reference');
    const transcript = await transcriptPromise;
    progress('Transcribing the reference', transcript ? `${transcript.length} lines` : 'no usable speech', true);

    // 5 — frames
    progress('Reading frames from every shot');
    const frames = sampleFrames(filePath, shots, tmpDir);
    if (!frames.length) throw new Error('Failed to extract any frames from the reference');
    progress('Reading frames from every shot', `${frames.length} frames across ${shots.length} shots`, true);

    // 6 — interpretation
    progress('Breaking down the narrative structure');
    const imageBlocks = frames.map((f) => ({
      type: 'image' as const,
      source: {
        type: 'base64' as const,
        media_type: 'image/jpeg' as const,
        data: fs.readFileSync(f.path).toString('base64'),
      },
    }));
    const frameIndex = frames
      .map((f, i) => `  image ${i + 1}: shot ${f.shotIndex} ${f.pos} (t=${f.t}s)`)
      .join('\n');
    const prompt = buildInterpretPrompt(format, shots, pacing, audio, transcript, frameIndex);
    let text: string, modelUsed = INTERPRET_MODEL;
    try {
      text = await callClaude(auth, INTERPRET_MODEL, imageBlocks, prompt);
    } catch (e) {
      // Timeout or API error on the primary model — surface it on the live card
      // and finish on the fast model rather than hanging the demo.
      progress('Breaking down the narrative structure', 'taking longer than usual — switching to the fast model');
      modelUsed = FALLBACK_MODEL;
      text = await callClaude(auth, FALLBACK_MODEL, imageBlocks, prompt, 90000);
    }
    const parsed = extractJson(text);
    progress('Breaking down the narrative structure', undefined, true);

    // 7 — synthesis
    progress('Writing the style profile');
    const gaps: string[] = (Array.isArray(parsed.gaps) ? parsed.gaps : []).map((g: any) => String(g));
    const blocks = synthesizeBlocks(parsed.blocks, cutTimes, format.durationSeconds);
    const rules = synthesizeRules(parsed.rules, gaps);

    const profile: StyleProfile = {
      version: PROFILE_VERSION,
      format,
      pacing,
      audio,
      transcriptAvailable: !!transcript,
      genre: String(parsed.genre ?? 'talking_head'),
      blocks,
      rules,
      captions: {
        present: !!(parsed.captions?.present ?? true),
        style: String(parsed.captions?.style ?? 'none'),
        description: String(parsed.captions?.description ?? ''),
      },
      grade: {
        look: String(parsed.grade?.look ?? parsed.colorGrade?.look ?? 'natural'),
        description: String(parsed.grade?.description ?? ''),
        useGradeReference: true,
      },
      transitions: {
        hardCutDominant: !!(parsed.transitions?.hardCutDominant ?? true),
        observed: (Array.isArray(parsed.transitions?.observed) ? parsed.transitions.observed : []).map((t: any) => String(t)),
      },
      gaps,
      description: String(parsed.description ?? ''),
    };
    progress('Writing the style profile', `${blocks.length} blocks · ${rules.length} rules`, true);

    return {
      captionStyle: parsed.captionStyle ?? parsed.captions ?? {},
      editing: parsed.editing ?? {
        pacing: pacing.avgShotSeconds < 2 ? 'fast' : pacing.avgShotSeconds < 4 ? 'medium' : 'slow',
        avgClipLengthSeconds: pacing.avgShotSeconds,
        hookStyle: 'none', hookDurationSeconds: 3, usesLetterboxBlur: false,
        usesZoomCuts: false, silenceRemoved: false, musicBed: false, brollStyle: 'none',
      },
      structure: parsed.structure ?? {
        openingSeconds: 3, bodySeconds: Math.max(1, format.durationSeconds - 6),
        ctaSeconds: 3, totalSeconds: format.durationSeconds,
      },
      colorGrade: parsed.colorGrade,
      description: String(parsed.description ?? ''),
      analyzedAt: Date.now(),
      model: modelUsed,
      profile,
    };
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

// ── Context digest (used by agentRuntime when building EDITH's context) ──────

export function renderProfileDigest(profile: StyleProfile): string {
  let out = '';
  const f = profile.format;
  out += `  STYLE PROFILE (${f.aspect}, ${Math.round(f.durationSeconds)}s reference, genre: ${profile.genre})\n`;
  out += `  ${profile.description}\n`;
  out += `  pacing: ${profile.pacing.shotCount} shots | avg ${profile.pacing.avgShotSeconds}s | median ${profile.pacing.medianShotSeconds}s | ${profile.pacing.cutsPerMinute} cuts/min`;
  if (profile.pacing.firstThirdAvgShot && profile.pacing.lastThirdAvgShot) {
    out += ` | opens at ${profile.pacing.firstThirdAvgShot}s avg, settles to ${profile.pacing.lastThirdAvgShot}s`;
  }
  out += '\n';
  if (profile.audio.speechGapMedianMs !== null) {
    out += `  audio: ${profile.audio.lufs ?? '?'} LUFS | median speech gap ${profile.audio.speechGapMedianMs}ms${profile.audio.speechGapMedianMs < 150 ? ' (breaths surgically removed)' : ''}\n`;
  }
  out += `  captions: ${profile.captions.present ? `${profile.captions.style} — ${profile.captions.description}` : 'none'}\n`;
  out += `  grade: ${profile.grade.look} — ${profile.grade.description} (transfer with gradeReference)\n`;
  out += '  narrative blocks (chronological):\n';
  for (const b of profile.blocks) {
    out += `    ${b.fn.toUpperCase()} ${b.startSeconds}s–${b.endSeconds}s (${b.cutCount} cuts, avg shot ${b.avgShotSeconds ?? '?'}s): ${b.label}\n`;
    const s = b.style;
    const bits = [s.captions && `captions: ${s.captions}`, s.punchIns && `punch-ins: ${s.punchIns}`,
      s.broll && `b-roll: ${s.broll}`, s.sfx && `sfx: ${s.sfx}`, s.music && `music: ${s.music}`, s.notes]
      .filter(Boolean);
    for (const bit of bits) out += `      - ${bit}\n`;
  }
  if (profile.rules.length) {
    out += '  style rules (trigger → op, support = how often it fires):\n';
    for (const r of profile.rules) {
      out += `    - ${r.trigger} → ${r.action.op}${r.action.params ? ' ' + JSON.stringify(r.action.params) : ''} (support ${r.support})\n`;
    }
  }
  if (profile.gaps.length) {
    out += `  NOT reproducible (be honest about these): ${profile.gaps.join('; ')}\n`;
  }
  return out;
}
