/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-var-requires */
import { exec, spawn, spawnSync } from 'child_process';
import { app, BrowserWindow } from 'electron';
import started from 'electron-squirrel-startup';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileIOManager } from '../backend/io/FileIOManager';
import { IPC_CHANNELS } from '../shared/ipc/channels';
import type {
  AppExitDecisionRequest,
  AppExitDecisionResponse,
} from '../shared/ipc/contracts';
import { registerProjectLifecycleEvents } from './ipc/projectLifecycle';
import { registerIpcModules } from './ipc/registerIpcModules';

// Import unified media-tools runner (transcription + noise reduction)
import type { MediaToolsProgress } from '../backend/media-tools/mediaToolsRunner';
import {
  getPythonWhisperStatus,
  initializePythonWhisper,
} from '../backend/media-tools/mediaToolsRunner';

// Import runtime download manager for on-demand installation

// Import file I/O manager for controlled concurrency

// Import hardware capabilities service for hybrid proxy encoding

// Backward compatible type alias
type WhisperProgress = MediaToolsProgress;

// Import Vite dev server URL
declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string;
declare const MAIN_WINDOW_VITE_NAME: string;

// Global variables
export let mainWindow: BrowserWindow | null = null;
const forceQuit = false;
const EXIT_REQUEST_ACK_TIMEOUT_MS = 500;
let allowAppClose = false;
let activeExitRequestId: number | null = null;
let nextExitRequestId = 0;
let exitRequestAckTimeout: NodeJS.Timeout | null = null;
let isWindowFocused = true;
const STARTUP_BUDGET_MS = 5000;
const startupStart = performance.now();
const shouldLogStartup =
  process.env.NODE_ENV === 'development' ||
  process.env.STARTUP_DEBUG === 'true' ||
  !app.isPackaged;
const startupMarks = new Map<string, number>();
let lastStartupMark = startupStart;
let startupCheckpointCounter = 0;
let latestStartupPhase = 'process-start';

const clearExitRequestAckTimeout = (): void => {
  if (!exitRequestAckTimeout) return;
  clearTimeout(exitRequestAckTimeout);
  exitRequestAckTimeout = null;
};

const clearActiveExitRequest = (): void => {
  activeExitRequestId = null;
  clearExitRequestAckTimeout();
};

const finalizeAppClose = (): void => {
  clearActiveExitRequest();
  allowAppClose = true;
  app.quit();
};

export const requestRendererExitValidation = (trigger: string): void => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    finalizeAppClose();
    return;
  }
  if (mainWindow.webContents.isDestroyed()) {
    finalizeAppClose();
    return;
  }
  if (activeExitRequestId !== null) {
    return;
  }

  const requestId = ++nextExitRequestId;
  activeExitRequestId = requestId;

  try {
    mainWindow.webContents.send(IPC_CHANNELS.EVENT_APP_EXIT_REQUESTED, {
      requestId,
      trigger,
    });
  } catch (error) {
    console.warn('[Main] Failed to request renderer exit validation', error);
    finalizeAppClose();
    return;
  }

  clearExitRequestAckTimeout();
  exitRequestAckTimeout = setTimeout(() => {
    if (activeExitRequestId !== requestId) {
      return;
    }
    console.warn(
      '[Main] Renderer did not acknowledge app exit request, closing directly',
    );
    finalizeAppClose();
  }, EXIT_REQUEST_ACK_TIMEOUT_MS);
};

const broadcastStartupPhase = (
  phase: string,
  sinceStart: number,
  sinceLast: number,
  meta?: Record<string, unknown>,
): void => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.webContents.isDestroyed()) return;

  try {
    mainWindow.webContents.send(IPC_CHANNELS.EVENT_STARTUP_PHASE, {
      phase,
      sinceStart,
      sinceLast,
      meta: meta || null,
    });
  } catch {
    // Ignore broadcast errors during early startup / shutdown
  }
};

export const markStartupPhase = (
  phase: string,
  meta?: Record<string, unknown>,
): void => {
  const now = performance.now();
  startupMarks.set(phase, now);
  const sinceStart = Math.round(now - startupStart);
  const sinceLast = Math.round(now - lastStartupMark);
  lastStartupMark = now;
  latestStartupPhase = phase;
  broadcastStartupPhase(phase, sinceStart, sinceLast, meta);

  if (!shouldLogStartup) return;

  const baseMessage = `⏱️ [startup] ${phase} +${sinceLast}ms (${sinceStart}ms)`;
  if (meta && Object.keys(meta).length > 0) {
    console.log('[Main] Log', baseMessage, meta);
  } else {
    console.log('[Main] Log', baseMessage);
  }

  if (
    (phase === 'app-ready' || phase === 'ui-interactive') &&
    sinceStart > STARTUP_BUDGET_MS
  ) {
    console.warn(
      `[Startup] interactive exceeded${STARTUP_BUDGET_MS}ms budget (${sinceStart}ms)`,
    );
  }
};

const execCommand = (command: string): Promise<string> =>
  new Promise((resolve, reject) => {
    exec(command, { encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(`${stdout || ''}${stderr || ''}`);
    });
  });
const titlebarOverlayState: {
  color: string;
  symbolColor: string;
  height?: number;
} = {
  color: '#171717',
  symbolColor: '#171717',
};
// Dynamic import of ffmpeg binaries to avoid module resolution issues
export let ffmpegPath: string | null = null;
export let ffprobePath: { path: string } | null = null;
let ffmpegAudioDenoiseFilter: 'arnndn' | 'afftdn' | null | undefined =
  undefined;

