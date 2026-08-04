/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-var-requires */
import { spawn, spawnSync } from 'child_process';
import { app, BrowserWindow, desktopCapturer, dialog, ipcMain, shell } from 'electron';
import started from 'electron-squirrel-startup';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {
  runFfmpeg,
  runFfmpegWithProgress,
} from './backend/ffmpeg/export/ffmpegRunner';
import { VideoEditJob } from './backend/ffmpeg/schema/ffmpegConfig';
import { parseSceneTimestamps } from './shared/sceneDetection';

// Import unified media-tools runner (transcription + noise reduction)
import type {
  MediaToolsProgress,
  NoiseReductionResult,
  WhisperResult,
} from './backend/media-tools/mediaToolsRunner';
import {
  cancelCurrentOperation,
  cancelTranscription,
  getMediaToolsStatus,
  getPythonWhisperStatus,
  initializePythonWhisper,
  reduceNoise,
  transcribeAudio,
} from './backend/media-tools/mediaToolsRunner';

// Import runtime download manager for on-demand installation
import {
  cancelDownload,
  checkRuntimeStatus,
  downloadRuntime,
  removeRuntime,
  verifyInstallation,
} from './backend/runtime/runtimeDownloadManager';

// Import file I/O manager for controlled concurrency
import { fileIOManager } from './backend/io/FileIOManager';

// Mycelium agent runtime
import { registerMyceliumIPC } from './backend/mycelium/agentRuntime';

// Import hardware capabilities service for hybrid proxy encoding
import {
  buildArnnDenCommand,
  getDefaultModelPath,
} from './backend/ffmpeg/alternativeDenoise';
import { buildFfmpegCommand } from './backend/ffmpeg/export/commandBuilder';
import {
  buildProxyFFmpegArgs,
  buildVaapiProxyFFmpegArgs,
  detectHardwareCapabilities,
  getProxyEncoderConfig,
  getSoftwareEncoderConfig,
  type ProxyEncoderConfig,
} from './backend/hardware/hardwareCapabilitiesService';
import { backgroundTaskQueue } from './backend/io';

// Backward compatible type alias
type WhisperProgress = MediaToolsProgress;

// Import Vite dev server URL
declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string;
declare const MAIN_WINDOW_VITE_NAME: string;

// â”€â”€ GEMINI KILL SWITCH â”€â”€ flip false to re-enable
const GEMINI_DISABLED = true;

// Global variables
let mainWindow: BrowserWindow | null = null;
const forceQuit = false;
let isWindowFocused = true;
const titlebarOverlayState: {
  color: string;
  symbolColor: string;
  height?: number;
} = {
  color: '#171717',
  symbolColor: '#171717',
};
// Dynamic import of ffmpeg binaries to avoid module resolution issues
let ffmpegPath: string | null = null;
let ffprobePath: { path: string } | null = null;
let ffmpegAudioDenoiseFilter: 'arnndn' | 'afftdn' | null | undefined =
  undefined;

function getFfmpegAudioDenoiseFilter(): 'arnndn' | 'afftdn' | null {
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
    console.warn('âš ï¸ Failed to detect FFmpeg filters:', error);
    ffmpegAudioDenoiseFilter = null;
  }

  console.log('ðŸ”Ž FFmpeg denoise filter support:', ffmpegAudioDenoiseFilter);
  return ffmpegAudioDenoiseFilter;
}

// File path to open when app starts (from double-click on .dividr file)
let pendingFilePath: string | null = null;

/**
 * Get .dividr file path from command-line arguments (Windows double-click)
 */
function getFileFromArgs(args: string[] = process.argv): string | null {
  // Skip the first arg (executable path) and any electron-specific args
  const fileArgs = args.slice(1);
  for (const arg of fileArgs) {
    if (
      arg.endsWith('.dividr') &&
      !arg.startsWith('-') &&
      !arg.startsWith('--')
    ) {
      return arg;
    }
  }
  return null;
}

// Check for file argument on startup
pendingFilePath = getFileFromArgs();

// Single instance lock - ensures only one instance of the app runs
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  // Another instance is already running, quit this one
  app.quit();
} else {
  // Handle second instance launch (e.g., double-click on .dividr file while app is running)
  app.on('second-instance', (_event, commandLine) => {
    if (mainWindow) {
      // Restore and focus the existing window
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();

      // Check if a .dividr file was passed
      const filePath = getFileFromArgs(commandLine);
      if (filePath) {
        mainWindow.webContents.send('open-project-file', filePath);
      }
    }
  });
}

// macOS: Handle file opened via Finder (before app is ready)
app.on('open-file', (event, filePath) => {
  event.preventDefault();
  if (filePath.endsWith('.dividr')) {
    if (mainWindow && mainWindow.webContents) {
      mainWindow.webContents.send('open-project-file', filePath);
    } else {
      pendingFilePath = filePath;
    }
  }
});

// Background worker management for sprite sheet generation
interface SpriteSheetJob {
  id: string;
  videoPath: string;
  outputDir: string;
  commands: string[][];
  progress: {
    current: number;
    total: number;
    stage: string;
  };
  startTime: number;
}

const activeSpriteSheetJobs = new Map<string, SpriteSheetJob>();
const spriteSheetJobCounter = 0;

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

function killCurrentFfmpegProcess(reason: string): boolean {
  if (!currentFfmpegProcess || currentFfmpegProcess.killed) {
    clearCurrentFfmpegProcess();
    return false;
  }

  console.warn(`ðŸ›‘ Killing FFmpeg process (${reason})`);
  const proc = currentFfmpegProcess;
  try {
    proc.kill('SIGTERM');
  } catch (error) {
    console.warn('âš ï¸ Failed to send SIGTERM to FFmpeg:', error);
  }

  setTimeout(() => {
    if (proc && !proc.killed) {
      try {
        proc.kill('SIGKILL');
      } catch (error) {
        console.warn('âš ï¸ Failed to send SIGKILL to FFmpeg:', error);
      }
    }
    // Only clear if the global still points at the process we just killed — a new
    // ffmpeg may have started in the 2s window and must not be orphaned.
    if (currentFfmpegProcess === proc) clearCurrentFfmpegProcess();
  }, 2000);

  return true;
}

function ensureNoStaleFfmpegProcess(): void {
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
function queueFFmpegTask<T>(
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
      `ðŸ“‹ FFmpeg task queued: ${taskId} (priority ${priority}), queue length: ${ffmpegTaskQueue.length}`,
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
      `âš™ï¸ Processing FFmpeg task: ${task.id} (priority ${task.priority}), remaining: ${ffmpegTaskQueue.length}`,
    );

    try {
      await task.execute();
    } catch (error) {
      console.error(`âŒ FFmpeg task ${task.id} failed:`, error);
      // Error is already handled by the task's reject
    }
  }

  isProcessingFFmpegQueue = false;
  console.log('âœ… FFmpeg queue empty');
}

// =============================================================================

const applyTitlebarOverlay = (options?: {
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

function runQueuedFfmpeg(
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
        // Only clear if the global still points at THIS ffmpeg — a newer run may own it now.
        if (currentFfmpegProcess === ffmpeg) clearCurrentFfmpegProcess();
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
  console.log('ðŸ” Initializing FFmpeg paths...');
  console.log('ðŸ“¦ Is packaged:', app.isPackaged);
  console.log('ðŸŒ Environment:', process.env.NODE_ENV || 'production');

  // Method 1: Try ffmpeg-static first (bundled, fast, reliable)
  if (!ffmpegPath) {
    try {
      console.log('ðŸ”„ Attempting ffmpeg-static (bundled binary)...');

      // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
      const ffmpegStatic = require('ffmpeg-static');
      if (ffmpegStatic) {
        // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
        const fs = require('fs');
        if (fs.existsSync(ffmpegStatic)) {
          ffmpegPath = ffmpegStatic;
          console.log('âœ… FFmpeg resolved via ffmpeg-static:', ffmpegPath);

          // Check version to confirm it's modern
          try {
            const { execSync } = require('child_process');
            const versionOutput = execSync(`"${ffmpegStatic}" -version`, {
              encoding: 'utf8',
            });
            const versionMatch = versionOutput.match(
              /ffmpeg version (\d+)\.(\d+)/,
            );
            if (versionMatch) {
              console.log(
                `â„¹ï¸  FFmpeg version ${versionMatch[1]}.${versionMatch[2]} (bundled)`,
              );
            }
          } catch (vErr) {
            console.log(
              'â„¹ï¸  (Could not detect version, but using ffmpeg-static)',
            );
          }
        } else {
          console.log('âš ï¸ ffmpeg-static returned invalid path:', ffmpegStatic);
        }
      }
    } catch (requireError) {
      console.log('âš ï¸ ffmpeg-static not available:', requireError.message);
      console.log('â„¹ï¸  Install with: yarn add ffmpeg-static');
    }
  }

  // Method 2: Try ffbinaries as fallback (downloads latest FFmpeg on demand)
  if (!ffmpegPath) {
    try {
      console.log(
        'ðŸ”„ Attempting ffbinaries fallback (downloads FFmpeg if needed)...',
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
        console.log('âœ… FFmpeg already downloaded via ffbinaries:', ffmpegPath);
      } else {
        console.log(
          'ðŸ“¥ Downloading FFmpeg via ffbinaries (first time setup)...',
        );

        // Download FFmpeg (async operation)
        await new Promise((resolve, reject) => {
          ffbinaries.downloadBinaries(
            'ffmpeg',
            { destination: binDir },
            (err: any) => {
              if (err) {
                console.error('âŒ Failed to download FFmpeg:', err);
                reject(err);
              } else {
                ffmpegPath = expectedPath;
                console.log('âœ… FFmpeg downloaded successfully:', ffmpegPath);
                resolve(null);
              }
            },
          );
        });
      }

      // Check version
      if (ffmpegPath) {
        try {
          const { execSync } = require('child_process');
          const versionOutput = execSync(`"${ffmpegPath}" -version`, {
            encoding: 'utf8',
          });
          const versionMatch = versionOutput.match(
            /ffmpeg version (\d+)\.(\d+)/,
          );
          if (versionMatch) {
            console.log(
              `â„¹ï¸  FFmpeg version ${versionMatch[1]}.${versionMatch[2]} from ffbinaries`,
            );
          }
        } catch (vErr) {
          console.log('â„¹ï¸  (Could not detect version, but FFmpeg is ready)');
        }
      }
    } catch (error) {
      console.log('âš ï¸ ffbinaries failed:', error.message);
      console.log('â„¹ï¸  Install with: yarn add ffbinaries');
    }
  }

  // Log if no FFmpeg found yet
  if (!ffmpegPath) {
    console.log('âš ï¸ No FFmpeg binary found in standard locations');
  }

  // FFprobe require method (only for development, same issue as ffmpeg)
  if (!app.isPackaged) {
    try {
      console.log('ðŸ”„ Attempting FFprobe require method (development mode)...');
      // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
      const ffprobeStatic = require('ffprobe-static');
      if (ffprobeStatic) {
        ffprobePath = ffprobeStatic;
        console.log('âœ… FFprobe resolved via require:', ffprobePath?.path);
      }
    } catch (requireError) {
      console.log('âš ï¸ FFprobe require method failed:', requireError.message);
    }
  } else {
    console.log(
      'ðŸš« Skipping FFprobe require method for packaged app - using manual resolution',
    );
  }

  // Method 2: Manual path resolution for packaged apps (always used for packaged apps)
  if (app.isPackaged) {
    try {
      console.log('ðŸ”„ Attempting manual path resolution...');
      // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
      const path = require('path');
      // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
      const fs = require('fs');

      // Get the correct base paths for packaged apps
      const appPath = app.getAppPath();
      const resourcesPath = process.resourcesPath;
      const isWindows = process.platform === 'win32';
      const ffmpegBinary = isWindows ? 'ffmpeg.exe' : 'ffmpeg';

      console.log('ðŸ“ App path:', appPath);
      console.log('ðŸ“ Resources path:', resourcesPath);
      console.log('ðŸ–¥ï¸ Platform:', process.platform);

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
        console.log('ðŸ” Checking FFmpeg path:', testPath);
        if (fs.existsSync(testPath)) {
          ffmpegPath = testPath;
          console.log('âœ… FFmpeg found at manual path:', testPath);
          break;
        } else {
          console.log('âŒ FFmpeg not found at:', testPath);
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
        console.log('ðŸ” Checking FFprobe path:', testPath);
        if (fs.existsSync(testPath)) {
          ffprobePath = { path: testPath };
          console.log('âœ… FFprobe found at manual path:', testPath);
          break;
        } else {
          console.log('âŒ FFprobe not found at:', testPath);
        }
      }
    } catch (manualError) {
      console.log('âš ï¸ Manual path resolution failed:', manualError.message);
    }
  }

  // Method 3: System fallback
  if (!ffmpegPath) {
    try {
      console.log('ðŸ”„ Attempting system FFmpeg fallback...');
      // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
      const { execSync } = require('child_process');
      const systemFfmpeg = execSync('where ffmpeg', {
        encoding: 'utf8',
      }).trim();
      ffmpegPath = systemFfmpeg.split('\n')[0];
      console.log('âœ… Using system FFmpeg:', ffmpegPath);
    } catch (systemError) {
      console.log('âš ï¸ System FFmpeg not available:', systemError.message);
    }
  }

  if (!ffprobePath) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
      const { execSync } = require('child_process');
      const systemFfprobe = execSync('where ffprobe', {
        encoding: 'utf8',
      }).trim();
      ffprobePath = { path: systemFfprobe.split('\n')[0] };
      console.log('âœ… Using system FFprobe:', ffprobePath.path);
    } catch (systemError) {
      console.log('âš ï¸ System FFprobe not available:', systemError.message);
    }
  }

  // Final status report
  console.log('ðŸŽ¯ FFmpeg initialization complete:');
  console.log(
    '  - FFmpeg available:',
    !!ffmpegPath,
    ffmpegPath ? `(${ffmpegPath})` : '',
  );
  console.log(
    '  - FFprobe available:',
    !!ffprobePath?.path,
    ffprobePath?.path ? `(${ffprobePath.path})` : '',
  );

  if (!ffmpegPath || !ffprobePath?.path) {
    console.error('âŒ FFmpeg initialization failed!');
    console.error(
      'ðŸ“‹ Please ensure ffmpeg-static and ffprobe-static packages are installed correctly',
    );
    console.error('ðŸ“‹ Or install FFmpeg system-wide as a fallback');
  }
}

if (started) {
  app.quit();
}

// Startup timing logs removed for production cleanliness
const logStartupPerf = (..._args: unknown[]): void => {
  // no-op
};

let deferredInitStarted = false;
const kickoffDeferredInitialization = () => {
  if (deferredInitStarted) return;
  deferredInitStarted = true;

  setTimeout(() => {
    initializeFfmpegPaths()
      .then(() => logStartupPerf())
      .catch((error) => {
        console.error('âš ï¸ FFmpeg init failed (non-blocking):', error);
      });
  }, 0);
};

const ensurePythonInitialized = async (_reason: string): Promise<void> => {
  if (getPythonWhisperStatus().available) return;

  try {
    await initializePythonWhisper();
  } catch (error) {
    console.error('âš ï¸ Python Whisper initialization failed:', error);
    throw error;
  }
};

// Create a simple HTTP server to serve media files
let mediaServer: http.Server | null = null;
const MEDIA_SERVER_PORT = 3001;
const MEDIA_CACHE_DIR_NAME = 'media-cache';
const MEDIA_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const TEMP_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 1 day
const MEDIA_CACHE_CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
let mediaCacheDir: string | null = null;
let mediaCacheCleanupTimer: NodeJS.Timeout | null = null;

function getMediaCacheDir(): string {
  if (mediaCacheDir) return mediaCacheDir;
  const baseDir = path.join(app.getPath('userData'), MEDIA_CACHE_DIR_NAME);
  try {
    if (!fs.existsSync(baseDir)) {
      fs.mkdirSync(baseDir, { recursive: true });
    }
  } catch (error) {
    console.warn('âš ï¸ Failed to ensure media cache directory:', error);
  }
  mediaCacheDir = baseDir;
  return mediaCacheDir;
}

// Baked-effect outputs (speed, reverse, facezoom, rack focus, …) are app-internal
// working files, NEVER user deliverables — they must live in app storage, not
// next to the user's source footage (which put them in Downloads).
let bakedDir: string | null = null;
function getBakedDir(): string {
  if (bakedDir) return bakedDir;
  const dir = path.join(app.getPath('userData'), 'baked');
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  } catch (error) {
    console.warn('Failed to ensure baked directory:', error);
  }
  bakedDir = dir;
  return bakedDir;
}

function resolveMediaPath(input: string): string | null {
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
      console.warn('âš ï¸ Failed to parse media URL:', error);
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

function cleanupMediaCache(): void {
  const baseDir = getMediaCacheDir();
  if (!fs.existsSync(baseDir)) return;

  const now = Date.now();

  const pruneDir = (dirPath: string, ttlMs: number): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        pruneDir(fullPath, ttlMs);
        // Remove empty directories
        try {
          if (fs.readdirSync(fullPath).length === 0) {
            fs.rmdirSync(fullPath);
          }
        } catch {
          // Ignore cleanup errors
        }
      } else {
        try {
          const stats = fs.statSync(fullPath);
          if (now - stats.mtimeMs > ttlMs) {
            fs.unlinkSync(fullPath);
          }
        } catch {
          // Ignore cleanup errors
        }
      }
    }
  };

  pruneDir(baseDir, MEDIA_CACHE_TTL_MS);

  const tempDirs = [
    path.join(os.tmpdir(), 'dividr-audio-extracts'),
    path.join(os.tmpdir(), 'dividr-transcode'),
  ];

  for (const tempDir of tempDirs) {
    if (fs.existsSync(tempDir)) {
      pruneDir(tempDir, TEMP_CACHE_TTL_MS);
    }
  }
}

function startMediaCacheCleanup(): void {
  if (mediaCacheCleanupTimer) return;
  cleanupMediaCache();
  mediaCacheCleanupTimer = setInterval(
    cleanupMediaCache,
    MEDIA_CACHE_CLEANUP_INTERVAL_MS,
  );
}

function createMediaServer() {
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
      console.error('Error parsing media server URL:', error);
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
          console.error('Error streaming file:', streamError);
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
          console.error('Error streaming file:', streamError);
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
      console.error('Error serving file:', error);
      setCorsHeaders(res);
      res.writeHead(500);
      res.end('Internal server error');
    }
  });

  mediaServer.listen(MEDIA_SERVER_PORT, 'localhost', () => {
    console.log(
      `ðŸ“ Media server started on http://localhost:${MEDIA_SERVER_PORT}`,
    );
    logStartupPerf();
  });

  mediaServer.on('error', (error) => {
    console.error('Media server error:', error);
  });
}

// Test-only: expose the renderer over CDP so Playwright can drive a real session
// (real EDITH + real python bakes). Gated by an env var; no effect in normal use.
if (process.env.DIVIDR_CDP) {
  app.commandLine.appendSwitch('remote-debugging-port', process.env.DIVIDR_CDP);
  app.commandLine.appendSwitch('remote-allow-origins', '*');
}

// Start media server when app is ready
app.whenReady().then(() => {
  createMediaServer();
  startMediaCacheCleanup();
});

// IPC Handler for opening file dialog
ipcMain.handle(
  'open-file-dialog',
  async (
    event,
    options?: {
      title?: string;
      filters?: Array<{ name: string; extensions: string[] }>;
      properties?: Array<'openFile' | 'openDirectory' | 'multiSelections'>;
    },
  ) => {
    try {
      const result = await dialog.showOpenDialog({
        title: options?.title || 'Select Media Files',
        properties: options?.properties || ['openFile', 'multiSelections'],
        filters: options?.filters || [
          {
            name: 'Media Files',
            extensions: [
              'mp4',
              'avi',
              'mov',
              'mkv',
              'mp3',
              'wav',
              'aac',
              'jpg',
              'jpeg',
              'png',
              'gif',
            ],
          },
          {
            name: 'Video Files',
            extensions: ['mp4', 'avi', 'mov', 'mkv', 'webm', 'wmv', 'flv'],
          },
          {
            name: 'Audio Files',
            extensions: ['mp3', 'wav', 'aac', 'flac', 'ogg', 'm4a'],
          },
          {
            name: 'Image Files',
            extensions: ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'tiff'],
          },
          { name: 'All Files', extensions: ['*'] },
        ],
      });

      if (!result.canceled && result.filePaths.length > 0) {
        // Get file info for each selected file
        const fileInfos = result.filePaths.map((filePath) => {
          const stats = fs.statSync(filePath);
          const fileName = path.basename(filePath);
          const ext = path.extname(fileName).toLowerCase().slice(1);

          // Determine file type based on extension
          let type: 'video' | 'audio' | 'image' = 'video';
          if (['mp3', 'wav', 'aac', 'flac', 'ogg', 'm4a'].includes(ext)) {
            type = 'audio';
          } else if (
            ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'tiff'].includes(ext)
          ) {
            type = 'image';
          }

          return {
            path: filePath,
            name: fileName,
            size: stats.size,
            type,
            extension: ext,
          };
        });

        return { success: true, files: fileInfos };
      } else {
        return { success: false, canceled: true };
      }
    } catch (error) {
      return { success: false, error: error.message };
    }
  },
);

