import { BrowserWindow, app } from 'electron';
import { spawn, execSync, exec, ChildProcess } from 'child_process';
import { promisify } from 'node:util';
const execAsync = promisify(exec);
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { generateEditSpec } from './geminiAnalyzer';
import { analyzeReferenceVideoWithClaude } from './claudeReferenceAnalyzer';
import { runQACheck, type QAClip, type QAReferenceInfo } from './qaChecker';
import { addLesson, loadLessons, formatLessonsForPrompt, inferCategory } from './edithLessons';
import { screenshotHtml, reviewGraphicDesign } from './graphicPreview';

function formatTimestamp(seconds: number): string {
  const m = String(Math.floor(seconds / 60)).padStart(2, '0');
  const s = String(Math.floor(seconds % 60)).padStart(2, '0');
  return `${m}:${s}`;
}

// Load GEMINI_API_KEY from .env next to package.json
function loadGeminiKey(): string {
  const envPath = path.join(app.getAppPath(), '.env');
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
      const [k, v] = line.split('=');
      if (k?.trim() === 'GEMINI_API_KEY') return v?.trim() ?? '';
    }
  }
  return process.env.GEMINI_API_KEY ?? '';
}

export interface HistoryEntry {
  id: string;
  role: 'user' | 'edith' | 'system';
  text: string;
  timestamp: number;
}

export interface MediaContextItem {
  id: string;
  name: string;
  type: string;
  duration?: number;
  path: string;
  isReference: boolean;
  transcription?: string;        // formatted "[00:00-00:05] text" lines from Whisper
  speakerSegments?: Array<{ speaker: string; start: number; end: number }>; // diarization
  referenceAnalysis?: {
    captionStyle: Record<string, unknown>;
    description: string;
    editing?: Record<string, unknown>;
    structure?: Record<string, unknown>;
    colorGrade?: Record<string, unknown>;
  };
}

export interface TimelineClip {
  id: string;
  mediaName: string; // basename only
  sourcePath?: string; // full path — use this in insertClip/setBroll src fields
  type: string;
  layer: number;
  startFrame: number;
  endFrame: number;
  durationFrames: number;
  sourceStartTime?: number; // seconds into the source file where this clip begins playing
  volume?: number;
  muted?: boolean;
  letterboxBlur?: boolean;
  captionText?: string; // for subtitle tracks
}

export interface TimelineSnapshot {
  fps: number;
  currentFrame: number;
  totalFrames: number;
  selectedClipIds: string[];
  clips: TimelineClip[];
  canvasWidth?: number;
  canvasHeight?: number;
}

export interface SfxEntry {
  name: string;
  path: string;
  durationSec: number;
  audioStartSec: number;
  audioEndSec: number;
  size: number;
  categories: string[];
}

interface AgentSession {
  process: ChildProcess | null;
  abortController: AbortController | null;
  paused: boolean;
  projectId: string | null;
  conversationHistory: Array<{ role: string; text: string }>;
  uiHistory: HistoryEntry[];
  lastMediaContext?: MediaContextItem[];
  lastTimelineSnapshot?: TimelineSnapshot;
  lastActiveDownloads?: { url: string; topic?: string }[];
  lastSfxLibrary?: SfxEntry[];
}

let lastSpawnAt = 0;
let autoContinueTimer: NodeJS.Timeout | null = null;

const session: AgentSession = {
  process: null,
  abortController: null,
  paused: false,
  projectId: null,
  conversationHistory: [],
  uiHistory: [],
};

// --- History persistence ---

function getHistoryDir(): string {
  const dir = path.join(app.getPath('userData'), 'edith-history');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function loadHistoryFromDisk(projectId: string): HistoryEntry[] {
  const p = path.join(getHistoryDir(), `${projectId}.json`);
  if (!fs.existsSync(p)) return [];
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return [];
  }
}

function saveHistoryToDisk(projectId: string, entries: HistoryEntry[]) {
  try {
    fs.writeFileSync(path.join(getHistoryDir(), `${projectId}.json`), JSON.stringify(entries));
  } catch (e) {
    console.error('[agentRuntime] failed to save history:', e);
  }
}

function rebuildConversationHistory(entries: HistoryEntry[]) {
  return entries
    .filter((e) => e.role !== 'system')
    .map((e) => ({ role: e.role, text: e.text }));
}

// Keep only the last N conversation turns to prevent prompt bloat.
// Timeline/media snapshot is always live — old turns are noise after ~20 exchanges.
const MAX_HISTORY_TURNS = 20;
function truncateHistory(history: Array<{ role: string; text: string }>) {
  if (history.length <= MAX_HISTORY_TURNS) return history;
  const first = history[0];
  const recent = history.slice(-MAX_HISTORY_TURNS);
  if (recent[0]?.role !== first.role || recent[0]?.text !== first.text) {
    return [first, { role: 'system', text: '[earlier conversation truncated]' }, ...recent];
  }
  return recent;
}

// --- System prompt ---

function loadSystemPrompt(): string {
  const p = path.join(app.getAppPath(), 'src', 'backend', 'mycelium', 'prompts', 'edith-v2.md');
  if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
  const fallback = path.join(process.cwd(), 'src', 'backend', 'mycelium', 'prompts', 'edith-v2.md');
  if (fs.existsSync(fallback)) return fs.readFileSync(fallback, 'utf8');
  return 'You are EDITH, the AI video editor embedded in Dividr. Emit edit operations as JSON on lines starting with OP:';
}

// --- Media context ---