export function getFfmpegAudioDenoiseFilter(): 'arnndn' | 'afftdn' | null {
  if (!ffmpegPath) {
    ffmpegAudioDenoiseFilter = null;
    return null;
  }
  if (ffmpegAudioDenoiseFilter !== undefined) {
    return ffmpegAudioDenoiseFilter;
  }

  try {
    const result = spawnSync(ffmpegPath, ['-hide_banner', '-filters'], {
      encoding: 'utf8',
    });
    const output = `${result.stdout || ''}\n${result.stderr || ''}`;
    const hasArnndn = /\barnndn\b/.test(output);
    const hasAfftdn = /\bafftdn\b/.test(output);

    if (hasArnndn) {
      ffmpegAudioDenoiseFilter = 'arnndn';
    } else if (hasAfftdn) {
      ffmpegAudioDenoiseFilter = 'afftdn';
    } else {
      ffmpegAudioDenoiseFilter = null;
    }
  } catch (error) {
    console.warn('[Main] Failed to detect FFmpeg filters', error);
    ffmpegAudioDenoiseFilter = null;
  }

  console.log('[Main] FFmpeg denoise filter support', ffmpegAudioDenoiseFilter);
  return ffmpegAudioDenoiseFilter;
}

// File path to open when app starts (from double-click on .dividr file)
let pendingFilePath: string | null = null;

registerProjectLifecycleEvents();

// =============================================================================
// FFmpeg Priority Queue System
// Priority levels: 1 (highest) = audio extraction, 2 = metadata/probing, 3 (lowest) = sprites/thumbnails
// This ensures audio tasks complete before heavy sprite sheet generation
// =============================================================================
type FFmpegPriority = 1 | 2 | 3;