// IPC Handler for save dialog
ipcMain.handle(
  'show-save-dialog',
  async (
    event,
    options?: {
      title?: string;
      defaultPath?: string;
      buttonLabel?: string;
      filters?: Array<{ name: string; extensions: string[] }>;
    },
  ) => {
    try {
      const result = await dialog.showSaveDialog({
        title: options?.title || 'Save Video As',
        defaultPath:
          options?.defaultPath || path.join(os.homedir(), 'Downloads'),
        buttonLabel: options?.buttonLabel || 'Save',
        filters: options?.filters || [
          {
            name: 'Video Files',
            extensions: ['mp4', 'avi', 'mov', 'mkv', 'webm', 'wmv'],
          },
          {
            name: 'All Files',
            extensions: ['*'],
          },
        ],
      });

      if (result.canceled) {
        return { success: false, canceled: true };
      }

      return {
        success: true,
        filePath: result.filePath,
        directory: path.dirname(result.filePath || ''),
        filename: path.basename(result.filePath || ''),
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  },
);

// IPC Handler for getting downloads directory
ipcMain.handle('get-downloads-directory', async () => {
  try {
    return {
      success: true,
      path: path.join(os.homedir(), 'Downloads'),
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// IPC Handler for writing a subtitle/text export file (.srt, .vtt, chapters .txt).
// Backs the long-declared preload `writeSubtitleFile` contract — used by the
// SRT caption export and the YouTube chapters export.
ipcMain.handle(
  'write-subtitle-file',
  async (
    _event,
    options: { content: string; filename: string; outputPath?: string },
  ) => {
    try {
      if (!options?.filename || typeof options.content !== 'string') {
        return { success: false, error: 'filename and content are required' };
      }
      const dir =
        options.outputPath && options.outputPath.trim()
          ? options.outputPath
          : path.join(os.homedir(), 'Downloads');
      fs.mkdirSync(dir, { recursive: true });
      // Strip path separators/illegal chars — filename only, never a path
      const illegal = '<>:"/\\|?*';
      const safeName = Array.from(options.filename)
        .map((ch) => (ch.charCodeAt(0) < 32 || illegal.includes(ch) ? '_' : ch))
        .join('');
      const filePath = path.join(dir, safeName);
      fs.writeFileSync(filePath, options.content, 'utf8');
      return { success: true, filePath };
    } catch (error) {
      return { success: false, error: error.message };
    }
  },
);

// IPC Handler for showing file in folder/explorer
ipcMain.handle('show-item-in-folder', async (event, filePath: string) => {
  try {
    if (!filePath) {
      return { success: false, error: 'No file path provided' };
    }

    // Check if file exists
    if (!fs.existsSync(filePath)) {
      return { success: false, error: 'File not found' };
    }

    // Show item in folder (works cross-platform)
    shell.showItemInFolder(filePath);

    console.log('ðŸ“‚ Opened file location:', filePath);
    return { success: true };
  } catch (error) {
    console.error('Failed to show file in folder:', error);
    return { success: false, error: error.message };
  }
});

// IPC Handler for FFmpeg operations (backward compatibility)
ipcMain.handle('run-ffmpeg', async (event, job: VideoEditJob) => {
  try {
    const result = await runFfmpeg(job);
    return { success: true, result };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Enhanced IPC Handler for FFmpeg operations with real-time progress
ipcMain.handle('run-ffmpeg-with-progress', async (event, job: VideoEditJob) => {
  try {
    const result = await runFfmpegWithProgress(job, {
      onProgress: (progress) => {
        // Send progress updates to renderer process
        event.sender.send('ffmpeg-progress', progress);
      },
      onStatus: (status) => {
        // Send status updates to renderer process
        event.sender.send('ffmpeg-status', status);
      },
      onLog: (log, type) => {
        // Send log updates to renderer process
        event.sender.send('ffmpeg-log', { log, type });
      },
    });

    // Send completion event
    event.sender.send('ffmpeg-complete', { success: true, result });
    return { success: true, result };
  } catch (error) {
    // Send error event
    event.sender.send('ffmpeg-complete', {
      success: false,
      error: error.message,
    });
    return { success: false, error: error.message };
  }
});

// IPC Handler for audio extraction from video files
// Uses PRIORITY 1 (highest) in FFmpeg queue - audio extraction should complete before sprite sheets
ipcMain.handle(
  'extract-audio-from-video',
  async (event, videoPath: string, outputDir?: string) => {
    console.log('ðŸŽµ MAIN PROCESS: extractAudioFromVideo handler called!');
    console.log('ðŸŽµ MAIN PROCESS: Video path:', videoPath);

    if (!ffmpegPath) {
      return {
        success: false,
        error:
          'FFmpeg binary not available. Please ensure ffmpeg-static is properly installed.',
      };
    }

    // Use priority queue with HIGHEST priority (1) for audio extraction
    // This ensures audio extracts before sprite sheets to prevent waveform delays
    return (async () => {
      // Create a unique output directory for extracted audio files.
      // MUST be persistent (userData), NOT os.tmpdir(): extracted audio is referenced
      // by saved projects indefinitely, and the temp cleanup prunes tmpdir files after
      // 1 day. Storing here previously caused saved projects to lose audio (video kept
      // playing because the video uses the user's original file; audio is a separate
      // extracted track) once the temp WAV was pruned.
      const audioOutputDir =
        outputDir || path.join(app.getPath('userData'), 'audio-extracts');

      // Use fileIOManager for directory creation with EMFILE protection
      await fileIOManager.mkdir(audioOutputDir, 'normal');
      console.log('ðŸ“ Audio extraction directory ready:', audioOutputDir);

      // Generate unique filename for extracted audio
      const videoBaseName = path.basename(videoPath, path.extname(videoPath));
      const timestamp = Date.now();
      const audioFileName = `${videoBaseName}_${timestamp}_extracted.wav`;
      const audioOutputPath = path.join(audioOutputDir, audioFileName);

      console.log('ðŸŽµ Extracting audio to:', audioOutputPath);

      // FFmpeg command to extract audio with high quality
      const args = [
        '-i',
        videoPath, // Input video file
        '-vn', // No video (audio only)
        '-acodec',
        'pcm_s16le', // Uncompressed PCM audio codec for quality
        '-ar',
        '44100', // Sample rate: 44.1kHz (CD quality)
        '-ac',
        '2', // Stereo (2 channels)
        '-y', // Overwrite output file if exists
        audioOutputPath, // Output audio file
      ];

      console.log('ðŸŽ¬ AUDIO EXTRACTION FFMPEG COMMAND:');
      console.log(['ffmpeg', ...args].join(' '));

      const ffmpegResult = await runQueuedFfmpeg(args, {
        priority: 1,
        timeoutMs: 5 * 60 * 1000, // 5 minutes
        onStdout: (text) =>
          console.log(`[Audio Extract stdout] ${text.trim()}`),
        onStderr: (text) =>
          console.log(`[Audio Extract stderr] ${text.trim()}`),
      });

      if (ffmpegResult.timedOut) {
        return {
          success: false,
          error: 'Audio extraction timed out',
        };
      }

      if (ffmpegResult.code === 0) {
        try {
          // Verify that the audio file was created and has content
          // Use async stat with retry for EMFILE protection
          let stats: fs.Stats | null = null;
          let lastError: Error | null = null;

          for (let attempt = 1; attempt <= 3; attempt++) {
            try {
              stats = fs.statSync(audioOutputPath);
              break;
            } catch (statErr) {
              lastError = statErr as Error;
              if (isEMFILEError(statErr) && attempt < 3) {
                console.warn(
                  `âš ï¸ EMFILE during audio file verification, retry ${attempt}/3`,
                );
                await new Promise((r) => setTimeout(r, 500 * attempt));
              } else {
                throw statErr;
              }
            }
          }

          if (stats && stats.size > 0) {
            // Create preview URL for the extracted audio
            // Use the same logic as the create-preview-url handler
            const previewUrl = `http://localhost:${MEDIA_SERVER_PORT}/${encodeURIComponent(audioOutputPath)}`;

            console.log('âœ… Audio extraction successful!');
            console.log('ðŸ“ Audio file path:', audioOutputPath);
            console.log('ðŸ“ Audio file size:', stats.size, 'bytes');

            return {
              success: true,
              audioPath: audioOutputPath,
              previewUrl,
              size: stats.size,
              message: 'Audio extracted successfully',
            };
          }

          console.error('âŒ Audio file was created but is empty');
          return {
            success: false,
            error: 'Audio extraction failed: output file is empty',
          };
        } catch (statError) {
          const errorMessage =
            statError instanceof Error ? statError.message : 'Unknown error';
          console.error(
            'âŒ Failed to verify extracted audio file:',
            errorMessage,
          );

          // Provide helpful EMFILE message
          if (isEMFILEError(statError)) {
            return {
              success: false,
              error:
                'System file limit reached during audio verification. Please try again.',
            };
          }

          return {
            success: false,
            error: `Audio extraction failed: ${errorMessage}`,
          };
        }
      }

      console.error(
        'âŒ Audio extraction failed with exit code:',
        ffmpegResult.code,
      );
      return {
        success: false,
        error: `Audio extraction failed with exit code ${ffmpegResult.code}: ${ffmpegResult.stderr}`,
      };
    })();
  },
);

// IPC Handler for custom FFmpeg commands (specifically for thumbnail extraction)
// Uses PRIORITY 3 (lowest) in FFmpeg queue - thumbnails should yield to audio extraction
ipcMain.handle(
  'run-custom-ffmpeg',
  async (event, args: string[], outputDir: string) => {
    console.log('ðŸŽ¯ MAIN PROCESS: runCustomFFmpeg handler called!');
    console.log('ðŸŽ¯ MAIN PROCESS: FFmpeg args:', args);
    console.log('ðŸŽ¯ MAIN PROCESS: Output directory:', outputDir);

    if (!ffmpegPath) {
      return {
        success: false,
        error:
          'FFmpeg binary not available. Please ensure ffmpeg-static is properly installed.',
      };
    }

    // Ensure output directory exists using fileIOManager for EMFILE protection
    const hasOutputDir = !!outputDir && outputDir.trim().length > 0;
    const absoluteOutputDir = hasOutputDir
      ? path.isAbsolute(outputDir)
        ? outputDir
        : path.resolve(outputDir)
      : '';

    try {
      if (hasOutputDir) {
        await fileIOManager.mkdir(absoluteOutputDir, 'high');
        console.log('ðŸ“ Output directory ready:', absoluteOutputDir);
      }
    } catch (dirError) {
      const errorMessage =
        dirError instanceof Error ? dirError.message : 'Unknown error';
      console.error('âŒ Failed to create output directory:', errorMessage);

      if (isEMFILEError(dirError)) {
        return {
          success: false,
          error: 'System file limit reached. Please wait and try again.',
        };
      }

      return {
        success: false,
        error: `Failed to create output directory: ${errorMessage}`,
      };
    }

    // Update output path in args to use absolute path
    const finalArgs = hasOutputDir
      ? args.map((arg) => {
          if (arg.includes(outputDir) && !path.isAbsolute(arg)) {
            return arg.replace(outputDir, absoluteOutputDir);
          }
          return arg;
        })
      : args;

    console.log('ðŸŽ¬ COMPLETE CUSTOM FFMPEG COMMAND:');
    console.log(['ffmpeg', ...finalArgs].join(' '));

    // Use priority queue with LOWEST priority (3) for thumbnail extraction
    const ffmpegResult = await runQueuedFfmpeg(finalArgs, {
      priority: 3,
      timeoutMs: 10 * 60 * 1000, // 10 minutes
      onStdout: (text) => console.log(`[FFmpeg stdout] ${text.trim()}`),
      onStderr: (text) => console.log(`[FFmpeg stderr] ${text.trim()}`),
    });

    if (ffmpegResult.timedOut) {
      return {
        success: false,
        error: 'FFmpeg process timed out',
      };
    }

    console.log(`ðŸŽ¬ FFmpeg process exited with code: ${ffmpegResult.code}`);

    if (ffmpegResult.code === 0) {
      if (!hasOutputDir) {
        return { success: true, output: [] };
      }
      // List generated files
      try {
        const outputFiles = fs
          .readdirSync(absoluteOutputDir)
          .filter((file) => file.startsWith('thumb_') && file.endsWith('.jpg'))
          .sort();

        console.log(
          `âœ… Generated ${outputFiles.length} thumbnail files:`,
          outputFiles,
        );

        return {
          success: true,
          output: outputFiles,
        };
      } catch (listError) {
        console.error('âŒ Error listing output files:', listError);
        return {
          success: false,
          error: `FFmpeg succeeded but failed to list output files: ${listError.message}`,
        };
      }
    }

    console.error(`âŒ FFmpeg failed with exit code: ${ffmpegResult.code}`);
    return {
      success: false,
      error: `FFmpeg process failed with exit code ${ffmpegResult.code}. stderr: ${ffmpegResult.stderr}`,
    };
  },
);

// IPC Handler for background sprite sheet generation
ipcMain.handle(
  'generate-sprite-sheet-background',
  async (
    event,
    options: {
      jobId: string;
      videoPath: string;
      outputDir: string;
      commands: string[][];
    },
  ) => {
    const { jobId, videoPath, outputDir, commands } = options;

    console.log('ðŸŽ¬ Starting background sprite sheet generation:', jobId);
    console.log('ðŸ“¹ Video:', videoPath);
    console.log('ðŸ“ Output:', outputDir);
    console.log('ðŸ”§ Commands:', commands.length);

    if (!ffmpegPath) {
      return {
        success: false,
        error:
          'FFmpeg binary not available. Please ensure ffmpeg-static is properly installed.',
      };
    }

    // Check if job already exists
    if (activeSpriteSheetJobs.has(jobId)) {
      return {
        success: false,
        error: 'Job already in progress',
      };
    }

    // Create job entry
    const job: SpriteSheetJob = {
      id: jobId,
      videoPath,
      outputDir,
      commands,
      progress: {
        current: 0,
        total: commands.length,
        stage: 'Starting...',
      },
      startTime: Date.now(),
    };

    activeSpriteSheetJobs.set(jobId, job);

    // Process commands sequentially in background
    processSpriteSheetsInBackground(jobId, job);

    return {
      success: true,
      jobId,
      message: 'Sprite sheet generation started in background',
    };
  },
);

// IPC Handler to get sprite sheet job progress
ipcMain.handle('get-sprite-sheet-progress', async (event, jobId: string) => {
  const job = activeSpriteSheetJobs.get(jobId);
  if (!job) {
    return {
      success: false,
      error: 'Job not found',
    };
  }

  return {
    success: true,
    progress: job.progress,
    elapsedTime: Date.now() - job.startTime,
  };
});

// IPC Handler to cancel sprite sheet generation
ipcMain.handle('cancel-sprite-sheet-job', async (event, jobId: string) => {
  const job = activeSpriteSheetJobs.get(jobId);
  if (!job) {
    return {
      success: false,
      error: 'Job not found',
    };
  }

  activeSpriteSheetJobs.delete(jobId);

  console.log('ðŸ›‘ Cancelled sprite sheet job:', jobId);
  return {
    success: true,
    message: 'Job cancelled',
  };
});

// Background sprite sheet processing function
async function processSpriteSheetsInBackground(
  jobId: string,
  job: SpriteSheetJob,
) {
  try {
    // Ensure output directory exists using fileIOManager for EMFILE protection
    const absoluteOutputDir = path.isAbsolute(job.outputDir)
      ? job.outputDir
      : path.resolve(job.outputDir);

    await fileIOManager.mkdir(absoluteOutputDir, 'normal');
    console.log('ðŸ“ Sprite sheet output directory ready:', absoluteOutputDir);

    // Process each command sequentially
    for (let i = 0; i < job.commands.length; i++) {
      const currentJob = activeSpriteSheetJobs.get(jobId);
      if (!currentJob) {
        console.log('ðŸ›‘ Job cancelled during processing:', jobId);
        return;
      }

      const command = job.commands[i];
      const adjustedCommand = command.map((arg) => {
        if (arg.includes(job.outputDir) && !path.isAbsolute(arg)) {
          return arg.replace(job.outputDir, absoluteOutputDir);
        }
        return arg;
      });

      // Update progress
      currentJob.progress = {
        current: i,
        total: job.commands.length,
        stage: `Generating sprite sheet ${i + 1}/${job.commands.length}`,
      };

      console.log(
        `ðŸŽ¬ Processing sprite sheet ${i + 1}/${job.commands.length} for job ${jobId}`,
      );
      console.log(
        'ðŸ”§ FFmpeg command:',
        ['ffmpeg', ...adjustedCommand].join(' '),
      );

      // Execute FFmpeg command with improved error handling and timeout
      // Uses PRIORITY 3 (lowest) in FFmpeg queue - sprite sheets should yield to audio extraction
      // Set adaptive timeout based on video complexity
      const timeoutMs = Math.min(300000, 60000 + i * 60000); // Max 5 minutes, min 1 minute + 1 minute per sheet
      const ffmpegResult = await runQueuedFfmpeg(adjustedCommand, {
        priority: 3,
        timeoutMs,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });

      const result: { success: boolean; error?: string } = {
        success: false,
      };

      if (ffmpegResult.timedOut) {
        result.success = false;
        result.error = `FFmpeg process timed out after ${timeoutMs / 1000} seconds`;
      } else if (ffmpegResult.code === 0) {
        console.log(`âœ… Sprite sheet ${i + 1} generated successfully`);

        // Progressive loading: Notify renderer that this sheet is ready
        if (mainWindow) {
          mainWindow.webContents.send('sprite-sheet-sheet-ready', {
            jobId,
            sheetIndex: i,
            totalSheets: job.commands.length,
            sheetPath: path.join(
              absoluteOutputDir,
              `sprite_${i.toString().padStart(3, '0')}.jpg`,
            ),
          });
        }

        result.success = true;
      } else {
        console.error(
          `âŒ Sprite sheet ${i + 1} failed with exit code: ${ffmpegResult.code}`,
        );
        // Try to extract meaningful error from stderr
        const errorMatch =
          ffmpegResult.stderr.match(/Error: (.+)/i) ||
          ffmpegResult.stderr.match(/\[error\] (.+)/i);
        const meaningfulError = errorMatch
          ? errorMatch[1]
          : `Process failed with code ${ffmpegResult.code}`;
        result.success = false;
        result.error = `FFmpeg: ${meaningfulError}`;
      }

      if (!result.success) {
        console.error(
          `âŒ Failed to generate sprite sheet ${i + 1}/${job.commands.length}:`,
          result.error,
        );

        // Update job with error
        currentJob.progress.stage = `Failed at sheet ${i + 1}: ${result.error}`;

        // Notify renderer about error with more context
        if (mainWindow) {
          mainWindow.webContents.send('sprite-sheet-job-error', {
            jobId,
            error: `Sheet ${i + 1}/${job.commands.length}: ${result.error}`,
            sheetIndex: i,
            totalSheets: job.commands.length,
          });
        }

        activeSpriteSheetJobs.delete(jobId);
        return;
      }

      console.log(
        `âœ… Successfully generated sprite sheet ${i + 1}/${job.commands.length}`,
      );
    }

    // Job completed successfully
    const finalJob = activeSpriteSheetJobs.get(jobId);
    if (finalJob) {
      finalJob.progress = {
        current: job.commands.length,
        total: job.commands.length,
        stage: 'Completed',
      };

      // List generated files with EMFILE retry
      try {
        let outputFiles: string[] = [];
        let lastError: Error | null = null;

        // Retry logic for EMFILE protection
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            outputFiles = fs
              .readdirSync(absoluteOutputDir)
              .filter(
                (file: string) =>
                  file.startsWith('sprite_') && file.endsWith('.jpg'),
              )
              .sort();
            break;
          } catch (err) {
            lastError = err as Error;
            if (isEMFILEError(err) && attempt < 3) {
              console.warn(
                `âš ï¸ EMFILE listing sprite sheet files, retry ${attempt}/3`,
              );
              await new Promise((r) => setTimeout(r, 500 * attempt));
            } else {
              throw err;
            }
          }
        }

        console.log(
          `âœ… Generated ${outputFiles.length} sprite sheet files for job ${jobId}`,
        );

        // Notify renderer about completion
        if (mainWindow) {
          mainWindow.webContents.send('sprite-sheet-job-completed', {
            jobId,
            outputFiles,
            outputDir: absoluteOutputDir,
          });
        }
      } catch (listError) {
        const errorMessage =
          listError instanceof Error ? listError.message : 'Unknown error';
        console.error(
          'âŒ Error listing sprite sheet output files:',
          errorMessage,
        );
      }

      activeSpriteSheetJobs.delete(jobId);
    }
  } catch (error) {
    console.error('âŒ Background sprite sheet processing error:', error);

    // Notify renderer about error
    if (mainWindow) {
      mainWindow.webContents.send('sprite-sheet-job-error', {
        jobId,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }

    activeSpriteSheetJobs.delete(jobId);
  }
}

// IPC Handler to cancel FFmpeg operation
ipcMain.handle('cancel-ffmpeg', async () => {
  try {
    const cancelled = killCurrentFfmpegProcess('user-cancel');
    if (cancelled) {
      return {
        success: true,
        message: 'FFmpeg process cancelled successfully',
      };
    } else {
      return { success: false, message: 'No active FFmpeg process to cancel' };
    }
  } catch (error) {
    return { success: false, message: `Failed to cancel: ${error.message}` };
  }
});

// Helper function to check for EMFILE errors
function isEMFILEError(error: unknown): boolean {
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

// Helper function to write file with EMFILE retry
async function writeFileWithRetry(
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
          `âš ï¸ EMFILE error writing ${filePath}, retry ${attempt}/${maxRetries}`,
        );
        // Exponential backoff
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

// IPC Handler for processing dropped files by writing them to temp location
// Uses controlled concurrency to prevent EMFILE errors
ipcMain.handle(
  'process-dropped-files',
  async (
    event,
    fileBuffers: Array<{
      name: string;
      type: string;
      size: number;
      buffer: ArrayBuffer;
    }>,
  ) => {
    try {
      console.log(
        `ðŸŽ¯ Processing ${fileBuffers.length} dropped files in main process (controlled concurrency)`,
      );

      const tempDir = path.join(os.tmpdir(), 'dividr-uploads');

      // Ensure temp directory exists using the file IO manager
      await fileIOManager.mkdir(tempDir, 'high');

      const processedFiles: Array<{
        name: string;
        originalName: string;
        type: 'video' | 'audio' | 'image';
        size: number;
        extension: string;
        path: string;
        hasPath: boolean;
        isTemporary: boolean;
      }> = [];

      const errors: string[] = [];

      // Process files in batches to prevent EMFILE
      const BATCH_SIZE = 3;
      const totalFiles = fileBuffers.length;

      for (
        let batchStart = 0;
        batchStart < totalFiles;
        batchStart += BATCH_SIZE
      ) {
        const batchEnd = Math.min(batchStart + BATCH_SIZE, totalFiles);
        const batch = fileBuffers.slice(batchStart, batchEnd);

        console.log(
          `ðŸ“ Processing batch ${Math.floor(batchStart / BATCH_SIZE) + 1}/${Math.ceil(totalFiles / BATCH_SIZE)} (files ${batchStart + 1}-${batchEnd} of ${totalFiles})`,
        );

        // Process batch in parallel (within concurrency limits)
        const batchPromises = batch.map(async (fileData, batchIndex) => {
          const globalIndex = batchStart + batchIndex;

          try {
            // Create a unique filename to avoid conflicts
            const timestamp = Date.now();
            const random = Math.random().toString(36).substring(2, 8);
            const ext = path.extname(fileData.name);
            const baseName = path.basename(fileData.name, ext);
            const uniqueFileName = `${baseName}_${timestamp}_${random}${ext}`;
            const tempFilePath = path.join(tempDir, uniqueFileName);

            // Write the file buffer using controlled I/O manager
            const buffer = Buffer.from(fileData.buffer);
            await writeFileWithRetry(tempFilePath, buffer);

            // Determine file type based on extension
            const extension = ext.toLowerCase().slice(1);
            let type: 'video' | 'audio' | 'image' = 'video';
            if (
              ['mp3', 'wav', 'aac', 'flac', 'ogg', 'm4a'].includes(extension)
            ) {
              type = 'audio';
            } else if (
              ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'tiff', 'webp'].includes(
                extension,
              )
            ) {
              type = 'image';
            }

            console.log(
              `âœ… [${globalIndex + 1}/${totalFiles}] Wrote: ${fileData.name} -> ${tempFilePath}`,
            );

            return {
              success: true as const,
              file: {
                name: fileData.name,
                originalName: fileData.name,
                type,
                size: fileData.size,
                extension,
                path: tempFilePath,
                hasPath: true,
                isTemporary: true,
              },
            };
          } catch (error) {
            const errorMessage =
              error instanceof Error ? error.message : 'Unknown error';
            console.error(
              `âŒ [${globalIndex + 1}/${totalFiles}] Failed to write: ${fileData.name}:`,
              errorMessage,
            );

            return {
              success: false as const,
              error: `Failed to process ${fileData.name}: ${errorMessage}`,
            };
          }
        });

        // Wait for batch to complete
        const batchResults = await Promise.all(batchPromises);

        // Collect results
        for (const result of batchResults) {
          if (result.success) {
            processedFiles.push(result.file);
          } else {
            errors.push(result.error);
          }
        }

        // Small delay between batches to allow system to recover
        if (batchEnd < totalFiles) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }

      // Log file I/O stats
      const stats = fileIOManager.getStats();
      console.log(
        `ðŸ“Š File I/O Stats - Completed: ${stats.completedOperations}, Failed: ${stats.failedOperations}, EMFILE errors: ${stats.emfileErrors}`,
      );

      if (processedFiles.length === 0 && errors.length > 0) {
        return {
          success: false,
          error: errors.join('; '),
          files: [],
        };
      }

      return {
        success: true,
        files: processedFiles,
        errors: errors.length > 0 ? errors : undefined,
        stats: {
          total: totalFiles,
          processed: processedFiles.length,
          failed: errors.length,
        },
      };
    } catch (error) {
      console.error('Failed to process dropped files:', error);
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      return { success: false, error: errorMessage };
    }
  },
);

// IPC Handler for cleaning up temporary files with controlled concurrency
ipcMain.handle('cleanup-temp-files', async (event, filePaths: string[]) => {
  try {
    let cleanedCount = 0;
    const errors: string[] = [];

    // Process deletions in batches to avoid EMFILE
    const BATCH_SIZE = 5;

    for (let i = 0; i < filePaths.length; i += BATCH_SIZE) {
      const batch = filePaths.slice(i, i + BATCH_SIZE);

      const batchPromises = batch.map(async (filePath) => {
        try {
          if (
            fileIOManager.exists(filePath) &&
            filePath.includes('dividr-uploads')
          ) {
            await fileIOManager.deleteFile(filePath, 'low');
            console.log(`ðŸ—‘ï¸ Cleaned up temporary file: ${filePath}`);
            return true;
          }
          return false;
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : 'Unknown error';
          console.warn(`âš ï¸ Failed to cleanup file ${filePath}:`, errorMessage);
          errors.push(`${path.basename(filePath)}: ${errorMessage}`);
          return false;
        }
      });

      const results = await Promise.all(batchPromises);
      cleanedCount += results.filter(Boolean).length;
    }

    return {
      success: true,
      cleanedCount,
      errors: errors.length > 0 ? errors : undefined,
    };
  } catch (error) {
    console.error('Failed to cleanup temporary files:', error);
    const errorMessage =
      error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: errorMessage };
  }
});

// ─── SFX Library ────────────────────────────────────────────────────────────

function loadSfxLibraryPath(): string {
  const envPath = path.join(app.getAppPath(), '.env');
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const [k, v] = line.split('=');
      if (k?.trim() === 'SFX_LIBRARY_PATH') return v?.trim() ?? '';
    }
  }
  return process.env.SFX_LIBRARY_PATH ?? '';
}

async function getAudioDurationSec(filePath: string): Promise<number> {
  return new Promise((resolve) => {
    const probe = spawn(ffprobePath.path, [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'json',
      filePath,
    ]);
    let out = '';
    probe.stdout.on('data', (d) => { out += d.toString(); });
    probe.on('close', () => {
      try {
        const parsed = JSON.parse(out);
        resolve(parseFloat(parsed?.format?.duration ?? '0') || 0);
      } catch {
        resolve(0);
      }
    });
    probe.on('error', () => resolve(0));
  });
}

function parseSfxCategories(filename: string): string[] {
  // "ES_User Interface, Click, Button Click, Input Response, Tap, Short - Epidemic Sound.mp3"
  // Strip prefix and suffix, split by comma
  const inner = filename
    .replace(/^ES_User Interface, /i, '')
    .replace(/ - Epidemic Sound\.(mp3|wav)$/i, '');
  return inner.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 4);
}

async function detectSfxBounds(filePath: string, totalDuration: number): Promise<{ audioStartSec: number; audioEndSec: number }> {
  // Use ffmpeg silencedetect to find where actual audio starts/ends
  // -50dB threshold, minimum 0.02s silence — catches leading/trailing pad in SFX files
  let ffmpegBin = 'ffmpeg';
  try { const s = require('ffmpeg-static') as string; if (s) ffmpegBin = s; } catch {}
  try {
    const { stderr } = await execAsync(
      `"${ffmpegBin}" -i "${filePath}" -af silencedetect=n=-50dB:d=0.02 -f null -`,
      { timeout: 5000 },
    );
    const lines = stderr.split('\n');
    let audioStart = 0;
    let audioEnd = totalDuration;
    // First silence_end = where audio starts (after leading silence)
    for (const line of lines) {
      const endMatch = line.match(/silence_end: ([\d.]+)/);
      if (endMatch) { audioStart = parseFloat(endMatch[1]); break; }
    }
    // Last silence_start = where audio ends (before trailing silence)
    for (let i = lines.length - 1; i >= 0; i--) {
      const startMatch = lines[i].match(/silence_start: ([\d.]+)/);
      if (startMatch) { audioEnd = parseFloat(startMatch[1]); break; }
    }
    // Sanity: if bounds are inverted or too tight, fall back to full duration
    if (audioStart >= audioEnd || (audioEnd - audioStart) < 0.05) {
      return { audioStartSec: 0, audioEndSec: totalDuration };
    }
    return { audioStartSec: audioStart, audioEndSec: audioEnd };
  } catch {
    return { audioStartSec: 0, audioEndSec: totalDuration };
  }
}

ipcMain.handle('scan-sfx-library', async () => {
  const libPath = loadSfxLibraryPath();
  if (!libPath || !fs.existsSync(libPath)) {
    return { entries: [], libPath: libPath || '(not configured — set SFX_LIBRARY_PATH in .env)' };
  }
  const AUDIO_EXTS = ['.mp3', '.wav', '.ogg', '.m4a'];
  const files = fs.readdirSync(libPath).filter((f) =>
    AUDIO_EXTS.includes(path.extname(f).toLowerCase()),
  );
  const entries: { name: string; path: string; durationSec: number; audioStartSec: number; audioEndSec: number; size: number; categories: string[] }[] = [];
  for (const file of files) {
    const fullPath = path.join(libPath, file);
    const durationSec = await getAudioDurationSec(fullPath);
    const { audioStartSec, audioEndSec } = await detectSfxBounds(fullPath, durationSec);
    const size = fs.existsSync(fullPath) ? fs.statSync(fullPath).size : 0;
    entries.push({ name: file, path: fullPath, durationSec, audioStartSec, audioEndSec, size, categories: parseSfxCategories(file) });
  }
  console.log(`[SFX] Scanned ${entries.length} files from ${libPath}`);
  return { entries, libPath };
});

// IPC Handler for reading file content with EMFILE protection
ipcMain.handle('read-file', async (event, filePath: string) => {
  try {
    console.log(`ðŸ“– Reading file content from: ${filePath}`);

    if (!fileIOManager.exists(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    // Read file content as UTF-8 text using controlled I/O manager
    const content = await fileIOManager.readFile(filePath, {
      encoding: 'utf-8',
      priority: 'normal',
    });
    console.log(`ðŸ“„ Successfully read file, content length: ${content.length}`);

    return content;
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : 'Unknown error';
    console.error(`âŒ Failed to read file ${filePath}:`, errorMessage);

    // Provide helpful error message for EMFILE
    if (isEMFILEError(error)) {
      throw new Error(
        `System file limit reached while reading ${path.basename(filePath)}. Please wait and try again.`,
      );
    }

    throw error;
  }
});

// IPC Handler for reading file as ArrayBuffer (for validation) with EMFILE protection
ipcMain.handle('read-file-as-buffer', async (event, filePath: string) => {
  try {
    console.log(`ðŸ“– Reading file as buffer from: ${filePath}`);

    if (!fileIOManager.exists(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    // Read file as Buffer using controlled I/O manager
    const buffer = await fileIOManager.readFileAsBuffer(filePath, 'normal');
    console.log(
      `ðŸ“„ Successfully read file buffer, size: ${buffer.length} bytes`,
    );

    // Convert Node Buffer to ArrayBuffer for transfer to renderer
    return buffer.buffer.slice(
      buffer.byteOffset,
      buffer.byteOffset + buffer.byteLength,
    );
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : 'Unknown error';
    console.error(
      `âŒ Failed to read file as buffer ${filePath}:`,
      errorMessage,
    );

    // Provide helpful error message for EMFILE
    if (isEMFILEError(error)) {
      throw new Error(
        `System file limit reached while reading ${path.basename(filePath)}. Please wait and try again.`,
      );
    }

    throw error;
  }
});

// IPC Handler for getting file I/O and background task queue status
ipcMain.handle('get-io-status', async () => {
  const fileIOStats = fileIOManager.getStats();
  const taskQueueStats = backgroundTaskQueue.getStats();

  return {
    fileIO: {
      activeReads: fileIOStats.activeReads,
      activeWrites: fileIOStats.activeWrites,
      queuedReads: fileIOStats.queuedReads,
      queuedWrites: fileIOStats.queuedWrites,
      completedOperations: fileIOStats.completedOperations,
      failedOperations: fileIOStats.failedOperations,
      emfileErrors: fileIOStats.emfileErrors,
      isUnderHeavyLoad: fileIOManager.isUnderHeavyLoad(),
    },
    taskQueue: {
      pending: taskQueueStats.pending,
      running: taskQueueStats.running,
      completed: taskQueueStats.completed,
      failed: taskQueueStats.failed,
      cancelled: taskQueueStats.cancelled,
      byType: taskQueueStats.byType,
      isIdle: backgroundTaskQueue.isIdle(),
    },
  };
});

// IPC Handler for cancelling background tasks for a specific media
ipcMain.handle('cancel-media-tasks', async (event, mediaId: string) => {
  const cancelledCount = backgroundTaskQueue.cancelTasksForMedia(mediaId);
  console.log(`ðŸ›‘ Cancelled ${cancelledCount} tasks for media ${mediaId}`);
  return { success: true, cancelledCount };
});

// IPC Handler for creating preview URLs from file paths
ipcMain.handle('create-preview-url', async (event, filePath: string) => {
  try {
    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    const ext = path.extname(filePath).toLowerCase().slice(1);

    // For images, create full data URL (they're usually small)
    if (['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp'].includes(ext)) {
      const fileBuffer = fs.readFileSync(filePath);
      let mimeType = 'image/jpeg';
      if (['png'].includes(ext)) {
        mimeType = 'image/png';
      } else if (['gif'].includes(ext)) {
        mimeType = 'image/gif';
      }

      const base64 = fileBuffer.toString('base64');
      const dataUrl = `data:${mimeType};base64,${base64}`;

      return { success: true, url: dataUrl };
    }

    // For videos and other media, use the local media server
    if (
      ['mp4', 'webm', 'ogg', 'avi', 'mov', 'mkv', 'mp3', 'wav', 'aac'].includes(
        ext,
      )
    ) {
      // URL encode the file path for the media server
      const encodedPath = encodeURIComponent(filePath);
      const serverUrl = `http://localhost:${MEDIA_SERVER_PORT}/${encodedPath}`;

      console.log(`ðŸŽ¬ Created server URL for media: ${serverUrl}`);
      return { success: true, url: serverUrl };
    }

    // For other file types, return error
    return { success: false, error: 'Unsupported file type' };
  } catch (error) {
    console.error('Failed to create preview URL:', error);
    return { success: false, error: error.message };
  }
});

// IPC Handler for serving files as streams (for large video files)
ipcMain.handle(
  'get-file-stream',
  async (event, filePath: string, start?: number, end?: number) => {
    try {
      if (!fs.existsSync(filePath)) {
        throw new Error(`File not found: ${filePath}`);
      }

      const stats = fs.statSync(filePath);
      const fileSize = stats.size;

      // If no range specified, return small chunk for preview
      const startByte = start || 0;
      const endByte = end || Math.min(startByte + 1024 * 1024, fileSize - 1); // 1MB max chunk

      const buffer = Buffer.alloc(endByte - startByte + 1);
      const fd = fs.openSync(filePath, 'r');
      fs.readSync(fd, buffer, 0, buffer.length, startByte);
      fs.closeSync(fd);

      return {
        success: true,
        data: buffer.toString('base64'),
        start: startByte,
        end: endByte,
        total: fileSize,
      };
    } catch (error) {
      console.error('Failed to get file stream:', error);
      return { success: false, error: error.message };
    }
  },
);

// IPC handlers for media cache utilities
ipcMain.handle('get-media-cache-dir', async () => {
  try {
    const dir = getMediaCacheDir();
    return { success: true, path: dir };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
});

ipcMain.handle('media-path-exists', async (_event, pathOrUrl: string) => {
  try {
    const resolved = resolveMediaPath(pathOrUrl);
    if (!resolved) {
      return { success: false, exists: false, error: 'Invalid media path' };
    }
    return { success: true, exists: fs.existsSync(resolved), path: resolved };
  } catch (error) {
    return {
      success: false,
      exists: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
});

// FFmpeg IPC handlers
ipcMain.handle('ffmpeg:detect-frame-rate', async (event, videoPath: string) => {
  return new Promise((resolve, reject) => {
    if (!ffprobePath?.path) {
      reject(
        new Error(
          'FFprobe binary not available. Please ensure ffprobe-static is properly installed.',
        ),
      );
      return;
    }

    const ffprobe = spawn(ffprobePath.path, [
      '-v',
      'quiet',
      '-print_format',
      'json',
      '-show_streams',
      '-select_streams',
      'v:0',
      videoPath,
    ]);

    let output = '';

    ffprobe.stdout.on('data', (data) => {
      output += data.toString();
    });

    ffprobe.stderr.on('data', (data) => {
      console.error(`ffprobe stderr: ${data}`);
    });

    ffprobe.on('close', (code) => {
      if (code === 0) {
        try {
          const result = JSON.parse(output);
          const videoStream = result.streams[0];

          if (videoStream && videoStream.r_frame_rate) {
            const [num, den] = videoStream.r_frame_rate.split('/').map(Number);
            const frameRate = Math.round((num / den) * 100) / 100;
            resolve(frameRate);
          } else {
            resolve(30);
          }
        } catch (err) {
          console.error('Failed to parse ffprobe output:', err);
          resolve(30);
        }
      } else {
        reject(new Error(`ffprobe failed with code ${code}`));
      }
    });

    ffprobe.on('error', (err) => {
      reject(new Error(`ffprobe error: ${err.message}`));
    });
  });
});

// Get media file duration using FFprobe
ipcMain.handle('ffmpeg:get-duration', async (event, filePath: string) => {
  return new Promise((resolve, reject) => {
    if (!ffprobePath?.path) {
      reject(
        new Error(
          'FFprobe binary not available. Please ensure ffprobe-static is properly installed.',
        ),
      );
      return;
    }

    const ffprobe = spawn(ffprobePath.path, [
      '-v',
      'quiet',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      filePath,
    ]);

    let output = '';

    ffprobe.stdout.on('data', (data) => {
      output += data.toString();
    });

    ffprobe.stderr.on('data', (data) => {
      console.error(`ffprobe stderr: ${data}`);
    });

    ffprobe.on('close', (code) => {
      if (code === 0) {
        try {
          const result = JSON.parse(output);

          // Try to get duration from format first (most reliable)
          if (result.format && result.format.duration) {
            const duration = parseFloat(result.format.duration);
            console.log(
              `ðŸ“ Duration from format: ${duration}s for ${filePath}`,
            );
            resolve(duration);
            return;
          }

          // Fallback: try to get duration from streams
          if (result.streams && result.streams.length > 0) {
            for (const stream of result.streams) {
              if (stream.duration && parseFloat(stream.duration) > 0) {
                const duration = parseFloat(stream.duration);
                console.log(
                  `ðŸ“ Duration from stream: ${duration}s for ${filePath}`,
                );
                resolve(duration);
                return;
              }
            }
          }

          // Last fallback: images get 5 seconds, others get 60 seconds
          const isImage = /\.(jpg|jpeg|png|gif|bmp|webp)$/i.test(filePath);
          const fallbackDuration = isImage ? 5 : 60;
          console.warn(
            `âš ï¸ Could not determine duration for ${filePath}, using fallback: ${fallbackDuration}s`,
          );
          resolve(fallbackDuration);
        } catch (err) {
          console.error('Failed to parse ffprobe output:', err);
          const isImage = /\.(jpg|jpeg|png|gif|bmp|webp)$/i.test(filePath);
          resolve(isImage ? 5 : 60); // Fallback
        }
      } else {
        console.error(`ffprobe failed with code ${code} for ${filePath}`);
        const isImage = /\.(jpg|jpeg|png|gif|bmp|webp)$/i.test(filePath);
        resolve(isImage ? 5 : 60); // Fallback
      }
    });

    ffprobe.on('error', (err) => {
      console.error(`ffprobe error for ${filePath}:`, err.message);
      const isImage = /\.(jpg|jpeg|png|gif|bmp|webp)$/i.test(filePath);
      resolve(isImage ? 5 : 60); // Fallback
    });
  });
});

ipcMain.handle('getVideoDimensions', async (_event, filePath: string) => {
  return new Promise<{ width: number; height: number }>((resolve, reject) => {
    const ffprobe = spawn(ffprobePath.path, [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=width,height,side_data_list:stream_tags=rotate',
      '-of',
      'json',
      filePath,
    ]);

    let stdout = '';
    let stderr = '';

    ffprobe.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    ffprobe.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    ffprobe.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`ffprobe exited with code ${code}: ${stderr}`));
        return;
      }

      try {
        const json = JSON.parse(stdout);
        const stream = json.streams?.[0];
        if (!stream?.width || !stream?.height) {
          reject(new Error('Could not read video dimensions'));
          return;
        }

        let { width, height } = stream;

        // Check rotation tag — phone videos are often stored as landscape
        // with a rotate tag (90 or 270). Swap dims so the editor treats them
        // as portrait from the start.
        const rotateDeg =
          parseInt(stream.tags?.rotate ?? '0', 10) ||
          (() => {
            // Also check side_data_list for displaymatrix rotation
            const sideData: Array<{ side_data_type?: string; rotation?: number }> =
              stream.side_data_list ?? [];
            const matrix = sideData.find(
              (d) => d.side_data_type === 'Display Matrix',
            );
            return matrix?.rotation ? Math.round(Math.abs(matrix.rotation)) : 0;
          })();

        if (rotateDeg === 90 || rotateDeg === 270) {
          [width, height] = [height, width];
        }

        resolve({ width, height });
      } catch (err) {
        reject(err);
      }
    });

    ffprobe.on('error', (err) => {
      reject(err);
    });
  });
});
ipcMain.handle('ffmpegRun', async (event, job: VideoEditJob) => {
  console.log('ðŸŽ¯ MAIN PROCESS: ffmpegRun handler called!');
  console.log('ðŸŽ¯ MAIN PROCESS: Received job:', JSON.stringify(job, null, 2));

  const location = job.outputPath || 'public/output/';
  // Ensure we have an absolute path for the location
  const absoluteLocation = path.isAbsolute(location)
    ? location
    : path.resolve(location);

  return queueFFmpegTask(2, async () => {
    let tempSubtitlePath: string | null = null;

    try {
      // Reverb Processor pre-pass: for audio inputs with a non-zero dial, bake
      // the reverb with the python script (the SAME DSP the live preview stage
      // runs) and substitute the audio source, so export matches what the user
      // heard. ffmpeg has no algorithmic reverb filter — this pre-pass is the
      // filter. Cached per (source, amount) for the lifetime of the baked dir.
      if (Array.isArray(job.inputs)) {
        for (const input of job.inputs as any[]) {
          const amt = Math.max(-50, Math.min(50, Math.round(input?.reverbAmount ?? 0)));
          if (!amt) continue;
          const srcPath: string | undefined = input.audioPath || input.path;
          if (!srcPath || !fs.existsSync(srcPath)) continue;
          try {
            const cacheName = `reverbexport_${amt}_${path.basename(srcPath).replace(/[^a-zA-Z0-9._-]/g, '_')}_${fs.statSync(srcPath).size}.wav`;
            const outputFile = path.join(getBakedDir(), cacheName);
            if (!fs.existsSync(outputFile)) {
              console.log(`🎛️ Reverb pre-pass (${amt}) on ${srcPath}`);
              const result = await runPythonSkill(
                'reverb-process',
                ['--input', srcPath, '--output', outputFile, '--amount', String(amt)],
                'reverbExport',
              );
              if (!result?.success) {
                console.warn('Reverb pre-pass failed, exporting unprocessed:', result?.error);
                continue;
              }
            }
            if (input.audioPath) input.audioPath = outputFile;
            else input.path = outputFile;
          } catch (e) {
            console.warn('Reverb pre-pass error, exporting unprocessed:', e);
          }
        }
      }

      // Stabilization pre-pass: for video inputs whose track has stabilization
      // enabled, bake the SAME per-frame corrections the live preview applies
      // (warpAffine rotate-about-center + translate, edges replicated — no zoom,
      // no crop, native resolution) and substitute the video source.
      if (Array.isArray(job.inputs)) {
        for (const input of job.inputs as any[]) {
          const offsetsPath: string | undefined = input?.stabilizeOffsetsPath;
          if (!offsetsPath || !fs.existsSync(offsetsPath)) continue;
          const srcPath: string | undefined = input.path;
          if (!srcPath || !fs.existsSync(srcPath)) continue;
          try {
            // Keyed on the offsets file as well as the source: a re-analysis
            // (new sidecar) must invalidate any previously baked export.
            const cacheName = `stabexport3_${path.basename(srcPath).replace(/[^a-zA-Z0-9._-]/g, '_')}_${fs.statSync(srcPath).size}_${fs.statSync(offsetsPath).size}.mp4`;
            const outputFile = path.join(getBakedDir(), cacheName);
            if (!fs.existsSync(outputFile)) {
              console.log(`🎥 Stabilization pre-pass on ${srcPath}`);
              const result = await runPythonSkill(
                'stabilize',
                ['--mode', 'bake', '--input', srcPath, '--offsets', offsetsPath, '--output', outputFile],
                'stabilizeExport',
              );
              if (!result?.success) {
                console.warn('Stabilization pre-pass failed, exporting unprocessed:', result?.error);
                continue;
              }
            }
            input.path = outputFile;
          } catch (e) {
            console.warn('Stabilization pre-pass error, exporting unprocessed:', e);
          }
        }
      }

      // Create temporary subtitle file if subtitle content is provided
      if (job.subtitleContent && job.operations.subtitles) {
        tempSubtitlePath = path.join(absoluteLocation, 'temp_subtitles.ass');

        // Ensure directory exists
        if (!fs.existsSync(absoluteLocation)) {
          fs.mkdirSync(absoluteLocation, { recursive: true });
        }

        // Write subtitle content to file
        fs.writeFileSync(tempSubtitlePath, job.subtitleContent, 'utf8');
        console.log('ðŸ“ Created temporary subtitle file:', tempSubtitlePath);

        // Update the job to use the absolute path instead of just the filename
        job.operations.subtitles = tempSubtitlePath;
        console.log('ðŸ“ Updated subtitle path to absolute:', tempSubtitlePath);
      }

      // Verify subtitle file exists before running FFmpeg
      if (tempSubtitlePath) {
        if (!fs.existsSync(tempSubtitlePath)) {
          throw new Error(`Subtitle file does not exist: ${tempSubtitlePath}`);
        }
        console.log('âœ… Subtitle file verified to exist:', tempSubtitlePath);
      }

      // Build proper FFmpeg command
      const baseArgs = await buildFfmpegCommand(
        job,
        absoluteLocation,
        ffmpegPath,
      );
      const args = ['-progress', 'pipe:1', '-y', ...baseArgs];

      console.log('ðŸŽ¬ COMPLETE FFMPEG COMMAND:');
      console.log(['ffmpeg', ...args].join(' '));

      return new Promise((resolve, reject) => {
        // Double-check subtitle file still exists right before spawning
        if (tempSubtitlePath && !fs.existsSync(tempSubtitlePath)) {
          reject(
            new Error(
              `Subtitle file disappeared before FFmpeg start: ${tempSubtitlePath}`,
            ),
          );
          return;
        }

        if (!ffmpegPath) {
          reject(
            new Error(
              'FFmpeg binary not available. Please ensure ffmpeg-static is properly installed.',
            ),
          );
          return;
        }

        ensureNoStaleFfmpegProcess();
        const ffmpeg = spawn(ffmpegPath, args);
        currentFfmpegProcess = ffmpeg;
        currentFfmpegStartedAt = Date.now();

        const exportTimeoutMs = 30 * 60 * 1000; // 30 minutes
        if (exportTimeoutMs > 0) {
          currentFfmpegTimeout = setTimeout(() => {
            killCurrentFfmpegProcess(`export-timeout ${exportTimeoutMs}ms`);
          }, exportTimeoutMs);
        }

        let logs = '';

        ffmpeg.stdout.on('data', (data) => {
          const text = data.toString();
          logs += `[stdout] ${text}\n`;
          event.sender.send('ffmpeg:progress', { type: 'stdout', data: text });
        });

        ffmpeg.stderr.on('data', (data) => {
          const text = data.toString();
          logs += `[stderr] ${text}\n`;
          event.sender.send('ffmpeg:progress', { type: 'stderr', data: text });
        });

        ffmpeg.on('close', (code, signal) => {
          if (ffmpeg.stdout) ffmpeg.stdout.removeAllListeners();
          if (ffmpeg.stderr) ffmpeg.stderr.removeAllListeners();
          ffmpeg.removeAllListeners();
          clearCurrentFfmpegProcess();

          // Always cleanup temporary subtitle file after FFmpeg completes
          if (tempSubtitlePath && fs.existsSync(tempSubtitlePath)) {
            try {
              fs.unlinkSync(tempSubtitlePath);
              console.log(
                'ðŸ—‘ï¸ Cleaned up temporary subtitle file after FFmpeg completion',
              );
            } catch (cleanupError) {
              console.warn(
                'âš ï¸ Failed to cleanup temporary subtitle file after completion:',
                cleanupError,
              );
            }
          }

          // Check if this was a user cancellation:
          // 1. Signal is SIGTERM/SIGKILL (direct signal kill)
          // 2. Code 255 AND logs contain "received signal 15" (FFmpeg caught signal)
          const wasCancelled =
            signal === 'SIGTERM' ||
            signal === 'SIGKILL' ||
            (code === 255 &&
              (logs.includes('received signal 15') ||
                logs.includes('Exiting normally, received signal')));

          if (wasCancelled) {
            console.log('ðŸ›‘ FFmpeg process was cancelled by user');

            // Delete the incomplete output file
            const outputFilePath = path.join(absoluteLocation, job.output);
            console.log(
              'ðŸ” Checking for incomplete output file at:',
              outputFilePath,
            );

            if (fs.existsSync(outputFilePath)) {
              try {
                fs.unlinkSync(outputFilePath);
                console.log(
                  'ðŸ—‘ï¸ Deleted incomplete output file:',
                  outputFilePath,
                );
              } catch (deleteError) {
                console.warn(
                  'âš ï¸ Failed to delete incomplete output file:',
                  deleteError,
                );
              }
            } else {
              console.log(
                'â„¹ï¸ No output file found to delete (may not have been created yet)',
              );
            }

            resolve({
              success: true,
              cancelled: true,
              logs,
              message: 'Export cancelled by user',
            });
            return;
          }

          console.log(
            `ðŸ FFmpeg process finished with code: ${code}, signal: ${signal}`,
          );

          if (code === 0) {
            resolve({ success: true, logs });
          } else {
            reject(
              new Error(`FFmpeg exited with code ${code}\nLogs:\n${logs}`),
            );
          }
        });

        ffmpeg.on('error', (err) => {
          if (ffmpeg.stdout) ffmpeg.stdout.removeAllListeners();
          if (ffmpeg.stderr) ffmpeg.stderr.removeAllListeners();
          ffmpeg.removeAllListeners();
          clearCurrentFfmpegProcess();
          console.log('âŒ FFmpeg process error:', err.message);

          // Cleanup temporary subtitle file on error
          if (tempSubtitlePath && fs.existsSync(tempSubtitlePath)) {
            try {
              fs.unlinkSync(tempSubtitlePath);
              console.log(
                'ðŸ—‘ï¸ Cleaned up temporary subtitle file after FFmpeg error',
              );
            } catch (cleanupError) {
              console.warn(
                'âš ï¸ Failed to cleanup temporary subtitle file after error:',
                cleanupError,
              );
            }
          }

          reject(err);
        });
      });
    } catch (error) {
      console.log('ðŸ’¥ Setup error occurred before FFmpeg could start:', error);

      // Only cleanup on setup errors, not FFmpeg execution errors
      if (tempSubtitlePath && fs.existsSync(tempSubtitlePath)) {
        try {
          fs.unlinkSync(tempSubtitlePath);
          console.log(
            'ðŸ—‘ï¸ Cleaned up temporary subtitle file due to setup error',
          );
        } catch (cleanupError) {
          console.warn(
            'âš ï¸ Failed to cleanup temporary subtitle file after setup error:',
            cleanupError,
          );
        }
      }
      throw error;
    }
  });
});

ipcMain.handle('ffmpeg:cancel', async () => {
  const cancelled = killCurrentFfmpegProcess('user-cancel');
  if (cancelled) {
    return { success: true, message: 'Export cancelled' };
  }
  return { success: false, message: 'No export running' };
});

// Keep track of active proxy generation promises to deduplicate requests
const activeProxyGenerations = new Map<string, Promise<any>>();

// Helper function to run FFmpeg proxy generation with a specific encoder config
async function runProxyFFmpeg(
  inputPath: string,
  tempPath: string,
  encoderConfig: ProxyEncoderConfig,
  ffmpegBinaryPath: string,
  eventSender: Electron.WebContents | null,
): Promise<{
  success: boolean;
  code?: number;
  stderr?: string;
}> {
  // Build FFmpeg args based on encoder type
  let args: string[];
  if (encoderConfig.type === 'vaapi') {
    // VAAPI requires special filter chain with hardware upload
    args = buildVaapiProxyFFmpegArgs(inputPath, tempPath);
  } else {
    args = buildProxyFFmpegArgs(inputPath, tempPath, encoderConfig);
  }

  console.log(
    `ðŸŽ¬ FFmpeg proxy command (${encoderConfig.description}):`,
    [ffmpegBinaryPath, ...args].join(' '),
  );

  try {
    const ffmpegResult = await runQueuedFfmpeg(args, {
      priority: 2,
      binaryPath: ffmpegBinaryPath,
      timeoutMs: 30 * 60 * 1000, // 30 minutes
      onStderr: (chunk) => {
        // Send progress updates to renderer
        if (chunk.includes('time=') && eventSender) {
          eventSender.send('proxy-progress', {
            path: inputPath,
            log: chunk,
            encoder: encoderConfig.type,
          });
        }
      },
    });

    return {
      success: ffmpegResult.code === 0,
      code: ffmpegResult.code ?? undefined,
      stderr: ffmpegResult.stderr,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error(`âŒ FFmpeg spawn error (${encoderConfig.type}):`, message);
    return {
      success: false,
      code: -1,
      stderr: message,
    };
  }
}

// IPC Handler for generating proxy files for 4K video optimization
// Uses hybrid encoder selection: GPU hardware encoder if available, CPU fallback otherwise
ipcMain.handle('generate-proxy', async (event, inputPath: string) => {
  console.log('ðŸ”„ generate-proxy called for:', inputPath);

  // Check if there is already an active generation for this file
  if (activeProxyGenerations.has(inputPath)) {
    console.log('ðŸ”„ Joining existing proxy generation for:', inputPath);
    return activeProxyGenerations.get(inputPath);
  }

  const generationPromise = (async () => {
    if (!ffmpegPath) {
      return { success: false, error: 'FFmpeg not available' };
    }

    try {
      const proxiesDir = path.join(app.getPath('userData'), 'proxies');
      if (!fs.existsSync(proxiesDir)) {
        fs.mkdirSync(proxiesDir, { recursive: true });
      }

      // Generate a stable hash for the filename based on input path
      const hash = crypto.createHash('md5').update(inputPath).digest('hex');
      const outputPath = path.join(proxiesDir, `${hash}.mp4`);

      // Check if proxy already exists
      if (fs.existsSync(outputPath)) {
        console.log('âœ… Proxy already exists at:', outputPath);
        // Verify it's valid (size > 0)
        const stats = fs.statSync(outputPath);
        if (stats.size > 0) {
          return { success: true, proxyPath: outputPath, cached: true };
        }
        // If invalid, delete and regenerate
        fs.unlinkSync(outputPath);
      }

      // Use a temporary file during generation to prevent incomplete reads
      const tempPath = outputPath + '.tmp';
      console.log(`ðŸ“ Writing to temp file: ${tempPath}`);

      // Clean up any stale temp file
      if (fs.existsSync(tempPath)) {
        try {
          fs.unlinkSync(tempPath);
        } catch (e) {
          console.warn('âš ï¸ Could not cleanup old temp proxy:', e);
        }
      }

      // Get optimal encoder configuration (hardware if available, software fallback)
      const encoderConfig = await getProxyEncoderConfig(ffmpegPath);

      console.log('ðŸš€ Starting proxy generation to:', outputPath);
      console.log(`ðŸŽ® Using encoder: ${encoderConfig.description}`);
      const startTime = Date.now();
      const startTimeString = new Date(startTime).toLocaleTimeString();
      console.log(
        `â±ï¸ Proxy generation START: ${startTimeString} (${startTime})`,
      );

      // Attempt proxy generation with selected encoder
      let result = await runProxyFFmpeg(
        inputPath,
        tempPath,
        encoderConfig,
        ffmpegPath,
        event.sender,
      );

      let fallbackUsed = false;
      let originalEncoder: string | undefined;

      // If hardware encoder failed, fallback to software encoding
      if (!result.success && encoderConfig.type !== 'software') {
        console.warn(
          `âš ï¸ Hardware encoder ${encoderConfig.type} failed (code: ${result.code}), falling back to software encoding`,
        );
        console.warn(`   Error: ${result.stderr?.slice(-200)}`);

        // Clean up any partial temp file from failed attempt
        if (fs.existsSync(tempPath)) {
          try {
            fs.unlinkSync(tempPath);
          } catch (e) {
            console.warn('âš ï¸ Could not cleanup temp file after failure:', e);
          }
        }

        // Retry with software encoder
        const softwareConfig = getSoftwareEncoderConfig();
        console.log(`ðŸ”„ Retrying with ${softwareConfig.description}...`);

        result = await runProxyFFmpeg(
          inputPath,
          tempPath,
          softwareConfig,
          ffmpegPath,
          event.sender,
        );

        fallbackUsed = true;
        originalEncoder = encoderConfig.type;
      }

      const endTime = Date.now();
      const endTimeString = new Date(endTime).toLocaleTimeString();
      const durationMs = endTime - startTime;

      console.log(`â±ï¸ Proxy generation END: ${endTimeString} (${endTime})`);
      console.log(`â±ï¸ Duration: ${durationMs}ms`);

      if (result.success) {
        try {
          // Wait a small amount of time to ensure file handles are released
          await new Promise((r) => setTimeout(r, 500));

          // Atomic rename: temp -> final
          if (fs.existsSync(tempPath)) {
            fs.renameSync(tempPath, outputPath);
            console.log(
              'âœ… Proxy generation complete (renamed temp -> final):',
              outputPath,
            );

            const finalEncoderType = fallbackUsed
              ? 'software'
              : encoderConfig.type;
            const finalEncoderDesc = fallbackUsed
              ? getSoftwareEncoderConfig().description
              : encoderConfig.description;

            return {
              success: true,
              proxyPath: outputPath,
              encoder: {
                type: finalEncoderType,
                description: finalEncoderDesc,
                fallbackUsed,
                originalEncoder,
              },
              benchmark: {
                durationMs,
                startTime,
                endTime,
              },
            };
          } else {
            console.error(
              'âŒ Temp proxy file missing after successful FFmpeg exit',
            );
            return { success: false, error: 'Temp proxy file missing' };
          }
        } catch (err) {
          console.error('âŒ Failed to rename temp proxy file:', err);
          return {
            success: false,
            error: 'Failed to finalize proxy file',
          };
        }
      } else {
        console.error(`âŒ Proxy generation failed with code: ${result.code}`);
        console.error(`âŒ FFmpeg stderr:`, result.stderr);

        // Cleanup temp file
        if (fs.existsSync(tempPath)) {
          fs.unlinkSync(tempPath);
        }
        return {
          success: false,
          error: `FFmpeg exited with code ${result.code}. Error: ${result.stderr?.slice(-200)}`,
        };
      }
    } catch (error) {
      console.error('Failed to generate proxy:', error);
      return { success: false, error: error.message };
    } finally {
      // Remove from active generations map when done
      activeProxyGenerations.delete(inputPath);
    }
  })();

  activeProxyGenerations.set(inputPath, generationPromise);
  return generationPromise;
});

// IPC Handler for getting hardware capabilities (for UI display and low-hardware modal)
ipcMain.handle('get-hardware-capabilities', async () => {
  if (!ffmpegPath) {
    return {
      success: false,
      error: 'FFmpeg not available',
    };
  }

  try {
    const capabilities = await detectHardwareCapabilities(ffmpegPath);

    return {
      success: true,
      capabilities: {
        hasHardwareEncoder: capabilities.hasHardwareEncoder,
        encoderType: capabilities.encoder.primary?.type || 'none',
        encoderDescription:
          capabilities.encoder.primary?.description ||
          'Software encoding (CPU)',
        cpuCores: capabilities.cpuCores,
        totalRamGB: Math.round(
          capabilities.totalRamBytes / (1024 * 1024 * 1024),
        ),
        freeRamGB: Math.round(capabilities.freeRamBytes / (1024 * 1024 * 1024)),
        isLowHardware: capabilities.isLowHardware,
      },
    };
  } catch (error) {
    console.error('Failed to detect hardware capabilities:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
});

// Diagnostic handler to check FFmpeg status
ipcMain.handle('ffmpeg:status', async () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
  const fs = require('fs');

  const ffmpegExists = ffmpegPath ? fs.existsSync(ffmpegPath) : false;
  const ffprobeExists = ffprobePath?.path
    ? fs.existsSync(ffprobePath.path)
    : false;

  return {
    ffmpegPath,
    ffprobePath: ffprobePath?.path,
    ffmpegExists,
    ffprobeExists,
    isReady: ffmpegPath !== null && ffprobePath?.path !== null,
    appPath: app.getAppPath(),
    isPackaged: app.isPackaged,
    environment: process.env.NODE_ENV || 'production',
  };
});

// ============================================================================
// Python Faster-Whisper IPC Handlers
// ============================================================================

// IPC Handler for Whisper transcription
ipcMain.handle(
  'whisper:transcribe',
  async (
    event,
    audioPath: string,
    options?: {
      model?:
        | 'tiny'
        | 'base'
        | 'small'
        | 'medium'
        | 'large'
        | 'large-v2'
        | 'large-v3';
      language?: string;
      translate?: boolean;
      device?: 'auto' | 'cpu' | 'cuda';
      computeType?: 'auto' | 'int8' | 'int16' | 'float16' | 'float32';
      beamSize?: number;
      vad?: boolean;
    },
  ) => {
    console.log('ðŸŽ¤ MAIN PROCESS: whisper:transcribe handler called (Python)');
    console.log('   Audio path:', audioPath);
    console.log('   Options:', options);

    try {
      await ensurePythonInitialized('ipc:whisper:transcribe');

      const result: WhisperResult = await transcribeAudio(audioPath, {
        ...options,
        onProgress: (progress: WhisperProgress) => {
          event.sender.send('whisper:progress', progress);
        },
        onChunk: (chunk: any) => {
          event.sender.send('whisper:chunk', chunk);
        },
      });

      console.log('âœ… Transcription successful');
      return { success: true, result };
    } catch (error) {
      console.error('âŒ Whisper transcription failed:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  },
);

// IPC Handler to cancel transcription
ipcMain.handle('whisper:cancel', async () => {
  console.log('ðŸ›‘ MAIN PROCESS: whisper:cancel handler called');

  const cancelled = cancelTranscription();
  return {
    success: cancelled,
    message: cancelled
      ? 'Transcription cancelled successfully'
      : 'No active transcription to cancel',
  };
});

// IPC Handler to check Whisper status
ipcMain.handle('whisper:status', async () => {
  console.log('ðŸ“Š MAIN PROCESS: whisper:status handler called');

  // Try to initialize if not already initialized (but don't fail if it doesn't work)
  if (!getPythonWhisperStatus().available) {
    try {
      await ensurePythonInitialized('ipc:whisper:status');
    } catch (error) {
      console.log(
        'âš ï¸ Python initialization failed during status check:',
        error,
      );
      // Continue to return status even if initialization failed
    }
  }

  const status = getPythonWhisperStatus();
  console.log('   Status:', status);

  return status;
});

// ============================================================================
// Media Tools IPC Handlers (Noise Reduction)
// ============================================================================

// IPC Handler for noise reduction
ipcMain.handle(
  'media-tools:noise-reduce',
  async (
    event,
    inputPath: string,
    outputPath: string,
    options?: {
      stationary?: boolean;
      propDecrease?: number;
      nFft?: number;
      engine?: 'ffmpeg' | 'deepfilter';
    },
  ) => {
    console.log('ðŸ”‡ MAIN PROCESS: media-tools:noise-reduce handler called');
    console.log('   Input path:', inputPath);
    console.log('   Output path:', outputPath);
    console.log('   Options:', options);

    const engine = options?.engine || 'ffmpeg'; // Default to FFmpeg for safety/speed

    try {
      if (engine === 'deepfilter') {
        // --- DeepFilterNet2 (Python) ---
        await ensurePythonInitialized('ipc:media-tools:noise-reduce');

        const result: NoiseReductionResult = await reduceNoise(
          inputPath,
          outputPath,
          {
            ...options,
            onProgress: (progress: MediaToolsProgress) => {
              // Send progress updates to renderer process
              event.sender.send('media-tools:progress', progress);
            },
          },
        );

        console.log('âœ… DeepFilter noise reduction successful');
        return { success: true, result };
      } else {
        // --- FFmpeg (Native) ---
        console.log('âš¡ Using FFmpeg for noise reduction');

        if (!ffmpegPath) {
          throw new Error('FFmpeg binary not available');
        }

        const filter = getFfmpegAudioDenoiseFilter();
        if (filter !== 'arnndn') {
          throw new Error(
            'FFmpeg build does not include arnndn filter required for RNNoise.',
          );
        }

        const modelPath = getDefaultModelPath();
        if (!fs.existsSync(modelPath)) {
          throw new Error(`RNNoise model not found: ${modelPath}`);
        }

        console.log('   Denoise filter:', filter);

        // Build command
        // Note: buildArnnDenCommand returns args for "ffmpeg -i input -af arnndn..."
        const args = buildArnnDenCommand(inputPath, outputPath);
        // We need to add -y to overwrite output if it exists (standard behavior)
        args.unshift('-y');

        console.log('   Command:', `ffmpeg ${args.join(' ')}`);

        const runFfmpegDenoise = async (runArgs: string[]) => {
          let durationSec = 0;
          let stderrLog = '';

          // Send initial loading state
          event.sender.send('media-tools:progress', {
            stage: 'loading',
            progress: 0,
            message: 'Initializing FFmpeg...',
          });

          const ffmpegResult = await runQueuedFfmpeg(runArgs, {
            priority: 2,
            timeoutMs: 30 * 60 * 1000, // 30 minutes
            onStderr: (text) => {
              stderrLog += text;

              // 1. Parse Duration: Duration: 00:00:10.50,
              if (durationSec === 0) {
                const durationMatch = text.match(
                  /Duration: (\d{2}):(\d{2}):(\d{2}\.\d{2})/,
                );
                if (durationMatch) {
                  const h = parseFloat(durationMatch[1]);
                  const m = parseFloat(durationMatch[2]);
                  const s = parseFloat(durationMatch[3]);
                  durationSec = h * 3600 + m * 60 + s;
                }
              }

              // 2. Parse Time: time=00:00:05.20
              if (durationSec > 0) {
                const timeMatch = text.match(
                  /time=(\d{2}):(\d{2}):(\d{2}\.\d{2})/,
                );
                if (timeMatch) {
                  const h = parseFloat(timeMatch[1]);
                  const m = parseFloat(timeMatch[2]);
                  const s = parseFloat(timeMatch[3]);
                  const timeSec = h * 3600 + m * 60 + s;
                  const percent = Math.min(
                    99,
                    Math.round((timeSec / durationSec) * 100),
                  );

                  event.sender.send('media-tools:progress', {
                    stage: 'processing',
                    progress: percent,
                    message: `Filtering... ${percent}%`,
                  });
                }
              }
            },
          });

          if (ffmpegResult.timedOut) {
            return { success: false, stderrLog: 'FFmpeg timed out' };
          }

          if (ffmpegResult.code === 0) {
            return { success: true, stderrLog };
          }

          console.error(
            'âŒ FFmpeg noise reduction failed. Code:',
            ffmpegResult.code,
          );
          return { success: false, stderrLog };
        };

        const firstAttempt = await runFfmpegDenoise(args);
        if (firstAttempt.success) {
          console.log('âœ… FFmpeg noise reduction successful');
          event.sender.send('media-tools:progress', {
            stage: 'complete',
            progress: 100,
            message: 'Noise reduction complete!',
          });
          return {
            success: true,
            result: {
              success: true,
              outputPath,
              message: 'FFmpeg denoising complete',
            },
          };
        }

        const stderrText = firstAttempt.stderrLog || '';
        // Check for common errors in stderr
        let errorMsg = 'FFmpeg exited with code 1';
        if (stderrText.includes('Permission denied'))
          errorMsg = 'Permission denied';
        if (stderrText.includes('No such file')) errorMsg = 'File not found';

        if (stderrText.trim()) {
          errorMsg += `\nStderr:\n${stderrText.trim()}`;
        }

        return {
          success: false,
          error: errorMsg,
        };
      }
    } catch (error) {
      console.error('âŒ Noise reduction failed:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  },
);

// IPC Handler to cancel media-tools operation
ipcMain.handle('media-tools:cancel', async () => {
  console.log('ðŸ›‘ MAIN PROCESS: media-tools:cancel handler called');

  const cancelled = cancelCurrentOperation();
  return {
    success: cancelled,
    message: cancelled
      ? 'Operation cancelled'
      : 'No active operation to cancel',
  };
});

// IPC Handler to check media-tools status
ipcMain.handle('media-tools:status', async () => {
  console.log('ðŸ“Š MAIN PROCESS: media-tools:status handler called');

  // Try to initialize if not already initialized
  if (!getMediaToolsStatus().available) {
    try {
      await ensurePythonInitialized('ipc:media-tools:status');
    } catch (error) {
      console.log(
        'âš ï¸ Media tools initialization failed during status check:',
        error,
      );
    }
  }

  const status = getMediaToolsStatus();
  console.log('   Status:', status);

  return status;
});

// ============================================================================
// Noise Reduction Cache IPC Handlers
// ============================================================================

// Noise reduction temp directory
const NOISE_REDUCTION_TEMP_DIR = path.join(
  os.tmpdir(),
  'dividr-noise-reduction',
);

// IPC Handler to get a unique output path for noise reduction
// IPC Handler to get a unique output path for noise reduction
ipcMain.handle(
  'noise-reduction:get-output-path',
  async (_event, inputPath: string, engine?: string) => {
    console.log(
      'ðŸ“ MAIN PROCESS: noise-reduction:get-output-path handler called',
    );
    console.log('   Input path:', inputPath);
    console.log('   Engine:', engine);

    try {
      // Ensure directory exists
      if (!fs.existsSync(NOISE_REDUCTION_TEMP_DIR)) {
        fs.mkdirSync(NOISE_REDUCTION_TEMP_DIR, { recursive: true });
        console.log(
          '   Created noise reduction temp directory:',
          NOISE_REDUCTION_TEMP_DIR,
        );
      }

      // Generate unique filename based on input path hash and timestamp
      const hash = crypto
        .createHash('md5')
        .update(inputPath)
        .digest('hex')
        .slice(0, 12);
      const timestamp = Date.now();
      const engineTag = engine ? `_${engine}` : '';
      const outputPath = path.join(
        NOISE_REDUCTION_TEMP_DIR,
        `nr_${hash}${engineTag}_${timestamp}.wav`,
      );

      console.log('   Generated output path:', outputPath);
      return { success: true, outputPath };
    } catch (error) {
      console.error('âŒ Failed to generate output path:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  },
);

// IPC Handler to cleanup noise reduction temp files
ipcMain.handle(
  'noise-reduction:cleanup-files',
  async (_event, filePaths: string[]) => {
    console.log(
      'ðŸ—‘ï¸ MAIN PROCESS: noise-reduction:cleanup-files handler called',
    );
    console.log('   Files to clean:', filePaths.length);

    try {
      let cleanedCount = 0;

      for (const filePath of filePaths) {
        try {
          // Security: only delete files in our noise reduction directory
          if (
            filePath.startsWith(NOISE_REDUCTION_TEMP_DIR) &&
            fs.existsSync(filePath)
          ) {
            fs.unlinkSync(filePath);
            cleanedCount++;
            console.log('   Cleaned up:', filePath);
          } else {
            console.warn('   Skipped (not in temp dir):', filePath);
          }
        } catch (error) {
          console.warn(`   Failed to cleanup ${filePath}:`, error);
        }
      }

      console.log(`âœ… Cleaned up ${cleanedCount} noise reduction files`);
      return { success: true, cleanedCount };
    } catch (error) {
      console.error('âŒ Failed to cleanup noise reduction files:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  },
);

// IPC Handler to create a blob URL for a file
ipcMain.handle(
  'noise-reduction:create-preview-url',
  async (_event, filePath: string) => {
    console.log(
      'ðŸ”— MAIN PROCESS: noise-reduction:create-preview-url handler called',
    );
    console.log('   File path:', filePath);

    try {
      // Read the file and return base64 data for creating blob URL in renderer
      if (!fs.existsSync(filePath)) {
        throw new Error(`File not found: ${filePath}`);
      }

      const buffer = fs.readFileSync(filePath);
      const base64 = buffer.toString('base64');
      const mimeType = 'audio/wav';

      console.log('âœ… Created preview URL data, size:', buffer.length);
      return { success: true, base64, mimeType };
    } catch (error) {
      console.error('âŒ Failed to create preview URL:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  },
);

// ============================================================================
// Runtime Download IPC Handlers
// ============================================================================

// IPC Handler to check runtime status
ipcMain.handle('runtime:status', async () => {
  console.log('ðŸ“Š MAIN PROCESS: runtime:status handler called');

  const status = await checkRuntimeStatus();
  console.log('   Runtime status:', status);

  return status;
});

// IPC Handler to start runtime download
ipcMain.handle('runtime:download', async (event) => {
  console.log('ðŸ“¥ MAIN PROCESS: runtime:download handler called');

  try {
    const result = await downloadRuntime((progress) => {
      // Send progress updates to renderer process
      event.sender.send('runtime:download-progress', progress);
    });

    console.log('   Download result:', result);
    return result;
  } catch (error) {
    console.error('âŒ Runtime download failed:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
});

// IPC Handler to cancel runtime download
ipcMain.handle('runtime:cancel-download', async () => {
  console.log('ðŸ›‘ MAIN PROCESS: runtime:cancel-download handler called');

  const result = await cancelDownload();
  return result;
});

// IPC Handler to verify runtime installation
ipcMain.handle('runtime:verify', async () => {
  console.log('ðŸ” MAIN PROCESS: runtime:verify handler called');

  const isValid = await verifyInstallation();
  return { valid: isValid };
});

// IPC Handler to remove runtime
ipcMain.handle('runtime:remove', async () => {
  console.log('ðŸ—‘ï¸ MAIN PROCESS: runtime:remove handler called');

  const result = await removeRuntime();
  return result;
});

// IPC Handler to check if a media file has audio
ipcMain.handle('media:has-audio', async (event, filePath: string) => {
  console.log('ðŸ”Š MAIN PROCESS: media:has-audio handler called');
  console.log('   File path:', filePath);

  if (!ffmpegPath) {
    return {
      success: false,
      hasAudio: false,
      error: 'FFmpeg binary not available',
    };
  }

  try {
    return new Promise((resolve) => {
      const ffprobe = spawn(ffmpegPath, [
        '-i',
        filePath,
        '-show_streams',
        '-select_streams',
        'a',
        '-loglevel',
        'error',
      ]);

      let stdout = '';
      let stderr = '';

      ffprobe.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      ffprobe.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      ffprobe.on('close', (code) => {
        // If there's audio stream info in stdout, the file has audio
        const hasAudio = stdout.includes('[STREAM]');

        console.log(`   Has audio: ${hasAudio} (exit code: ${code})`);

        resolve({
          success: true,
          hasAudio,
        });
      });

      ffprobe.on('error', (error) => {
        console.error('   FFprobe error:', error);
        resolve({
          success: false,
          hasAudio: false,
          error: error.message,
        });
      });
    });
  } catch (error) {
    console.error('âŒ Error checking audio:', error);
    return {
      success: false,
      hasAudio: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
});

// SCENE DETECTION
// FFmpeg-native shot detection: the select='gt(scene,T)' filter scores each frame's
// visual difference from the previous; showinfo prints pts_time for frames above the
// threshold. Single pass, no ML, no API — cheap and fast.
ipcMain.handle(
  'media:detectScenes',
  async (
    _event,
    { filePath, threshold = 0.4 }: { filePath: string; threshold?: number },
  ): Promise<{ success: boolean; scenes?: number[]; error?: string }> => {
    if (!ffmpegPath) return { success: false, error: 'FFmpeg binary not available' };
    if (!filePath || !fs.existsSync(filePath)) {
      return { success: false, error: `File not found: ${filePath}` };
    }
    const t = Math.max(0.05, Math.min(0.95, Number(threshold) || 0.4));
    return new Promise((resolve) => {
      let settled = false;
      const settle = (r: { success: boolean; scenes?: number[]; error?: string }) => {
        if (settled) return;
        settled = true;
        resolve(r);
      };
      const proc = spawn(
        ffmpegPath!,
        ['-i', filePath, '-filter:v', `select='gt(scene,${t})',showinfo`, '-an', '-f', 'null', '-'],
        { shell: false },
      );
      let stderr = '';
      const timer = setTimeout(() => {
        try { proc.kill(); } catch { /* already gone */ }
        settle({ success: false, error: 'Scene detection timed out' });
      }, 120000);
      proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
      proc.on('close', () => {
        clearTimeout(timer);
        settle({ success: true, scenes: parseSceneTimestamps(stderr) });
      });
      proc.on('error', (err: Error) => {
        clearTimeout(timer);
        settle({ success: false, error: err.message });
      });
    });
  },
);

// =============================================================================
// TRANSCODE SERVICE - AVI to MP4 background transcoding
// =============================================================================

// Formats that need transcoding for browser playback
const FORMATS_REQUIRING_TRANSCODE = [
  '.avi',
  '.wmv',
  '.flv',
  '.divx',
  '.xvid',
  '.asf',
  '.rm',
  '.rmvb',
  '.3gp',
  '.3g2',
];

// Codecs that browsers can't decode
const UNSUPPORTED_CODECS = [
  'xvid',
  'divx',
  'mpeg4',
  'msmpeg4',
  'wmv1',
  'wmv2',
  'wmv3',
  'vc1',
  'rv10',
  'rv20',
  'rv30',
  'rv40',
];

// Active transcode jobs
interface TranscodeJob {
  id: string;
  mediaId: string;
  inputPath: string;
  outputPath: string;
  status: 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled';
  progress: number;
  duration: number;
  currentTime: number;
  error?: string;
  startedAt?: number;
  completedAt?: number;
  process?: ReturnType<typeof spawn>;
}

const activeTranscodeJobs = new Map<string, TranscodeJob>();
const transcodeOutputDir = path.join(os.tmpdir(), 'dividr-transcode');

// Ensure transcode output directory exists
if (!fs.existsSync(transcodeOutputDir)) {
  fs.mkdirSync(transcodeOutputDir, { recursive: true });
}
console.log(`ðŸ“ Transcode output directory: ${transcodeOutputDir}`);

// IPC Handler to check if a file requires transcoding
ipcMain.handle(
  'transcode:requires-transcoding',
  async (event, filePath: string) => {
    console.log(
      'ðŸ” MAIN PROCESS: transcode:requires-transcoding handler called',
    );
    console.log('   File path:', filePath);

    const ext = path.extname(filePath).toLowerCase();

    // Check if extension requires transcoding
    if (FORMATS_REQUIRING_TRANSCODE.includes(ext)) {
      console.log(`   âœ… File requires transcoding (${ext} format)`);
      return { requiresTranscoding: true, reason: `${ext} format` };
    }

    // For other formats, check the actual codec
    if (!ffprobePath?.path) {
      console.log('   âš ï¸ FFprobe not available, cannot check codec');
      return { requiresTranscoding: false, reason: 'Cannot detect codec' };
    }

    try {
      const codecResult = await new Promise<string | null>((resolve) => {
        const ffprobe = spawn(ffprobePath.path, [
          '-v',
          'quiet',
          '-select_streams',
          'v:0',
          '-show_entries',
          'stream=codec_name',
          '-of',
          'default=noprint_wrappers=1:nokey=1',
          filePath,
        ]);

        let output = '';
        ffprobe.stdout.on('data', (data) => {
          output += data.toString();
        });

        ffprobe.on('close', (code) => {
          if (code === 0 && output.trim()) {
            resolve(output.trim().toLowerCase());
          } else {
            resolve(null);
          }
        });

        ffprobe.on('error', () => resolve(null));
      });

      if (
        codecResult &&
        UNSUPPORTED_CODECS.some((c) => codecResult.includes(c))
      ) {
        console.log(`   âœ… File requires transcoding (${codecResult} codec)`);
        return { requiresTranscoding: true, reason: `${codecResult} codec` };
      }

      console.log(
        `   âŒ File does not require transcoding (codec: ${codecResult || 'unknown'})`,
      );
      return { requiresTranscoding: false, reason: 'Supported format' };
    } catch (error) {
      console.warn('   âš ï¸ Could not detect codec:', error);
      return { requiresTranscoding: false, reason: 'Cannot detect codec' };
    }
  },
);

// IPC Handler to start transcoding
ipcMain.handle(
  'transcode:start',
  async (
    event,
    options: {
      mediaId: string;
      inputPath: string;
      videoBitrate?: string;
      audioBitrate?: string;
      crf?: number;
    },
  ) => {
    console.log('ðŸŽ¬ MAIN PROCESS: transcode:start handler called');
    console.log('   Media ID:', options.mediaId);
    console.log('   Input path:', options.inputPath);

    if (!ffmpegPath) {
      return { success: false, error: 'FFmpeg not available' };
    }

    // Generate job ID and output path
    const jobId = crypto.randomUUID();
    const outputFileName = `${jobId}.mp4`;
    const outputPath = path.join(transcodeOutputDir, outputFileName);

    // Get video metadata first
    let duration = 0;
    if (ffprobePath?.path) {
      try {
        duration = await new Promise<number>((resolve) => {
          const ffprobe = spawn(ffprobePath.path, [
            '-v',
            'quiet',
            '-print_format',
            'json',
            '-show_format',
            options.inputPath,
          ]);

          let output = '';
          ffprobe.stdout.on('data', (data) => {
            output += data.toString();
          });

          ffprobe.on('close', () => {
            try {
              const metadata = JSON.parse(output);
              resolve(parseFloat(metadata.format?.duration || '0'));
            } catch {
              resolve(0);
            }
          });

          ffprobe.on('error', () => resolve(0));
        });
      } catch {
        duration = 0;
      }
    }

    // Create job
    const job: TranscodeJob = {
      id: jobId,
      mediaId: options.mediaId,
      inputPath: options.inputPath,
      outputPath,
      status: 'processing',
      progress: 0,
      duration,
      currentTime: 0,
      startedAt: Date.now(),
    };

    activeTranscodeJobs.set(jobId, job);

    console.log(`   Job ID: ${jobId}`);
    console.log(`   Output path: ${outputPath}`);
    console.log(`   Duration: ${duration.toFixed(2)}s`);

    // Build FFmpeg arguments
    const args = [
      '-i',
      options.inputPath,
      '-c:v',
      'libx264',
      '-preset',
      'medium',
      '-crf',
      String(options.crf || 23),
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      options.audioBitrate || '192k',
      '-ac',
      '2',
      '-movflags',
      '+faststart',
      '-progress',
      'pipe:1',
      '-y',
      outputPath,
    ];

    console.log(`   FFmpeg command: ffmpeg ${args.join(' ')}`);

    let stderrOutput = '';

    const ffmpegTask = runQueuedFfmpeg(args, {
      priority: 2,
      timeoutMs: 30 * 60 * 1000, // 30 minutes
      onStart: (proc) => {
        job.process = proc;
        if (job.status === 'cancelled') {
          proc.kill('SIGTERM');
        }
      },
      onStdout: (data) => {
        const output = data.toString();

        // Parse progress
        const timeMatch = output.match(/out_time_ms=(\d+)/);
        if (timeMatch) {
          const currentTimeMs = parseInt(timeMatch[1], 10);
          job.currentTime = currentTimeMs / 1000000;

          if (job.duration > 0) {
            job.progress = Math.min(
              100,
              (job.currentTime / job.duration) * 100,
            );
          }

          // Send progress to renderer
          mainWindow?.webContents.send('transcode:progress', {
            jobId: job.id,
            mediaId: job.mediaId,
            status: job.status,
            progress: job.progress,
            currentTime: job.currentTime,
            duration: job.duration,
          });
        }
      },
      onStderr: (data) => {
        stderrOutput += data.toString();
      },
    });

    void ffmpegTask
      .then((result) => {
        if (result.timedOut) {
          job.status = 'failed';
          job.error = 'FFmpeg transcode timed out';
          mainWindow?.webContents.send('transcode:completed', {
            jobId: job.id,
            mediaId: job.mediaId,
            success: false,
            error: job.error,
          });
          delete job.process;
          return;
        }

        if (result.code === 0) {
          job.status = 'completed';
          job.progress = 100;
          job.completedAt = Date.now();

          const processingTime =
            job.completedAt - (job.startedAt || job.completedAt);
          console.log(
            `âœ… Transcode completed: ${jobId} in ${(processingTime / 1000).toFixed(1)}s`,
          );

          // Create preview URL for the transcoded file
          const previewUrl = `http://localhost:${MEDIA_SERVER_PORT}/${encodeURIComponent(outputPath)}`;

          mainWindow?.webContents.send('transcode:completed', {
            jobId: job.id,
            mediaId: job.mediaId,
            success: true,
            outputPath,
            previewUrl,
          });

          delete job.process;
          return;
        }

        if (job.status === 'cancelled') {
          console.log(`ðŸš« Transcode cancelled: ${jobId}`);

          // Clean up output file
          if (fs.existsSync(outputPath)) {
            try {
              fs.unlinkSync(outputPath);
            } catch (e) {
              console.warn('   Could not delete incomplete transcode file');
            }
          }

          mainWindow?.webContents.send('transcode:completed', {
            jobId: job.id,
            mediaId: job.mediaId,
            success: false,
            error: 'Cancelled',
          });
        } else {
          job.status = 'failed';
          job.error =
            stderrOutput.slice(-500) ||
            `FFmpeg exited with code ${result.code}`;

          console.error(`âŒ Transcode failed: ${jobId}`);
          console.error(`   Error: ${job.error}`);

          mainWindow?.webContents.send('transcode:completed', {
            jobId: job.id,
            mediaId: job.mediaId,
            success: false,
            error: job.error,
          });
        }

        delete job.process;
      })
      .catch((error) => {
        job.status = 'failed';
        job.error = error instanceof Error ? error.message : 'Unknown error';

        console.error(`âŒ Transcode process error: ${jobId}`);
        console.error(`   Error: ${job.error}`);

        mainWindow?.webContents.send('transcode:completed', {
          jobId: job.id,
          mediaId: job.mediaId,
          success: false,
          error: job.error,
        });
      });

    return {
      success: true,
      jobId,
      outputPath,
    };
  },
);

// IPC Handler to get transcode job status
ipcMain.handle('transcode:status', async (event, jobId: string) => {
  const job = activeTranscodeJobs.get(jobId);
  if (!job) {
    return { success: false, error: 'Job not found' };
  }

  return {
    success: true,
    job: {
      id: job.id,
      mediaId: job.mediaId,
      status: job.status,
      progress: job.progress,
      duration: job.duration,
      currentTime: job.currentTime,
      error: job.error,
    },
  };
});

// IPC Handler to cancel transcode job
ipcMain.handle('transcode:cancel', async (event, jobId: string) => {
  console.log('ðŸ›‘ MAIN PROCESS: transcode:cancel handler called');
  console.log('   Job ID:', jobId);

  const job = activeTranscodeJobs.get(jobId);
  if (!job) {
    return { success: false, error: 'Job not found' };
  }

  if (job.process && !job.process.killed) {
    job.status = 'cancelled';
    job.process.kill('SIGTERM');
    console.log(`   Cancelled job: ${jobId}`);
    return { success: true };
  }

  job.status = 'cancelled';
  return { success: true, message: 'Job queued for cancellation' };
});

// IPC Handler to cancel all transcode jobs for a media ID
ipcMain.handle('transcode:cancel-for-media', async (event, mediaId: string) => {
  console.log('ðŸ›‘ MAIN PROCESS: transcode:cancel-for-media handler called');
  console.log('   Media ID:', mediaId);

  let cancelled = 0;
  for (const [jobId, job] of activeTranscodeJobs.entries()) {
    if (
      job.mediaId === mediaId &&
      (job.status === 'queued' || job.status === 'processing')
    ) {
      job.status = 'cancelled';
      if (job.process && !job.process.killed) {
        job.process.kill('SIGTERM');
      }
      cancelled++;
    }
  }

  console.log(`   Cancelled ${cancelled} jobs`);
  return { success: true, cancelled };
});

// IPC Handler to get all active transcode jobs
ipcMain.handle('transcode:get-active-jobs', async () => {
  const jobs = Array.from(activeTranscodeJobs.values())
    .filter((job) => job.status === 'queued' || job.status === 'processing')
    .map((job) => ({
      id: job.id,
      mediaId: job.mediaId,
      status: job.status,
      progress: job.progress,
      duration: job.duration,
      currentTime: job.currentTime,
    }));

  return { success: true, jobs };
});

// IPC Handler to cleanup old transcode files with EMFILE protection
ipcMain.handle(
  'transcode:cleanup',
  async (event, maxAgeMs: number = 24 * 60 * 60 * 1000) => {
    console.log('ðŸ§¹ MAIN PROCESS: transcode:cleanup handler called');

    try {
      // Read directory with retry for EMFILE protection
      let files: string[] = [];
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          files = fs.readdirSync(transcodeOutputDir);
          break;
        } catch (err) {
          if (isEMFILEError(err) && attempt < 3) {
            console.warn(`âš ï¸ EMFILE reading transcode dir, retry ${attempt}/3`);
            await new Promise((r) => setTimeout(r, 500 * attempt));
          } else {
            throw err;
          }
        }
      }

      const now = Date.now();
      let cleaned = 0;
      const errors: string[] = [];

      // Process deletions in batches to prevent EMFILE
      const BATCH_SIZE = 5;
      const filesToDelete: string[] = [];

      // First pass: identify files to delete
      for (const file of files) {
        const filePath = path.join(transcodeOutputDir, file);
        try {
          const stats = fs.statSync(filePath);
          const age = now - stats.mtimeMs;
          if (age > maxAgeMs) {
            filesToDelete.push(filePath);
          }
        } catch (statErr) {
          // Skip files we can't stat
          console.warn(`âš ï¸ Could not stat ${file}:`, statErr);
        }
      }

      // Second pass: delete in batches
      for (let i = 0; i < filesToDelete.length; i += BATCH_SIZE) {
        const batch = filesToDelete.slice(i, i + BATCH_SIZE);
        const batchPromises = batch.map(async (filePath) => {
          try {
            await fileIOManager.deleteFile(filePath, 'low');
            return true;
          } catch (err) {
            const errorMessage = err instanceof Error ? err.message : 'Unknown';
            errors.push(`${path.basename(filePath)}: ${errorMessage}`);
            return false;
          }
        });

        const results = await Promise.all(batchPromises);
        cleaned += results.filter(Boolean).length;
      }

      console.log(`   Cleaned ${cleaned} old transcode files`);
      return {
        success: true,
        cleaned,
        errors: errors.length > 0 ? errors : undefined,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      console.error('   Error cleaning up:', errorMessage);

      if (isEMFILEError(error)) {
        return {
          success: false,
          error:
            'System file limit reached during cleanup. Please try again later.',
        };
      }

      return {
        success: false,
        error: errorMessage,
      };
    }
  },
);

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

  logStartupPerf();

  if (mainWindow) {
    const fallbackShow = setTimeout(() => {
      if (!mainWindow) return;
      if (!mainWindow.isVisible()) {
        logStartupPerf();
        mainWindow.show();
      }
      kickoffDeferredInitialization();
    }, 1200);

    mainWindow.webContents.once('did-start-loading', () => {
      logStartupPerf();
    });

    mainWindow.webContents.on('render-process-gone', (_event, details) => {
      console.error('[CRASH] Renderer process gone:', details.reason, details.exitCode);
    });

    mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
      if (level === 3) console.error(`[RENDERER ERROR] ${sourceId}:${line} — ${message}`);
    });

    mainWindow.webContents.once('dom-ready', () => {
      logStartupPerf();
      // DOM is ready, loader HTML is already visible from index.html
      // Show window immediately since loader is in HTML
      if (mainWindow && !mainWindow.isVisible()) {
        clearTimeout(fallbackShow);
        mainWindow.show();
        kickoffDeferredInitialization();
      }
    });

    mainWindow.webContents.once('did-finish-load', () => {
      logStartupPerf();

      // Send pending file path to renderer if app was opened with a .dividr file
      if (pendingFilePath && mainWindow) {
        mainWindow.webContents.send('open-project-file', pendingFilePath);
        pendingFilePath = null;
      }
    });

    // Show window when ready (fallback)
    mainWindow.once('ready-to-show', () => {
      clearTimeout(fallbackShow);
      logStartupPerf();
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
        // ðŸš« Remove all default menus so "View â†’ Toggle Developer Tools" disappears
        // Menu.setApplicationMenu(null);

        // ðŸš« Block DevTools shortcuts, but allow clipboard shortcuts
        mainWindow.webContents.on('before-input-event', (event, input) => {
          const ctrl = input.control || input.meta;
          // Allow clipboard: Ctrl+C, Ctrl+X, Ctrl+V, Ctrl+A, Ctrl+Z, Ctrl+Y
          if (ctrl && ['c','x','v','a','z','y'].includes(input.key.toLowerCase())) return;
          if (
            (input.control && input.shift && input.key.toLowerCase() === 'i') ||
            input.key === 'F12' ||
            (process.platform === 'darwin' && input.meta && input.alt && input.key.toLowerCase() === 'i')
          ) {
            event.preventDefault();
          }
        });

        // ðŸš« If DevTools somehow open, force-close them
        mainWindow.webContents.on('devtools-opened', () => {
          mainWindow?.webContents.closeDevTools();
        });

      }

      // Right-click context menu â€” always show, Copy enabled when text is selected
      mainWindow.webContents.on('context-menu', (e, params) => {
        e.preventDefault();
        const { Menu } = require('electron');
        const menu = Menu.buildFromTemplate([
          {
            label: 'Copy',
            enabled: params.selectionText.length > 0,
            click: () => mainWindow?.webContents.copy(),
          },
          {
            label: 'Paste',
            click: () => mainWindow?.webContents.paste(),
          },
        ]);
        menu.popup({ window: mainWindow! });
      });
    }

    // Handle window close events - hide instead of close
    mainWindow.on('close', async (event) => {
      if (!forceQuit) {
        // Get the real-time setting
        const shouldRunInBackground = await getRunInBackgroundSetting();
        console.log('Window closing, checking setting:', shouldRunInBackground);

        if (shouldRunInBackground) {
          event.preventDefault();
          mainWindow?.hide();
          return false;
        }
      }
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
      mainWindow?.webContents.send('window-maximize-changed', true);
    });

    mainWindow.on('unmaximize', () => {
      mainWindow?.webContents.send('window-maximize-changed', false);
    });

    // Prevent navigation to external URLs
    mainWindow.webContents.on('will-navigate', (event) => {
      event.preventDefault();
    });
  }
};

// MAIN FUNCTIONS FOR TITLE BAR
ipcMain.on('close-btn', () => {
  if (!mainWindow) return;
  app.quit();
});

ipcMain.on('minimize-btn', () => {
  if (mainWindow) mainWindow.minimize();
});

ipcMain.on('maximize-btn', () => {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) {
    mainWindow.unmaximize();
  } else {
    mainWindow.maximize();
  }
});

// Get current maximize state
ipcMain.handle('get-maximize-state', () => {
  if (!mainWindow) return false;
  return mainWindow.isMaximized();
});

ipcMain.handle(
  'set-titlebar-overlay',
  (
    _event,
    options: { color?: string; symbolColor?: string; height?: number },
  ) => {
    applyTitlebarOverlay(options);
    return process.platform === 'win32' && !!mainWindow;
  },
);

ipcMain.handle('set-window-fullscreen', (_event, isFullscreen: boolean) => {
  if (!mainWindow) return false;
  const nextState = Boolean(isFullscreen);
  if (process.platform === 'darwin') {
    const macWindow = mainWindow as BrowserWindow & {
      setSimpleFullScreen?: (v: boolean) => void;
    };
    if (typeof macWindow.setSimpleFullScreen === 'function') {
      macWindow.setSimpleFullScreen(nextState);
    } else {
      mainWindow.setFullScreen(nextState);
    }
    return true;
  }

  mainWindow.setFullScreen(nextState);
  return true;
});

// Helper function to get run in background setting
async function getRunInBackgroundSetting(): Promise<boolean> {
  // This would typically read from a settings file or store
  // For now, return false as default
  return false;
}

// â”€â”€ yt-dlp download handlers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const ytdlpProcesses = new Map<string, ReturnType<typeof spawn>>();

function getYtdlpPath(): string {
  // 1. Bundled alongside the app
  const bundled = path.join(app.getAppPath(), 'yt-dlp.exe');
  if (fs.existsSync(bundled)) return bundled;

  // 2. Known install locations on Windows
  const winCandidates = [
    path.join(os.homedir(), 'AppData', 'Local', 'Microsoft', 'WinGet', 'Packages',
      'yt-dlp.yt-dlp_Microsoft.Winget.Source_8wekyb3d8bbwe', 'yt-dlp.exe'),
    path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Python', 'Python312', 'Scripts', 'yt-dlp.exe'),
    path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Python', 'Python311', 'Scripts', 'yt-dlp.exe'),
    path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Python', 'Python310', 'Scripts', 'yt-dlp.exe'),
    'C:\\ProgramData\\chocolatey\\bin\\yt-dlp.exe',
    path.join(os.homedir(), 'scoop', 'shims', 'yt-dlp.exe'),
  ];
  for (const candidate of winCandidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  // 3. Resolve via `where` (Windows) or `which` (Unix) so spawn gets a full path
  try {
    const whereCmd = process.platform === 'win32' ? 'where' : 'which';
    const result = spawnSync(whereCmd, ['yt-dlp'], { encoding: 'utf8' });
    if (result.status === 0 && result.stdout) {
      const found = result.stdout.trim().split('\n')[0].trim();
      if (found && fs.existsSync(found)) return found;
    }
  } catch {}

  return 'yt-dlp'; // last resort — may still fail if not in Electron's PATH
}

export interface VideoChapter {
  start: number; // seconds into the source
  title: string;
}

/**
 * Fetch YouTube/source chapters without downloading the video.
 * Uses `yt-dlp --print "%(chapters)j"` which prints the chapters array as JSON
 * (or "NA"/empty when the video has none). Returns null when there are no chapters
 * so callers can cheaply gate the timeline overlay on "does this source have chapters".
 */
async function fetchSourceChapters(
  ytdlp: string,
  url: string,
  extraArgs: string[] = [],
): Promise<VideoChapter[] | null> {
  try {
    const raw: string = await new Promise((res, rej) => {
      let out = '';
      let err = '';
      const p = spawn(
        ytdlp,
        [url, '--print', '%(chapters)j', '--skip-download', '--no-warnings', ...extraArgs],
        { shell: false },
      );
      p.stdout?.on('data', (c: Buffer) => { out += c.toString(); });
      p.stderr?.on('data', (c: Buffer) => { err += c.toString(); });
      p.on('close', (code) =>
        code === 0 ? res(out) : rej(new Error(err.trim().split('\n').pop() || `exit ${code}`)),
      );
      p.on('error', rej);
      // Hard cap — never let a metadata probe stall the download flow
      setTimeout(() => { try { p.kill(); } catch {} rej(new Error('timed out')); }, 25000);
    });
    const trimmed = raw.trim();
    if (!trimmed || trimmed === 'NA' || trimmed === 'null') return null;
    const parsed = JSON.parse(trimmed) as Array<{ start_time?: number; title?: string }>;
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    const chapters = parsed
      .filter((c) => typeof c.start_time === 'number')
      .map((c, i) => ({ start: Math.max(0, c.start_time as number), title: (c.title ?? `Chapter ${i + 1}`).trim() }))
      .sort((a, b) => a.start - b.start);
    return chapters.length ? chapters : null;
  } catch (e) {
    // Re-throw so the caller can surface why it failed; caller treats it as "no chapters".
    throw e instanceof Error ? e : new Error(String(e));
  }
}

function inferFileType(filePath: string): 'video' | 'audio' | 'image' {
  const ext = path.extname(filePath).toLowerCase().slice(1);
  if (['mp3', 'wav', 'aac', 'flac', 'ogg', 'm4a', 'opus'].includes(ext)) return 'audio';
  if (['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp'].includes(ext)) return 'image';
  return 'video';
}

ipcMain.handle('media:initDownloadDir', async () => {
  const dlDir = path.join(os.homedir(), 'Dividr Downloads');
  try {
    if (!fs.existsSync(dlDir)) fs.mkdirSync(dlDir, { recursive: true });
    return { success: true, path: dlDir };
  } catch (e) {
    return { success: false, error: String(e) };
  }
});

async function extractPreviewFrame(
  filePath: string,
  ffmpegBin: string,
): Promise<string | null> {
  const os2 = await import('os');
  const tmpFrame = path.join(os2.tmpdir(), `dividr_preview_${Date.now()}.jpg`);
  try {
    await new Promise<void>((resolve) => {
      const p = spawn(ffmpegBin, [
        '-ss', '5',
        '-i', filePath,
        '-frames:v', '1',
        '-q:v', '3',
        '-y', tmpFrame,
      ], { shell: false });
      p.on('close', () => resolve());
      p.on('error', () => resolve());
    });
    if (!fs.existsSync(tmpFrame)) return null;
    return fs.readFileSync(tmpFrame).toString('base64');
  } catch {
    return null;
  } finally {
    try { fs.unlinkSync(tmpFrame); } catch {}
  }
}

async function verifyClipContent(
  filePath: string,
  ffmpegBin: string,
  anthropicApiKey: string,
  verify: string,
  sendMsg: (text: string) => void,
): Promise<{ passed: boolean; reason: string; frameBase64: string | null }> {
  try {
    const durationSeconds = await getVideoDuration(filePath, ffmpegBin);
    const count = Math.min(6, Math.max(2, Math.ceil(durationSeconds / 4)));
    const timestamps = Array.from({ length: count }, (_, i) =>
      Math.max(1, Math.floor(durationSeconds * (i + 0.5) / count)),
    );

    const validFrames: { index: number; ts: number; b64: string }[] = [];
    for (let i = 0; i < timestamps.length; i++) {
      const tmpFrame = path.join(os.tmpdir(), `dividr_cv_${Date.now()}_${i}.jpg`);
      await new Promise<void>((resolve) => {
        const p = spawn(ffmpegBin, ['-ss', String(timestamps[i]), '-i', filePath, '-frames:v', '1', '-q:v', '3', '-y', tmpFrame], { shell: false });
        p.on('close', () => resolve());
        p.on('error', () => resolve());
      });
      if (fs.existsSync(tmpFrame)) {
        validFrames.push({ index: i + 1, ts: timestamps[i], b64: fs.readFileSync(tmpFrame).toString('base64') });
        try { fs.unlinkSync(tmpFrame); } catch {}
      }
    }

    if (!validFrames.length) return { passed: false, reason: 'no frames extracted', frameBase64: null };

    const content: any[] = [];
    for (const f of validFrames) {
      content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: f.b64 } });
      content.push({ type: 'text', text: `Frame ${f.index} (${f.ts}s):` });
    }
    content.push({
      type: 'text',
      text: `These ${validFrames.length} frames are sampled evenly from a downloaded YouTube video.\n\nRequirement: "${verify}"\n\nYou must assess whether THIS VIDEO is genuinely about the required topic — not just whether one frame looks vaguely similar.\n\nREJECT (passed: false) if ANY of these are true:\n- Fewer than half the frames show content that matches the requirement\n- The video appears to be about a completely different topic (e.g. a branding/logo video, wrong subject, unrelated documentary)\n- Any frame shows a title card, channel logo, creator name, or intro screen with visible text — this signals the wrong video was downloaded\n- The frames show only abstract visuals that superficially resemble the topic but don't actually show it\n\nPASS (passed: true) only if:\n- The MAJORITY of frames clearly show the required content\n- The video is genuinely about the described topic, not just one frame that happens to look similar\n\nReply ONLY with JSON:\n{"passed": true or false, "reason": "one sentence explaining the decision", "bestFrameIndex": <1-${validFrames.length}>}`,
    });

    sendMsg('↳ Verifying clip content…');

    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': anthropicApiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 150, messages: [{ role: 'user', content }] }),
    });

    if (!resp.ok) return { passed: true, reason: 'verify skipped (api error)', frameBase64: validFrames[0]?.b64 ?? null };

    const data = await resp.json() as any;
    const text: string = data.content?.[0]?.text?.trim() ?? '';
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return { passed: true, reason: 'verify skipped (parse error)', frameBase64: validFrames[0]?.b64 ?? null };

    const result = JSON.parse(m[0]);
    const bestIdx = result.bestFrameIndex != null
      ? Math.max(0, Math.min(result.bestFrameIndex - 1, validFrames.length - 1))
      : (result.best != null ? Math.max(0, Math.min(result.best - 1, validFrames.length - 1)) : 0);
    return {
      passed: !!result.passed,
      reason: result.reason ?? '',
      frameBase64: validFrames[bestIdx]?.b64 ?? null,
    };
  } catch {
    return { passed: true, reason: 'verify skipped', frameBase64: null };
  }
}

async function verifyBrollQuality(
  filePath: string,
  anthropicApiKey: string,
  verify?: string,
): Promise<{ passed: boolean; reason: string }> {
  const os2 = await import('os');
  const tmpFramePaths: string[] = [];

  try {
    // Get duration so we can spread 5 frames across the clip
    const duration = await getVideoDuration(filePath, ffmpegPath!);
    const clampedDuration = Math.max(duration, 1);

    // Sample at 10%, 25%, 50%, 75%, 90% of the clip
    const timestamps = [0.1, 0.25, 0.5, 0.75, 0.9]
      .map((f) => Math.max(0.5, clampedDuration * f));

    const frames: { index: number; ts: number; b64: string }[] = [];

    for (let i = 0; i < timestamps.length; i++) {
      const tmpPath = path.join(os2.tmpdir(), `broll_check_${Date.now()}_${i}.jpg`);
      tmpFramePaths.push(tmpPath);

      await new Promise<void>((resolve) => {
        const p = spawn(ffmpegPath!, ['-ss', String(timestamps[i]), '-i', filePath, '-frames:v', '1', '-q:v', '3', '-y', tmpPath], { shell: false });
        p.on('close', () => resolve());
        p.on('error', () => resolve());
      });

      if (fs.existsSync(tmpPath)) {
        frames.push({ index: i + 1, ts: timestamps[i], b64: fs.readFileSync(tmpPath).toString('base64') });
      }
    }

    if (frames.length === 0) return { passed: true, reason: 'no frames extracted' };

    // Build multi-frame content array for the vision request
    const content: any[] = [];
    for (const f of frames) {
      content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: f.b64 } });
      content.push({ type: 'text', text: `Frame ${f.index} at ${f.ts.toFixed(1)}s:` });
    }
    const contentRequirement = verify
      ? `\n\nCONTENT REQUIREMENT — the clip MUST visually show: "${verify}"\nREJECT if the frames do not match this description, even if the clip is high quality.`
      : '';
    content.push({
      type: 'text',
      text: `These are ${frames.length} frames sampled evenly across a downloaded B-roll clip. Reply ONLY with JSON: {"passed": true/false, "reason": "one short sentence"}${contentRequirement}\n\nALSO REJECT if ANY of these quality issues are present:\n- STILL IMAGE: all frames look identical or nearly identical — no motion, no scene change. This is a photo exported as video. REJECT IT.\n- Visible text, captions, watermarks, or branded logos\n- Person looking directly at the camera (interview or talking-head style)\n- Visibly low quality, heavily compressed, or blurry footage\n\nALLOW if:\n- Frames show clear visual variation (motion, lighting changes) indicating real video\n- Content visually matches the requirement above\n- People appear but are doing a task and NOT looking at camera\n\nRespond ONLY with the JSON object, no markdown.`,
    });

    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': anthropicApiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 150,
        messages: [{ role: 'user', content }],
      }),
    });

    const data = await resp.json() as any;
    const text: string = data.content?.[0]?.text?.trim() ?? '{"passed":true}';
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return { passed: true, reason: 'parse error' };
    const result = JSON.parse(m[0]);
    return { passed: !!result.passed, reason: result.reason ?? '' };
  } catch {
    return { passed: true, reason: 'check skipped' };
  } finally {
    for (const p of tmpFramePaths) {
      try { fs.unlinkSync(p); } catch {}
    }
  }
}
async function extractFrameAtSec(filePath: string, ffmpegBin: string, atSec: number): Promise<string | null> {
  const tmp = path.join(os.tmpdir(), `dividr_verify_${Date.now()}.jpg`);
  await new Promise<void>((resolve) => {
    const p = spawn(ffmpegBin, ['-ss', String(Math.max(0, atSec)), '-i', filePath, '-frames:v', '1', '-q:v', '3', '-y', tmp], { shell: false });
    p.on('close', () => resolve());
    p.on('error', () => resolve());
  });
  try {
    if (fs.existsSync(tmp)) {
      const b64 = fs.readFileSync(tmp).toString('base64');
      fs.unlinkSync(tmp);
      return b64;
    }
  } catch { /* ignore */ }
  return null;
}

// Contact-sheet verification of a downloaded clip — the same batch-panel pipeline the
// findMoment op uses (timestamped frames tiled into sheets, temp JPEGs deleted the
// moment they're sent). A found timestamp doubles as proof AND tells EDITH where the
// wanted scene lives inside the clip. Returns null on infrastructure failure (python
// venv / claude CLI unavailable) so the caller can fall back to the discrete-frame
// Haiku check instead of rubber-stamping the download.
async function verifyClipByContactSheets(
  filePath: string,
  verify: string,
  sendMsg: (text: string) => void,
): Promise<{ passed: boolean; reason: string; foundAtSec: number | null; frameBase64: string | null } | null> {
  sendMsg('Frame-verifying the clip against: "' + verify + '"...');
  let res: any;
  try {
    res = await runPythonSkill('find-moment', ['--input', filePath, '--target', verify, '--interval', '0.5', '--start', '0', '--dense'], 'verifyDownload');
  } catch {
    return null;
  }
  // find_moment reports vision-infrastructure failures as a "clean miss" with an
  // error field — that is NOT a scanned-and-absent verdict. Fall back, don't reject.
  if (res?.error || res?.success === false) return null;
  const foundAtSec = typeof res?.foundAtSec === 'number' ? res.foundAtSec : null;
  if (foundAtSec === null) {
    return { passed: false, reason: `no frame in the clip shows "${verify}"`, foundAtSec: null, frameBase64: null };
  }
  const mm = Math.floor(foundAtSec / 60);
  const ss = Math.floor(foundAtSec % 60).toString().padStart(2, '0');
  const frameBase64 = ffmpegPath ? await extractFrameAtSec(filePath, ffmpegPath, foundAtSec) : null;
  return {
    passed: true,
    reason: `"${verify}" confirmed at ${mm}:${ss} (${res?.confidence ?? 'medium'} confidence)`,
    foundAtSec,
    frameBase64,
  };
}

async function getVideoDuration(filePath: string, ffmpegBin: string): Promise<number> {
  return new Promise<number>((resolve) => {
    // Try ffprobe first (more reliable), fall back to ffmpeg -i stderr parsing
    const ffprobeBin = ffmpegBin.replace(/ffmpeg(\.exe)?$/i, (_, ext) => `ffprobe${ext ?? ''}`);
    const useFFprobe = fs.existsSync(ffprobeBin);
    if (useFFprobe) {
      let out = '';
      const p = spawn(ffprobeBin, ['-v', 'quiet', '-show_entries', 'format=duration', '-of', 'csv=p=0', filePath], { shell: false });
      p.stdout?.on('data', (c: Buffer) => { out += c.toString(); });
      p.on('close', () => { const d = parseFloat(out.trim()); resolve(isNaN(d) ? 0 : d); });
      p.on('error', () => resolve(0));
    } else {
      let stderr = '';
      const p = spawn(ffmpegBin, ['-i', filePath, '-f', 'null', '-'], { shell: false });
      p.stderr?.on('data', (c: Buffer) => { stderr += c.toString(); });
      p.on('close', () => {
        const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+\.?\d*)/);
        resolve(m ? parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseFloat(m[3]) : 0);
      });
      p.on('error', () => resolve(0));
    }
  });
}

// Scan the first 15s of a video and find where the title card/intro ends.
// Returns 0 if no intro detected (content starts immediately).
async function detectIntroEndSec(
  filePath: string,
  ffmpegBin: string,
  anthropicApiKey: string,
): Promise<number> {
  const timestamps = [1, 3, 5, 8, 12, 17, 22, 28];
  const frames: { ts: number; b64: string }[] = [];

  for (const ts of timestamps) {
    const tmpPath = path.join(os.tmpdir(), `intro_${Date.now()}_${ts}.jpg`);
    await new Promise<void>((resolve) => {
      const p = spawn(ffmpegBin, ['-ss', String(ts), '-i', filePath, '-frames:v', '1', '-q:v', '4', '-y', tmpPath], { shell: false });
      p.on('close', () => resolve());
      p.on('error', () => resolve());
    });
    if (fs.existsSync(tmpPath)) {
      try { frames.push({ ts, b64: fs.readFileSync(tmpPath).toString('base64') }); fs.unlinkSync(tmpPath); } catch {}
    }
  }

  if (!frames.length) return 0;

  const content: any[] = [];
  for (const f of frames) {
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: f.b64 } });
    content.push({ type: 'text', text: `Frame at ${f.ts}s:` });
  }
  content.push({
    type: 'text',
    text: `These frames are from the opening of a YouTube video. Find the LAST second that still shows any title card, intro screen, or creator branding — even if it is fading out. Title cards include: film/video title text, creator name, channel logo, version numbers, subtitle text, or any graphic/animated intro screen. A frame still counts as "title card" even if text is partially transparent or fading.\n\nIf the video has NO title card, reply: {"introEndSec":0}\nOtherwise reply: {"introEndSec":<last second where title/branding is still visible, then add 3 seconds as a safety buffer>}\n\nReply ONLY with JSON, no markdown.`,
  });

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': anthropicApiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 60, messages: [{ role: 'user', content }] }),
    });
    if (!resp.ok) return 0;
    const data = await resp.json() as any;
    const raw: string = data.content?.[0]?.text?.trim() ?? '';
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return 0;
    const result = JSON.parse(m[0]);
    return Math.max(0, Number(result.introEndSec ?? 0));
  } catch { return 0; }
}

async function findBestYouTubeSegment(
  filePath: string,
  ffmpegBin: string,
  anthropicApiKey: string,
  query: string,
  sendMsg: (text: string) => void,
): Promise<string> {
  try {
    const durationSeconds = await getVideoDuration(filePath, ffmpegBin);
    if (durationSeconds < 25) return filePath; // already short enough

    sendMsg('↳ Scanning footage for best segment…');

    // Extract 5 frames evenly spaced across the video
    const positions = [0.10, 0.25, 0.50, 0.70, 0.90];
    const timestamps = positions.map((p) => Math.max(1, Math.floor(durationSeconds * p)));
    const framePaths: string[] = [];

    for (const ts of timestamps) {
      const tmpFrame = path.join(os.tmpdir(), `yt_seg_${Date.now()}_${ts}.jpg`);
      await new Promise<void>((resolve) => {
        const p = spawn(ffmpegBin, ['-ss', String(ts), '-i', filePath, '-frames:v', '1', '-q:v', '3', '-y', tmpFrame], { shell: false });
        p.on('close', () => resolve());
        p.on('error', () => resolve());
      });
      framePaths.push(tmpFrame);
    }

    const validFrames: { index: number; path: string; ts: number }[] = [];
    for (let i = 0; i < framePaths.length; i++) {
      if (fs.existsSync(framePaths[i])) {
        validFrames.push({ index: i + 1, path: framePaths[i], ts: timestamps[i] });
      }
    }

    if (!validFrames.length) return filePath;

    // Send all frames to Haiku in one call — ask which best shows the target content
    const content: any[] = [];
    for (const f of validFrames) {
      const b64 = fs.readFileSync(f.path).toString('base64');
      content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } });
      content.push({ type: 'text', text: `Frame ${f.index} (at ${f.ts}s into the video):` });
    }
    content.push({
      type: 'text',
      text: `These are ${validFrames.length} frames sampled from a downloaded YouTube video. Target content: "${query}".\n\nWhich frame best shows the actual subject footage (not intro cards, title screens, or talking-head interviews)? Prefer frames with clear visual action matching the topic.\n\nReply ONLY with JSON: {"best": <frame_number_1_to_${validFrames.length}>, "reason": "one sentence"}`,
    });

    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': anthropicApiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 120, messages: [{ role: 'user', content }] }),
    });

    for (const f of validFrames) { try { fs.unlinkSync(f.path); } catch {} }

    if (!resp.ok) return filePath;

    const data = await resp.json() as any;
    const text: string = data.content?.[0]?.text?.trim() ?? '';
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return filePath;

    const result = JSON.parse(m[0]);
    const bestIdx = Math.max(0, Math.min((result.best ?? 1) - 1, validFrames.length - 1));
    const bestFrame = validFrames[bestIdx];
    if (!bestFrame) return filePath;

    sendMsg(`↳ Best segment at ${bestFrame.ts}s — ${result.reason ?? ''}`);

    // Detect intro/title card and use its end as the floor for trimStart
    const introEndSec = await detectIntroEndSec(filePath, ffmpegBin, anthropicApiKey);
    if (introEndSec > 0) sendMsg(`↳ Skipping ${introEndSec}s intro/title card`);

    // Trim a 20s window centered around the best frame, never starting before intro ends.
    // introEndSec already includes a +3s buffer from the prompt, so no extra margin needed.
    let trimStart = Math.max(introEndSec, bestFrame.ts - 10);
    const trimEnd = Math.min(durationSeconds, trimStart + 20);
    const ext = path.extname(filePath);
    const trimmedPath = filePath.replace(ext, `_segment${ext}`);

    await new Promise<void>((resolve) => {
      const ff = spawn(ffmpegBin, [
        '-ss', String(trimStart),
        '-i', filePath,
        '-t', String(trimEnd - trimStart),
        '-c', 'copy',
        '-y', trimmedPath,
      ], { shell: false });
      ff.on('close', () => resolve());
      ff.on('error', () => resolve());
    });

    if (fs.existsSync(trimmedPath)) {
      sendMsg(`↳ Trimmed to ${Math.round(trimEnd - trimStart)}s clip`);
      return trimmedPath;
    }
    return filePath;
  } catch {
    return filePath; // non-fatal — return original
  }
}