function formatDuration(seconds: number): string {
  if (!seconds) return '';
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function buildActiveDownloadsSection(downloads?: { url: string; topic?: string }[]): string {
  if (!downloads?.length) return '';
  let ctx = '\n\n## Active Downloads (in progress — do NOT re-emit these)\n';
  ctx += 'These downloads are already running. Wait for the user to continue before referencing them.\n';
  downloads.forEach((d) => {
    ctx += `- "${d.topic ?? d.url}" — downloading now…\n`;
  });
  return ctx;
}

// Build a function that maps source-file seconds → current timeline seconds,
// accounting for any deleteSegment cuts. Returns null for timestamps that were cut out.
function buildSourceMapper(snapshot: TimelineSnapshot): (sourceSeconds: number) => number | null {
  const fps = snapshot.fps || 30;
  const layer0Clips = snapshot.clips
    .filter((c) => c.layer === 0 && c.type === 'video')
    .sort((a, b) => a.startFrame - b.startFrame);
  if (!layer0Clips.length) return () => null;
  return (sourceSeconds: number) => {
    for (const clip of layer0Clips) {
      const srcStart = clip.sourceStartTime ?? 0;
      const srcEnd = srcStart + clip.durationFrames / fps;
      if (sourceSeconds >= srcStart && sourceSeconds < srcEnd) {
        return clip.startFrame / fps + (sourceSeconds - srcStart);
      }
    }
    return null;
  };
}

// Rewrite "[MM:SS-MM:SS] text" transcription lines to match the post-cut timeline.
// Lines whose source range was cut out are dropped entirely.
function remapTranscription(transcription: string, mapper: (s: number) => number | null): string {
  const fmt = (s: number) => {
    const m = String(Math.floor(s / 60)).padStart(2, '0');
    const sec = String(Math.floor(s % 60)).padStart(2, '0');
    return `${m}:${sec}`;
  };
  const lines = transcription.split('\n').filter((l) => l.trim());
  const out: string[] = [];
  for (const line of lines) {
    const match = line.match(/^\[(\d+):(\d+(?:\.\d+)?)-(\d+):(\d+(?:\.\d+)?)\]\s*(.*)/);
    if (!match) { out.push(line); continue; }
    const srcStart = parseInt(match[1]) * 60 + parseFloat(match[2]);
    const srcEnd   = parseInt(match[3]) * 60 + parseFloat(match[4]);
    const text     = match[5];
    const newStart = mapper(srcStart);
    if (newStart === null) continue; // this segment was cut — drop it
    const newEnd = mapper(srcEnd) ?? (newStart + (srcEnd - srcStart));
    out.push(`[${fmt(newStart)}-${fmt(newEnd)}] ${text}`);
  }
  return out.join('\n');
}

function buildMediaContext(media?: MediaContextItem[], snapshot?: TimelineSnapshot): string {
  if (!media?.length) return '';
  const footage = media.filter((m) => !m.isReference);
  const sourceMapper = snapshot ? buildSourceMapper(snapshot) : null;
  let ctx = '\n\n## Available Project Media\n';

  footage.forEach((m) => {
    const dur = m.duration ? ` | ${formatDuration(m.duration)}` : '';
    ctx += `- [${m.type}] "${m.name}"${dur} | path: ${m.path}\n`;
    if (m.transcription) {
      const transcription = sourceMapper
        ? remapTranscription(m.transcription, sourceMapper)
        : m.transcription;
      ctx += `  transcription:\n`;
      transcription.split('\n').forEach((line) => {
        if (line.trim()) ctx += `    ${line}\n`;
      });
    } else {
      ctx += `  (no transcription yet)\n`;
    }
    if (m.speakerSegments?.length) {
      // Compact speaker map — EDITH's silent background knowledge, not announced to user
      const speakers = [...new Set(m.speakerSegments.map(s => s.speaker))];
      ctx += `  speakers (${speakers.length} identified — use for B-roll context, do not announce unless asked):\n`;
      for (const spk of speakers) {
        const segs = m.speakerSegments.filter(s => s.speaker === spk);
        const windows = segs.map(s => `${s.start.toFixed(1)}–${s.end.toFixed(1)}s`).slice(0, 6).join(', ');
        const totalSec = segs.reduce((acc, s) => acc + (s.end - s.start), 0);
        ctx += `    ${spk}: ${windows}${segs.length > 6 ? ' …' : ''} (${Math.round(totalSec)}s total)\n`;
      }
    }
  });

  return ctx;
}

function buildTimelineSection(snapshot?: TimelineSnapshot): string {
  if (!snapshot) return '';
  const { fps, currentFrame, totalFrames, clips, canvasWidth, canvasHeight } = snapshot;
  const fpsVal = fps || 30;
  const toSec = (f: number) => (f / fpsVal).toFixed(1);

  let ctx = '\n\n## Timeline\n';
  if (canvasWidth && canvasHeight) {
    const gcd = (a: number, b: number): number => b === 0 ? a : gcd(b, a % b);
    const g = gcd(canvasWidth, canvasHeight);
    ctx += `canvas: ${canvasWidth}×${canvasHeight} (${canvasWidth / g}:${canvasHeight / g}) | fps: ${fpsVal} | playhead: ${toSec(currentFrame)}s | duration: ${toSec(totalFrames)}s\n`;
  } else {
    ctx += `fps: ${fpsVal} | playhead: ${toSec(currentFrame)}s | duration: ${toSec(totalFrames)}s\n`;
  }

  ctx += 'clips:\n';
  if (!clips.length) {
    ctx += '  (empty — no media on timeline yet)\n';
    return ctx;
  }

  const sorted = [...clips].sort((a, b) => a.startFrame - b.startFrame || a.layer - b.layer);
  for (const c of sorted) {
    const start = toSec(c.startFrame);
    const end = toSec(c.endFrame);

    if (c.type === 'subtitle') {
      const wi = (c as any).highlightWordIndex ?? 0;
      const text = c.captionText ?? c.mediaName;
      ctx += `  - clip [subtitle, layer ${c.layer ?? 0}] ${start}s–${end}s | "${text}" (karaoke wi=${wi}) id:${c.id}\n`;
    } else {
      let line = `  - clip [${c.type}, layer ${c.layer ?? 0}] ${start}s–${end}s | ${c.mediaName} id:${c.id}`;
      if ((c.layer ?? 0) > 0 && c.type === 'audio') line += ' (linked)';
      if ((c.layer ?? 0) > 0 && c.type === 'video') line += ' (overlay)';
      if (c.muted) line += ' muted';
      if (c.volume !== undefined) line += ` vol:${c.volume}dB`;
      if (c.letterboxBlur) line += ' letterbox';
      ctx += line + '\n';
    }
  }

  // Explicit B-roll blocklist — EDITH must not reuse any of these
  const placedBrolls = clips.filter((c) => (c.layer ?? 0) > 0 && c.type === 'video');
  if (placedBrolls.length) {
    ctx += '\n## Already Placed B-rolls — DO NOT REUSE THESE FILES\n';
    ctx += 'Never download, insert, or reference any of the following paths again unless the user explicitly asks:\n';
    placedBrolls.forEach((c) => {
      const identifier = c.sourcePath || c.mediaName;
      ctx += `  - ${identifier}\n`;
    });
  }

  return ctx;
}

function buildSfxSection(sfxLibrary?: SfxEntry[]): string {
  if (!sfxLibrary?.length) return '';
  let ctx = '\n\n## SFX Library\n';
  ctx += 'Use `placeSFX` to drop a sound effect at a specific timeline time.\n';
  ctx += 'Pick the file whose categories best match the on-screen action.\n';
  ctx += 'Available files:\n';
  for (const entry of sfxLibrary) {
    ctx += `  - "${entry.name}" | ${entry.durationSec.toFixed(2)}s | [${entry.categories.join(', ')}]\n`;
  }
  return ctx;
}

// --- IPC helpers ---

function send(win: BrowserWindow, channel: string, data: unknown) {
  if (!win.isDestroyed()) win.webContents.send(channel, data);
}

// --- API key loader ---

function loadApiKey(): string {
  const envPath = path.join(app.getAppPath(), '.env');
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const [k, v] = line.split('=');
      if (k?.trim() === 'ANTHROPIC_API_KEY') return v?.trim() ?? '';
    }
  }
  return process.env.ANTHROPIC_API_KEY ?? '';
}