interface FFmpegQueueTask {
  id: string;
  priority: FFmpegPriority;
  execute: () => Promise<void>;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

const ffmpegTaskQueue: FFmpegQueueTask[] = [];
let isProcessingFFmpegQueue = false;

// Global FFmpeg process tracking
let currentFfmpegProcess: ReturnType<typeof spawn> | null = null;
let currentFfmpegStartedAt: number | null = null;
let currentFfmpegTimeout: NodeJS.Timeout | null = null;
const DEFAULT_FFMPEG_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const STALE_FFMPEG_THRESHOLD_MS = 15 * 60 * 1000; // 15 minutes

function clearCurrentFfmpegProcess(): void {
  if (currentFfmpegTimeout) {
    clearTimeout(currentFfmpegTimeout);
    currentFfmpegTimeout = null;
  }
  currentFfmpegProcess = null;
  currentFfmpegStartedAt = null;
}

export function killCurrentFfmpegProcess(reason: string): boolean {
  if (!currentFfmpegProcess || currentFfmpegProcess.killed) {
    clearCurrentFfmpegProcess();
    return false;
  }

  console.warn(`[Main] Killing FFmpeg process (${reason})`);
  const proc = currentFfmpegProcess;
  try {
    proc.kill('SIGTERM');
  } catch (error) {
    console.warn('[Main] Failed to send SIGTERM to FFmpeg', error);
  }

  setTimeout(() => {
    if (proc && !proc.killed) {
      try {
        proc.kill('SIGKILL');
      } catch (error) {
        console.warn('[Main] Failed to send SIGKILL to FFmpeg', error);
      }
    }
    clearCurrentFfmpegProcess();
  }, 2000);

  return true;
}

export function ensureNoStaleFfmpegProcess(): void {
  if (!currentFfmpegProcess || !currentFfmpegStartedAt) return;
  if (currentFfmpegProcess.killed || currentFfmpegProcess.exitCode !== null) {
    clearCurrentFfmpegProcess();
    return;
  }
  const age = Date.now() - currentFfmpegStartedAt;
  if (age > STALE_FFMPEG_THRESHOLD_MS) {
    killCurrentFfmpegProcess(`stale-process (${Math.round(age / 1000)}s)`);
  }
}

/**
 * Add a task to the FFmpeg priority queue.
 * Tasks are executed in priority order (1 = highest, 3 = lowest).
 * Within the same priority, FIFO order is maintained.
 */
export function queueFFmpegTask<T>(
  priority: FFmpegPriority,
  taskFn: () => Promise<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const taskId = `ffmpeg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    const task: FFmpegQueueTask = {
      id: taskId,
      priority,
      execute: async () => {
        try {
          const result = await taskFn();
          resolve(result);
        } catch (error) {
          reject(error);
        }
      },
      resolve: resolve as (value: unknown) => void,
      reject,
    };

    // Insert task in priority order (lower number = higher priority)
    let insertIndex = ffmpegTaskQueue.length;
    for (let i = 0; i < ffmpegTaskQueue.length; i++) {
      if (ffmpegTaskQueue[i].priority > priority) {
        insertIndex = i;
        break;
      }
    }
    ffmpegTaskQueue.splice(insertIndex, 0, task);

    console.log(
      `[Main] FFmpeg task queued${taskId} (priority ${priority}), queue length: ${ffmpegTaskQueue.length}`,
    );

    // Start processing if not already running
    processFFmpegQueue();
  });
}

/**
 * Process the FFmpeg task queue sequentially by priority.
 */
async function processFFmpegQueue() {
  if (isProcessingFFmpegQueue) return;
  isProcessingFFmpegQueue = true;

  while (ffmpegTaskQueue.length > 0) {
    const task = ffmpegTaskQueue.shift();
    if (!task) break;

    console.log(
      `[Main] Processing FFmpeg task${task.id} (priority ${task.priority}), remaining: ${ffmpegTaskQueue.length}`,
    );

    try {
      await task.execute();
    } catch (error) {
      console.error(`[Main] FFmpeg task${task.id} failed:`, error);
      // Error is already handled by the task's reject
    }
  }

  isProcessingFFmpegQueue = false;
  console.log('[Main] FFmpeg queue empty');
}

// =============================================================================

export const applyTitlebarOverlay = (options?: {
  color?: string;
  symbolColor?: string;
  height?: number;
}) => {
  if (process.platform !== 'win32' || !mainWindow) return;
  if (options) {
    if (typeof options.color === 'string') {
      titlebarOverlayState.color = options.color;
    }
    if (typeof options.symbolColor === 'string') {
      titlebarOverlayState.symbolColor = options.symbolColor;
    }
    if (typeof options.height === 'number') {
      titlebarOverlayState.height = options.height;
    }
  }

  const overlayOptions: Electron.TitleBarOverlayOptions = {
    color: titlebarOverlayState.color,
    symbolColor: titlebarOverlayState.symbolColor,
  };

  if (typeof titlebarOverlayState.height === 'number') {
    overlayOptions.height = titlebarOverlayState.height;
  }

  mainWindow.setTitleBarOverlay(overlayOptions);
};

interface QueuedFfmpegOptions {
  priority: FFmpegPriority;
  timeoutMs?: number;
  windowsHide?: boolean;
  stdio?: Array<'pipe' | 'ignore'>;
  onStdout?: (text: string) => void;
  onStderr?: (text: string) => void;
  binaryPath?: string;
  onStart?: (process: ReturnType<typeof spawn>) => void;
}

export function runQueuedFfmpeg(
  args: string[],
  options: QueuedFfmpegOptions,
): Promise<{
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}> {
  return queueFFmpegTask(options.priority, () => {
    return new Promise((resolve, reject) => {
      const binaryPath = options.binaryPath || ffmpegPath;
      if (!binaryPath) {
        reject(
          new Error(
            'FFmpeg binary not available. Please ensure ffmpeg-static is properly installed.',
          ),
        );
        return;
      }

      ensureNoStaleFfmpegProcess();

      const stdio = options.stdio || ['ignore', 'pipe', 'pipe'];
      const ffmpeg = spawn(binaryPath, args, {
        stdio,
        windowsHide: options.windowsHide ?? true,
      });

      currentFfmpegProcess = ffmpeg;
      currentFfmpegStartedAt = Date.now();
      options.onStart?.(ffmpeg);

      let stdout = '';
      let stderr = '';
      let timedOut = false;

      const timeoutMs = options.timeoutMs ?? DEFAULT_FFMPEG_TIMEOUT_MS;
      if (timeoutMs > 0) {
        currentFfmpegTimeout = setTimeout(() => {
          timedOut = true;
          killCurrentFfmpegProcess(`timeout ${timeoutMs}ms`);
        }, timeoutMs);
      }

      if (ffmpeg.stdout) {
        ffmpeg.stdout.on('data', (data) => {
          const text = data.toString();
          stdout += text;
          options.onStdout?.(text);
        });
      }

      if (ffmpeg.stderr) {
        ffmpeg.stderr.on('data', (data) => {
          const text = data.toString();
          stderr += text;
          options.onStderr?.(text);
        });
      }

      const cleanup = () => {
        if (ffmpeg.stdout) ffmpeg.stdout.removeAllListeners();
        if (ffmpeg.stderr) ffmpeg.stderr.removeAllListeners();
        ffmpeg.removeAllListeners();
        clearCurrentFfmpegProcess();
      };

      ffmpeg.on('close', (code, signal) => {
        cleanup();
        resolve({ code, signal, stdout, stderr, timedOut });
      });

      ffmpeg.on('error', (error) => {
        cleanup();
        reject(error);
      });
    });
  });
}

// =============================================================================

// Initialize ffmpeg paths dynamically with fallbacks
async function initializeFfmpegPaths() {
  markStartupPhase('ffmpeg-init-start');
  console.log('[Main] Initializing FFmpeg paths');
  console.log('[Main] Is packaged', app.isPackaged);
  console.log('[Main] Environment', process.env.NODE_ENV || 'production');

  // Method 1: Try ffmpeg-static first (bundled, fast, reliable)
  if (!ffmpegPath) {
    try {
      console.log('[Main] Attempting ffmpeg-static (bundled binary)');

      // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
      const ffmpegStatic = require('ffmpeg-static');
      if (ffmpegStatic) {
        // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
        const fs = require('fs');
        if (fs.existsSync(ffmpegStatic)) {
          ffmpegPath = ffmpegStatic;
          console.log('[Main] FFmpeg resolved via ffmpeg-static', ffmpegPath);

          // Check version to confirm it's modern
          try {
            const versionOutput = await execCommand(
              `"${ffmpegStatic}" -version`,
            );
            const versionMatch = versionOutput.match(
              /ffmpeg version (\d+)\.(\d+)/,
            );
            if (versionMatch) {
              console.log(
                `[Main] ℹ FFmpeg version${versionMatch[1]}.${versionMatch[2]} (bundled)`,
              );
            }
          } catch (vErr) {
            console.log(
              '[Main] ℹ (Could not detect version, but using ffmpeg-static)',
            );
          }
        } else {
          console.log(
            '[Main] ffmpeg-static returned invalid path',
            ffmpegStatic,
          );
        }
      }
    } catch (requireError) {
      console.log('[Main] ffmpeg-static not available', requireError.message);
      console.log('[Main] ℹ Install with: yarn add ffmpeg-static');
    }
  }

  // Method 2: Try ffbinaries as fallback (downloads latest FFmpeg on demand)
  if (!ffmpegPath) {
    try {
      console.log(
        '[Main] Attempting ffbinaries fallback (downloads FFmpeg if needed)',
      );

      // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
      const ffbinaries = require('ffbinaries');
      // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
      const path = require('path');

      // Directory to store downloaded binaries
      const binDir = path.join(app.getPath('userData'), 'ffmpeg-bin');

      // Check if already downloaded
      const platform = ffbinaries.detectPlatform();
      const expectedPath = path.join(
        binDir,
        platform === 'windows-64' ? 'ffmpeg.exe' : 'ffmpeg',
      );

      if (require('fs').existsSync(expectedPath)) {
        ffmpegPath = expectedPath;
        console.log(
          '[Main] FFmpeg already downloaded via ffbinaries',
          ffmpegPath,
        );
      } else {
        console.log(
          '[Main] Downloading FFmpeg via ffbinaries (first time setup)',
        );

        // Download FFmpeg (async operation)
        await new Promise((resolve, reject) => {
          ffbinaries.downloadBinaries(
            'ffmpeg',
            { destination: binDir },
            (err: any) => {
              if (err) {
                console.error('[Main] Failed to download FFmpeg', err);
                reject(err);
              } else {
                ffmpegPath = expectedPath;
                console.log(
                  '[Main] FFmpeg downloaded successfully',
                  ffmpegPath,
                );
                resolve(null);
              }
            },
          );
        });
      }

      // Check version
      if (ffmpegPath) {
        try {
          const versionOutput = await execCommand(`"${ffmpegPath}" -version`);
          const versionMatch = versionOutput.match(
            /ffmpeg version (\d+)\.(\d+)/,
          );
          if (versionMatch) {
            console.log(
              `[Main] ℹ FFmpeg version${versionMatch[1]}.${versionMatch[2]} from ffbinaries`,
            );
          }
        } catch (vErr) {
          console.log(
            '[Main] ℹ (Could not detect version, but FFmpeg is ready)',
          );
        }
      }
    } catch (error) {
      console.log('[Main] ffbinaries failed', error.message);
      console.log('[Main] ℹ Install with: yarn add ffbinaries');
    }
  }

  // Log if no FFmpeg found yet
  if (!ffmpegPath) {
    console.log('[Main] No FFmpeg binary found in standard locations');
  }

  // FFprobe require method (only for development, same issue as ffmpeg)
  if (!app.isPackaged) {
    try {
      console.log(
        '[Main] Attempting FFprobe require method (development mode)',
      );
      // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
      const ffprobeStatic = require('ffprobe-static');
      if (ffprobeStatic) {
        ffprobePath = ffprobeStatic;
        console.log('[Main] FFprobe resolved via require', ffprobePath?.path);
      }
    } catch (requireError) {
      console.log('[Main] FFprobe require method failed', requireError.message);
    }
  } else {
    console.log(
      '[Main] Skipping FFprobe require method for packaged app - using manual resolution',
    );
  }

  // Method 2: Manual path resolution for packaged apps (always used for packaged apps)
  if (app.isPackaged) {
    try {
      console.log('[Main] Attempting manual path resolution');
      // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
      const path = require('path');
      // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
      const fs = require('fs');

      // Get the correct base paths for packaged apps
      const appPath = app.getAppPath();
      const resourcesPath = process.resourcesPath;
      const isWindows = process.platform === 'win32';
      const ffmpegBinary = isWindows ? 'ffmpeg.exe' : 'ffmpeg';

      console.log('[Main] App path', appPath);
      console.log('[Main] Resources path', resourcesPath);
      console.log('[Main] Platform', process.platform);

      const possiblePaths = [
        // Try @ffmpeg-installer first (better hardware acceleration)
        path.join(
          resourcesPath,
          'app.asar.unpacked',
          'node_modules',
          '@ffmpeg-installer',
          'ffmpeg',
          ffmpegBinary,
        ),
        path.join(
          appPath,
          '..',
          'app.asar.unpacked',
          'node_modules',
          '@ffmpeg-installer',
          'ffmpeg',
          ffmpegBinary,
        ),
        path.join(
          appPath,
          'node_modules',
          '@ffmpeg-installer',
          'ffmpeg',
          ffmpegBinary,
        ),
        path.join(
          resourcesPath,
          'node_modules',
          '@ffmpeg-installer',
          'ffmpeg',
          ffmpegBinary,
        ),

        // Fallback to ffmpeg-static - try without .exe first (common for ffmpeg-static)
        path.join(
          resourcesPath,
          'app.asar.unpacked',
          'node_modules',
          'ffmpeg-static',
          'ffmpeg',
        ),
        // Then try with platform-specific extension
        path.join(
          resourcesPath,
          'app.asar.unpacked',
          'node_modules',
          'ffmpeg-static',
          ffmpegBinary,
        ),
        // Fallback: App path relative - try without .exe first
        path.join(
          appPath,
          '..',
          'app.asar.unpacked',
          'node_modules',
          'ffmpeg-static',
          'ffmpeg',
        ),
        path.join(
          appPath,
          '..',
          'app.asar.unpacked',
          'node_modules',
          'ffmpeg-static',
          ffmpegBinary,
        ),
        // Direct node_modules paths (for unpackaged scenarios)
        path.join(appPath, 'node_modules', 'ffmpeg-static', 'ffmpeg'),
        path.join(appPath, 'node_modules', 'ffmpeg-static', ffmpegBinary),
        path.join(resourcesPath, 'node_modules', 'ffmpeg-static', 'ffmpeg'),
        path.join(resourcesPath, 'node_modules', 'ffmpeg-static', ffmpegBinary),
      ];

      for (const testPath of possiblePaths) {
        console.log('[Main] Checking FFmpeg path', testPath);
        if (fs.existsSync(testPath)) {
          ffmpegPath = testPath;
          console.log('[Main] FFmpeg found at manual path', testPath);
          break;
        } else {
          console.log('[Main] FFmpeg not found at', testPath);
        }
      }

      // Similar logic for ffprobe - it has a different directory structure
      const ffprobeBinary = isWindows ? 'ffprobe.exe' : 'ffprobe';
      const platformPath = isWindows
        ? path.join('bin', 'win32', 'x64')
        : path.join('bin', 'linux', 'x64');

      const ffprobePaths = [
        // Primary: ffprobe-static has platform-specific subdirectories
        path.join(
          resourcesPath,
          'app.asar.unpacked',
          'node_modules',
          'ffprobe-static',
          platformPath,
          'ffprobe',
        ),
        path.join(
          resourcesPath,
          'app.asar.unpacked',
          'node_modules',
          'ffprobe-static',
          platformPath,
          ffprobeBinary,
        ),
        // Fallback: App path relative with platform subdirectories
        path.join(
          appPath,
          '..',
          'app.asar.unpacked',
          'node_modules',
          'ffprobe-static',
          platformPath,
          'ffprobe',
        ),
        path.join(
          appPath,
          '..',
          'app.asar.unpacked',
          'node_modules',
          'ffprobe-static',
          platformPath,
          ffprobeBinary,
        ),
        // Legacy paths (try root directory too)
        path.join(
          resourcesPath,
          'app.asar.unpacked',
          'node_modules',
          'ffprobe-static',
          'ffprobe',
        ),
        path.join(
          resourcesPath,
          'app.asar.unpacked',
          'node_modules',
          'ffprobe-static',
          ffprobeBinary,
        ),
        // Direct node_modules paths (for unpackaged scenarios)
        path.join(
          appPath,
          'node_modules',
          'ffprobe-static',
          platformPath,
          'ffprobe',
        ),
        path.join(
          appPath,
          'node_modules',
          'ffprobe-static',
          platformPath,
          ffprobeBinary,
        ),
        path.join(appPath, 'node_modules', 'ffprobe-static', 'ffprobe'),
        path.join(appPath, 'node_modules', 'ffprobe-static', ffprobeBinary),
        path.join(
          resourcesPath,
          'node_modules',
          'ffprobe-static',
          platformPath,
          'ffprobe',
        ),
        path.join(
          resourcesPath,
          'node_modules',
          'ffprobe-static',
          platformPath,
          ffprobeBinary,
        ),
        path.join(resourcesPath, 'node_modules', 'ffprobe-static', 'ffprobe'),
        path.join(
          resourcesPath,
          'node_modules',
          'ffprobe-static',
          ffprobeBinary,
        ),
      ];

      for (const testPath of ffprobePaths) {
        console.log('[Main] Checking FFprobe path', testPath);
        if (fs.existsSync(testPath)) {
          ffprobePath = { path: testPath };
          console.log('[Main] FFprobe found at manual path', testPath);
          break;
        } else {
          console.log('[Main] FFprobe not found at', testPath);
        }
      }
    } catch (manualError) {
      console.log('[Main] Manual path resolution failed', manualError.message);
    }
  }

  // Method 3: System fallback
  if (!ffmpegPath) {
    try {
      console.log('[Main] Attempting system FFmpeg fallback');
      const systemFfmpeg = (await execCommand('where ffmpeg')).trim();
      ffmpegPath = systemFfmpeg.split('\n')[0];
      console.log('[Main] Using system FFmpeg', ffmpegPath);
    } catch (systemError) {
      console.log('[Main] System FFmpeg not available', systemError.message);
    }
  }

  if (!ffprobePath) {
    try {
      const systemFfprobe = (await execCommand('where ffprobe')).trim();
      ffprobePath = { path: systemFfprobe.split('\n')[0] };
      console.log('[Main] Using system FFprobe', ffprobePath.path);
    } catch (systemError) {
      console.log('[Main] System FFprobe not available', systemError.message);
    }
  }

  // Final status report
  console.log('[Main] FFmpeg initialization complete');
  console.log(
    '[Main] FFmpeg available',
    !!ffmpegPath,
    ffmpegPath ? `(${ffmpegPath})` : '',
  );
  console.log(
    '[Main] FFprobe available',
    !!ffprobePath?.path,
    ffprobePath?.path ? `(${ffprobePath.path})` : '',
  );

  if (!ffmpegPath || !ffprobePath?.path) {
    console.error('[Main] FFmpeg initialization failed!');
    console.error(
      '[Main] Please ensure ffmpeg-static and ffprobe-static packages are installed correctly',
    );
    console.error('[Main] Or install FFmpeg system-wide as a fallback');
  }
}

if (started) {
  app.quit();
}

const logStartupPerf = (label?: string): void => {
  if (!shouldLogStartup) return;
  const phase = label ?? `checkpoint-${++startupCheckpointCounter}`;
  markStartupPhase(phase);
};

let deferredInitStarted = false;
let deferredInitScheduled = false;
let deferredInitTimer: NodeJS.Timeout | null = null;

const runDeferredInitialization = (reason: string): void => {
  if (deferredInitStarted) return;
  deferredInitStarted = true;
  markStartupPhase('deferred-init-start', { reason });

  const tasks: Array<Promise<unknown>> = [
    initializeFfmpegPaths()
      .then(() => markStartupPhase('ffmpeg-ready'))
      .catch((error) => {
        console.error('[Main] FFmpeg init failed (non-blocking)', error);
      }),
    ensureMediaServer().catch((error) => {
      console.error('[Main] Media server init failed (non-blocking)', error);
    }),
    startMediaCacheCleanup().catch((error) => {
      console.error(
        '[Main] Media cache cleanup init failed (non-blocking)',
        error,
      );
    }),
  ];

  void Promise.allSettled(tasks).then(() => {
    markStartupPhase('deferred-init-complete');
  });
};

export const kickoffDeferredInitialization = (reason = 'window-visible') => {
  if (deferredInitScheduled || deferredInitStarted) return;
  deferredInitScheduled = true;

  const elapsed = performance.now() - startupStart;
  const delay = Math.max(0, STARTUP_BUDGET_MS - elapsed);

  if (shouldLogStartup) {
    console.log(
      `[Main] ⏳ [startup] scheduling deferred init in${Math.round(delay)}ms`,
      {
        reason,
      },
    );
  }

  deferredInitTimer = setTimeout(() => {
    runDeferredInitialization(reason);
  }, delay);
};

export const ensurePythonInitialized = async (
  _reason: string,
): Promise<void> => {
  if (getPythonWhisperStatus().available) return;

  try {
    await initializePythonWhisper();
  } catch (error) {
    console.error('[Main] Python Whisper initialization failed', error);
    throw error;
  }
};

// Create a simple HTTP server to serve media files
let mediaServer: http.Server | null = null;
let mediaServerReadyPromise: Promise<void> | null = null;
export const MEDIA_SERVER_PORT = 3001;
const MEDIA_CACHE_DIR_NAME = 'media-cache';
const MEDIA_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const TEMP_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 1 day
const MEDIA_CACHE_CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
let mediaCacheDir: string | null = null;
let mediaCacheCleanupTimer: NodeJS.Timeout | null = null;

export function getMediaCacheDir(): string {
  if (mediaCacheDir) return mediaCacheDir;
  const baseDir = path.join(app.getPath('userData'), MEDIA_CACHE_DIR_NAME);
  try {
    if (!fs.existsSync(baseDir)) {
      fs.mkdirSync(baseDir, { recursive: true });
    }
  } catch (error) {
    console.warn('[Main] Failed to ensure media cache directory', error);
  }
  mediaCacheDir = baseDir;
  return mediaCacheDir;
}

export function resolveMediaPath(input: string): string | null {
  if (!input) return null;

  let candidate = input;

  // If this is a media server URL, extract the path portion
  if (/^https?:\/\//i.test(input)) {
    try {
      const url = new URL(input);
      if (
        (url.hostname === 'localhost' || url.hostname === '127.0.0.1') &&
        url.port === String(MEDIA_SERVER_PORT)
      ) {
        if (url.pathname === '/media-file' && url.searchParams.has('path')) {
          const paramPath = url.searchParams.get('path') || '';
          candidate = decodeURIComponent(paramPath);
        } else {
          candidate = decodeURIComponent(url.pathname.slice(1));
        }
      }
    } catch (error) {
      console.warn('[Main] Failed to parse media URL', error);
      return null;
    }
  }

  // Normalize Windows absolute paths with a leading slash (e.g., /C:\...)
  if (candidate.startsWith('/') && /^[A-Za-z]:[\\/]/.test(candidate.slice(1))) {
    candidate = candidate.slice(1);
  }

  // Resolve relative paths against current working directory
  const resolved = path.isAbsolute(candidate)
    ? candidate
    : path.resolve(candidate);

  return resolved;
}

function setCorsHeaders(res: http.ServerResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
}

let mediaCacheCleanupInProgress = false;

async function cleanupMediaCache(): Promise<void> {
  const baseDir = getMediaCacheDir();
  try {
    await fs.promises.access(baseDir);
  } catch {
    return;
  }

  const now = Date.now();
  let processed = 0;

  const yieldIfNeeded = async (): Promise<void> => {
    if (processed > 0 && processed % 50 === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  };

  const pruneDir = async (dirPath: string, ttlMs: number): Promise<void> => {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        await pruneDir(fullPath, ttlMs);
        try {
          const remaining = await fs.promises.readdir(fullPath);
          if (remaining.length === 0) {
            await fs.promises.rm(fullPath, { recursive: false, force: true });
          }
        } catch {
          // Ignore cleanup errors
        }
      } else {
        try {
          const stats = await fs.promises.stat(fullPath);
          if (now - stats.mtimeMs > ttlMs) {
            await fs.promises.unlink(fullPath);
          }
        } catch {
          // Ignore cleanup errors
        }
      }

      processed += 1;
      await yieldIfNeeded();
    }
  };

  await pruneDir(baseDir, MEDIA_CACHE_TTL_MS);

  const tempDirs = [
    path.join(os.tmpdir(), 'dividr-audio-extracts'),
    path.join(os.tmpdir(), 'dividr-transcode'),
  ];

  for (const tempDir of tempDirs) {
    try {
      await fs.promises.access(tempDir);
      await pruneDir(tempDir, TEMP_CACHE_TTL_MS);
    } catch {
      // Ignore missing temp dirs
    }
  }
}

const runMediaCacheCleanup = async (reason: string): Promise<void> => {
  if (mediaCacheCleanupInProgress) return;
  mediaCacheCleanupInProgress = true;
  markStartupPhase('media-cache-cleanup-start', { reason });
  try {
    await cleanupMediaCache();
  } catch (error) {
    console.warn('[Main] Media cache cleanup failed', error);
  } finally {
    mediaCacheCleanupInProgress = false;
    markStartupPhase('media-cache-cleanup-complete', { reason });
  }
};

async function startMediaCacheCleanup(): Promise<void> {
  if (mediaCacheCleanupTimer) return;
  await runMediaCacheCleanup('startup');
  mediaCacheCleanupTimer = setInterval(() => {
    void runMediaCacheCleanup('interval');
  }, MEDIA_CACHE_CLEANUP_INTERVAL_MS);
}

export function ensureMediaServer(): Promise<void> {
  if (mediaServer && mediaServer.listening) {
    return Promise.resolve();
  }

  if (mediaServerReadyPromise) {
    return mediaServerReadyPromise;
  }

  mediaServerReadyPromise = new Promise((resolve, reject) => {
    mediaServer = http.createServer((req, res) => {
      if (!req.url) {
        setCorsHeaders(res);
        res.writeHead(404);
        res.end();
        return;
      }

      if (req.method === 'OPTIONS') {
        setCorsHeaders(res);
        res.writeHead(204);
        res.end();
        return;
      }

      let urlPath = '';
      try {
        const parsedUrl = new URL(req.url, 'http://localhost');
        if (
          parsedUrl.pathname === '/media-file' &&
          parsedUrl.searchParams.has('path')
        ) {
          const paramPath = parsedUrl.searchParams.get('path') || '';
          urlPath = decodeURIComponent(paramPath);
        } else {
          urlPath = decodeURIComponent(parsedUrl.pathname.slice(1));
        }
      } catch (error) {
        console.error('[Main] Error parsing media server URL', error);
        setCorsHeaders(res);
        res.writeHead(400);
        res.end('Invalid URL');
        return;
      }

      const resolvedPath = resolveMediaPath(urlPath);
      if (!resolvedPath) {
        setCorsHeaders(res);
        res.writeHead(400);
        res.end('Invalid media path');
        return;
      }

      try {
        if (!fs.existsSync(resolvedPath)) {
          setCorsHeaders(res);
          res.writeHead(404);
          res.end('File not found');
          return;
        }

        const stats = fs.statSync(resolvedPath);
        const ext = path.extname(resolvedPath).toLowerCase();

        // Set appropriate MIME type
        let mimeType = 'application/octet-stream';
        if (['.mp4', '.webm', '.ogg'].includes(ext)) {
          mimeType = `video/${ext.slice(1)}`;
        } else if (['.mp3', '.wav', '.aac'].includes(ext)) {
          mimeType = `audio/${ext.slice(1)}`;
        } else if (['.jpg', '.jpeg'].includes(ext)) {
          mimeType = 'image/jpeg';
        } else if (ext === '.png') {
          mimeType = 'image/png';
        } else if (ext === '.gif') {
          mimeType = 'image/gif';
        }

        // Handle range requests for video streaming
        const range = req.headers.range;
        if (range) {
          const parts = range.replace(/bytes=/, '').split('-');
          const start = parseInt(parts[0], 10);
          const end = parts[1] ? parseInt(parts[1], 10) : stats.size - 1;
          const chunksize = end - start + 1;

          const stream = fs.createReadStream(resolvedPath, { start, end });
          setCorsHeaders(res);
          res.writeHead(206, {
            'Content-Range': `bytes ${start}-${end}/${stats.size}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': chunksize,
            'Content-Type': mimeType,
          });

          stream.on('error', (streamError) => {
            console.error('[Main] Error streaming file', streamError);
            if (!res.headersSent) {
              setCorsHeaders(res);
              res.writeHead(500);
            }
            res.end('Stream error');
          });

          res.on('close', () => {
            stream.destroy();
          });

          stream.pipe(res);
        } else {
          setCorsHeaders(res);
          res.writeHead(200, {
            'Content-Length': stats.size,
            'Content-Type': mimeType,
          });

          const stream = fs.createReadStream(resolvedPath);
          stream.on('error', (streamError) => {
            console.error('[Main] Error streaming file', streamError);
            if (!res.headersSent) {
              setCorsHeaders(res);
              res.writeHead(500);
            }
            res.end('Stream error');
          });

          res.on('close', () => {
            stream.destroy();
          });

          stream.pipe(res);
        }
      } catch (error) {
        console.error('[Main] Error serving file', error);
        setCorsHeaders(res);
        res.writeHead(500);
        res.end('Internal server error');
      }
    });

    mediaServer.listen(MEDIA_SERVER_PORT, 'localhost', () => {
      console.log(
        `[Main] Media server started on http://localhost${MEDIA_SERVER_PORT}`,
      );
      markStartupPhase('media-server-ready');
      resolve();
    });

    mediaServer.on('error', (error) => {
      console.error('[Main] Media server error', error);
      mediaServerReadyPromise = null;
      reject(error);
    });
  });

  return mediaServerReadyPromise;
}