ipcMain.handle(
  'media:downloadFromUrl',
  async (event, { jobId, url, startSeconds, endSeconds, downloadDir, verify, topic, isStockFootage }: {
    jobId: string;
    url: string;
    startSeconds?: number;
    endSeconds?: number;
    downloadDir?: string;
    verify?: string;
    topic?: string;
    isStockFootage?: boolean;
  }) => {
    const ytdlp = getYtdlpPath();
    const dlDir = downloadDir || path.join(os.homedir(), 'Dividr Downloads');
    if (!fs.existsSync(dlDir)) fs.mkdirSync(dlDir, { recursive: true });

    const sendMsg = (text: string) =>
      event.sender.send('mycelium:message', { role: 'system', text });


    // â”€â”€ PRE-DOWNLOAD SPOT CHECKS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    const loadEnvKey = (key: string): string => {
      const envPath = path.join(app.getAppPath(), '.env');
      if (fs.existsSync(envPath)) {
        for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
          const [k, v] = line.split('=');
          if (k?.trim() === key) return v?.trim() ?? '';
        }
      }
      return process.env[key] ?? '';
    };

    const geminiApiKey = loadEnvKey('GEMINI_API_KEY');

    // â”€â”€ PIXABAY SEARCH â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if (url.startsWith('pixabaysearch:')) {
      const query = url.slice('pixabaysearch:'.length).trim();
      const pixabayKey = loadEnvKey('PIXABAY_API_KEY');
      if (!pixabayKey) return { success: false, error: 'PIXABAY_API_KEY not set in .env' };

      sendMsg(`â†³ Searching Pixabay for: ${query}`);
      const apiUrl = `https://pixabay.com/api/videos/?key=${pixabayKey}&q=${encodeURIComponent(query)}&video_type=film&per_page=10&safesearch=true`;
      const apiRes = await fetch(apiUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'application/json, text/plain, */*',
          'Accept-Language': 'en-US,en;q=0.9',
          'Referer': 'https://pixabay.com/',
        }
      });
      if (!apiRes.ok) {
        const errText = await apiRes.text().catch(() => String(apiRes.status));
        return { success: false, error: `Pixabay API error ${apiRes.status} — check PIXABAY_API_KEY. Details: ${errText.slice(0, 200)}` };
      }
      const contentType = apiRes.headers.get('content-type') ?? '';
      if (!contentType.includes('json')) {
        const errText = await apiRes.text().catch(() => '');
        return { success: false, error: `Pixabay returned non-JSON (key may be invalid or rate-limited). Preview: ${errText.slice(0, 150)}` };
      }
      const apiData = (await apiRes.json()) as any;
      const hits = apiData?.hits as any[];
      if (!hits?.length) return { success: false, error: `No Pixabay results for "${query}"` };

      // Score hits by views+downloads; pre-filter sub-720p by metadata, prefer 4-45s clips
      const rawScored = hits
        .filter((h: any) => {
          const bestRes = h.videos?.large ?? h.videos?.medium ?? h.videos?.small;
          const minDim = Math.min(bestRes?.width ?? 0, bestRes?.height ?? 0);
          return minDim >= 720 && h.duration >= 4 && h.duration <= 45;
        })
        .map((h: any) => ({
          hit: h,
          score: (h.views ?? 0) * 0.6 + (h.downloads ?? 0) * 0.4,
          url: h.videos?.large?.url || h.videos?.medium?.url || h.videos?.small?.url,
        }))
        .filter((s: any) => !!s.url)
        .sort((a: any, b: any) => b.score - a.score);
      if (!rawScored.length) return { success: false, error: `No Pixabay results at 720p+ for "${query}"` };

      // Shuffle within tiers to avoid always returning the same top video for the same query.
      // Tier 1: top 3 by score (shuffle among them). Tier 2: remaining (shuffle among them).
      const tier1 = rawScored.slice(0, 3).sort(() => Math.random() - 0.5);
      const tier2 = rawScored.slice(3).sort(() => Math.random() - 0.5);
      const scored = [...tier1, ...tier2];

      const anthropicApiKey = loadEnvKey('ANTHROPIC_API_KEY');
      let chosenFile: string | null = null;
      let chosenHit: any = null;
      const maxAttempts = Math.min(scored.length, 5); // try up to 5 instead of 3

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const candidate = scored[attempt];
        const cHit = candidate.hit;
        const cUrl: string = candidate.url;
        const label = cHit.tags?.split(',')[0]?.trim() ?? 'clip';
        sendMsg(`Checking B-roll candidate ${attempt + 1}/${maxAttempts}: "${label}" (${cHit.duration}s)`);

        const cRes = await fetch(cUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'video/*,*/*',
            'Accept-Language': 'en-US,en;q=0.9',
            'Referer': 'https://pixabay.com/',
          }
        });
        if (!cRes.ok) { sendMsg(`Fetch failed (${cRes.status}) — trying next`); continue; }

        const readableName = (cHit.tags?.split(',').slice(0, 3).map((t: string) => t.trim()).join('-') ?? 'pixabay-clip')
          .toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').slice(0, 50);
        const basePath = path.join(dlDir, `${readableName}.mp4`);
        const cFilePath = fs.existsSync(basePath) ? path.join(dlDir, `${readableName}-${Date.now()}.mp4`) : basePath;
        fs.writeFileSync(cFilePath, Buffer.from(await cRes.arrayBuffer()));

        if (anthropicApiKey && ffmpegPath) {
          const check = await verifyBrollQuality(cFilePath, anthropicApiKey, verify);
          event.sender.send('edith:brollCheck', {
            label,
            duration: cHit.duration,
            passed: check.passed,
            reason: check.reason,
            frameBase64: check.frameBase64 ?? null,
          });
          if (!check.passed) {
            sendMsg(`Rejected: ${check.reason} — trying next`);
            try { fs.unlinkSync(cFilePath); } catch {}
            continue;
          }
        }

        chosenFile = cFilePath;
        chosenHit = cHit;
        break;
      }

      if (!chosenFile) {
        const fallback = scored[0];
        const fRes = await fetch(fallback.url);
        if (!fRes.ok) return { success: false, error: `All Pixabay candidates failed quality check for "${query}"` };
        const readableName = (fallback.hit.tags?.split(',').slice(0, 3).map((t: string) => t.trim()).join('-') ?? 'pixabay-clip')
          .toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').slice(0, 50);
        const basePath = path.join(dlDir, `${readableName}.mp4`);
        chosenFile = fs.existsSync(basePath) ? path.join(dlDir, `${readableName}-${Date.now()}.mp4`) : basePath;
        chosenHit = fallback.hit;
        fs.writeFileSync(chosenFile, Buffer.from(await fRes.arrayBuffer()));
        sendMsg(`All checks failed — using best available`);
      }

      const pixabayTitle = chosenHit.tags?.split(',').slice(0, 3).map((t: string) => t.trim()).join(', ') ?? 'Pixabay clip';
      sendMsg(`Download complete`);
      return { success: true, filePath: chosenFile, fileType: 'video', title: pixabayTitle };
    }

    // â”€â”€ IMAGE DOWNLOADS (direct file URLs + product/pin pages) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // EDITH sources still images. Two shapes:
    //  1. A direct image file URL (Wikimedia, i.pinimg.com, i.ebayimg.com) — plain fetch.
    //  2. An eBay listing / Pinterest pin PAGE URL — those sites 403 every non-browser
    //     fetcher (incl. EDITH's WebFetch), but this app IS Chromium: load the page in a
    //     hidden window, lift the high-res image URL from the DOM, then fetch that.
    const saveImageToDisk = async (imgUrl: string, label: string) => {
      const imgRes = await fetch(imgUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'image/*,*/*',
          'Referer': new URL(imgUrl).origin + '/',
        },
      });
      if (!imgRes.ok) return { success: false as const, error: `Image fetch failed (${imgRes.status})` };
      const imgCtype = imgRes.headers.get('content-type') ?? '';
      if (!imgCtype.startsWith('image/')) {
        return { success: false as const, error: `URL did not return an image (content-type: ${imgCtype.slice(0, 60)})` };
      }
      const imgExt = (imgUrl.match(/\.(jpe?g|png|gif|webp|bmp)/i)?.[1] ?? 'jpg').toLowerCase();
      const imgLabel = (label || 'image')
        .toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'image';
      const imgBasePath = path.join(dlDir, `${imgLabel}.${imgExt}`);
      const imgPath = fs.existsSync(imgBasePath) ? path.join(dlDir, `${imgLabel}-${Date.now()}.${imgExt}`) : imgBasePath;
      fs.writeFileSync(imgPath, Buffer.from(await imgRes.arrayBuffer()));
      return { success: true as const, filePath: imgPath };
    };

    // â”€â”€ IMAGE SEARCH (DuckDuckGo Images JSON) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // `imagesearch:<query>` — real image search with structured results (direct image
    // URL + true dimensions + hosting page). Supports `site:ebay.com`-style filters,
    // skips watermark-heavy stock domains, prefers high resolution.
    if (url.startsWith('imagesearch:')) {
      const imgQuery = url.slice('imagesearch:'.length).trim();
      if (!imgQuery) return { success: false, error: 'imagesearch: empty query' };
      const WATERMARK_DOMAINS = /shutterstock|alamy|istockphoto|gettyimages|dreamstime|123rf|depositphotos|freepik|vecteezy|stock\.adobe/i;
      const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
      sendMsg(`â†³ Searching images for: ${imgQuery}`);
      try {
        const htmlRes = await fetch(
          `https://duckduckgo.com/?q=${encodeURIComponent(imgQuery)}&iax=images&ia=images`,
          { headers: { 'User-Agent': UA } },
        );
        const vqd = (await htmlRes.text()).match(/vqd=["']?([\d-]+)["']?/)?.[1];
        if (!vqd) return { success: false, error: 'Image search token not found — try again in a moment' };
        const apiRes = await fetch(
          `https://duckduckgo.com/i.js?l=us-en&o=json&q=${encodeURIComponent(imgQuery)}&vqd=${vqd}&f=,,,&p=1`,
          { headers: { 'User-Agent': UA, 'Referer': 'https://duckduckgo.com/' } },
        );
        if (!apiRes.ok) return { success: false, error: `Image search failed (${apiRes.status})` };
        const searchData = (await apiRes.json()) as { results?: Array<{ image?: string; url?: string; title?: string; width?: number; height?: number }> };
        const rawResults = (searchData.results ?? []).filter((r) => !!r.image);
        if (!rawResults.length) return { success: false, error: 'Image search returned no results — try different wording' };

        // Honor a site: filter via the hosting page, drop watermark stock, prefer >=640px.
        const siteMatch = imgQuery.match(/site:([\w.-]+)/i);
        const siteFilter = siteMatch ? siteMatch[1].toLowerCase().replace(/^www\./, '') : null;
        let ranked = rawResults.filter((r) => {
          if (WATERMARK_DOMAINS.test(r.image!) || WATERMARK_DOMAINS.test(r.url ?? '')) return false;
          if (siteFilter && !(r.url ?? '').toLowerCase().includes(siteFilter)) return false;
          return true;
        });
        if (!ranked.length) ranked = rawResults.filter((r) => !WATERMARK_DOMAINS.test(r.image!));
        if (!ranked.length) return { success: false, error: 'Only watermarked stock results found — refine the query' };
        const sharp = ranked.filter((r) => Math.min(r.width ?? 0, r.height ?? 0) >= 640);
        if (sharp.length) ranked = sharp;

        for (let i = 0; i < Math.min(ranked.length, 4); i++) {
          const cand = ranked[i];
          // eBay images upgrade to full resolution by swapping the size token.
          const candUrl = cand.image!.replace(/(i\.ebayimg\.com\/images\/g\/[^/]+\/)s-l\d+/i, '$1s-l1600');
          try {
            const saved = await saveImageToDisk(candUrl, topic || imgQuery.replace(/site:[\w.-]+/i, '').trim());
            if (saved.success) {
              sendMsg(`âœ“ Image downloaded (${cand.width}Ã—${cand.height}, from ${(cand.url ?? '').slice(0, 60)})`);
              return { success: true, filePath: saved.filePath, fileType: 'image', title: cand.title || topic || imgQuery, origin: 'imagesearch' };
            }
            sendMsg(`â†³ Candidate ${i + 1} failed (${saved.error}) — trying next`);
          } catch {
            sendMsg(`â†³ Candidate ${i + 1} unreachable — trying next`);
          }
        }
        return { success: false, error: 'All image candidates failed to download — try different wording' };
      } catch (searchErr) {
        return { success: false, error: `Image search failed: ${String((searchErr as Error)?.message ?? searchErr).slice(0, 200)}` };
      }
    }

    const isImagePageUrl = /^https?:\/\/(www\.)?ebay\.[a-z.]+\/itm\//i.test(url)
      || /^https?:\/\/([a-z]+\.)?pinterest\.[a-z.]+\/pin\//i.test(url);
    if (isImagePageUrl) {
      sendMsg('â†³ Opening the page to extract its product photoâ€¦');
      let scrapeWin: BrowserWindow | null = null;
      try {
        scrapeWin = new BrowserWindow({
          show: false,
          width: 1280,
          height: 900,
          webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
        });
        // Electron's default UA contains "Electron/…", which bot walls flag — present as plain Chrome.
        scrapeWin.webContents.setUserAgent(
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        );
        try {
          await Promise.race([
            scrapeWin.loadURL(url),
            new Promise((_, rej) => setTimeout(() => rej(new Error('page load timed out')), 25000)),
          ]);
        } catch (loadErr) {
          if (!/ERR_ABORTED/.test(String(loadErr))) throw loadErr;
        }
        for (let w = 0; w < 30 && scrapeWin.webContents.isLoading(); w++) {
          await new Promise((r) => setTimeout(r, 500));
        }
        await new Promise((r) => setTimeout(r, 3000)); // let the image gallery hydrate
        const imgUrl: string | null = await scrapeWin.webContents.executeJavaScript(
          `(() => {
            const ebay = [...document.querySelectorAll('img')]
              .map((i) => i.currentSrc || i.src || i.getAttribute('data-src') || '')
              .filter((s) => /i\\.ebayimg\\.com\\/images\\/g\\//.test(s));
            if (ebay.length) return ebay[0].replace(/s-l\\d+/, 's-l1600');
            const og = document.querySelector('meta[property="og:image"]');
            return og ? og.getAttribute('content') : null;
          })()`,
          true,
        );
        if (!imgUrl) return { success: false, error: 'No product image found on that page — try a different listing URL' };
        sendMsg('â†³ Downloading the high-res imageâ€¦');
        const saved = await saveImageToDisk(imgUrl, topic || path.basename(new URL(url).pathname));
        if (!saved.success) return { success: false, error: saved.error };
        sendMsg('âœ“ Image downloaded');
        return { success: true, filePath: saved.filePath, fileType: 'image', title: topic || 'page image', origin: 'url' };
      } catch (pageErr) {
        return { success: false, error: `Page image extraction failed: ${String((pageErr as Error)?.message ?? pageErr).slice(0, 200)}` };
      } finally {
        try { scrapeWin?.destroy(); } catch { /* already gone */ }
      }
    }

    const isDirectImageUrl = /^https?:\/\//i.test(url) && /\.(jpe?g|png|gif|webp|bmp)([?#].*)?$/i.test(url);
    if (isDirectImageUrl) {
      try {
        sendMsg('â†³ Downloading imageâ€¦');
        const saved = await saveImageToDisk(
          url,
          topic || path.basename(new URL(url).pathname, path.extname(new URL(url).pathname)),
        );
        if (!saved.success) return { success: false, error: saved.error };
        sendMsg('âœ“ Image downloaded');
        return { success: true, filePath: saved.filePath, fileType: 'image', title: topic || 'image', origin: 'url' };
      } catch (imgErr) {
        return { success: false, error: `Image download failed: ${String((imgErr as Error)?.message ?? imgErr).slice(0, 200)}` };
      }
    }

    const isSearchQuery = url.startsWith('ytsearch') || url.startsWith('ytdl:ytsearch');
    if (isSearchQuery) sendMsg(`â†³ Searching YouTube for: ${url.replace(/^ytsearch\d*:/, '').trim()}`);

    if (!GEMINI_DISABLED && geminiApiKey && (verify || topic || isStockFootage) && !isSearchQuery) {
      sendMsg('Running spot checks before downloadâ€¦');

      try {
        // Step 1: Fetch metadata via yt-dlp --dump-json (no video download)
        sendMsg('â†³ Fetching video metadataâ€¦');
        const metaJson: string = await new Promise((res, rej) => {
          let out = '';
          const p = spawn(ytdlp, [url, '--dump-json', '--no-warnings'], { shell: false });
          p.stdout?.on('data', (c: Buffer) => { out += c.toString(); });
          p.on('close', (code) => code === 0 ? res(out) : rej(new Error(`yt-dlp metadata failed (${code})`)));
          p.on('error', rej);
        });

        const meta = JSON.parse(metaJson) as { title?: string; description?: string; thumbnail?: string; tags?: string[] };
        const titleDesc = `Title: ${meta.title ?? ''}\nDescription: ${(meta.description ?? '').slice(0, 400)}\nTags: ${(meta.tags ?? []).slice(0, 10).join(', ')}`;

        // Step 2: Quick text relevance check (no Gemini needed)
        const searchTerms = (verify || topic || '').toLowerCase().split(/\s+/).filter(Boolean);
        const metaText = titleDesc.toLowerCase();
        const metaMatchScore = searchTerms.filter((t) => metaText.includes(t)).length;
        const metaCheckPassed = searchTerms.length === 0 || metaMatchScore >= Math.ceil(searchTerms.length * 0.4);
        sendMsg(`${metaCheckPassed ? 'âœ“' : 'âœ—'} Metadata: "${meta.title ?? 'unknown'}" â€” ${metaMatchScore}/${searchTerms.length} terms matched`);

        if (!metaCheckPassed) {
          return { success: false, error: `Spot check failed: video title/description does not match "${verify || topic}". Try a different URL.` };
        }

        // Step 3: Visual check via Gemini (thumbnail)
        if (meta.thumbnail) {
          sendMsg('â†³ Fetching thumbnail for visual checkâ€¦');
          const thumbRes = await fetch(meta.thumbnail);
          if (thumbRes.ok) {
            const thumbBuf = Buffer.from(await thumbRes.arrayBuffer());
            const thumbMime = thumbRes.headers.get('content-type') ?? 'image/jpeg';

            const { spotCheckImageInline } = await import('./backend/mycelium/geminiAnalyzer');

            let visualPrompt: string;
            if (isStockFootage) {
              visualPrompt = `Analyze this video thumbnail and answer each question. Return ONLY a JSON array, no markdown:
[
  {"check": "No watermarks or text overlays", "passed": true/false, "reason": "brief"},
  {"check": "No person talking directly to camera", "passed": true/false, "reason": "brief"},
  {"check": "Content relevant to topic: ${topic || 'unspecified'}", "passed": true/false, "reason": "brief"},
  {"check": "Real footage (not animated/cartoon)", "passed": true/false, "reason": "brief"}
]
Be strict on watermarks â€” even faint, semi-transparent watermarks count as failing.`;
            } else {
              visualPrompt = `Analyze this video thumbnail and answer each question. Return ONLY a JSON array, no markdown:
[
  {"check": "Content matches: ${verify || topic || 'requested topic'}", "passed": true/false, "reason": "brief"},
  {"check": "Real footage (not animated/cartoon/stock watermark)", "passed": true/false, "reason": "brief"}
]`;
            }

            const visualChecks = await spotCheckImageInline(thumbBuf, thumbMime, visualPrompt, geminiApiKey);

            for (const c of visualChecks) {
              sendMsg(`${c.passed ? 'âœ“' : 'âœ—'} ${c.check}: ${c.reason}`);
            }

            const failedChecks = visualChecks.filter((c) => !c.passed);
            if (failedChecks.length > 0) {
              const reasons = failedChecks.map((c) => c.check).join(', ');
              return { success: false, error: `Spot check failed: ${reasons}. Not downloading.` };
            }
          }
        }

        sendMsg('âœ“ All checks passed â€” proceeding with download.');
      } catch (spotErr) {
        // Spot check error is non-fatal â€” warn but continue
        sendMsg(`âš  Spot check skipped (${String(spotErr).slice(0, 80)}) â€” proceeding anyway.`);
      }
    }

    // â”€â”€ ACTUAL DOWNLOAD â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    sendMsg('â†³ Downloadingâ€¦ this may take a moment.');


    const hasSections = startSeconds !== undefined && endSeconds !== undefined;
    const videoOrigin: 'youtube' | 'url' = /youtu\.?be/i.test(url) ? 'youtube' : 'url';
    let videoChapters: VideoChapter[] | null = null;

    // YouTube authentication â€” scan Downloads for any YouTube cookies file the extension may have saved
    const cookieArgs: string[] = [];
    const dlDir2 = app.getPath('downloads');
    const cookiesFilePath = (() => {
      // Check known fixed names first
      for (const name of ['cookies_www.youtube.com.txt', 'cookies.txt']) {
        const p = path.join(dlDir2, name);
        if (fs.existsSync(p)) return p;
      }
      // Scan for any file matching youtube + cookies pattern
      try {
        const files = fs.readdirSync(dlDir2);
        const match = files
          .filter(f => /youtube/i.test(f) && /cookie/i.test(f) && f.endsWith('.txt'))
          .sort((a, b) => {
            // Prefer most recently modified
            const sta = fs.statSync(path.join(dlDir2, a)).mtimeMs;
            const stb = fs.statSync(path.join(dlDir2, b)).mtimeMs;
            return stb - sta;
          })[0];
        if (match) return path.join(dlDir2, match);
      } catch { /* ignore */ }
      return undefined;
    })();

    if (cookiesFilePath) {
      sendMsg(`â†³ Using cookies file: ${path.basename(cookiesFilePath)}`);
      cookieArgs.push('--cookies', cookiesFilePath);
    } else {
      // No manual cookies file — try auto-extracting from installed browsers (Chrome → Edge → Firefox)
      const { execSync: _execSync } = require('child_process') as typeof import('child_process');
      const browserOrder = process.platform === 'win32'
        ? ['chrome', 'edge', 'firefox']
        : ['chrome', 'firefox', 'chromium'];
      let browserFound = false;
      for (const browser of browserOrder) {
        try {
          const testResult = _execSync(
            `"${ytdlp}" --cookies-from-browser ${browser} --simulate --quiet "https://www.youtube.com" 2>&1`,
            { timeout: 8000, encoding: 'utf8' },
          );
          if (!testResult.toLowerCase().includes('error')) {
            cookieArgs.push('--cookies-from-browser', browser);
            sendMsg(`â†³ Using cookies from ${browser}`);
            browserFound = true;
            break;
          }
        } catch { /* browser not installed or locked — try next */ }
      }
      if (!browserFound) {
        sendMsg('â†³ No browser cookies available — downloading without auth (may fail for age-restricted videos)');
      }
    }

    // â”€â”€ CHAPTERS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // EDITH sometimes routes a real video URL through her b-roll/search path, so `url` arrives
    // as "ytsearch:<watch url>". Strip any search prefix and, if what's left is a real video
    // URL, probe THAT for chapters regardless of the b-roll flags — this was the case being
    // silently skipped. Probe runs AFTER cookies so auth-gated videos still return chapters.
    const cleanUrl = url.replace(/^(ytdl:)?ytsearch\d*:/i, '').trim();
    const looksLikeVideoUrl = /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)/i.test(cleanUrl);
    if (looksLikeVideoUrl || (!isSearchQuery && !isStockFootage && !hasSections)) {
      sendMsg('â†³ Checking for chaptersâ€¦');
      try {
        videoChapters = await fetchSourceChapters(ytdlp, cleanUrl, cookieArgs);
        sendMsg(
          videoChapters?.length
            ? `âœ“ Found ${videoChapters.length} chapters`
            : 'â†³ No chapters in this video',
        );
      } catch (chErr) {
        sendMsg(`âš  Chapter check failed: ${String((chErr as Error)?.message ?? chErr).slice(0, 120)}`);
      }
    }
    // A video with chapters is long-form content the user wants whole — never auto-trim it.
    const keepFull = !!(videoChapters && videoChapters.length && !hasSections);

    // Use %(id)s instead of %(title)s — title can contain colons/quotes/slashes
    // that Windows mangles into unpredictable filenames the Electron player can't load.
    const args: string[] = [
      url,
      '--output', path.join(dlDir, '%(id)s.%(ext)s'),
      '--no-warnings',
      '--newline',
      '--print', 'after_move:filepath',
      '--format', 'bestvideo[ext=mp4][vcodec^=avc]+bestaudio[ext=m4a]/bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best',
      '--merge-output-format', 'mp4',
      ...cookieArgs,
    ];

    if (hasSections) {
      args.push('--download-sections', `*${startSeconds}-${endSeconds}`);
      args.push('--force-keyframes-at-cuts');
    }

    if (ffmpegPath) {
      args.push('--ffmpeg-location', path.dirname(ffmpegPath));
    }

    const DOWNLOAD_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes

    return new Promise<{ success: boolean; filePath?: string; fileType?: string; error?: string; chapters?: VideoChapter[]; origin?: string; title?: string }>((resolve) => {
      let finalPath = '';
      let stderrBuf = '';
      let settled = false;

      const settle = (result: { success: boolean; filePath?: string; fileType?: string; error?: string; chapters?: VideoChapter[]; origin?: string; title?: string }) => {
        if (settled) return;
        settled = true;
        ytdlpProcesses.delete(jobId);
        resolve(result);
      };

      const proc = spawn(ytdlp, args, { shell: false });
      ytdlpProcesses.set(jobId, proc);

      const timer = setTimeout(() => {
        proc.kill();
        sendMsg(`âœ— Download timed out after ${Math.round(DOWNLOAD_TIMEOUT_MS / 60000)} minutes â€” try a shorter clip or different URL.`);
        settle({ success: false, error: 'Download timed out' });
      }, DOWNLOAD_TIMEOUT_MS);

      let lastReportedPct = -1;
      proc.stdout?.on('data', (chunk: Buffer) => {
        for (const line of chunk.toString().split('\n')) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          const pct = trimmed.match(/\[download\]\s+(\d+\.?\d*)%/);
          if (pct) {
            event.sender.send('media:downloadProgress', { jobId, percent: parseFloat(pct[1]) });
            const p = Math.floor(parseFloat(pct[1]) / 10) * 10;
            if (p !== lastReportedPct && p > 0) {
              lastReportedPct = p;
              sendMsg(`â†³ Downloadingâ€¦ ${p}%`);
            }
          } else if (!trimmed.startsWith('[') && (trimmed.includes('\\') || trimmed.includes('/')) && /\.\w{2,4}$/.test(trimmed)) {
            finalPath = trimmed;
          }
        }
      });

      proc.stderr?.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        stderrBuf += text;
        const errorLine = text.split('\n').find((l) => l.includes('ERROR') || l.includes('error'));
        if (errorLine) sendMsg(`âš  ${errorLine.trim().slice(0, 100)}`);
      });

      proc.on('close', (code) => {
        clearTimeout(timer);
        if (code === null) return settle({ success: false, error: 'Download cancelled' });
        if (code === 0 && !finalPath) {
          // Fallback: find the newest file in dlDir
          try {
            const files = fs.readdirSync(dlDir).map((f) => {
              const fp = path.join(dlDir, f);
              return { fp, mt: fs.statSync(fp).mtimeMs };
            }).sort((a, b) => b.mt - a.mt);
            if (files[0]) finalPath = files[0].fp;
          } catch {}
        }
        if (code === 0 && finalPath) {
          const runFrameCheck = async (checkPath: string) => {
            const anthropicApiKey2 = loadEnvKey('ANTHROPIC_API_KEY');
            if (verify) {
              // Contact-sheet verification first (findMoment's batch-panel pipeline);
              // discrete-frame Haiku check only as infrastructure fallback.
              let result = await verifyClipByContactSheets(checkPath, verify, sendMsg);
              if (!result && ffmpegPath && anthropicApiKey2) {
                sendMsg('Contact-sheet verify unavailable - falling back to quick frame check.');
                const legacy = await verifyClipContent(checkPath, ffmpegPath, anthropicApiKey2, verify, sendMsg);
                result = { passed: legacy.passed, reason: legacy.reason, foundAtSec: null, frameBase64: legacy.frameBase64 ?? null };
              }
              if (result) {
                event.sender.send('edith:brollCheck', {
                  label: topic || verify,
                  duration: 0,
                  passed: result.passed,
                  reason: result.reason,
                  frameBase64: result.frameBase64 ?? null,
                });
                if (!result.passed) {
                  try { fs.unlinkSync(checkPath); } catch {}
                  settle({ success: false, error: `Clip rejected — doesn't match "${verify}": ${result.reason}` });
                  return false;
                }
                sendMsg(`Verified: ${result.reason}`);
              }
            } else if (ffmpegPath) {
              // No verify string — just show a preview frame
              const frameBase64 = await extractPreviewFrame(checkPath, ffmpegPath);
              event.sender.send('edith:brollCheck', {
                label: topic || 'downloaded clip',
                duration: 0,
                passed: true,
                reason: 'review clip',
                frameBase64: frameBase64 ?? null,
              });
            }
            return true;
          };

          if (hasSections && ffmpegPath) {
            sendMsg('â†³ Trimming clipâ€¦');
            const ext = path.extname(finalPath);
            const trimmedPath = finalPath.replace(ext, `_trim${ext}`);
            const ffArgs = [
              '-i', finalPath,
              '-ss', String(startSeconds),
              '-to', String(endSeconds),
              '-c', 'copy',
              '-y', trimmedPath,
            ];
            const ff = spawn(ffmpegPath, ffArgs, { shell: false });
            ff.on('close', async (ffCode) => {
              const usePath = ffCode === 0 && fs.existsSync(trimmedPath) ? trimmedPath : finalPath;
              if (ffCode === 0 && fs.existsSync(trimmedPath)) {
                try { fs.unlinkSync(finalPath); } catch {}
              }
              const ok = await runFrameCheck(usePath);
              if (!ok) return;
              sendMsg('âœ“ Download complete â€” review the clip below.');
              settle({ success: true, filePath: usePath, fileType: inferFileType(usePath), title: topic, origin: videoOrigin });
            });
          } else {
            (async () => {
              // For YouTube downloads, scan frames and trim to the best 20s segment.
              // Skip when the video has chapters — that's long-form content the user wants whole.
              const anthropicApiKey = loadEnvKey('ANTHROPIC_API_KEY');
              if (!isStockFootage && !keepFull && anthropicApiKey && ffmpegPath) {
                const segmentPath = await findBestYouTubeSegment(finalPath, ffmpegPath, anthropicApiKey, topic || verify || '', sendMsg);
                if (segmentPath !== finalPath) {
                  try { fs.unlinkSync(finalPath); } catch {}
                  finalPath = segmentPath;
                }
              }
              const ok = await runFrameCheck(finalPath);
              if (!ok) return;
              sendMsg('âœ” Download complete â€” review the clip below.');
              settle({ success: true, filePath: finalPath, fileType: inferFileType(finalPath), title: topic, chapters: videoChapters ?? undefined, origin: videoOrigin });
            })();
          }
        } else {
          const errLine = stderrBuf.trim().split('\n').filter(Boolean).slice(-2).join(' ');
          settle({ success: false, error: errLine || `yt-dlp exited with code ${code}` });
        }
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        settle({ success: false, error: `yt-dlp not found or failed to start: ${err.message}` });
      });
    });
  },
);

