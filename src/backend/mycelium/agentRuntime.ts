import { BrowserWindow, app } from 'electron';
import { spawn, ChildProcess } from 'child_process';
import path from 'node:path';
import fs from 'node:fs';
import { analyzeReferenceVideo, generateEditSpec } from './geminiAnalyzer';

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

interface AgentSession {
  process: ChildProcess | null;
  paused: boolean;
  projectId: string | null;
  conversationHistory: Array<{ role: string; text: string }>;
  uiHistory: HistoryEntry[];
}

let lastSpawnAt = 0;

const session: AgentSession = {
  process: null,
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

// --- System prompt ---

function loadSystemPrompt(): string {
  const p = path.join(app.getAppPath(), 'src', 'backend', 'mycelium', 'prompts', 'edith.md');
  if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
  const fallback = path.join(process.cwd(), 'src', 'backend', 'mycelium', 'prompts', 'edith.md');
  if (fs.existsSync(fallback)) return fs.readFileSync(fallback, 'utf8');
  return 'You are E.D.I.T.H, an AI video editing agent inside Dividr. Emit edit operations as JSON on lines starting with OP:';
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

function buildMediaContext(media?: MediaContextItem[]): string {
  if (!media?.length) return '';
  const footage = media.filter((m) => !m.isReference);
  const references = media.filter((m) => m.isReference);
  let ctx = '\n\n## Available Project Media\n';
  ctx += 'Use these paths in ops. Do not invent paths.\n';

  if (footage.length) {
    ctx += '\n### Footage\n';
    footage.forEach((m) => {
      const dur = m.duration ? ` | ${formatDuration(m.duration)}` : '';
      ctx += `- [${m.type}] "${m.name}"${dur}\n  id: ${m.id}\n  path: ${m.path}\n`;
      if (m.transcription) {
        ctx += `  transcription:\n`;
        m.transcription.split('\n').forEach((line) => {
          if (line.trim()) ctx += `    ${line}\n`;
        });
      } else {
        ctx += `  (no transcription yet — emit runWhisper with this id before referencing spoken content)\n`;
      }
    });
  }

  if (references.length) {
    ctx += '\n### Reference Videos\n';
    references.forEach((m) => {
      const dur = m.duration ? ` | ${formatDuration(m.duration)}` : '';
      ctx += `- "${m.name}"${dur}\n  id: ${m.id}\n  path: ${m.path}\n`;
      if (m.referenceAnalysis) {
        const r = m.referenceAnalysis as any;
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

function buildTimelineSection(snapshot?: TimelineSnapshot): string {
  if (!snapshot) return '';
  const { fps, currentFrame, totalFrames, selectedClipIds, clips, canvasWidth, canvasHeight } = snapshot;
  const fpsVal = fps || 30;
  const toSec = (f: number) => (f / fpsVal).toFixed(2);

  let ctx = `\n\n## Current Timeline\n`;
  if (canvasWidth && canvasHeight) {
    const gcd = (a: number, b: number): number => b === 0 ? a : gcd(b, a % b);
    const g = gcd(canvasWidth, canvasHeight);
    ctx += `canvas: ${canvasWidth}×${canvasHeight} (${canvasWidth / g}:${canvasHeight / g})\n`;
  }
  ctx += `fps: ${fpsVal} | playhead: frame ${currentFrame} (${toSec(currentFrame)}s) | totalFrames: ${totalFrames} (${toSec(totalFrames)}s) | clipsOnTimeline: ${clips.length}\n`;
  if (selectedClipIds.length) ctx += `selectedClipIds: [${selectedClipIds.map((id) => `"${id}"`).join(', ')}]\n`;

  ctx += '\n### Clips (in playback order)\n';
  if (!clips.length) {
    ctx += '(timeline is empty — insert media first before referencing clipIds)\n';
    return ctx;
  }

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

// --- IPC helpers ---

function send(win: BrowserWindow, channel: string, data: unknown) {
  if (!win.isDestroyed()) win.webContents.send(channel, data);
}

// --- Core spawn ---

export function spawnEdith(
  win: BrowserWindow,
  userMessage: string,
  mediaContext?: MediaContextItem[],
  timelineSnapshot?: TimelineSnapshot,
  activeDownloads?: { url: string; topic?: string }[],
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

  const systemPrompt = loadSystemPrompt();
  const mediaSection = buildMediaContext(mediaContext);
  const timelineSection = buildTimelineSection(timelineSnapshot);
  const activeDownloadsSection = buildActiveDownloadsSection(activeDownloads);
  const historyText = session.conversationHistory
    .map((m) => `${m.role === 'user' ? 'User' : 'EDITH'}: ${m.text}`)
    .join('\n');
  const fullPrompt = `${systemPrompt}${mediaSection}${timelineSection}${activeDownloadsSection}\n\n${historyText}\n\nEDITH:`;

  if (session.process) {
    session.process.kill();
    session.process = null;
  }
  session.paused = false;

  send(win, 'mycelium:message', { role: 'system', text: 'E.D.I.T.H thinking…' });

  const claude = spawn(
    'claude',
    ['--print', '--model', 'claude-sonnet-4-6', '--max-turns', '5'],
    { shell: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env } },
  );

  if (claude.stdin) {
    claude.stdin.write(fullPrompt);
    claude.stdin.end();
  }

  session.process = claude;
  let buffer = '';
  const edithLinesThisRun: string[] = [];

  claude.stdout?.on('data', (chunk: Buffer) => {
    if (session.paused) return;
    const raw = chunk.toString();
    stdoutBuf += raw;
    buffer += raw;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (line.startsWith('OP:')) {
        try {
          const op = JSON.parse(line.slice(3).trim());
          send(win, 'mycelium:op', op);
        } catch {
          console.error('[agentRuntime] bad OP line:', line);
        }
      } else if (line.startsWith('PLAN:')) {
        try {
          const steps = JSON.parse(line.slice(5).trim());
          send(win, 'mycelium:plan', { steps });
          session.conversationHistory.push({ role: 'edith', text: line });
          edithLinesThisRun.push(line);
        } catch {
          console.error('[agentRuntime] bad PLAN line:', line);
        }
      } else if (line.startsWith('Q:')) {
        try {
          const q = JSON.parse(line.slice(2).trim());
          // Send as a question event — FridayPanel renders this as an interactive card
          send(win, 'mycelium:question', q);
          // Also store in history as plain text so it survives reloads
          session.conversationHistory.push({ role: 'edith', text: line });
          edithLinesThisRun.push(line);
        } catch {
          console.error('[agentRuntime] bad Q line:', line);
        }
      } else if (line.trim()) {
        send(win, 'mycelium:message', { role: 'edith', text: line });
        session.conversationHistory.push({ role: 'edith', text: line });
        edithLinesThisRun.push(line);
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
    if (code !== 0 && code !== null) {
      // Filter out OP:/PLAN:/Q: lines — only show human-readable error lines
      const errLines = (stderrBuf.trim() || stdoutBuf.trim())
        .split('\n')
        .filter((l) => l.trim() && !l.startsWith('OP:') && !l.startsWith('PLAN:') && !l.startsWith('Q:'))
        .slice(-3)
        .join(' ');
      console.error('[agentRuntime] exit code', code, '| output:', errLines);
      if (errLines) send(win, 'mycelium:message', { role: 'system', text: `EDITH error: ${errLines}` });
    }
    send(win, 'mycelium:done', null);
  });
}

// --- Session controls ---

export function pauseSession() { session.paused = true; }
export function resumeSession() { session.paused = false; }

export function stopSession() {
  if (session.process) { session.process.kill(); session.process = null; }
  session.paused = false;
  session.conversationHistory = [];
  session.uiHistory = [];
}

// --- IPC registration ---

export function registerMyceliumIPC(
  ipcMain: Electron.IpcMain,
  getWindow: () => BrowserWindow | null,
) {
  ipcMain.handle('mycelium:sendMessage', async (_event, payload: { text: string; mediaContext?: MediaContextItem[]; timelineSnapshot?: TimelineSnapshot; activeDownloads?: { url: string; topic?: string }[] }) => {
    const win = getWindow();
    if (!win) return { success: false, error: 'No window' };
    spawnEdith(win, payload.text, payload.mediaContext, payload.timelineSnapshot, payload.activeDownloads);
    return { success: true };
  });

  // Load history when user opens or switches projects.
  ipcMain.handle('mycelium:setProject', async (_event, projectId: string) => {
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

  // Analyze a reference video with Gemini — returns captionStyle JSON
  ipcMain.handle('mycelium:analyzeReference', async (_event, payload: { filePath: string }) => {
    const apiKey = loadGeminiKey();
    if (!apiKey) return { success: false, error: 'GEMINI_API_KEY not set in .env' };
    try {
      const result = await analyzeReferenceVideo(payload.filePath, apiKey);
      return { success: true, analysis: result };
    } catch (e) {
      return { success: false, error: String(e) };
    }
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
