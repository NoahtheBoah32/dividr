import { app } from 'electron';
import * as path from 'path';

/**
 * Get the path to the RNNoise model directory
 * In production: resources/ffmpeg-model
 * In development: src/backend/ffmpeg/ffmpeg-model
 */
function getModelDirectory(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'ffmpeg-model');
  } else {
    return path.join(
      app.getAppPath(),
      'src',
      'backend',
      'ffmpeg',
      'ffmpeg-model',
    );
  }
}

/**
 * Get the absolute path to the std.rnnn model file
 */
export function getDefaultModelPath(): string {
  return path.join(getModelDirectory(), 'std.rnnn');
}

export function buildArnnDenCommand(
  inputFile: string,
  outputFile: string,
  modelPath?: string,
): string[] {
  const modelFilePath = modelPath || getDefaultModelPath();

  // Escape path for FFmpeg filter on Windows (backslashes -> forward slashes, escape drive colon)
  const escapedModelPath = modelFilePath
    .replace(/\\/g, '/')
    .replace(/^([a-zA-Z]):/, '$1\\:');
  const finalModelPath = `'${escapedModelPath}'`;

  // RNNoise requires: 48kHz, float planar (fltp), mono input.
  // Use aresample before arnndn to guarantee the expected format, and avoid
  // forcing soxr (not always available in bundled FFmpeg builds).
  const audioFilter = `aresample=48000,aformat=sample_fmts=fltp:channel_layouts=mono,arnndn=m=${finalModelPath}`;

  return ['-i', inputFile, '-af', audioFilter, '-ac', '2', outputFile];
}

export function buildFftDenoiseCommand(
  inputFile: string,
  outputFile: string,
): string[] {
  const audioFilter = 'afftdn';
  return ['-i', inputFile, '-af', audioFilter, '-ac', '2', outputFile];
}

export function ffmpegDenoise(
  inputFile: string,
  outputFile: string,
  modelPath?: string,
): string {
  const args = buildArnnDenCommand(inputFile, outputFile, modelPath);
  return `ffmpeg ${args.join(' ')}`;
}