ipcMain.handle('media:cancelDownload', (_event, jobId: string) => {
  const proc = ytdlpProcesses.get(jobId);
  if (proc) { proc.kill(); ytdlpProcesses.delete(jobId); }
  return { success: true };
});

// EDITH web sourcing: search YouTube via yt-dlp and return ranked candidates so the
// model can reason over sources (resolution keywords, view counts, channel credibility)
// instead of blindly taking ytsearch1's first hit. Search-only — nothing is downloaded.
ipcMain.handle('media:searchMedia', async (_event, { query, count }: { query: string; count?: number }) => {
  const q = (query ?? '').trim();
  if (!q) return { success: false, error: 'Empty search query' };
  const n = Math.min(Math.max(count ?? 6, 1), 12);
  const ytdlp = getYtdlpPath();
  return new Promise((resolve) => {
    let out = '';
    let errBuf = '';
    const proc = spawn(ytdlp, [`ytsearch${n}:${q}`, '--dump-json', '--flat-playlist', '--no-warnings'], { shell: false });
    const timer = setTimeout(() => {
      proc.kill();
      resolve({ success: false, error: 'Search timed out after 45s' });
    }, 45000);
    proc.stdout?.on('data', (c: Buffer) => { out += c.toString(); });
    proc.stderr?.on('data', (c: Buffer) => { errBuf += c.toString(); });
    proc.on('close', () => {
      clearTimeout(timer);
      const candidates = out
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .filter(Boolean)
        .map((j: any) => ({
          title: j.title ?? 'untitled',
          url: j.url ?? (j.id ? `https://www.youtube.com/watch?v=${j.id}` : ''),
          durationSec: typeof j.duration === 'number' ? Math.round(j.duration) : null,
          viewCount: typeof j.view_count === 'number' ? j.view_count : null,
          channel: j.channel ?? j.uploader ?? null,
        }))
        .filter((c: any) => c.url);
      if (!candidates.length) {
        const errLine = errBuf.trim().split('\n').filter(Boolean).slice(-1)[0];
        resolve({ success: false, error: errLine || 'No results' });
        return;
      }
      resolve({ success: true, candidates });
    });
    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({ success: false, error: `yt-dlp failed to start: ${err.message}` });
    });
  });
});

