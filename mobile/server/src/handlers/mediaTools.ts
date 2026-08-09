/**
 * Media-tools channels (noise reduction). Reuses
 * ../../../../src/backend/media-tools/mediaToolsRunner.ts (reduceNoise),
 * which runs DeepFilterNet / ffmpeg denoise via the python sidecar.
 */
import type { Handler } from './index';

type Register = (channel: string, fn: Handler) => void;

export function registerMediaToolsHandlers(handle: Register): void {
  handle('media-tools:noise-reduce', async ([inputPath, outputPath, options], { emit }) => {
    const { reduceNoise } = await import(
      '../../../../src/backend/media-tools/mediaToolsRunner.js'
    );
    return reduceNoise(
      inputPath as string,
      outputPath as string,
      options as never,
      (progress: unknown) => emit('media-tools:progress', progress),
    );
  });

  handle('media-tools:cancel', async () => {
    const { cancelCurrentOperation } = await import(
      '../../../../src/backend/media-tools/mediaToolsRunner.js'
    );
    return cancelCurrentOperation();
  });

  handle('media-tools:status', async () => {
    const { getMediaToolsStatus } = await import(
      '../../../../src/backend/media-tools/mediaToolsRunner.js'
    );
    return getMediaToolsStatus();
  });
}