export const NOISE_REDUCTION_TEMP_DIR = path.join(
  os.tmpdir(),
  'dividr-noise-reduction',
);

export function isEMFILEError(error: unknown): boolean {
  if (error instanceof Error) {
    const nodeError = error as NodeJS.ErrnoException;
    return (
      nodeError.code === 'EMFILE' ||
      nodeError.code === 'ENFILE' ||
      error.message.includes('too many open files')
    );
  }
  return false;
}

export async function writeFileWithRetry(
  filePath: string,
  data: Buffer,
  maxRetries = 3,
): Promise<void> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await fileIOManager.writeFile(filePath, data, {
        priority: 'high',
        createDir: true,
      });
      return;
    } catch (error) {
      lastError = error as Error;
      if (isEMFILEError(error) && attempt < maxRetries) {
        console.warn(
          `[Main] EMFILE error writing${filePath}, retry ${attempt}/${maxRetries}`,
        );
        await new Promise((resolve) =>
          setTimeout(resolve, 500 * Math.pow(2, attempt - 1)),
        );
      } else {
        throw error;
      }
    }
  }

  throw lastError || new Error('Write failed after retries');
}

export function setPendingFilePath(filePath: string | null): void {
  pendingFilePath = filePath;
}

export function resolveAppExitDecision(
  payload: AppExitDecisionRequest | null,
): AppExitDecisionResponse {
  const requestId = Number(payload?.requestId);
  const decision = payload?.decision;
  if (!Number.isInteger(requestId) || !decision) {
    return { success: false };
  }
  if (activeExitRequestId !== requestId) {
    return { success: false };
  }

  if (decision === 'pending') {
    clearExitRequestAckTimeout();
    return { success: true };
  }

  if (decision === 'cancel') {
    clearActiveExitRequest();
    allowAppClose = false;
    return { success: true };
  }

  if (decision === 'allow') {
    finalizeAppClose();
    return { success: true };
  }

  return { success: false };
}