// Media-level filler removal — transcribes the FILE itself (word timestamps),
// cuts every um/uh/erm/ahh/hmm in one filter_complex pass, and writes
// "Filler removed <name>" next to the source. Powers EDITH's removeFillersFromMedia
// op for media that is not on the timeline (e.g. recordings sent from the Record
// studio). The timeline removeFillers op is untouched — that one ripple-deletes.
ipcMain.handle('media:removeFillersFromFile', async (event, payload: {
  filePath: string;
  extraWords?: string[];
  transcript?: { segments?: Array<{ words?: Array<{ word: string; start: number; end: number }> }>; duration?: number; text?: string };
}) => {
  const sendMsg = (text: string) =>
    event.sender.send('mycelium:message', { role: 'system', text });
  const filePath = payload?.filePath;
  if (!filePath || !fs.existsSync(filePath)) return { success: false, error: `File not found: ${filePath}` };
  if (!ffmpegPath) return { success: false, error: 'FFmpeg binary not available' };
  try {
    // A caller-supplied transcript (live transcription captured while the take
    // was recorded) has the same word-timestamp shape Whisper would produce —
    // cutting starts immediately, no second transcription pass.
    const cachedWordCount = (payload?.transcript?.segments ?? [])
      .reduce((n, s) => n + (s.words?.length ?? 0), 0);
    let result: WhisperResult;
    if (cachedWordCount > 0) {
      sendMsg('↳ This take arrived with a live transcript — skipping transcription, scanning for fillers…');
      result = payload.transcript as WhisperResult;
    } else {
      await ensurePythonInitialized('ipc:media:removeFillersFromFile');
      sendMsg('↳ Transcribing the recording to find every filler word…');
      const t0 = Date.now();
      result = await transcribeAudio(filePath, {});
      sendMsg(`↳ Transcribed ${Math.round(result.duration)}s in ${Math.round((Date.now() - t0) / 1000)}s — scanning for fillers…`);
    }
    const words: { word: string; start: number; end: number }[] = [];
    for (const seg of result.segments ?? []) for (const w of seg.words ?? []) words.push({ word: w.word, start: w.start, end: w.end });
    if (!words.length) return { success: false, error: 'Transcription produced no word timestamps' };

    // Same filler families as the timeline removeFillers op: um/umm/uhm…, uh/uhh…,
    // er/erm, ah/ahh, hm/hmm — matched whole after stripping punctuation.
    const FILLER_RE = /^(u+h*m+|u+h+|e+r+m*|a+h+|h+m+)$/;
    const extras = (payload.extraWords ?? []).map((w) => String(w).toLowerCase().trim()).filter(Boolean);
    const cleanTok = (t: string) => t.toLowerCase().replace(/[^a-z]/g, '');
    const cuts: { start: number; end: number; token: string }[] = [];
    for (let i = 0; i < words.length; i++) {
      const tok = cleanTok(words[i].word);
      if (!tok || !(FILLER_RE.test(tok) || extras.includes(tok))) continue;
      // Small pad for a clean cut, clamped to the neighbouring words so no real
      // speech is ever eaten.
      const prevEnd = i > 0 ? words[i - 1].end : 0;
      const nextStart = i + 1 < words.length ? words[i + 1].start : Infinity;
      const start = Math.max(prevEnd, words[i].start - 0.04);
      const end = Math.min(nextStart, words[i].end + 0.04);
      if (end > start) cuts.push({ start, end, token: tok });
    }
    if (!cuts.length) {
      return { success: true, removedCount: 0, outPath: null, breakdown: {}, transcriptChars: result.text?.length ?? 0 };
    }

    cuts.sort((a, b) => a.start - b.start);
    const mergedCuts: { start: number; end: number }[] = [];
    for (const c of cuts) {
      const last = mergedCuts[mergedCuts.length - 1];
      if (last && c.start <= last.end + 0.02) last.end = Math.max(last.end, c.end);
      else mergedCuts.push({ start: c.start, end: c.end });
    }
    const totalDur = result.duration || words[words.length - 1].end;
    const keeps: { start: number; end: number }[] = [];
    let cursor = 0;
    for (const m of mergedCuts) {
      if (m.start > cursor + 0.01) keeps.push({ start: cursor, end: m.start });
      cursor = Math.max(cursor, m.end);
    }
    if (cursor < totalDur - 0.01) keeps.push({ start: cursor, end: totalDur });
    if (!keeps.length) return { success: false, error: 'Nothing left after cutting fillers' };

    const isAudio = /\.(mp3|m4a|wav|aac|ogg|opus)$/i.test(filePath);
    const dir = path.dirname(filePath);
    const base = path.basename(filePath, path.extname(filePath));
    const outExt = isAudio ? '.mp3' : '.mp4';
    let outPath = path.join(dir, `Filler removed ${base}${outExt}`);
    for (let n = 2; fs.existsSync(outPath); n++) outPath = path.join(dir, `Filler removed ${base} (${n})${outExt}`);

    sendMsg(`↳ Cutting ${cuts.length} filler word${cuts.length === 1 ? '' : 's'} (${mergedCuts.length} splice${mergedCuts.length === 1 ? '' : 's'})…`);
    const fc: string[] = [];
    keeps.forEach((k, i) => {
      if (!isAudio) fc.push(`[0:v]trim=start=${k.start.toFixed(3)}:end=${k.end.toFixed(3)},setpts=PTS-STARTPTS[v${i}]`);
      fc.push(`[0:a]atrim=start=${k.start.toFixed(3)}:end=${k.end.toFixed(3)},asetpts=PTS-STARTPTS[a${i}]`);
    });
    const concatIn = keeps.map((_, i) => (isAudio ? `[a${i}]` : `[v${i}][a${i}]`)).join('');
    fc.push(`${concatIn}concat=n=${keeps.length}:v=${isAudio ? 0 : 1}:a=1${isAudio ? '[aout]' : '[vout][aout]'}`);
    const args = ['-y', '-i', filePath, '-filter_complex', fc.join(';')];
    if (isAudio) args.push('-map', '[aout]', '-codec:a', 'libmp3lame', '-q:a', '2', outPath);
    else args.push('-map', '[vout]', '-map', '[aout]', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', outPath);
    await new Promise<void>((resolve, reject) => {
      const p = spawn(ffmpegPath!, args);
      let errOut = '';
      p.stderr?.on('data', (d: Buffer) => { errOut += d.toString(); });
      p.on('close', (code) => (code === 0 && fs.existsSync(outPath) ? resolve() : reject(new Error(`ffmpeg exit ${code}: ${errOut.slice(-300)}`))));
      p.on('error', reject);
    });
    const removedSec = mergedCuts.reduce((s, m) => s + (m.end - m.start), 0);
    const breakdown: Record<string, number> = {};
    for (const c of cuts) breakdown[c.token] = (breakdown[c.token] ?? 0) + 1;
    return { success: true, outPath, removedCount: cuts.length, removedSec: +removedSec.toFixed(2), breakdown };
  } catch (e: any) {
    return { success: false, error: e?.message ?? String(e) };
  }
});

// IPC Handler to cut silence from a media file using ffmpeg silencedetect
ipcMain.handle(
  'media:cutSilence',
  async (
    _event,
    { filePath, noiseDb = -30, minDuration = 0.4 }: { filePath: string; noiseDb?: number; minDuration?: number },
  ): Promise<{ success: boolean; filePath?: string; keepRanges?: Array<{ start: number; end: number }>; newDuration?: number; error?: string }> => {
    console.log('âœ‚ï¸ MAIN PROCESS: media:cutSilence called', { filePath, noiseDb, minDuration });

    if (!ffmpegPath) {
      return { success: false, error: 'FFmpeg binary not available' };
    }

    if (!filePath || !fs.existsSync(filePath)) {
      return { success: false, error: `File not found: ${filePath}` };
    }

    try {
      // Step 1: Run silencedetect to get silence timestamps from stderr
      const silenceStderr = await new Promise<string>((resolve, reject) => {
        const proc = spawn(ffmpegPath!, [
          '-i', filePath,
          '-af', `silencedetect=noise=${noiseDb}dB:d=${minDuration}`,
          '-f', 'null', '-',
        ]);
        let stderr = '';
        proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
        proc.on('close', () => resolve(stderr));
        proc.on('error', reject);
      });

      // Step 2: Parse silence_start / silence_end pairs
      const silenceStartMatches = [...silenceStderr.matchAll(/silence_start:\s*([\d.]+)/g)];
      const silenceEndMatches = [...silenceStderr.matchAll(/silence_end:\s*([\d.]+)/g)];

      const silences: Array<{ start: number; end: number }> = [];
      for (let i = 0; i < silenceStartMatches.length; i++) {
        const start = parseFloat(silenceStartMatches[i][1]);
        // silence_end may not exist for trailing silence â€” use a large number
        const end = silenceEndMatches[i] ? parseFloat(silenceEndMatches[i][1]) : 1e9;
        silences.push({ start, end });
      }

      console.log(`âœ‚ï¸ Found ${silences.length} silence region(s)`);

      // Step 3: Get total duration of input
      const durationRaw = await new Promise<string>((resolve, reject) => {
        const proc = spawn(ffmpegPath!, [
          '-i', filePath,
          '-f', 'null', '-',
        ]);
        let stderr = '';
        proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
        proc.on('close', () => resolve(stderr));
        proc.on('error', reject);
      });
      const durationMatch = durationRaw.match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
      const totalDuration = durationMatch
        ? parseInt(durationMatch[1]) * 3600 + parseInt(durationMatch[2]) * 60 + parseFloat(durationMatch[3])
        : 0;

      // Step 4: Invert silence regions to get speech segments
      const speechSegments: Array<{ start: number; end: number }> = [];
      let cursor = 0;
      for (const silence of silences) {
        if (silence.start > cursor + 0.01) {
          speechSegments.push({ start: cursor, end: silence.start });
        }
        cursor = silence.end;
      }
      if (totalDuration > 0 && cursor < totalDuration - 0.01) {
        speechSegments.push({ start: cursor, end: totalDuration });
      }

      console.log(`âœ‚ï¸ Speech segments: ${JSON.stringify(speechSegments)}`);

      if (speechSegments.length === 0) {
        return { success: false, error: 'No speech found â€” file appears to be entirely silence' };
      }

      // No silence found â€” return original file unchanged
      if (speechSegments.length === 1 && speechSegments[0].start < 0.05 && silences.length === 0) {
        console.log('âœ‚ï¸ No silence detected â€” returning original file');
        return { success: true, filePath };
      }

      const tmpDir = app.getPath('temp');
      const baseName = path.basename(filePath, path.extname(filePath));
      const ext = path.extname(filePath) || '.mp4';

      // Step 5: Extract each speech segment as a CFR-encoded temp file
      const segmentFiles: string[] = [];
      for (let i = 0; i < speechSegments.length; i++) {
        const seg = speechSegments[i];
        const segFile = path.join(tmpDir, `dividr_seg_${Date.now()}_${i}${ext}`);
        await new Promise<void>((resolve, reject) => {
          const proc = spawn(ffmpegPath!, [
            '-y',
            '-ss', String(seg.start),
            '-to', String(seg.end),
            '-i', filePath,
            '-r', '30',
            '-fps_mode', 'cfr',
            '-c:v', 'libx264',
            '-preset', 'fast',
            '-crf', '18',
            '-c:a', 'aac',
            '-b:a', '192k',
            segFile,
          ]);
          let stderr = '';
          proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
          proc.on('close', (code) => {
            if (code === 0 && fs.existsSync(segFile)) resolve();
            else reject(new Error(`Segment ${i} extraction failed (exit ${code}): ${stderr.slice(-500)}`));
          });
          proc.on('error', reject);
        });
        segmentFiles.push(segFile);
      }

      // If only one segment, just rename it to output (no concat needed)
      const outputFile = path.join(
        path.dirname(filePath),
        `${baseName}_nosilence${ext}`,
      );

      // Kept ranges + new total duration let the renderer remap transcript timings
      // and fix clip durations after the cut — without them every downstream
      // transcript-driven op works in stale original-file time.
      const keptDuration = speechSegments.reduce((a, s) => a + (s.end - s.start), 0);

      if (segmentFiles.length === 1) {
        fs.renameSync(segmentFiles[0], outputFile);
        console.log('âœ‚ï¸ Single segment â€” output:', outputFile);
        return { success: true, filePath: outputFile, keepRanges: speechSegments, newDuration: keptDuration };
      }

      // Step 6: Write concat list file
      const concatListFile = path.join(tmpDir, `dividr_concat_${Date.now()}.txt`);
      const concatContent = segmentFiles.map((f) => `file '${f.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n');
      fs.writeFileSync(concatListFile, concatContent, 'utf8');

      // Step 7: Concat segments using ffmpeg concat demuxer
      await new Promise<void>((resolve, reject) => {
        const proc = spawn(ffmpegPath!, [
          '-y',
          '-f', 'concat',
          '-safe', '0',
          '-i', concatListFile,
          '-c', 'copy',
          outputFile,
        ]);
        let stderr = '';
        proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
        proc.on('close', (code) => {
          if (code === 0 && fs.existsSync(outputFile)) resolve();
          else reject(new Error(`Concat failed (exit ${code}): ${stderr.slice(-500)}`));
        });
        proc.on('error', reject);
      });

      // Step 8: Clean up temp segment files and concat list
      for (const segFile of segmentFiles) {
        try { fs.unlinkSync(segFile); } catch { /* ignore */ }
      }
      try { fs.unlinkSync(concatListFile); } catch { /* ignore */ }

      console.log(`âœ‚ï¸ Silence cut complete â†’ ${outputFile}`);
      return { success: true, filePath: outputFile, keepRanges: speechSegments, newDuration: keptDuration };
    } catch (err: any) {
      console.error('âœ‚ï¸ media:cutSilence error:', err);
      return { success: false, error: err.message ?? String(err) };
    }
  },
);

// One-time probe: does this machine's ffmpeg + GPU driver actually encode with
// h264_nvenc? (Listing the encoder isn't enough — Blackwell/driver combos can list
// it but fail at runtime.) We test a tiny encode and cache the verdict.
let _nvencWorks: boolean | null = null;
async function nvencWorks(): Promise<boolean> {
  if (_nvencWorks !== null) return _nvencWorks;
  if (!ffmpegPath) return false;
  _nvencWorks = await new Promise<boolean>((resolve) => {
    try {
      const p = spawn(ffmpegPath!, [
        '-hide_banner', '-f', 'lavfi', '-i', 'color=c=black:s=64x64:d=0.1',
        '-c:v', 'h264_nvenc', '-f', 'null', '-',
      ]);
      let settled = false;
      const done = (v: boolean) => { if (!settled) { settled = true; try { p.kill(); } catch {} resolve(v); } };
      // Hard timeout — never let a hung probe stall the first encode.
      const t = setTimeout(() => done(false), 5000);
      p.on('close', (code) => { clearTimeout(t); done(code === 0); });
      p.on('error', () => { clearTimeout(t); done(false); });
    } catch {
      resolve(false);
    }
  });
  console.log(`🎞️ NVENC GPU encoding ${_nvencWorks ? 'available' : 'unavailable'} — reverse/encode will use ${_nvencWorks ? 'GPU' : 'CPU (libx264 veryfast)'}`);
  return _nvencWorks;
}

// Build the video+audio encode args for re-encoding ops, preferring GPU NVENC.
async function buildVideoEncodeArgs(): Promise<string[]> {
  if (await nvencWorks()) {
    return ['-c:v', 'h264_nvenc', '-preset', 'p4', '-cq', '20', '-c:a', 'aac', '-b:a', '192k', '-ar', '44100'];
  }
  return ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-c:a', 'aac', '-b:a', '192k', '-ar', '44100'];
}

// media:setSpeed — change playback speed of a clip via ffmpeg
ipcMain.handle(
  'media:setSpeed',
  async (
    _event,
    { filePath, speed, startSeconds, endSeconds }: { filePath: string; speed: number; startSeconds?: number; endSeconds?: number },
  ): Promise<{ success: boolean; filePath?: string; duration?: number; error?: string }> => {
    if (!ffmpegPath) return { success: false, error: 'FFmpeg binary not available' };
    if (!filePath || !fs.existsSync(filePath)) return { success: false, error: `File not found: ${filePath}` };
    if (speed <= 0) return { success: false, error: 'Speed must be greater than 0' };

    try {
      const ext = path.extname(filePath) || '.mp4';
      const outputFile = path.join(getBakedDir(), `speed_${Date.now()}${ext}`);
      const pts = (1 / speed).toFixed(6);

      function buildAtempo(s: number): string {
        const filters: string[] = [];
        if (s <= 0.5) {
          let rem = s;
          while (rem < 0.5) { filters.push('atempo=0.5'); rem *= 2; }
          if (Math.abs(rem - 1) > 0.001) filters.push(`atempo=${rem.toFixed(4)}`);
        } else if (s >= 2.0) {
          let rem = s;
          while (rem > 2.0) { filters.push('atempo=2.0'); rem /= 2; }
          if (Math.abs(rem - 1) > 0.001) filters.push(`atempo=${rem.toFixed(4)}`);
        } else {
          filters.push(`atempo=${s.toFixed(4)}`);
        }
        return filters.length ? filters.join(',') : 'atempo=1.0';
      }

      // Get original duration from input file
      const origDuration = await new Promise<number>((resolve) => {
        let out = '';
        const p = spawn(ffprobePath!.path, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', filePath]);
        p.stdout.on('data', (d: Buffer) => { out += d.toString(); });
        p.on('close', () => resolve(parseFloat(out.trim()) || 0));
        p.on('error', () => resolve(0));
      });

      const hasTrimRange = startSeconds !== undefined && endSeconds !== undefined;

      const runSeg = (a: string[]) => new Promise<void>((resolve, reject) => {
        const p = spawn(ffmpegPath!, a);
        let errOut = '';
        p.stderr?.on('data', (d: Buffer) => { errOut += d.toString(); });
        p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}: ${errOut.slice(-300)}`))));
        p.on('error', reject);
      });

      const commonEnc = ['-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-c:a', 'aac', '-b:a', '192k', '-ar', '44100'];

      if (hasTrimRange) {
        const clampedEnd = Math.min(endSeconds!, origDuration);
        const tmpDir = path.dirname(filePath);
        const ts = Date.now();
        const segBefore = path.join(tmpDir, `seg_before_${ts}.mp4`);
        const segMiddle = path.join(tmpDir, `seg_mid_${ts}.mp4`);
        const segAfter  = path.join(tmpDir, `seg_after_${ts}.mp4`);
        const concatList = path.join(tmpDir, `concat_speed_${ts}.txt`);

        // Before: 0 → startSeconds at normal speed
        if (startSeconds! > 0.01) {
          await runSeg(['-y', '-i', filePath, '-t', String(startSeconds), '-map', '0:v', '-map', '0:a?', ...commonEnc, segBefore]);
        }

        // Middle: startSeconds → endSeconds at new speed (video + audio both retime)
        // -ss/-to MUST be input options (before -i) so the trim happens before the PTS filter.
        // As output options, -to=3 with setpts=2*PTS stops at output ts 3s (= only 1.5s of input).
        await runSeg([
          '-y',
          '-ss', String(startSeconds),
          '-to', String(clampedEnd),
          '-i', filePath,
          '-map', '0:v', '-map', '0:a?',
          '-vf', `setpts=${pts}*PTS`,
          '-af', buildAtempo(speed),
          ...commonEnc, segMiddle,
        ]);

        // After: endSeconds → end at normal speed
        const afterDur = origDuration - clampedEnd;
        if (afterDur > 0.01) {
          await runSeg(['-y', '-ss', String(clampedEnd), '-i', filePath, '-map', '0:v', '-map', '0:a?', ...commonEnc, segAfter]);
        }

        let concatContent = '';
        if (startSeconds! > 0.01 && fs.existsSync(segBefore)) concatContent += `file '${segBefore.replace(/\\/g, '/')}'\n`;
        if (fs.existsSync(segMiddle)) concatContent += `file '${segMiddle.replace(/\\/g, '/')}'\n`;
        if (afterDur > 0.01 && fs.existsSync(segAfter)) concatContent += `file '${segAfter.replace(/\\/g, '/')}'\n`;
        fs.writeFileSync(concatList, concatContent);

        await runSeg(['-y', '-f', 'concat', '-safe', '0', '-i', concatList, '-map', '0:v', '-map', '0:a?', ...commonEnc, '-movflags', '+faststart', outputFile]);

        for (const f of [segBefore, segMiddle, segAfter, concatList]) {
          try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch { /* ignore */ }
        }
      } else {
        await runSeg([
          '-y', '-i', filePath,
          '-map', '0:v', '-map', '0:a?',
          '-vf', `setpts=${pts}*PTS`,
          '-af', buildAtempo(speed),
          '-c:v', 'libx264', '-preset', 'fast', '-crf', '18',
          '-c:a', 'aac', '-b:a', '192k',
          '-movflags', '+faststart',
          outputFile,
        ]);
      }

      // Compute expected duration mathematically from the input — reliable regardless of output probe
      let duration: number;
      if (hasTrimRange && origDuration > 0) {
        const clampedEnd = Math.min(endSeconds!, origDuration);
        const slowedSeg = (clampedEnd - startSeconds!) / speed;
        duration = startSeconds! + slowedSeg + Math.max(0, origDuration - clampedEnd);
      } else if (origDuration > 0) {
        duration = origDuration / speed;
      } else {
        // fallback: probe output file
        duration = await new Promise<number>((resolve) => {
          let out = '';
          const p = spawn(ffprobePath!.path, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', outputFile]);
          p.stdout.on('data', (d: Buffer) => { out += d.toString(); });
          p.on('close', () => resolve(parseFloat(out.trim()) || 0));
          p.on('error', () => resolve(0));
        });
      }

      return { success: true, filePath: outputFile, duration };
    } catch (err: any) {
      console.error('media:setSpeed error:', err);
      return { success: false, error: err.message ?? String(err) };
    }
  },
);