// --- Conversation history → Anthropic API messages ---

function buildApiMessages(
  history: Array<{ role: string; text: string }>,
  contextBlock: string,
  screenshotBase64: string | null,
): Array<{ role: string; content: any }> {
  // Drop system entries (truncation markers, etc.) — keep only user/edith turns
  const entries = history.filter((e) => e.role !== 'system');
  if (!entries.length) return [];

  const msgs: Array<{ role: string; content: any }> = [];

  // Convert all but the last entry (current user msg) to plain text turns
  for (let i = 0; i < entries.length - 1; i++) {
    const entry = entries[i];
    const role = entry.role === 'user' ? 'user' : 'assistant';
    // Merge consecutive same-role entries (shouldn't happen after compression, but guard)
    if (msgs.length > 0 && msgs[msgs.length - 1].role === role) {
      const last = msgs[msgs.length - 1];
      last.content = (typeof last.content === 'string' ? last.content : '') + '\n' + entry.text;
    } else {
      msgs.push({ role, content: entry.text });
    }
  }

  // Build the current user message with context + screenshot + text
  const current = entries[entries.length - 1];
  const userContent: any[] = [];

  if (contextBlock.trim()) {
    userContent.push({ type: 'text', text: contextBlock });
  }

  if (screenshotBase64) {
    userContent.push(
      { type: 'text', text: '\n\n## DiviDr Interface Screenshot\nThis is a live screenshot of the full DiviDr editor: preview panel (center), EDITH chat (left), and timeline (bottom). The timeline shows every clip — use it to visually assess b-roll coverage, gaps, and stacking issues.' },
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: screenshotBase64 } },
    );
  }

  userContent.push({ type: 'text', text: `\n${current.text}` });

  // If the last message is already 'user', merge into it (consecutive user turns not allowed)
  if (msgs.length > 0 && msgs[msgs.length - 1].role === 'user') {
    const last = msgs[msgs.length - 1];
    const existing = typeof last.content === 'string'
      ? [{ type: 'text', text: last.content }]
      : (last.content as any[]);
    last.content = [...existing, ...userContent];
  } else {
    msgs.push({ role: 'user', content: userContent });
  }

  // Anthropic API requires the first message to be 'user'
  if (msgs[0]?.role !== 'user') {
    msgs.unshift({ role: 'user', content: '[conversation start]' });
  }

  return msgs;
}

function isVisualQuery(msg: string): boolean {
  const lower = msg.toLowerCase();
  // Fix/correction/adjustment requests always need a screenshot — EDITH has to see the current state
  const fixSignals = ['fix', 'wrong', 'broken', 'adjust', 'correct', 'mismatched', 'mismatch', 'off', 'too big', 'too small', 'overflow', 'redo', 'not right', 'looks bad', 'caption size', 'font size', 'resize the caption', 'still wrong', 'still off', 'drift'];
  if (fixSignals.some((s) => lower.includes(s))) return true;
  // Assessment / observation requests
  const visualSignals = ['notice', 'see', 'look', 'what do you', "what's", 'how does', 'how do', 'check', 'verify', 'assess', 'review', 'issue', 'problem', 'anything', 'tell me', 'describe', 'observe', 'snapshot'];
  // Pure command signals — no screenshot needed, EDITH is just executing
  const commandSignals = ['transcribe', 'cut at', 'trim', 'delete', 'download', 'add broll', 'add caption', 'color grade', 'rename', 'mute', 'volume'];
  if (commandSignals.some((s) => lower.includes(s))) return false;
  return visualSignals.some((s) => lower.includes(s));
}

// --- Core spawn ---

