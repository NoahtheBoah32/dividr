/**
 * FFmpeg channels — reuse ../../../../src/backend/ffmpeg/export/ffmpegRunner.ts
 * directly. That module shells out to ffmpeg-static and is largely electron-free,
 * so it runs as-is on the server.
 *
 * Streaming channels (ffmpeg-progress / -status / -log / -complete) are emitted
 * over the WS hub, matching what the desktop pushes via webContents.send.
 */
import type { Handler } from './index';

// NOTE: import lazily inside handlers so a missing native dep doesn't crash boot.
type Register = (channel: string, fn: Handler) => void;

export function registerFfmpegHandlers(handle: Register): void {
  handle('run-ffmpeg-with-progress', async ([job], { emit }) => {
    const { runFfmpegWithProgress } = await import(
      '../../../../src/backend/ffmpeg/export/ffmpegRunner.js'
    );
    // Desktop passes callbacks that forward to webContents.send; we forward to WS.
    const result = await runFfmpegWithProgress(
      job as never,
      (p: unknown) => emit('ffmpeg-progress', p),
      (s: unknown) => emit('ffmpeg-status', s),
      (l: unknown) => emit('ffmpeg-log', l),
    );
    emit('ffmpeg-complete', { success: true, result });
    return result;
  });

  handle('run-ffmpeg', async ([job]) => {
    const { runFfmpeg } = await import(
      '../../../../src/backend/ffmpeg/export/ffmpegRunner.js'
    );
    return runFfmpeg(job as never);
  });

  // Desktop aliases ffmpegRun → run-ffmpeg.
  handle('ffmpegRun', async ([job]) => {
    const { runFfmpeg } = await import(
      '../../../../src/backend/ffmpeg/export/ffmpegRunner.js'
    );
    return runFfmpeg(job as never);
  });

  handle('cancel-ffmpeg', async () => {
    const { cancelCurrentFfmpeg } = await import(
      '../../../../src/backend/ffmpeg/export/ffmpegRunner.js'
    );
    return cancelCurrentFfmpeg();
  });

  handle('generate-proxy', async ([inputPath]) => {
    const { generateProxy } = await import(
      '../../../../src/backend/ffmpeg/export/ffmpegRunner.js'
    );
    return generateProxy(inputPath as string);
  });

  // ffmpeg:get-duration and getVideoDimensions use ffprobe.
  // TODO(decouple): the desktop wires these in main.ts; lift the ffprobe calls
  // out of main.ts into a shared helper so both desktop and server import them.
}