// media:reverse — reverse a whole clip, or only the [startSeconds, endSeconds] segment.
// Duration is unchanged (reverse preserves length). Mirrors media:setSpeed's
// trim → process-middle → concat structure.
ipcMain.handle(
  'media:reverse',
  async (
    _event,
    { filePath, startSeconds, endSeconds, segmentOnly }: { filePath: string; startSeconds?: number; endSeconds?: number; segmentOnly?: boolean },
  ): Promise<{ success: boolean; filePath?: string; duration?: number; error?: string }> => {
    if (!ffmpegPath) return { success: false, error: 'FFmpeg binary not available' };
    if (!filePath || !fs.existsSync(filePath)) return { success: false, error: `File not found: ${filePath}` };

    try {
      const ext = path.extname(filePath) || '.mp4';
      const outputFile = path.join(getBakedDir(), `reverse_${Date.now()}${ext}`);

      const origDuration = await new Promise<number>((resolve) => {
        let out = '';
        const p = spawn(ffprobePath!.path, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', filePath]);
        p.stdout.on('data', (d: Buffer) => { out += d.toString(); });
        p.on('close', () => resolve(parseFloat(out.trim()) || 0));
        p.on('error', () => resolve(0));
      });

      const runSeg = (a: string[]) => new Promise<void>((resolve, reject) => {
        const p = spawn(ffmpegPath!, a);
        let errOut = '';
        p.stderr?.on('data', (d: Buffer) => { errOut += d.toString(); });
        p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}: ${errOut.slice(-300)}`))));
        p.on('error', reject);
      });

      // Detect whether the input has a video stream (linked-audio tracks are audio-only).
      const hasVideo = await new Promise<boolean>((resolve) => {
        let out = '';
        const p = spawn(ffprobePath!.path, ['-v', 'error', '-select_streams', 'v', '-show_entries', 'stream=index', '-of', 'csv=p=0', filePath]);
        p.stdout.on('data', (d: Buffer) => { out += d.toString(); });
        p.on('close', () => resolve(out.trim().length > 0));
        p.on('error', () => resolve(true));
      });

      const maps = hasVideo ? ['-map', '0:v', '-map', '0:a?'] : ['-map', '0:a'];
      const revFilters = hasVideo ? ['-vf', 'reverse', '-af', 'areverse'] : ['-af', 'areverse'];
      // GPU NVENC encode when available (huge speedup vs CPU libx264); audio-only → pcm.
      const enc = hasVideo ? await buildVideoEncodeArgs() : ['-c:a', 'pcm_s16le', '-ar', '44100'];
      const hasRange =
        startSeconds !== undefined && endSeconds !== undefined && endSeconds > startSeconds;

      const tmpDir = path.dirname(filePath);
      const ts = Date.now();

      // Reverse [rStart, rStart+rDur] of the input into outFile WITHOUT loading the
      // whole span into RAM: split into small chunks, reverse each in its own ffmpeg
      // process (memory freed between chunks), then concat the chunks in reverse order.
      // FFmpeg's `reverse`/`areverse` are in-memory filters, so a long single-pass
      // reverse OOMs — chunking keeps peak memory bounded by one chunk.
      const CHUNK = 8; // seconds per chunk — each reverses in its own process, memory freed between
      const chunkReverse = async (rStart: number, rDur: number, outFile: string) => {
        const n = Math.max(1, Math.ceil(rDur / CHUNK));
        const parts: string[] = [];
        for (let i = 0; i < n; i++) {
          const cs = rStart + i * CHUNK;
          const cd = Math.min(CHUNK, rStart + rDur - cs);
          if (cd <= 0.01) break;
          const cf = path.join(tmpDir, `revchunk_${ts}_${i}${ext}`);
          await runSeg(['-y', '-ss', String(cs), '-t', String(cd), '-i', filePath, ...maps, ...revFilters, ...enc, cf]);
          parts.push(cf);
        }
        if (parts.length === 1) {
          // Single chunk — it IS the reversed output; just move it (no concat pass).
          try { fs.renameSync(parts[0], outFile); } catch { fs.copyFileSync(parts[0], outFile); try { fs.unlinkSync(parts[0]); } catch {} }
          return;
        }
        const list = path.join(tmpDir, `revlist_${ts}_${Math.round(rStart * 1000)}.txt`);
        fs.writeFileSync(
          list,
          parts.slice().reverse().map((f) => `file '${f.replace(/\\/g, '/')}'\n`).join(''),
        );
        // Stream-copy the concat — chunks already share codec params, so no re-encode.
        await runSeg(['-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', ...(hasVideo ? ['-movflags', '+faststart'] : []), outFile]);
        for (const f of [...parts, list]) {
          try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch { /* ignore */ }
        }
      };

      if (hasRange && segmentOnly) {
        // Reverse ONLY [start, end] and return just that segment (length = end-start).
        // Used by the timeline-split reverse path — the before/after live as untouched
        // sibling clips, so we never re-encode the rest of the video.
        const clampedEnd = Math.min(endSeconds!, origDuration || endSeconds!);
        await chunkReverse(startSeconds!, clampedEnd - startSeconds!, outputFile);
        return { success: true, filePath: outputFile, duration: clampedEnd - startSeconds! };
      }

      if (hasRange) {
        const clampedEnd = Math.min(endSeconds!, origDuration || endSeconds!);
        const segBefore = path.join(tmpDir, `rev_before_${ts}${ext}`);
        const segMiddle = path.join(tmpDir, `rev_mid_${ts}${ext}`);
        const segAfter  = path.join(tmpDir, `rev_after_${ts}${ext}`);
        const concatList = path.join(tmpDir, `concat_rev_${ts}.txt`);

        if (startSeconds! > 0.01) {
          await runSeg(['-y', '-i', filePath, '-t', String(startSeconds), ...maps, ...enc, segBefore]);
        }
        await chunkReverse(startSeconds!, clampedEnd - startSeconds!, segMiddle);
        const afterDur = (origDuration || clampedEnd) - clampedEnd;
        if (afterDur > 0.01) {
          await runSeg(['-y', '-ss', String(clampedEnd), '-i', filePath, ...maps, ...enc, segAfter]);
        }

        let concatContent = '';
        if (startSeconds! > 0.01 && fs.existsSync(segBefore)) concatContent += `file '${segBefore.replace(/\\/g, '/')}'\n`;
        if (fs.existsSync(segMiddle)) concatContent += `file '${segMiddle.replace(/\\/g, '/')}'\n`;
        if (afterDur > 0.01 && fs.existsSync(segAfter)) concatContent += `file '${segAfter.replace(/\\/g, '/')}'\n`;
        fs.writeFileSync(concatList, concatContent);

        await runSeg(['-y', '-f', 'concat', '-safe', '0', '-i', concatList, ...maps, ...enc, ...(hasVideo ? ['-movflags', '+faststart'] : []), outputFile]);

        for (const f of [segBefore, segMiddle, segAfter, concatList]) {
          try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch { /* ignore */ }
        }
      } else {
        // Whole clip reversed — chunked so even a 20-min clip stays within memory.
        await chunkReverse(0, origDuration, outputFile);
      }

      return { success: true, filePath: outputFile, duration: origDuration };
    } catch (err: any) {
      console.error('media:reverse error:', err);
      return { success: false, error: err.message ?? String(err) };
    }
  },
);

// media:matchBrollPace — piecewise speed-warp a clip so visual markers align with speech markers
// sourceMarkers: timestamps in the source clip where each key visual moment occurs
// targetMarkers: desired timestamps in the output clip (matching when Alex says each zoom level)
// Both arrays must be equal length. Segments outside the first/last marker play at normal speed.
ipcMain.handle(
  'media:matchBrollPace',
  async (
    _event,
    { filePath, sourceMarkers, targetMarkers }: {
      filePath: string;
      sourceMarkers: number[];
      targetMarkers: number[];
    },
  ): Promise<{ success: boolean; filePath?: string; duration?: number; error?: string }> => {
    if (!ffmpegPath || !ffprobePath) return { success: false, error: 'FFmpeg not available' };
    if (!fs.existsSync(filePath)) return { success: false, error: `File not found: ${filePath}` };
    if (sourceMarkers.length < 2) return { success: false, error: 'Need at least 2 source markers' };
    if (sourceMarkers.length !== targetMarkers.length) return { success: false, error: 'sourceMarkers and targetMarkers must be the same length' };

    const origDuration = await new Promise<number>((resolve) => {
      let out = '';
      const p = spawn(ffprobePath!.path, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', filePath]);
      p.stdout.on('data', (d: Buffer) => { out += d.toString(); });
      p.on('close', () => resolve(parseFloat(out.trim()) || 0));
      p.on('error', () => resolve(0));
    });

    const runSeg = (args: string[]) => new Promise<void>((resolve, reject) => {
      const p = spawn(ffmpegPath!, args);
      let err = '';
      p.stderr?.on('data', (d: Buffer) => { err += d.toString(); });
      p.on('close', (code) => code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}: ${err.slice(-400)}`)));
      p.on('error', reject);
    });

    const commonEnc = ['-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-c:a', 'aac', '-b:a', '128k', '-ar', '44100'];

    function buildAtempo(s: number): string {
      const filters: string[] = [];
      if (s <= 0.5) {
        let rem = s;
        while (rem < 0.5) { filters.push('atempo=0.5'); rem *= 2; }
        if (Math.abs(rem - 1) > 0.001) filters.push(`atempo=${rem.toFixed(4)}`);
      } else if (s >= 2.0) {
        let rem = s;
        while (rem > 2.0) { filters.push('atempo=2.0'); rem /= 2; }
        if (Math.abs(rem - 1) > 0.001) filters.push(`atempo=${rem.toFixed(4)}`);
      } else {
        filters.push(`atempo=${s.toFixed(4)}`);
      }
      return filters.length ? filters.join(',') : 'atempo=1.0';
    }

    try {
      const tmpDir = path.dirname(filePath);
      const ts = Date.now();
      const segFiles: string[] = [];
      let totalDuration = 0;

      // Build segment list: pre-marker segment + each inter-marker segment + post-marker segment
      type Seg = { srcStart: number; srcEnd: number; speed: number };
      const segments: Seg[] = [];

      // Before first marker: normal speed
      if (sourceMarkers[0] > 0.05) {
        segments.push({ srcStart: 0, srcEnd: sourceMarkers[0], speed: 1.0 });
      }
      // Piecewise segments between markers
      for (let i = 0; i < sourceMarkers.length - 1; i++) {
        const srcDur = sourceMarkers[i + 1] - sourceMarkers[i];
        const tgtDur = targetMarkers[i + 1] - targetMarkers[i];
        const speed = tgtDur > 0.01 ? Math.max(0.1, Math.min(16, srcDur / tgtDur)) : 1.0;
        segments.push({ srcStart: sourceMarkers[i], srcEnd: sourceMarkers[i + 1], speed });
      }
      // After last marker: normal speed
      const lastSrc = sourceMarkers[sourceMarkers.length - 1];
      if (origDuration - lastSrc > 0.05) {
        segments.push({ srcStart: lastSrc, srcEnd: origDuration, speed: 1.0 });
      }

      for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        const segFile = path.join(tmpDir, `mbp_seg_${ts}_${i}.mp4`);
        const pts = (1 / seg.speed).toFixed(6);
        const args = [
          '-y', '-ss', String(seg.srcStart), '-to', String(seg.srcEnd), '-i', filePath,
          '-map', '0:v', '-map', '0:a?',
          '-vf', `setpts=${pts}*PTS`,
          '-af', buildAtempo(seg.speed),
          ...commonEnc, segFile,
        ];
        await runSeg(args);
        if (fs.existsSync(segFile)) {
          segFiles.push(segFile);
          const segDur = (seg.srcEnd - seg.srcStart) / seg.speed;
          totalDuration += segDur;
        }
      }

      if (!segFiles.length) return { success: false, error: 'No segments produced' };

      const outputFile = path.join(tmpDir, `matched_${ts}.mp4`);

      if (segFiles.length === 1) {
        fs.renameSync(segFiles[0], outputFile);
      } else {
        const concatList = path.join(tmpDir, `mbp_concat_${ts}.txt`);
        fs.writeFileSync(concatList, segFiles.map(f => `file '${f.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'));
        await runSeg(['-y', '-f', 'concat', '-safe', '0', '-i', concatList, '-map', '0:v', '-map', '0:a?', ...commonEnc, '-movflags', '+faststart', outputFile]);
        for (const f of [...segFiles, concatList]) { try { fs.unlinkSync(f); } catch {} }
      }

      return { success: true, filePath: outputFile, duration: totalDuration };
    } catch (err: any) {
      console.error('media:matchBrollPace error:', err);
      return { success: false, error: err.message ?? String(err) };
    }
  },
);

// media:faceZoom — face-tracked smooth zoom via MediaPipe + FFmpeg zoompan
ipcMain.handle(
  'media:faceZoom',
  async (
    _event,
    { filePath, startSeconds, endSeconds, zoomLevel = 2.5, easeSeconds = 0.4, target = 'face' }:
    { filePath: string; startSeconds: number; endSeconds: number; zoomLevel?: number; easeSeconds?: number; target?: string },
  ): Promise<{ success: boolean; filePath?: string; error?: string }> => {
    if (!filePath || !fs.existsSync(filePath)) {
      return { success: false, error: `File not found: ${filePath}` };
    }

    try {
      const ext = path.extname(filePath) || '.mp4';
      const outputFile = path.join(getBakedDir(), `facezoom_${Date.now()}${ext}`);

      // Resolve Python executable + main.py via the same logic as mediaToolsRunner
      const isWindows = process.platform === 'win32';
      const venvPython = isWindows
        ? path.join(process.cwd(), 'src', 'backend', 'python', 'venv', 'Scripts', 'python.exe')
        : path.join(process.cwd(), 'src', 'backend', 'python', 'venv', 'bin', 'python');
      const mainPy = path.join(process.cwd(), 'src', 'backend', 'python', 'main.py');

      const pythonExe = fs.existsSync(venvPython) ? venvPython : (isWindows ? 'python' : 'python3');

      await new Promise<void>((resolve, reject) => {
        const args = [
          mainPy, 'face-zoom',
          '--input',  filePath,
          '--output', outputFile,
          '--start',  String(startSeconds),
          '--end',    String(endSeconds),
          '--zoom',   String(zoomLevel),
          '--ease',   String(easeSeconds),
          '--target', target,
        ];
        const proc = spawn(pythonExe, args);
        let errOut = '';
        proc.stderr?.on('data', (d: Buffer) => { errOut += d.toString(); });
        proc.stdout?.on('data', (d: Buffer) => {
          const lines = d.toString().split('\n');
          for (const line of lines) {
            if (line.startsWith('PROGRESS|')) {
              console.log('[faceZoom]', line);
            }
          }
        });
        proc.on('close', (code) => code === 0 ? resolve() : reject(new Error(`face-zoom exit ${code}: ${errOut.slice(-500)}`)));
        proc.on('error', reject);
      });

      if (!fs.existsSync(outputFile) || fs.statSync(outputFile).size < 1000) {
        return { success: false, error: 'face-zoom produced no output file' };
      }
      return { success: true, filePath: outputFile };
    } catch (err: any) {
      console.error('media:faceZoom error:', err);
      return { success: false, error: err.message ?? String(err) };
    }
  },
);

// media:analyzeMotion — body pose detection via MediaPipe, returns motion events
ipcMain.handle(
  'media:analyzeMotion',
  async (
    _event,
    { filePath, detect = 'punch,jump,energy,speaker', sampleEvery = 3 }:
    { filePath: string; detect?: string; sampleEvery?: number },
  ): Promise<{ success: boolean; events?: any[]; energyTimeline?: any[]; speakerTrack?: any[]; fps?: number; totalFrames?: number; error?: string }> => {
    if (!filePath || !fs.existsSync(filePath)) {
      return { success: false, error: `File not found: ${filePath}` };
    }

    try {
      const isWindows = process.platform === 'win32';
      const venvPython = isWindows
        ? path.join(process.cwd(), 'src', 'backend', 'python', 'venv', 'Scripts', 'python.exe')
        : path.join(process.cwd(), 'src', 'backend', 'python', 'venv', 'bin', 'python');
      const mainPy = path.join(process.cwd(), 'src', 'backend', 'python', 'main.py');
      const pythonExe = fs.existsSync(venvPython) ? venvPython : (isWindows ? 'python' : 'python3');

      const result = await new Promise<any>((resolve, reject) => {
        const args = [
          mainPy, 'motion-analyze',
          '--input',        filePath,
          '--detect',       detect,
          '--sample-every', String(sampleEvery),
        ];
        const proc = spawn(pythonExe, args);
        let stdoutBuf = '';
        let errOut = '';

        proc.stderr?.on('data', (d: Buffer) => { errOut += d.toString(); });
        proc.stdout?.on('data', (d: Buffer) => { stdoutBuf += d.toString(); });
        proc.on('close', (code) => {
          if (code !== 0) return reject(new Error(`motion-analyze exit ${code}: ${errOut.slice(-500)}`));
          // Process lines only after all stdout is collected — avoids chunk-split truncation
          let resultJson: string | null = null;
          for (const line of stdoutBuf.split('\n')) {
            if (line.startsWith('PROGRESS|')) {
              console.log('[analyzeMotion]', line);
            } else if (line.startsWith('RESULT|')) {
              resultJson = line.slice(7);
            }
          }
          if (!resultJson) return reject(new Error('motion-analyze produced no RESULT line'));
          try { resolve(JSON.parse(resultJson)); } catch (e) { reject(e); }
        });
        proc.on('error', reject);
      });

      return { success: true, ...result };
    } catch (err: any) {
      console.error('media:analyzeMotion error:', err);
      return { success: false, error: err.message ?? String(err) };
    }
  },
);

// media:renderSkeleton — draw MediaPipe skeleton overlay onto every frame
ipcMain.handle(
  'media:renderSkeleton',
  async (
    _event,
    { filePath }: { filePath: string },
  ): Promise<{ success: boolean; outputPath?: string; error?: string }> => {
    if (!filePath || !fs.existsSync(filePath)) {
      return { success: false, error: `File not found: ${filePath}` };
    }
    try {
      const isWindows = process.platform === 'win32';
      const venvPython = isWindows
        ? path.join(process.cwd(), 'src', 'backend', 'python', 'venv', 'Scripts', 'python.exe')
        : path.join(process.cwd(), 'src', 'backend', 'python', 'venv', 'bin', 'python');
      const mainPy = path.join(process.cwd(), 'src', 'backend', 'python', 'main.py');
      const pythonExe = fs.existsSync(venvPython) ? venvPython : (isWindows ? 'python' : 'python3');

      const ext = path.extname(filePath) || '.mp4';
      const outputPath = path.join(getBakedDir(), `skeleton_${Date.now()}${ext}`);

      const result = await new Promise<{ outputPath: string }>((resolve, reject) => {
        const proc = spawn(pythonExe, [mainPy, 'skeleton-render', '--input', filePath, '--output', outputPath]);
        let resultJson: string | null = null;
        let errOut = '';
        proc.stderr?.on('data', (d: Buffer) => { errOut += d.toString(); });
        proc.stdout?.on('data', (d: Buffer) => {
          const lines = d.toString().split('\n');
          for (const line of lines) {
            if (line.startsWith('PROGRESS|')) console.log('[renderSkeleton]', line);
            else if (line.startsWith('RESULT|')) resultJson = line.slice(7);
          }
        });
        proc.on('close', (code) => {
          if (code !== 0) return reject(new Error(`skeleton-render exit ${code}: ${errOut.slice(-400)}`));
          if (!resultJson) return reject(new Error('skeleton-render produced no RESULT line'));
          try { resolve(JSON.parse(resultJson)); } catch (e) { reject(e); }
        });
        proc.on('error', reject);
      });

      return { success: true, outputPath: result.outputPath };
    } catch (err: any) {
      console.error('media:renderSkeleton error:', err);
      return { success: false, error: err.message ?? String(err) };
    }
  },
);

// ─── New nuanced skills: helper to run a main.py subcommand and parse RESULT| ───
const runPythonSkill = async (
  command: string,
  flags: string[],
  tag: string,
): Promise<any> => {
  const isWindows = process.platform === 'win32';
  const venvPython = isWindows
    ? path.join(process.cwd(), 'src', 'backend', 'python', 'venv', 'Scripts', 'python.exe')
    : path.join(process.cwd(), 'src', 'backend', 'python', 'venv', 'bin', 'python');
  const mainPy = path.join(process.cwd(), 'src', 'backend', 'python', 'main.py');
  const pythonExe = fs.existsSync(venvPython) ? venvPython : (isWindows ? 'python' : 'python3');

  return new Promise<any>((resolve, reject) => {
    const proc = spawn(pythonExe, [mainPy, command, ...flags]);
    let stdoutBuf = '';
    let errOut = '';
    proc.stderr?.on('data', (d: Buffer) => { errOut += d.toString(); });
    proc.stdout?.on('data', (d: Buffer) => { stdoutBuf += d.toString(); });
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(`${command} exit ${code}: ${errOut.slice(-500)}`));
      let resultJson: string | null = null;
      for (const line of stdoutBuf.split('\n')) {
        if (line.startsWith('PROGRESS|')) console.log(`[${tag}]`, line);
        else if (line.startsWith('RESULT|')) resultJson = line.slice(7);
      }
      if (!resultJson) return reject(new Error(`${command} produced no RESULT line`));
      try { resolve(JSON.parse(resultJson)); } catch (e) { reject(e); }
    });
    proc.on('error', reject);
  });
};

// media:rackFocus — depth-plane focus pull (near↔far), MiDaS depth + animated defocus
ipcMain.handle(
  'media:rackFocus',
  async (
    _event,
    { filePath, startSeconds, endSeconds, direction = 'near-to-far', strength = 70, hold = 0.35, fromSubject = '', toSubject = '' }:
    { filePath: string; startSeconds: number; endSeconds: number; direction?: string; strength?: number; hold?: number; fromSubject?: string; toSubject?: string },
  ): Promise<{ success: boolean; filePath?: string; direction?: string; duration?: number; reason?: string; error?: string; anchoredFrom?: boolean; anchoredTo?: boolean }> => {
    if (!filePath || !fs.existsSync(filePath)) return { success: false, error: `File not found: ${filePath}` };
    try {
      const ext = path.extname(filePath) || '.mp4';
      const outputFile = path.join(getBakedDir(), `rackfocus_${Date.now()}${ext}`);
      const dir = direction === 'far-to-near' ? 'far-to-near' : 'near-to-far';
      const flags = [
        '--input', filePath, '--output', outputFile,
        '--start', String(startSeconds), '--end', String(endSeconds),
        '--direction', dir, '--strength', String(strength), '--hold', String(hold),
      ];
      if (fromSubject) flags.push('--from-subject', fromSubject);
      if (toSubject) flags.push('--to-subject', toSubject);
      const result = await runPythonSkill('rack-focus', flags, 'rackFocus');
      if (!result?.success) return { success: false, error: result?.error ?? 'Rack focus failed', reason: result?.reason };
      return result;
    } catch (err: any) {
      console.error('media:rackFocus error:', err);
      return { success: false, error: err.message ?? String(err) };
    }
  },
);

// media:reverbProcess — Reverb Processor: amount<0 strips reverb (spectral late-reverb
// suppression), amount>0 adds genuine convolution reverb (diffuse synthetic IR).
// Output is a wav in app storage (baked dir) — NEVER next to the source.
ipcMain.handle(
  'media:reverbProcess',
  async (
    _event,
    { filePath, amount }: { filePath: string; amount: number },
  ): Promise<{ success: boolean; filePath?: string; mode?: string; amount?: number; tailDecayBeforeMs?: number; tailDecayAfterMs?: number; error?: string }> => {
    if (!filePath || !fs.existsSync(filePath)) return { success: false, error: `File not found: ${filePath}` };
    const amt = Math.max(-50, Math.min(50, Math.round(amount ?? 0)));
    if (amt === 0) return { success: false, error: 'amount 0 = nothing to do' };
    try {
      const outputFile = path.join(getBakedDir(), `reverb_${Date.now()}.wav`);
      const result = await runPythonSkill(
        'reverb-process',
        ['--input', filePath, '--output', outputFile, '--amount', String(amt)],
        'reverbProcess',
      );
      if (!result?.success) return { success: false, error: result?.error ?? 'Reverb processing failed' };
      return result;
    } catch (err: any) {
      console.error('media:reverbProcess error:', err);
      return { success: false, error: err.message ?? String(err) };
    }
  },
);

// media:stabilizeAnalyze — measure camera shake and compute per-frame counter-offsets
// (phase correlation + low-pass camera path). Writes a sidecar offsets JSON in the
// baked dir (cached per source file) and returns the offsets inline so the preview
// can start compensating immediately. No zoom, no crop — translation only.
ipcMain.handle(
  'media:stabilizeAnalyze',
  async (
    _event,
    { filePath }: { filePath: string },
  ): Promise<{ success: boolean; offsetsPath?: string; offsets?: number[][]; fps?: number; frames?: number; zoom?: number; shakeBefore?: number; shakeAfter?: number; error?: string }> => {
    if (!filePath || !fs.existsSync(filePath)) return { success: false, error: `File not found: ${filePath}` };
    try {
      // stab3_ = v3 sidecars ([dx, dy, da] similarity model + constant auto-zoom).
      // The prefix bump orphans older curves so they can never be served again.
      const cacheName = `stab3_${path.basename(filePath).replace(/[^a-zA-Z0-9._-]/g, '_')}_${fs.statSync(filePath).size}.json`;
      const offsetsPath = path.join(getBakedDir(), cacheName);
      if (!fs.existsSync(offsetsPath)) {
        const result = await runPythonSkill(
          'stabilize',
          ['--mode', 'analyze', '--input', filePath, '--output', offsetsPath],
          'stabilizeAnalyze',
        );
        if (!result?.success) return { success: false, error: result?.error ?? 'Stabilization analysis failed' };
      }
      const data = JSON.parse(fs.readFileSync(offsetsPath, 'utf8'));
      return {
        success: true,
        offsetsPath,
        offsets: data.offsets,
        fps: data.fps,
        frames: data.frames,
        zoom: data.zoom,
        shakeBefore: data.shakeBefore,
        shakeAfter: data.shakeAfter,
      };
    } catch (err: any) {
      console.error('media:stabilizeAnalyze error:', err);
      return { success: false, error: err.message ?? String(err) };
    }
  },
);

// media:stabilizeLoadOffsets — re-read an existing offsets sidecar (project reload path).
ipcMain.handle(
  'media:stabilizeLoadOffsets',
  async (
    _event,
    { offsetsPath }: { offsetsPath: string },
  ): Promise<{ success: boolean; offsets?: number[][]; fps?: number; zoom?: number; error?: string }> => {
    try {
      if (!offsetsPath || !fs.existsSync(offsetsPath)) return { success: false, error: 'offsets file missing' };
      const data = JSON.parse(fs.readFileSync(offsetsPath, 'utf8'));
      return { success: true, offsets: data.offsets, fps: data.fps, zoom: data.zoom };
    } catch (err: any) {
      return { success: false, error: err.message ?? String(err) };
    }
  },
);

// media:findMoment — "CTRL-F for video" visual/object search (API-free, early-exit)
ipcMain.handle(
  'media:findMoment',
  async (
    _event,
    { filePath, target, interval = 0.5, start = 0, findAll = false }:
    { filePath: string; target: string; interval?: number; start?: number; findAll?: boolean },
  ): Promise<{ success: boolean; foundAtSec?: number | null; label?: string; confidence?: number; allMatchesSec?: number[]; error?: string }> => {
    if (!filePath || !fs.existsSync(filePath)) return { success: false, error: `File not found: ${filePath}` };
    const flags = ['--input', filePath, '--target', target, '--interval', String(interval), '--start', String(start)];
    if (findAll) flags.push('--find-all');
    // The vision scan spawns the Claude subscription CLI; a transient spawn/boot failure must NOT
    // masquerade as "moment not found" — the user can't tell a broken tool from a genuine miss.
    // Retry once on an EXEC failure only. A clean {foundAtSec:null} is a real miss (not a throw),
    // so it returns as-is and is never retried.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await runPythonSkill('find-moment', flags, 'findMoment');
      } catch (err: any) {
        if (attempt === 0) { console.warn('media:findMoment exec failed, retrying once:', err?.message ?? err); continue; }
        console.error('media:findMoment error:', err);
        return { success: false, error: err.message ?? String(err) };
      }
    }
    return { success: false, error: 'find-moment: unreachable' };
  },
);

// media:organizeMedia — plan how to sort the media library into folders.
// Receives the library inventory, runs the name + frame-reference passes in Python,
// and returns {assignments: {mediaId: folderName}, folders, summary}. The renderer
// applies it in one undoable step — this handler only computes the plan.
ipcMain.handle(
  'media:organizeMedia',
  async (
    _event,
    { inventory, noVision = false }: { inventory: unknown[]; noVision?: boolean },
  ): Promise<{
    success: boolean;
    assignments?: Record<string, string>;
    folders?: Array<{ name: string; count: number }>;
    summary?: unknown;
    error?: string;
  }> => {
    if (!Array.isArray(inventory) || inventory.length === 0) {
      return { success: false, error: 'No media to organize' };
    }
    const tmpPath = path.join(os.tmpdir(), `dividr_org_${Date.now()}.json`);
    try {
      fs.writeFileSync(tmpPath, JSON.stringify(inventory), 'utf-8');
      const flags = ['--input', tmpPath];
      if (noVision) flags.push('--no-vision');
      return await runPythonSkill('organize-media', flags, 'organizeMedia');
    } catch (err: any) {
      console.error('media:organizeMedia error:', err);
      return { success: false, error: err.message ?? String(err) };
    } finally {
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        /* temp file cleanup is best-effort */
      }
    }
  },
);

// media:voiceSeparate — true 2-stem source separation (voice + background).
// One-time offline bake per clip via the MDX-Net ONNX model (CPU). Produces two
// WAV stems the editor mixes LIVE with a gain crossfade (the separation curve),
// so dragging the mix is real-time. Progress is forwarded to the renderer because
// the bake is CPU-heavy and can take from seconds to a couple of minutes.
ipcMain.handle(
  'media:voiceSeparate',
  async (
    event,
    { filePath, model = '' }: { filePath: string; model?: string },
  ): Promise<{ success: boolean; filePath?: string; instrumentalPath?: string; duration?: number; sampleRate?: number; error?: string }> => {
    if (!filePath || !fs.existsSync(filePath)) return { success: false, error: `File not found: ${filePath}` };
    try {
      const isWindows = process.platform === 'win32';
      const venvPython = isWindows
        ? path.join(process.cwd(), 'src', 'backend', 'python', 'venv', 'Scripts', 'python.exe')
        : path.join(process.cwd(), 'src', 'backend', 'python', 'venv', 'bin', 'python');
      const mainPy = path.join(process.cwd(), 'src', 'backend', 'python', 'main.py');
      const pythonExe = fs.existsSync(venvPython) ? venvPython : (isWindows ? 'python' : 'python3');

      const dir = path.dirname(filePath);
      const base = path.basename(filePath, path.extname(filePath));
      const stamp = Date.now();
      const voiceOut = path.join(dir, `voice_${base}_${stamp}.wav`);
      const bgOut = path.join(dir, `background_${base}_${stamp}.wav`);

      const result = await new Promise<any>((resolve, reject) => {
        const args = [
          mainPy, 'voice-separate',
          '--input', filePath,
          '--output', voiceOut,
          '--instrumental', bgOut,
        ];
        if (model) args.push('--model', model);
        const proc = spawn(pythonExe, args);
        let stdoutBuf = '';
        let errOut = '';
        proc.stderr?.on('data', (d: Buffer) => { errOut += d.toString(); });
        proc.stdout?.on('data', (d: Buffer) => {
          stdoutBuf += d.toString();
          // Forward progress lines live — separation is slow, keep the UI moving.
          for (const line of d.toString().split('\n')) {
            if (line.startsWith('PROGRESS|')) {
              try {
                if (!event.sender.isDestroyed())
                  event.sender.send('media:voiceSeparate-progress', JSON.parse(line.slice(9)));
              } catch { /* ignore malformed progress */ }
            }
          }
        });
        proc.on('close', (code) => {
          if (code !== 0) return reject(new Error(`voice-separate exit ${code}: ${errOut.slice(-500)}`));
          let resultJson: string | null = null;
          for (const line of stdoutBuf.split('\n')) {
            if (line.startsWith('RESULT|')) resultJson = line.slice(7);
          }
          if (!resultJson) return reject(new Error('voice-separate produced no RESULT line'));
          try { resolve(JSON.parse(resultJson)); } catch (e) { reject(e); }
        });
        proc.on('error', reject);
      });

      if (!result?.success) return { success: false, error: result?.error ?? 'Voice separation failed' };
      return result;
    } catch (err: any) {
      console.error('media:voiceSeparate error:', err);
      return { success: false, error: err.message ?? String(err) };
    }
  },
);

// delete-file — used by DownloadApprovalModal deny action
ipcMain.handle('delete-file', async (_event, filePath: string) => {
  try {
    if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
    return { success: true };
  } catch (e) {
    return { success: false, error: String(e) };
  }
});

ipcMain.handle('save-temp-image', async (_event, base64Data: string, ext: string) => {
  try {
    const buf = Buffer.from(base64Data.replace(/^data:[^;]+;base64,/, ''), 'base64');
    const tmpDir = app.getPath('temp');
    const fileName = `edith-paste-${Date.now()}.${ext || 'png'}`;
    const filePath = path.join(tmpDir, fileName);
    fs.writeFileSync(filePath, buf);
    return { success: true, filePath };
  } catch (e) {
    return { success: false, error: String(e) };
  }
});

// Generic sibling of save-temp-image for document attachments (PDF, scripts,
// XML…): pasted files have no filesystem path in the renderer, so the bytes
// come over as a data URL and land in temp where EDITH's Read tool can open
// them. Keeps the ORIGINAL filename (sanitized) — EDITH reads it in the
// [Attached: …] token and the extension tells her what she's opening.
// ═══ Record & Create (Clipchamp-style in-app recorder) ═══
// Chunks stream straight to disk under userData/recordings while capturing, so
// long takes never sit in renderer memory. Recordings live ONLY there until the
// user saves them into the media library — nothing is ever written to the
// user's Downloads folder.

const recorderStreams = new Map<string, { stream: fs.WriteStream; tempPath: string }>();

function getRecordingsDir(): string {
  const dir = path.join(app.getPath('userData'), 'recordings');
  try { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); } catch { /* handled at write */ }
  return dir;
}

// Screen/window thumbnails for the custom "choose what to share" picker.
ipcMain.handle('recorder:getSources', async () => {
  try {
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 320, height: 180 },
      fetchWindowIcons: false,
    });
    return {
      success: true,
      sources: sources.map((s) => ({
        id: s.id,
        name: s.name,
        isScreen: s.id.startsWith('screen'),
        thumbnail: s.thumbnail?.toDataURL() ?? null,
      })),
    };
  } catch (e: any) {
    return { success: false, error: e?.message ?? String(e) };
  }
});

ipcMain.handle('recorder:begin', async () => {
  try {
    const id = `rec_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const tempPath = path.join(getRecordingsDir(), `${id}.raw.webm`);
    const stream = fs.createWriteStream(tempPath);
    recorderStreams.set(id, { stream, tempPath });
    return { success: true, id };
  } catch (e: any) {
    return { success: false, error: e?.message ?? String(e) };
  }
});