export function getStartupState(): {
  success: true;
  latestPhase: string;
  elapsedMs: number;
  phases: Record<string, number>;
} {
  const phases: Record<string, number> = {};
  for (const [phase, ts] of startupMarks.entries()) {
    phases[phase] = Math.round(ts - startupStart);
  }

  return {
    success: true,
    latestPhase: latestStartupPhase,
    elapsedMs: Math.round(performance.now() - startupStart),
    phases,
  };
}

const createWindow = () => {
  const useNativeTitlebarOverlay = process.platform === 'win32';
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 720,
    frame: false,
    ...(useNativeTitlebarOverlay
      ? { titleBarStyle: 'hidden', titleBarOverlay: true }
      : {}),
    autoHideMenuBar: true,
    minWidth: 1280,
    minHeight: 520,
    show: false, // Don't show immediately - wait for ready-to-show
    backgroundColor: '#171717', // Match loader background to prevent flash
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      webSecurity: true,
      nodeIntegration: true,
      // devTools: false,
    },
  });

  applyTitlebarOverlay();

  logStartupPerf('window-created');

  if (mainWindow) {
    const fallbackShow = setTimeout(() => {
      if (!mainWindow) return;
      if (!mainWindow.isVisible()) {
        logStartupPerf('window-show-fallback');
        mainWindow.show();
      }
      kickoffDeferredInitialization();
    }, 1200);

    mainWindow.webContents.once('did-start-loading', () => {
      logStartupPerf('renderer-start-loading');
    });

    mainWindow.webContents.once('dom-ready', () => {
      logStartupPerf('renderer-dom-ready');
      // DOM is ready, loader HTML is already visible from index.html
      // Show window immediately since loader is in HTML
      if (mainWindow && !mainWindow.isVisible()) {
        clearTimeout(fallbackShow);
        mainWindow.show();
        kickoffDeferredInitialization();
      }
    });

    mainWindow.webContents.once('did-finish-load', () => {
      logStartupPerf('renderer-did-finish-load');

      // Send pending file path to renderer if app was opened with a .dividr file
      if (pendingFilePath && mainWindow) {
        mainWindow.webContents.send(
          IPC_CHANNELS.EVENT_OPEN_PROJECT_FILE,
          pendingFilePath,
        );
        pendingFilePath = null;
      }
    });

    // Show window when ready (fallback)
    mainWindow.once('ready-to-show', () => {
      clearTimeout(fallbackShow);
      logStartupPerf('window-ready-to-show');
      if (!mainWindow?.isVisible()) {
        mainWindow?.show();
        kickoffDeferredInitialization();
      }
    });

    const allowDevTools =
      process.env.NODE_ENV === 'development' ||
      process.env.ALLOW_DEVTOOLS === 'true';

    if (
      process.env.NODE_ENV === 'development' &&
      MAIN_WINDOW_VITE_DEV_SERVER_URL
    ) {
      mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
      mainWindow.webContents.openDevTools();
    } else {
      mainWindow.loadFile(
        path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
      );

      if (!allowDevTools) {
        // 🚫 Remove all default menus so "View → Toggle Developer Tools" disappears
        // Menu.setApplicationMenu(null);

        // 🚫 Block keyboard shortcuts
        mainWindow.webContents.on('before-input-event', (event, input) => {
          if (
            (input.control && input.shift && input.key.toLowerCase() === 'i') || // Ctrl+Shift+I
            input.key === 'F12' || // F12
            (process.platform === 'darwin' &&
              input.meta &&
              input.alt &&
              input.key.toLowerCase() === 'i') // Cmd+Opt+I
          ) {
            event.preventDefault();
          }
        });

        // 🚫 If DevTools somehow open, force-close them
        mainWindow.webContents.on('devtools-opened', () => {
          mainWindow?.webContents.closeDevTools();
        });

        // 🚫 Disable right-click → Inspect Element
        mainWindow.webContents.on('context-menu', (e) => {
          e.preventDefault();
        });
      }
    }

    // Handle window close events - hide instead of close
    mainWindow.on('close', (event) => {
      if (allowAppClose) {
        allowAppClose = false;
        clearActiveExitRequest();
        return;
      }

      event.preventDefault();
      void (async () => {
        if (!forceQuit) {
          // Get the real-time setting
          const shouldRunInBackground = await getRunInBackgroundSetting();
          console.log(
            '[Main] Window closing, checking setting',
            shouldRunInBackground,
          );

          if (shouldRunInBackground) {
            mainWindow?.hide();
            return;
          }
        }

        requestRendererExitValidation('window-close');
      })();

      return false;
    });

    // Focus tracking for clipboard monitoring
    mainWindow.on('focus', () => {
      isWindowFocused = true;
      // console.log('Window focused - clipboard monitoring paused');
    });

    mainWindow.on('blur', () => {
      isWindowFocused = false;
      // console.log('Window unfocused - clipboard monitoring resumed');
    });

    // Maximize state change events
    mainWindow.on('maximize', () => {
      mainWindow?.webContents.send(
        IPC_CHANNELS.EVENT_WINDOW_MAXIMIZE_CHANGED,
        true,
      );
    });

    mainWindow.on('unmaximize', () => {
      mainWindow?.webContents.send(
        IPC_CHANNELS.EVENT_WINDOW_MAXIMIZE_CHANGED,
        false,
      );
    });

    // Prevent navigation to external URLs
    mainWindow.webContents.on('will-navigate', (event) => {
      event.preventDefault();
    });
  }
};