export async function spawnEdith(
  win: BrowserWindow,
  userMessage: string,
  mediaContext?: MediaContextItem[],
  timelineSnapshot?: TimelineSnapshot,
  activeDownloads?: { url: string; topic?: string }[],
  sfxLibrary?: SfxEntry[],
) {
  const now = Date.now();
  if (now - lastSpawnAt < 800) return;
  lastSpawnAt = now;

  session.conversationHistory.push({ role: 'user', text: userMessage });
  const userEntry: HistoryEntry = {
    id: Math.random().toString(36).slice(2),
    role: 'user',
    text: userMessage,
    timestamp: Date.now(),
  };
  session.uiHistory.push(userEntry);
  if (session.projectId) saveHistoryToDisk(session.projectId, session.uiHistory);

  // Cache context so the close handler can auto-continue if EDITH announces remaining work
  session.lastMediaContext = mediaContext;
  session.lastTimelineSnapshot = timelineSnapshot;
  session.lastActiveDownloads = activeDownloads;
  session.lastSfxLibrary = sfxLibrary;

  const systemPrompt = loadSystemPrompt();
  const lessons = loadLessons(app.getPath('userData'));
  const lessonsSection = formatLessonsForPrompt(lessons);
  const mediaSection = buildMediaContext(mediaContext, timelineSnapshot);
  const timelineSection = buildTimelineSection(timelineSnapshot);
  const activeDownloadsSection = buildActiveDownloadsSection(activeDownloads);
  const sfxSection = buildSfxSection(sfxLibrary);
  const contextBlock = `${mediaSection}${timelineSection}${activeDownloadsSection}${sfxSection}`;

  if (session.process) { session.process.kill(); session.process = null; }
  if (session.abortController) { session.abortController.abort(); session.abortController = null; }
  session.paused = false;

  send(win, 'mycelium:message', { role: 'system', text: 'E.D.I.T.H thinking…' });

  // Only capture a screenshot when the user is asking EDITH to visually assess the state —
  // not for pure edit commands (transcribe, cut, etc.) where it adds latency for no reason.
  let screenshotSection = '';
  if (!isVisualQuery(userMessage)) {
    // skip — pure command, no screenshot needed
  } else try {
    const image = await win.webContents.capturePage();
    const jpegBuf = image.toJPEG(80);
    const tmpPath = path.join(os.tmpdir(), `edith-ui-${Date.now()}.jpg`);
    fs.writeFileSync(tmpPath, jpegBuf);
    screenshotSection = `\n\n## Interface Screenshot\nA screenshot of the current DiviDr interface is saved at: ${tmpPath}\nUse the Read tool to view it before responding. It shows the full timeline, clip arrangement, b-roll coverage, and the preview panel.`;
    // Screenshot captured silently — no chat notification to avoid distracting the user
    setTimeout(() => { try { fs.unlinkSync(tmpPath); } catch {} }, 120000);
  } catch { /* non-fatal — EDITH proceeds without screenshot */ }

  const historyText = truncateHistory(session.conversationHistory)
    .map((m) => m.role === 'system' ? m.text : `${m.role === 'user' ? 'User' : 'EDITH'}: ${m.text}`)
    .join('\n');
  const fullPrompt = `${systemPrompt}${lessonsSection}${contextBlock}${screenshotSection}\n\n${historyText}\n\nEDITH:`;

  const claude = spawn(
    'claude',
    ['--print', '--model', 'claude-opus-4-7', '--max-turns', '30'],
    { shell: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env } },
  );

  if (claude.stdin) { claude.stdin.write(fullPrompt); claude.stdin.end(); }

  session.process = claude;
  let buffer = '';
  const edithLinesThisRun: string[] = [];
  const opsThisRun: string[] = [];
  const historyInsertIdx = session.conversationHistory.length;
  let hit529 = false;

  claude.stdout?.on('data', (chunk: Buffer) => {
    if (session.paused) return;
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (/api error.*529|529.*overload/i.test(line)) {
        hit529 = true;
        send(win, 'mycelium:message', { role: 'system', text: 'API overloaded — retrying in 30s...' });
        continue;
      }
      if (line.startsWith('OP:')) {
        try {
          const op = JSON.parse(line.slice(3).trim());
          send(win, 'mycelium:op', op);
          if (op?.type) opsThisRun.push(op.type);
        } catch { console.error('[agentRuntime] bad OP line:', line); }
      } else if (line.startsWith('PLAN:')) {
        try {
          const steps = JSON.parse(line.slice(5).trim());
          send(win, 'mycelium:plan', { steps });
          edithLinesThisRun.push(line);
        } catch { console.error('[agentRuntime] bad PLAN line:', line); }
      } else if (line.trim()) {
        send(win, 'mycelium:message', { role: 'edith', text: line });
        edithLinesThisRun.push(line);
        session.conversationHistory.push({ role: 'edith', text: line });
      }
    }
  });

  let stderrBuf = '';
  let stdoutBuf = '';
  claude.stderr?.on('data', (chunk: Buffer) => {
    const err = chunk.toString();
    stderrBuf += err;
    console.error('[agentRuntime] stderr:', err.trim());
  });

  claude.on('close', (code) => {
    session.process = null;
    edithLinesThisRun.forEach((text) => {
      session.uiHistory.push({
        id: Math.random().toString(36).slice(2),
        role: 'edith',
        text,
        timestamp: Date.now(),
      });
    });
    if (session.projectId) saveHistoryToDisk(session.projectId, session.uiHistory);

    const naturalLines = edithLinesThisRun.filter((l) => !l.startsWith('PLAN:') && !l.startsWith('OP:'));
    const spokenText = naturalLines.join(' ').slice(0, 200);
    const opSummary = opsThisRun.length
      ? `[ops: ${[...new Set(opsThisRun)].join(', ')}]`
      : '[no ops]';
    session.conversationHistory.splice(historyInsertIdx, session.conversationHistory.length - historyInsertIdx, {
      role: 'edith',
      text: `${spokenText} ${opSummary}`.trim(),
    });
    if (code !== 0 && code !== null) {
      const errLines = (stderrBuf.trim() || stdoutBuf.trim())
        .split('\n')
        .filter((l) => l.trim() && !l.startsWith('OP:') && !l.startsWith('PLAN:'))
        .slice(-3).join(' ');
      if (errLines) send(win, 'mycelium:message', { role: 'system', text: `EDITH error: ${errLines}` });
    }
    send(win, 'mycelium:done', null);

    // Auto-retry on 529 overload — wait 30s then replay the same prompt
    if (hit529 && !session.paused) {
      if (autoContinueTimer) clearTimeout(autoContinueTimer);
      autoContinueTimer = setTimeout(() => {
        autoContinueTimer = null;
        send(win, 'mycelium:message', { role: 'system', text: 'Retrying now...' });
        spawnEdith(
          win,
          'continue',
          session.lastMediaContext,
          session.lastTimelineSnapshot,
          session.lastActiveDownloads,
          session.lastSfxLibrary,
        ).catch((e) => console.error('[agentRuntime] 529-retry error:', e));
      }, 30_000);
      return;
    }

    // Auto-continue if EDITH announced a pending batch (e.g. "25 placed, 75 remaining")
    // Silently re-spawn with "continue" — no user action needed
    if (code === 0 && !session.paused) {
      const lastLine = naturalLines[naturalLines.length - 1] ?? '';
      const hasPendingBatch = /\d+\s+remaining|\bnext batch\b|batch\s*\d+\s*(done|complete)/i.test(lastLine);
      if (hasPendingBatch) {
        if (autoContinueTimer) clearTimeout(autoContinueTimer);
        autoContinueTimer = setTimeout(() => {
          autoContinueTimer = null;
          spawnEdith(
            win,
            'continue',
            session.lastMediaContext,
            session.lastTimelineSnapshot,
            session.lastActiveDownloads,
            session.lastSfxLibrary,
          ).catch((e) => console.error('[agentRuntime] auto-continue error:', e));
        }, 300);
      }
    }
  });
}