ipcMain.handle('recorder:appendChunk', async (_event, id: string, chunk: ArrayBuffer) => {
  const entry = recorderStreams.get(id);
  if (!entry) return { success: false, error: 'unknown recording id' };
  return new Promise((resolve) => {
    entry.stream.write(Buffer.from(chunk), (err) =>
      resolve(err ? { success: false, error: err.message } : { success: true }));
  });
});

// Close the raw stream and finalize: MediaRecorder webm blobs carry no duration
// header, so a stream-copy remux writes one (fast, no re-encode). Audio-only
// takes are transcoded to mp3 so they behave like the rest of the audio pipeline.
ipcMain.handle('recorder:finish', async (_event, id: string, kind: 'video' | 'audio') => {
  const entry = recorderStreams.get(id);
  if (!entry) return { success: false, error: 'unknown recording id' };
  recorderStreams.delete(id);
  await new Promise<void>((resolve) => entry.stream.end(() => resolve()));
  if (!ffmpegPath) return { success: false, error: 'FFmpeg binary not available' };
  try {
    // MediaRecorder may hand us h264+opus in a webm/matroska shell — h264 is
    // illegal in a real WebM container, so pick the output box by codec:
    // h264 → .mp4 (video copy, opus→aac); vp8/vp9 → .webm stream copy.
    let vCodec = '';
    if (kind === 'video' && ffprobePath?.path) {
      vCodec = await new Promise<string>((resolve) => {
        let out = '';
        const p = spawn(ffprobePath!.path, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', entry.tempPath]);
        p.stdout.on('data', (d: Buffer) => { out += d.toString(); });
        p.on('close', () => resolve(out.trim()));
        p.on('error', () => resolve(''));
      });
    }
    const isH264 = vCodec === 'h264';
    const ext = kind === 'audio' ? '.mp3' : isH264 ? '.mp4' : '.webm';
    const outPath = path.join(getRecordingsDir(), `${id}${ext}`);
    const args = kind === 'audio'
      ? ['-y', '-i', entry.tempPath, '-vn', '-codec:a', 'libmp3lame', '-q:a', '2', outPath]
      : isH264
        ? ['-y', '-i', entry.tempPath, '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', outPath]
        : ['-y', '-i', entry.tempPath, '-c', 'copy', outPath];
    await new Promise<void>((resolve, reject) => {
      const p = spawn(ffmpegPath!, args);
      let errOut = '';
      p.stderr?.on('data', (d: Buffer) => { errOut += d.toString(); });
      p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}: ${errOut.slice(-300)}`))));
      p.on('error', reject);
    });
    try { fs.unlinkSync(entry.tempPath); } catch { /* temp cleanup is best-effort */ }
    let duration = 0;
    if (ffprobePath?.path) {
      duration = await new Promise<number>((resolve) => {
        let out = '';
        const p = spawn(ffprobePath!.path, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', outPath]);
        p.stdout.on('data', (d: Buffer) => { out += d.toString(); });
        p.on('close', () => resolve(parseFloat(out.trim()) || 0));
        p.on('error', () => resolve(0));
      });
    }
    return { success: true, filePath: outPath, duration };
  } catch (e: any) {
    return { success: false, error: e?.message ?? String(e) };
  }
});

// Retake / delete — remove every trace of the take from disk.
ipcMain.handle('recorder:discard', async (_event, payload: { id?: string; filePath?: string }) => {
  const entry = payload?.id ? recorderStreams.get(payload.id) : undefined;
  if (entry && payload.id) {
    recorderStreams.delete(payload.id);
    await new Promise<void>((resolve) => entry.stream.end(() => resolve()));
    try { fs.unlinkSync(entry.tempPath); } catch { /* already gone */ }
  }
  if (payload?.filePath && payload.filePath.startsWith(getRecordingsDir())) {
    try { fs.unlinkSync(payload.filePath); } catch { /* already gone */ }
  }
  return { success: true };
});

// "Send to EDITH" gate — does the finished recording actually contain audible
// audio? A muted mic still writes a silent track, so stream presence alone
// proves nothing: volumedetect must see real signal above the silence floor.
ipcMain.handle('recorder:hasAudibleAudio', async (_event, payload: { filePath: string }) => {
  if (!ffmpegPath) return { success: false, error: 'FFmpeg binary not available' };
  const filePath = payload?.filePath;
  if (!filePath || !fs.existsSync(filePath)) return { success: false, error: `File not found: ${filePath}` };
  try {
    const stderr = await new Promise<string>((resolve, reject) => {
      let err = '';
      // -map 0:a:0 makes ffmpeg fail outright when the file has no audio stream,
      // which is exactly the signal wanted for that case.
      const p = spawn(ffmpegPath!, ['-i', filePath, '-map', '0:a:0', '-vn', '-af', 'volumedetect', '-f', 'null', '-']);
      p.stderr?.on('data', (d: Buffer) => { err += d.toString(); });
      p.on('close', () => resolve(err));
      p.on('error', reject);
    });
    const maxM = stderr.match(/max_volume:\s*(-?[\d.]+)\s*dB/);
    if (!maxM) return { success: true, hasAudioStream: false, audible: false, maxVolumeDb: null };
    const maxDb = parseFloat(maxM[1]);
    const meanM = stderr.match(/mean_volume:\s*(-?[\d.]+)\s*dB/);
    // Muted-mic tracks measure at the ~-91dB silence floor; real speech peaks far
    // above -50 even when quiet.
    return {
      success: true,
      hasAudioStream: true,
      audible: maxDb > -50,
      maxVolumeDb: maxDb,
      meanVolumeDb: meanM ? parseFloat(meanM[1]) : null,
    };
  } catch (e: any) {
    return { success: false, error: e?.message ?? String(e) };
  }
});

// ═══ Live transcription (audio recorder) ═══
// One long-lived live_transcribe.py per recorder session: PCM streams to its
// stdin while recording, PARTIAL/SEGMENT events stream back to the renderer.
// Spawned directly (NOT via mediaToolsRunner) — the runner kills any previous
// python process on each command, which would murder this one the moment any
// other transcription ran.
let liveTxProc: ReturnType<typeof spawn> | null = null;
let liveTxFinal: { resolve: (r: unknown) => void } | null = null;

function killLiveTx() {
  if (liveTxProc) { try { liveTxProc.kill(); } catch { /* already gone */ } }
  liveTxProc = null;
  liveTxFinal = null;
}

ipcMain.handle('recorder:liveTranscribe:start', async (event) => {
  try {
    killLiveTx();
    const isWindows = process.platform === 'win32';
    const venvPython = isWindows
      ? path.join(process.cwd(), 'src', 'backend', 'python', 'venv', 'Scripts', 'python.exe')
      : path.join(process.cwd(), 'src', 'backend', 'python', 'venv', 'bin', 'python');
    const script = path.join(process.cwd(), 'src', 'backend', 'python', 'scripts', 'live_transcribe.py');
    const pythonExe = fs.existsSync(venvPython) ? venvPython : (isWindows ? 'python' : 'python3');
    if (!fs.existsSync(script)) return { success: false, error: 'live_transcribe.py not found' };

    const proc = spawn(pythonExe, [script], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
    });
    liveTxProc = proc;
    const sender = event.sender;
    let lineBuf = '';
    proc.stdout?.on('data', (d: Buffer) => {
      lineBuf += d.toString();
      let nl;
      while ((nl = lineBuf.indexOf('\n')) >= 0) {
        const line = lineBuf.slice(0, nl).trim();
        lineBuf = lineBuf.slice(nl + 1);
        const sep = line.indexOf('|');
        if (sep < 0) continue;
        const prefix = line.slice(0, sep);
        let data: unknown;
        try { data = JSON.parse(line.slice(sep + 1)); } catch { continue; }
        if (prefix === 'FINAL' && liveTxFinal) { liveTxFinal.resolve(data); liveTxFinal = null; }
        if (!sender.isDestroyed()) {
          sender.send('recorder:liveTranscribe:event', { type: prefix.toLowerCase(), data });
        }
      }
    });
    proc.stderr?.on('data', (d: Buffer) => {
      const s = d.toString().trim();
      if (s) console.log('[liveTranscribe]', s.slice(0, 400));
    });
    proc.on('close', () => { if (liveTxProc === proc) { liveTxProc = null; liveTxFinal = null; } });
    return { success: true };
  } catch (e: any) {
    return { success: false, error: e?.message ?? String(e) };
  }
});

ipcMain.handle('recorder:liveTranscribe:feed', async (_event, chunk: ArrayBuffer) => {
  if (!liveTxProc?.stdin?.writable) return { success: false, error: 'no live transcriber running' };
  try { liveTxProc.stdin.write(Buffer.from(chunk)); return { success: true }; } catch (e: any) {
    return { success: false, error: e?.message ?? String(e) };
  }
});

// Close stdin → the script flushes the tail, emits FINAL, and exits. Resolves
// with the full transcriptionResult (cachedKaraokeSubtitles shape).
ipcMain.handle('recorder:liveTranscribe:finish', async () => {
  const proc = liveTxProc;
  if (!proc) return { success: false, error: 'no live transcriber running' };
  const result = await new Promise<unknown>((resolve) => {
    liveTxFinal = { resolve };
    const timer = setTimeout(() => { if (liveTxFinal) { liveTxFinal = null; resolve(null); } }, 60_000);
    proc.on('close', () => { clearTimeout(timer); if (liveTxFinal) { liveTxFinal = null; resolve(null); } });
    try { proc.stdin?.end(); } catch { resolve(null); }
  });
  if (liveTxProc === proc) liveTxProc = null;
  return result ? { success: true, result } : { success: false, error: 'no final transcript' };
});

ipcMain.handle('recorder:liveTranscribe:cancel', async () => {
  killLiveTx();
  return { success: true };
});

// The screen+camera composite is painted on a canvas by renderer timers. While
// the user records another app, DiviDr sits in the background — Chromium would
// throttle those timers to ~1fps and freeze the composite, so throttling is
// switched off for the duration of the recording only.
ipcMain.handle('recorder:setBackgroundThrottling', async (_event, enabled: boolean) => {
  try {
    mainWindow?.webContents.setBackgroundThrottling(enabled);
    return { success: true };
  } catch (e: any) {
    return { success: false, error: e?.message ?? String(e) };
  }
});

// Chromium runs webcam capture in an out-of-process `video_capture` utility
// service. When Windows' camera pipeline wedges (green or frozen frames, or
// "Could not start video source"), a renderer re-calling getUserMedia only
// reconnects to the same dead service — killing the service process is the
// one thing that clears it. Chromium respawns it on the next getUserMedia.
// Desktop/screen capture lives in the browser process and is unaffected.
ipcMain.handle('recorder:restartVideoCapture', async () => {
  try {
    const victims = app.getAppMetrics().filter((m: any) =>
      m.type === 'Utility' && /video.?capture/i.test(m.serviceName ?? m.name ?? ''));
    for (const v of victims) { try { process.kill(v.pid); } catch { /* already gone */ } }
    return { success: true, killed: victims.length };
  } catch (e: any) {
    return { success: false, error: e?.message ?? String(e) };
  }
});

ipcMain.handle('save-temp-attachment', async (_event, base64Data: string, originalName: string) => {
  try {
    const buf = Buffer.from(base64Data.replace(/^data:[^;]+;base64,/, ''), 'base64');
    const safeName = String(originalName || 'attachment').replace(/[^\w.\- ]+/g, '_').slice(-80);
    const tmpDir = path.join(app.getPath('temp'), 'edith-attachments');
    fs.mkdirSync(tmpDir, { recursive: true });
    const filePath = path.join(tmpDir, `${Date.now()}_${safeName}`);
    fs.writeFileSync(filePath, buf);
    return { success: true, filePath };
  } catch (e) {
    return { success: false, error: String(e) };
  }
});

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// Register Mycelium agent IPC handlers
registerMyceliumIPC(ipcMain, () => mainWindow);

app.on('ready', async () => {
  // Create window first to show loader immediately
  logStartupPerf();
  createWindow();
});

app.on('window-all-closed', () => {
  if (mediaServer) {
    mediaServer.close();
    console.log('ðŸ“ Media server stopped');
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
    console.log('ðŸ“ Media server stopped');
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
    console.warn('âš ï¸ Failed to cleanup FFmpeg before quit:', error);
  }

  // Cleanup noise reduction temp directory
  if (fs.existsSync(NOISE_REDUCTION_TEMP_DIR)) {
    try {
      fs.rmSync(NOISE_REDUCTION_TEMP_DIR, { recursive: true, force: true });
      console.log('ðŸ—‘ï¸ Cleaned up noise reduction temp directory');
    } catch (error) {
      console.warn(
        'âš ï¸ Failed to cleanup noise reduction temp directory:',
        error,
      );
    }
  }
});