// Helper function to get run in background setting
async function getRunInBackgroundSetting(): Promise<boolean> {
  // This would typically read from a settings file or store
  // For now, return false as default
  return false;
}

registerIpcModules();

app.on('ready', async () => {
  // Create window first to show loader immediately
  logStartupPerf('app-bootstrap');
  createWindow();
  void ensureMediaServer();

  setTimeout(() => {
    kickoffDeferredInitialization('budget-fallback');
  }, STARTUP_BUDGET_MS + 2000);
});

app.on('window-all-closed', () => {
  if (mediaServer) {
    mediaServer.close();
    console.log('[Main] Media server stopped');
  }

  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

app.on('before-quit', () => {
  if (mediaServer) {
    mediaServer.close();
    console.log('[Main] Media server stopped');
  }

  if (mediaCacheCleanupTimer) {
    clearInterval(mediaCacheCleanupTimer);
    mediaCacheCleanupTimer = null;
  }

  // Ensure any active FFmpeg process is terminated before exit
  try {
    killCurrentFfmpegProcess('app-quit');
    ffmpegTaskQueue.length = 0;
  } catch (error) {
    console.warn('[Main] Failed to cleanup FFmpeg before quit', error);
  }

  // Cleanup noise reduction temp directory
  if (fs.existsSync(NOISE_REDUCTION_TEMP_DIR)) {
    try {
      fs.rmSync(NOISE_REDUCTION_TEMP_DIR, { recursive: true, force: true });
      console.log('[Main] Cleaned up noise reduction temp directory');
    } catch (error) {
      console.warn(
        '[Main] Failed to cleanup noise reduction temp directory',
        error,
      );
    }
  }
});
