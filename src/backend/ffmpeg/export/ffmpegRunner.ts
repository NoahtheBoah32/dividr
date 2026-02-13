/* eslint-disable @typescript-eslint/no-explicit-any */
// Renderer-side FFmpeg wrapper using IPC to main process
import { VideoEditJob } from '@/backend/ffmpeg/schema/ffmpegConfig';

// Progress interface for FFmpeg output
export interface FfmpegProgress {
  frame: number;
  fps: number;
  bitrate: string;
  totalSize: string;
  outTime: string;
  speed: string;
  progress: string;
  percentage?: number;
}

export interface FfmpegCallbacks {
  onProgress?: (progress: FfmpegProgress) => void;
  onStatus?: (status: string) => void;
  onLog?: (log: string, type: 'stdout' | 'stderr') => void;
}

// Check if we're in Electron renderer
const isElectron = () => {
  return typeof window !== 'undefined' && window.electronAPI;
};

const formatSecondsToTime = (totalSeconds: number): string => {
  const safeSeconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const seconds = safeSeconds % 60;
  return `${hours.toString().padStart(2, '0')}:${minutes
    .toString()
    .padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
};

const parseTimeToSeconds = (value: string): number | null => {
  if (!value) return null;
  const parts = value.split(':');
  if (parts.length !== 3) return null;
  const hours = Number(parts[0]);
  const minutes = Number(parts[1]);
  const seconds = Number(parts[2]);
  if (![hours, minutes, seconds].every(Number.isFinite)) {
    return null;
  }
  if (hours < 0 || minutes < 0 || seconds < 0) {
    return null;
  }
  return hours * 3600 + minutes * 60 + seconds;
};

const estimateJobDurationSeconds = (job: VideoEditJob): number => {
  const targetFps = job.operations?.targetFrameRate || 30;
  let maxEndFrame = 0;
  for (const input of job.inputs || []) {
    if (typeof input !== 'object' || input === null) continue;
    const track = input as {
      timelineEndFrame?: number;
      duration?: number;
      startTime?: number;
    };
    if (
      Number.isFinite(track.timelineEndFrame) &&
      (track.timelineEndFrame as number) > maxEndFrame
    ) {
      maxEndFrame = track.timelineEndFrame as number;
    }
  }
  if (maxEndFrame > 0) {
    return maxEndFrame / targetFps;
  }

  let fallback = 0;
  for (const input of job.inputs || []) {
    if (typeof input !== 'object' || input === null) continue;
    const track = input as { duration?: number; startTime?: number };
    const duration = Number(track.duration) || 0;
    const startTime = Number(track.startTime) || 0;
    fallback = Math.max(fallback, startTime + duration);
  }
  return fallback;
};

// Detect video frame rate using IPC
export async function detectVideoFrameRate(videoPath: string): Promise<number> {
  if (!isElectron()) {
    console.warn(
      '[FfmpegRunner] FFmpeg operations require Electron main process',
    );
    return 30; // Fallback
  }

  try {
    return await window.electronAPI.detectVideoFrameRate(videoPath);
  } catch (error) {
    console.error('[FfmpegRunner] Failed to detect video frame rate', error);
    return 30; // Fallback
  }
}

// Detect frame rates for multiple videos and suggest target
export async function suggestConcatFrameRate(
  videoPaths: string[],
): Promise<number> {
  try {
    const frameRates = await Promise.all(
      videoPaths.map((path) => detectVideoFrameRate(path)),
    );

    console.log('[FfmpegRunner] Detected frame rates', frameRates);

    // Use the highest frame rate to avoid quality loss
    const maxFrameRate = Math.max(...frameRates);

    // Round to common frame rates
    if (maxFrameRate <= 24.5) return 24;
    if (maxFrameRate <= 25.5) return 25;
    if (maxFrameRate <= 30.5) return 30;
    if (maxFrameRate <= 60.5) return 60;

    return Math.round(maxFrameRate);
  } catch (err) {
    console.warn(
      '[FfmpegRunner] Failed to detect frame rates, using default 30fps',
      err,
    );
    return 30;
  }
}

// Cancel current FFmpeg process via IPC
export function cancelCurrentFfmpeg(): Promise<boolean> {
  if (!isElectron()) {
    console.warn(
      '[FfmpegRunner] FFmpeg operations require Electron main process',
    );
    return Promise.resolve(false);
  }

  return window.electronAPI
    .cancelFfmpegExport()
    .then((result) => result.success);
}

// Check if FFmpeg is currently running
export function isFfmpegRunning(): boolean {
  // This would need to be tracked via IPC or state management
  console.warn(
    '[FfmpegRunner] isFfmpegRunning not implemented for IPC version',
  );
  return false;
}

// Parse FFmpeg progress output
export function parseFfmpegProgress(
  progressLine: string,
): Partial<FfmpegProgress> {
  const progress: any = {};

  const patterns = {
    frame: /frame=\s*(\d+)/,
    fps: /fps=\s*([\d.]+)/,
    bitrate: /bitrate=\s*([\d.]+\w+)/,
    outTime: /time=(\d{2}:\d{2}:\d{2}(?:\.\d+)?)/,
    totalSize: /size=\s*(\d+\w+)/,
    speed: /speed=\s*([\d.]+x)/,
    progress: /progress=(\w+)/,
  };

  for (const [key, pattern] of Object.entries(patterns)) {
    const match = progressLine.match(pattern);
    if (match) {
      progress[key] =
        key === 'frame' || key === 'fps' ? Number(match[1]) : match[1];
    }
  }

  return progress;
}

// Enhanced FFmpeg runner with progress callbacks via IPC
export async function runFfmpegWithProgress(
  job: VideoEditJob,
  callbacks?: FfmpegCallbacks,
): Promise<{
  command: string;
  logs: string;
  cancelled?: boolean;
  message?: string;
}> {
  console.log('[FfmpegRunner] runFfmpegWithProgress called with job', job);

  if (!isElectron()) {
    console.error('[FfmpegRunner] Not in Electron environment!');
    throw new Error('FFmpeg operations require Electron main process');
  }
  console.log('[FfmpegRunner] Electron environment confirmed');

  const estimatedDuration = estimateJobDurationSeconds(job);
  const progressState: Partial<FfmpegProgress> = {};
  let lastOutTimeSeconds = 0;
  let lastPercentage = 0;
  let stdoutLineBuffer = '';
  let stderrLineBuffer = '';

  const applyOutTimeSeconds = (seconds: number) => {
    if (!Number.isFinite(seconds) || seconds < 0) return;
    lastOutTimeSeconds = Math.max(lastOutTimeSeconds, seconds);
    progressState.outTime = formatSecondsToTime(lastOutTimeSeconds);
  };

  const processProgressLine = (line: string, type: 'stdout' | 'stderr') => {
    const trimmed = line.trim();
    if (!trimmed) return;

    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex > 0 && type === 'stdout') {
      const key = trimmed.slice(0, separatorIndex);
      const value = trimmed.slice(separatorIndex + 1);

      switch (key) {
        case 'frame':
          progressState.frame = Number(value) || progressState.frame || 0;
          return;
        case 'fps':
          progressState.fps = Number(value) || progressState.fps || 0;
          return;
        case 'bitrate':
          progressState.bitrate = value;
          return;
        case 'total_size':
          progressState.totalSize = value;
          return;
        case 'out_time': {
          const parsed = parseTimeToSeconds(value);
          if (parsed !== null) {
            applyOutTimeSeconds(parsed);
          }
          return;
        }
        case 'out_time_us':
        case 'out_time_ms': {
          const microseconds = Number(value);
          const seconds = microseconds / 1_000_000;
          applyOutTimeSeconds(seconds);
          return;
        }
        case 'out_time_ns': {
          const nanoseconds = Number(value);
          const seconds = nanoseconds / 1_000_000_000;
          applyOutTimeSeconds(seconds);
          return;
        }
        case 'speed':
          progressState.speed = value;
          return;
        case 'progress':
          progressState.progress = value;
          callbacks?.onStatus?.(
            value === 'end' ? 'Processing complete' : 'Rendering...',
          );
          return;
      }
    }

    // Fallback parser for stderr "time=..." lines (and any non-keyvalue lines)
    const fallback = parseFfmpegProgress(trimmed);
    if (typeof fallback.frame === 'number') {
      progressState.frame = fallback.frame;
    }
    if (typeof fallback.fps === 'number') {
      progressState.fps = fallback.fps;
    }
    if (typeof fallback.bitrate === 'string') {
      progressState.bitrate = fallback.bitrate;
    }
    if (typeof fallback.totalSize === 'string') {
      progressState.totalSize = fallback.totalSize;
    }
    if (typeof fallback.speed === 'string') {
      progressState.speed = fallback.speed;
    }
    if (typeof fallback.progress === 'string') {
      progressState.progress = fallback.progress;
      callbacks?.onStatus?.(
        fallback.progress === 'end' ? 'Processing complete' : 'Rendering...',
      );
    }
    if (typeof fallback.outTime === 'string') {
      const parsed = parseTimeToSeconds(fallback.outTime);
      if (parsed !== null) {
        applyOutTimeSeconds(parsed);
      }
    }
  };

  const offProgress = window.electronAPI.onFfmpegRunProgress((payload) => {
    callbacks?.onLog?.(payload.data, payload.type);
    const targetBuffer =
      payload.type === 'stdout' ? stdoutLineBuffer : stderrLineBuffer;
    const combined = `${targetBuffer}${payload.data}`;
    const lines = combined.split(/\r?\n/);
    const remaining = lines.pop() ?? '';

    if (payload.type === 'stdout') {
      stdoutLineBuffer = remaining;
    } else {
      stderrLineBuffer = remaining;
    }

    for (const line of lines) {
      processProgressLine(line, payload.type);
    }

    // Process completed line when ffmpeg emits CR-only updates
    if (
      (payload.data.includes('\r') || payload.data.includes('\n')) &&
      remaining
    ) {
      processProgressLine(remaining, payload.type);
      if (payload.type === 'stdout') {
        stdoutLineBuffer = '';
      } else {
        stderrLineBuffer = '';
      }
    }

    const percentage =
      estimatedDuration > 0
        ? Math.max(
            0,
            Math.min(
              100,
              Math.max(
                lastPercentage,
                (Math.max(0, lastOutTimeSeconds) / estimatedDuration) * 100,
              ),
            ),
          )
        : undefined;
    if (percentage !== undefined && Number.isFinite(percentage)) {
      lastPercentage = percentage;
    }

    callbacks?.onProgress?.({
      frame: progressState.frame || 0,
      fps: progressState.fps || 0,
      bitrate: progressState.bitrate || '',
      totalSize: progressState.totalSize || '',
      outTime: progressState.outTime || '',
      speed: progressState.speed || '',
      progress: progressState.progress || '',
      percentage,
    });
  });

  try {
    const result = await window.electronAPI.ffmpegRun(job);

    if (result.success) {
      return {
        command: 'ffmpeg-via-ipc',
        logs: result.logs || '',
        cancelled: result.cancelled,
        message: result.message,
      };
    }

    throw new Error(result.error || 'FFmpeg execution failed');
  } finally {
    offProgress();
  }
}

// Keep original function for backward compatibility
export async function runFfmpeg(
  job: VideoEditJob,
): Promise<{ command: string; logs: string }> {
  const result = await window.electronAPI.ffmpegRun(job);

  if (result.success) {
    return {
      command: 'ffmpeg-via-ipc',
      logs: result.logs || '',
    };
  } else {
    throw new Error(result.error || 'FFmpeg execution failed');
  }
}

// Generate a proxy file for 4K editing optimization
export async function generateProxy(
  inputPath: string,
): Promise<{ success: boolean; proxyPath: string }> {
  if (!isElectron()) {
    console.warn(
      '[FfmpegRunner] FFmpeg operations require Electron main process',
    );
    throw new Error('FFmpeg operations require Electron main process');
  }

  try {
    const result = await window.electronAPI.generateProxy(inputPath);
    if (result.success && result.proxyPath) {
      return { success: true, proxyPath: result.proxyPath };
    }
    throw new Error(result.error || 'Failed to generate proxy');
  } catch (error) {
    console.error('[FfmpegRunner] Failed to generate proxy', error);
    throw error;
  }
}
