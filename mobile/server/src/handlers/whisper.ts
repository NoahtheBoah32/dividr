/**
 * Whisper transcription channels. Reuses the python transcription path in
 * ../../../../src/backend/media-tools/mediaToolsRunner.ts (transcribeAudio),
 * which spawns ../../../../src/backend/python/scripts/transcribe.py.
 *
 * Requires the server host to have Python + the deps from ../../../../requirements.txt
 * installed (faster-whisper, torch, …).
 */
import type { Handler } from './index';

type Register = (channel: string, fn: Handler) => void;

export function registerWhisperHandlers(handle: Register): void {
  handle('whisper:transcribe', async ([audioPath, options], { emit }) => {
    const { transcribeAudio } = await import(
      '../../../../src/backend/media-tools/mediaToolsRunner.js'
    );
    // The desktop forwards progress via webContents.send('whisper:progress', …).
    // transcribeAudio accepts a progress callback — forward it to WS.
    return transcribeAudio(
      audioPath as string,
      options as never,
      (progress: unknown) => emit('whisper:progress', progress),
    );
  });

  handle('whisper:cancel', async () => {
    const { cancelTranscription } = await import(
      '../../../../src/backend/media-tools/mediaToolsRunner.js'
    );
    return cancelTranscription();
  });

  handle('whisper:status', async () => {
    const { getPythonWhisperStatus } = await import(
      '../../../../src/backend/media-tools/mediaToolsRunner.js'
    );
    return getPythonWhisperStatus();
  });
}