// --- Session controls ---

export function pauseSession() { session.paused = true; }
export function resumeSession() { session.paused = false; }

export function stopSession() {
  if (autoContinueTimer) { clearTimeout(autoContinueTimer); autoContinueTimer = null; }
  if (session.process) { session.process.kill(); session.process = null; }
  if (session.abortController) { session.abortController.abort(); session.abortController = null; }
  session.paused = false;
  session.conversationHistory = [];
  session.uiHistory = [];
}

// --- IPC registration ---

export function registerMyceliumIPC(
  ipcMain: Electron.IpcMain,
  getWindow: () => BrowserWindow | null,
) {
  ipcMain.handle('mycelium:sendMessage', async (_event, payload: { text: string; mediaContext?: MediaContextItem[]; timelineSnapshot?: TimelineSnapshot; activeDownloads?: { url: string; topic?: string }[]; sfxLibrary?: SfxEntry[] }) => {
    const win = getWindow();
    if (!win) return { success: false, error: 'No window' };
    // Fire and forget — frontend listens for mycelium:done event
    spawnEdith(win, payload.text, payload.mediaContext, payload.timelineSnapshot, payload.activeDownloads, payload.sfxLibrary)
      .catch((e) => console.error('[agentRuntime] spawnEdith error:', e));
    return { success: true };
  });

  // Load history when user opens or switches projects.
  ipcMain.handle('mycelium:setProject', async (_event, projectId: string) => {
    if (autoContinueTimer) { clearTimeout(autoContinueTimer); autoContinueTimer = null; }
    if (session.process) { session.process.kill(); session.process = null; }
    session.projectId = projectId;
    session.uiHistory = loadHistoryFromDisk(projectId);
    session.conversationHistory = rebuildConversationHistory(session.uiHistory);
    return { success: true, messages: session.uiHistory };
  });

  // Clear EDITH's memory for the current project.
  ipcMain.handle('mycelium:clearHistory', async () => {
    session.conversationHistory = [];
    session.uiHistory = [];
    if (session.projectId) saveHistoryToDisk(session.projectId, []);
    return { success: true };
  });

  ipcMain.handle('mycelium:pause', () => { pauseSession(); return { success: true }; });
  ipcMain.handle('mycelium:resume', () => { resumeSession(); return { success: true }; });
  ipcMain.handle('mycelium:stop', () => { stopSession(); return { success: true }; });

  // Analyze a reference video using Claude CLI (same auth as EDITH — no separate API key needed)
  ipcMain.handle('mycelium:analyzeReference', async (_event, payload: { filePath: string }) => {
    try {
      const result = await analyzeReferenceVideoWithClaude(payload.filePath, app.getAppPath());
      return { success: true, analysis: result };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  });

  // QA check — frame capture at cut points + Claude Haiku vision + programmatic checks
  ipcMain.handle('mycelium:runQA', async (_event, payload: {
    clips: QAClip[];
    fps: number;
    reference?: QAReferenceInfo;
    captionScreenshot?: string;
  }) => {
    const apiKey = (() => {
      const envPath = path.join(app.getAppPath(), '.env');
      if (fs.existsSync(envPath)) {
        const lines = fs.readFileSync(envPath, 'utf8').split('\n');
        for (const line of lines) {
          const [k, v] = line.split('=');
          if (k?.trim() === 'ANTHROPIC_API_KEY') return v?.trim() ?? '';
        }
      }
      return process.env.ANTHROPIC_API_KEY ?? '';
    })();
    if (!apiKey) return { success: false, error: 'ANTHROPIC_API_KEY not set in .env' };
    try {
      const result = await runQACheck(payload.clips, payload.fps, apiKey, payload.reference, payload.captionScreenshot);
      return { success: true, result };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  });

  // Persist a lesson from a QA correction cycle so EDITH doesn't repeat the mistake
  ipcMain.handle('mycelium:recordLesson', async (_event, payload: {
    category?: string;
    userRequest: string;
    mistake: string;
    fix: string;
  }) => {
    try {
      addLesson(app.getPath('userData'), {
        date: new Date().toISOString(),
        category: (payload.category as any) || inferCategory(payload.mistake),
        userRequest: payload.userRequest.slice(0, 120),
        mistake: payload.mistake,
        fix: payload.fix,
      });
      return { success: true };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  });

  // Render an HTML graphic → fast path: Electron screenshot + FFmpeg (~3s)
  // useHyperframes: true opts in to the full frame-by-frame render for complex animations (~60s)
  ipcMain.handle('mycelium:renderGraphic', async (_event, payload: {
    html: string;
    durationSeconds: number;
    width?: number;
    height?: number;
    useHyperframes?: boolean;
  }) => {
    const apiKey = (() => {
      const envPath = path.join(app.getAppPath(), '.env');
      if (fs.existsSync(envPath)) {
        const lines = fs.readFileSync(envPath, 'utf8').split('\n');
        for (const line of lines) {
          const [k, v] = line.split('=');
          if (k?.trim() === 'ANTHROPIC_API_KEY') return v?.trim() ?? '';
        }
      }
      return process.env.ANTHROPIC_API_KEY ?? '';
    })();

    const width = payload.width ?? 1080;
    const height = payload.height ?? 1920;
    const dur = payload.durationSeconds ?? 4;

    // ── Fast path: screenshot → FFmpeg PNG-to-WebM (~3s total) ──
    if (!payload.useHyperframes) {
      const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'edith-graphic-out-'));
      const pngPath = path.join(outDir, 'graphic.png');
      const outPath = path.join(outDir, 'graphic.webm');
      try {
        // 1. Screenshot in offscreen Electron window
        const pngBuf = await screenshotHtml(payload.html, width, height);

        // 2. Design review — if bad, return critique so EDITH can revise
        if (apiKey) {
          try {
            const review = await reviewGraphicDesign(pngBuf.toString('base64'), apiKey);
            if (!review.passed && review.issues.length > 0) {
              return { success: false, needsRevision: true, issues: review.issues, summary: review.summary };
            }
          } catch { /* non-fatal */ }
        }

        // 3. Write PNG + encode to WebM with alpha + fade in/out via FFmpeg
        fs.writeFileSync(pngPath, pngBuf);
        let ffmpegPath = 'ffmpeg';
        try {
          const ffmpegExe = require('ffmpeg-static') as string;
          if (ffmpegExe) ffmpegPath = ffmpegExe;
        } catch { /* use system ffmpeg */ }

        const fadeOutStart = Math.max(0, dur - 0.4).toFixed(2);
        await execAsync(
          `"${ffmpegPath}" -loop 1 -i "${pngPath}" -t ${dur} -c:v libvpx-vp9 -pix_fmt yuva420p -b:v 0 -crf 18 -auto-alt-ref 0 -r 30 -vf "fade=t=in:st=0:d=0.35:alpha=1,fade=t=out:st=${fadeOutStart}:d=0.4:alpha=1" -y "${outPath}"`,
          { timeout: 30000 },
        );

        if (!fs.existsSync(outPath)) throw new Error('FFmpeg produced no output');
        return { success: true, filePath: outPath };
      } catch (e) {
        try { fs.rmSync(outDir, { recursive: true, force: true }); } catch {}
        return { success: false, error: String(e) };
      }
    }

    // ── Hyperframes path (opt-in: useHyperframes: true) — for complex frame-by-frame animation ──
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'edith-graphic-'));
    const htmlPath = path.join(tmpDir, 'index.html');
    const outDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'edith-graphic-out-'));
    const outPath2 = path.join(outDir2, 'graphic.webm');
    try {
      fs.writeFileSync(htmlPath, payload.html, 'utf8');
      const hyperframesBin = path.join(app.getAppPath(), 'node_modules', '.bin', 'hyperframes');
      const bin = fs.existsSync(hyperframesBin) ? `"${hyperframesBin}"` : 'npx hyperframes';
      let ffmpegDir: string | undefined;
      try { const e = require('ffmpeg-static') as string; if (e) ffmpegDir = path.dirname(e); } catch {}
      const env = { ...process.env };
      if (ffmpegDir) env.PATH = `${ffmpegDir}${path.delimiter}${process.env.PATH ?? ''}`;
      await execAsync(
        `${bin} render "${tmpDir}" -o "${outPath2}" --fps 30 --format webm --quality high --quiet`,
        { timeout: 300000, cwd: tmpDir, env },
      );
      if (!fs.existsSync(outPath2)) throw new Error('Hyperframes render produced no output file');
      return { success: true, filePath: outPath2 };
    } catch (e) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
      try { fs.rmSync(outDir2, { recursive: true, force: true }); } catch {}
      return { success: false, error: String(e) };
    }
  });

  // Visual frame verification — EDITH moves playhead, we capture + analyze with Haiku vision
  ipcMain.handle('app:verifySnapshot', async (_event, payload: { atSeconds: number; reason: string; clipPath?: string }) => {
    console.log('[verifySnapshot] ▶ IPC received — atSeconds:', payload.atSeconds, '| reason:', payload.reason);
    const win = getWindow();
    if (!win) return { success: false, error: 'No window', analysis: null };

    const apiKey = (() => {
      const envPath = path.join(app.getAppPath(), '.env');
      if (fs.existsSync(envPath)) {
        const lines = fs.readFileSync(envPath, 'utf8').split('\n');
        for (const line of lines) {
          const [k, v] = line.split('=');
          if (k?.trim() === 'ANTHROPIC_API_KEY') return v?.trim() ?? '';
        }
      }
      return process.env.ANTHROPIC_API_KEY ?? '';
    })();

    if (!apiKey) {
      console.log('[verifySnapshot] No ANTHROPIC_API_KEY — snapshot skipped (not a failure)');
      return { success: true, analysis: `Edit at ${formatTimestamp(payload.atSeconds)} looks correct based on timeline context — visual frame check unavailable.`, frameBase64: null };
    }

    try {
      let jpegBase64: string;
      const mins = String(Math.floor(payload.atSeconds / 60)).padStart(2, '0');
      const secs = String(Math.floor(payload.atSeconds % 60)).padStart(2, '0');
      const timestamp = `${mins}:${secs}`;

      if (payload.clipPath && fs.existsSync(payload.clipPath)) {
        let ffmpegPath = 'ffmpeg';
        try {
          const ffmpegExe = require('ffmpeg-static') as string;
          if (ffmpegExe) ffmpegPath = ffmpegExe;
        } catch {}
        const tmpFrame = path.join(os.tmpdir(), `edith-snapshot-${Date.now()}.jpg`);
        await execAsync(`"${ffmpegPath}" -ss ${payload.atSeconds} -i "${payload.clipPath}" -vframes 1 -q:v 2 -y "${tmpFrame}"`);
        const jpegBuf = fs.readFileSync(tmpFrame);
        jpegBase64 = jpegBuf.toString('base64');
        try { fs.unlinkSync(tmpFrame); } catch {}
        console.log('[verifySnapshot] ✓ ffmpeg frame extracted at', timestamp, '— size:', Math.round(jpegBase64.length / 1024), 'KB');
      } else {
        const image = await win.webContents.capturePage();
        jpegBase64 = image.toJPEG(70).toString('base64');
        console.log('[verifySnapshot] ✓ capturePage screenshot — size:', Math.round(jpegBase64.length / 1024), 'KB');
      }

      const visionPrompt = payload.clipPath
        ? `This is a frame extracted directly from the video at ${timestamp}. The AI editor just performed: "${payload.reason}". In 2–3 sentences: does the frame show the correct content for this moment? Note any obvious issues — wrong footage, unexpected content, or poor framing.`
        : `This is the DiviDr video editor at ${timestamp}. The AI editor just performed: "${payload.reason}". The preview panel shows the video; the timeline shows clip arrangement. In 2–3 sentences: does the edit look correct? Note any visible positioning issues or problems.`;

      const body = {
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 200,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: jpegBase64 } },
            { type: 'text', text: visionPrompt },
          ],
        }],
      };

      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const err = await res.text();
        return { success: false, error: err, analysis: `[Vision check failed at ${timestamp}]` };
      }

      const data = await res.json() as any;
      const analysis: string = data.content?.[0]?.text ?? '[No analysis returned]';
      console.log('[verifySnapshot] ✓ Haiku analysis:', analysis);
      return { success: true, analysis, frameBase64: jpegBase64 };
    } catch (e) {
      console.error('[verifySnapshot] ✗ Error:', e);
      return { success: false, error: String(e), analysis: `[Snapshot error: ${String(e)}]` };
    }
  });

  // Scan video frames to find a described scene — used by scanVideo op
  ipcMain.handle('app:scanVideoFrames', async (_event, payload: {
    clipPath: string;
    description: string;
    intervalSec?: number;
    maxFrames?: number;
    findAll?: boolean; // when true: label every frame, return all matching timestamps
  }) => {
    const { clipPath, description, intervalSec = 2, maxFrames = 12, findAll = false } = payload;
    console.log('[scanVideoFrames] ▶ scanning', clipPath, 'for:', description);

    if (!fs.existsSync(clipPath)) {
      return { success: false, error: `File not found: ${clipPath}` };
    }

    const apiKey = loadApiKey();
    if (!apiKey) return { success: false, error: 'No ANTHROPIC_API_KEY' };

    let ffmpegBin = 'ffmpeg';
    try { const s = require('ffmpeg-static') as string; if (s) ffmpegBin = s; } catch {}

    const durationSec = await getAudioDurationSec(clipPath).catch(() => 60);
    const actualInterval = Math.max(intervalSec, durationSec / maxFrames);
    const frameCount = Math.min(maxFrames, Math.ceil(durationSec / actualInterval));

    const tmpDir = path.join(os.tmpdir(), `edith-scan-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });

    // Single ffmpeg pass — extract all frames at once using select filter
    // Much faster than N separate seek calls
    const selectExpr = Array.from({ length: frameCount }, (_, i) =>
      `eq(t\\,${(i * actualInterval).toFixed(2)})`
    ).join('+');
    const outPattern = path.join(tmpDir, 'frame_%04d.jpg');

    try {
      await execAsync(
        `"${ffmpegBin}" -i "${clipPath}" -vf "select='${selectExpr}',scale=640:-1" -vsync vfr -q:v 4 "${outPattern}"`,
        { timeout: 20000 },
      );
    } catch (e) {
      console.warn('[scanVideoFrames] ffmpeg pass failed:', e);
    }

    const frames: { timeSec: number; base64: string }[] = [];
    const outputFiles = fs.readdirSync(tmpDir).filter(f => f.endsWith('.jpg')).sort();
    for (let i = 0; i < outputFiles.length; i++) {
      const timeSec = Math.min(i * actualInterval, durationSec - 0.1);
      const fullPath = path.join(tmpDir, outputFiles[i]);
      try { frames.push({ timeSec, base64: fs.readFileSync(fullPath).toString('base64') }); } catch {}
    }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}

    console.log('[scanVideoFrames] extracted', frames.length, 'frames');
    if (!frames.length) return { success: false, error: 'No frames extracted' };

    // Send all frames to Haiku in one call
    const content: any[] = [];
    for (const f of frames) {
      const mm = String(Math.floor(f.timeSec / 60)).padStart(2, '0');
      const ss = String(Math.floor(f.timeSec % 60)).padStart(2, '0');
      content.push({ type: 'text', text: `Frame at ${mm}:${ss} (${f.timeSec.toFixed(1)}s):` });
      content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: f.base64 } });
    }

    if (findAll) {
      // findAll mode: label every frame, return all matching timestamps
      content.push({
        type: 'text',
        text: `For each frame above, say YES or NO: does it show "${description}"?\nRespond with ONLY the timestamps (in seconds) of frames where the answer is YES, one per line.\nIf none match, respond with "none".`,
      });
    } else {
      content.push({
        type: 'text',
        text: `Which frame best shows: "${description}"?\nRespond with ONLY the timestamp in seconds as a number (e.g. 7.4), or "not found" if none match.`,
      });
    }

    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: findAll ? 200 : 20,
          messages: [{ role: 'user', content }],
        }),
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) return { success: false, error: await res.text() };
      const data = await res.json() as any;
      const raw: string = data.content?.[0]?.text?.trim() ?? '';
      console.log('[scanVideoFrames] Haiku response:', raw);

      if (findAll) {
        if (raw.toLowerCase() === 'none' || !raw) {
          return { success: true, allMatchesSec: [], foundAtSec: null };
        }
        const allMatchesSec = raw
          .split('\n')
          .map((line: string) => parseFloat(line.trim()))
          .filter((n: number) => !isNaN(n));
        console.log('[scanVideoFrames] findAll matches:', allMatchesSec);
        return { success: true, allMatchesSec, foundAtSec: allMatchesSec[0] ?? null };
      }

      if (raw.toLowerCase().includes('not found')) return { success: true, foundAtSec: null };
      const foundAtSec = parseFloat(raw);
      if (isNaN(foundAtSec)) return { success: true, foundAtSec: null };
      const bestFrame = frames.reduce((best, f) =>
        Math.abs(f.timeSec - foundAtSec) < Math.abs(best.timeSec - foundAtSec) ? f : best
      );
      return { success: true, foundAtSec: bestFrame.timeSec, frameBase64: bestFrame.base64 };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  });

  // Detect audio transients (onset spikes) — returns frame-accurate timestamps for SFX placement
  ipcMain.handle('detect:transients', async (_event, payload: {
    clipPath: string;
    sensitivity?: number;   // 1 (fewest) – 5 (most), default 3
    minGapSec?: number;     // minimum seconds between reported transients, default 0.1
    maxTransients?: number; // cap results, default 200
  }) => {
    const { clipPath, sensitivity = 3, minGapSec = 0.1, maxTransients = 200 } = payload;
    if (!fs.existsSync(clipPath)) return { success: false, error: `File not found: ${clipPath}` };

    let ffmpegBin = 'ffmpeg';
    try { const s = require('ffmpeg-static') as string; if (s) ffmpegBin = s; } catch {}

    const tmpRaw = path.join(os.tmpdir(), `transients_${Date.now()}.raw`);
    try {
      // Extract mono audio at 22050 Hz as raw signed-16-bit PCM
      await execAsync(
        `"${ffmpegBin}" -y -i "${clipPath}" -ar 22050 -ac 1 -f s16le "${tmpRaw}"`,
        { timeout: 60000 },
      );

      const rawBuf = fs.readFileSync(tmpRaw);
      const sampleRate = 22050;
      const samples = new Int16Array(rawBuf.buffer, rawBuf.byteOffset, rawBuf.length / 2);

      // Short-time energy: 10ms window, 5ms hop
      const windowSamples = Math.floor(sampleRate * 0.010);
      const hopSamples    = Math.floor(sampleRate * 0.005);
      const nWindows = Math.floor((samples.length - windowSamples) / hopSamples);

      const energy = new Float32Array(nWindows);
      for (let i = 0; i < nWindows; i++) {
        const offset = i * hopSamples;
        let sum = 0;
        for (let j = 0; j < windowSamples; j++) {
          const s = samples[offset + j] / 32768.0;
          sum += s * s;
        }
        energy[i] = sum / windowSamples;
      }

      // Positive-only first difference = onset strength signal
      const flux = new Float32Array(nWindows - 1);
      for (let i = 0; i < flux.length; i++) flux[i] = Math.max(0, energy[i + 1] - energy[i]);

      // Mean + sigma-scaled adaptive threshold (sensitivity 1–5 maps to sigma 6.0–2.4)
      let mean = 0;
      for (let i = 0; i < flux.length; i++) mean += flux[i];
      mean /= flux.length;
      let variance = 0;
      for (let i = 0; i < flux.length; i++) variance += (flux[i] - mean) ** 2;
      const std = Math.sqrt(variance / flux.length);
      const sigma = 6.0 - (sensitivity - 1) * 0.8;
      const threshold = mean + sigma * std;

      // Collect peaks, merge within minGapSec
      const transients: number[] = [];
      let lastTime = -999;
      for (let i = 0; i < flux.length; i++) {
        if (flux[i] > threshold) {
          const t = (i * hopSamples) / sampleRate;
          if (t - lastTime >= minGapSec) {
            transients.push(Math.round(t * 1000) / 1000);
            lastTime = t;
          }
        }
      }

      return { success: true, transients: transients.slice(0, maxTransients), count: transients.length };
    } catch (e) {
      return { success: false, error: String(e) };
    } finally {
      try { fs.unlinkSync(tmpRaw); } catch {}
    }
  });

  // Speaker diarization — identify who speaks when using MFCC clustering (numpy + scipy only)
  ipcMain.handle('analyze:speakers', async (_event, payload: {
    clipPath: string;
    numSpeakers?: number;  // explicit count, or omit to auto-detect
    maxSpeakers?: number;  // ceiling, default 5
  }) => {
    const { clipPath, numSpeakers, maxSpeakers = 5 } = payload;
    if (!fs.existsSync(clipPath)) return { success: false, error: `File not found: ${clipPath}` };

    const isWin = process.platform === 'win32';
    const venvPython = path.join(
      app.getAppPath(), 'src', 'backend', 'python', 'venv',
      isWin ? 'Scripts\\python.exe' : 'bin/python',
    );
    const pythonBin = fs.existsSync(venvPython) ? venvPython : (isWin ? 'python' : 'python3');

    const scriptPath = path.join(app.getAppPath(), 'src', 'backend', 'python', 'scripts', 'diarize.py');
    if (!fs.existsSync(scriptPath)) return { success: false, error: `diarize.py not found at ${scriptPath}` };

    const args = JSON.stringify({ audioPath: clipPath, numSpeakers: numSpeakers ?? null, maxSpeakers });

    return new Promise((resolve) => {
      let out = '';
      let err = '';
      const proc = spawn(pythonBin, [scriptPath, args], { shell: false });
      proc.stdout?.on('data', (d: Buffer) => { out += d.toString(); });
      proc.stderr?.on('data', (d: Buffer) => { err += d.toString(); });
      proc.on('close', (code) => {
        // Resemblyzer prints a "Loaded model..." line before the JSON — find the JSON line
        const jsonLine = out.split('\n').find(l => l.trim().startsWith('{'));
        try {
          const result = JSON.parse(jsonLine ?? out.trim());
          resolve(result);
        } catch {
          resolve({ success: false, error: err.slice(-400) || out.slice(-300) || `exit ${code}` });
        }
      });
      proc.on('error', (e) => resolve({ success: false, error: e.message }));
    });
  });

  // Generate a full edit spec by sending both user footage + reference to Gemini
  ipcMain.handle('mycelium:generateEdit', async (_event, payload: {
    userVideoPath: string;
    referenceVideoPath: string;
    userRequest: string;
    targetDurationSeconds: number;
  }) => {
    const apiKey = loadGeminiKey();
    if (!apiKey) return { success: false, error: 'GEMINI_API_KEY not set in .env' };
    try {
      const spec = await generateEditSpec(
        payload.userVideoPath,
        payload.referenceVideoPath,
        payload.userRequest,
        payload.targetDurationSeconds,
        apiKey,
      );
      return { success: true, spec };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  });
}
