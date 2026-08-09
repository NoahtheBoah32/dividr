/**
 * Browser implementation of `window.electronAPI`.
 *
 * Every method here mirrors the signature exposed in ../../../src/preload.ts,
 * but instead of ipcRenderer it uses the HTTP/WS transport. Because the shape
 * is identical, the shared frontend (../../../src/frontend) runs unchanged.
 *
 * Convention: named convenience methods delegate to invoke(<same channel name
 * the desktop preload used>). Event subscriptions delegate to on(<event>).
 */
import { invoke, on, removeAllListeners, removeListener } from './transport';

type AnyFn = (...args: unknown[]) => void;

export const electronAPI = {
  // Generic IPC
  invoke: (channel: string, ...args: unknown[]) => invoke(channel, ...args),
  on: (channel: string, listener: AnyFn) => on(channel, listener),
  removeListener: (channel: string, listener: AnyFn) => removeListener(channel, listener),

  // File dialogs — on mobile these resolve to upload/share flows server-side.
  openFileDialog: (options?: unknown) => invoke('open-file-dialog', options),
  showSaveDialog: (options?: unknown) => invoke('show-save-dialog', options),
  getDownloadsDirectory: () => invoke('get-downloads-directory'),
  showItemInFolder: (filePath: string) => invoke('show-item-in-folder', filePath),

  // File preview / streaming
  createPreviewUrl: (filePath: string) => invoke('create-preview-url', filePath),
  getFileStream: (filePath: string, start?: number, end?: number) =>
    invoke('get-file-stream', filePath, start, end),

  // Media cache
  getMediaCacheDir: () => invoke('get-media-cache-dir'),
  mediaPathExists: (pathOrUrl: string) => invoke('media-path-exists', pathOrUrl),

  // File processing — fileBuffers are uploaded as part of the JSON/multipart body.
  processDroppedFiles: (fileBuffers: unknown) => invoke('process-dropped-files', fileBuffers),
  cleanupTempFiles: (filePaths: string[]) => invoke('cleanup-temp-files', filePaths),
  readFile: (filePath: string) => invoke('read-file', filePath),
  readFileAsBuffer: (filePath: string) => invoke('read-file-as-buffer', filePath),

  // IO status
  getIOStatus: () => invoke('get-io-status'),
  cancelMediaTasks: (mediaId: string) => invoke('cancel-media-tasks', mediaId),

  // FFmpeg
  ffmpegRun: (job: unknown) => invoke('ffmpegRun', job),
  runFfmpeg: (job: unknown) => invoke('run-ffmpeg', job),
  getDuration: (filePath: string) => invoke('ffmpeg:get-duration', filePath),
  runCustomFFmpeg: (args: string[], outputDir: string) =>
    invoke('run-custom-ffmpeg', args, outputDir),
  getVideoDimensions: (filePath: string) => invoke('getVideoDimensions', filePath),
  extractAudioFromVideo: (videoPath: string, outputDir?: string) =>
    invoke('extract-audio-from-video', videoPath, outputDir),
  cleanupExtractedAudio: (audioPaths: string[]) => invoke('cleanup-extracted-audio', audioPaths),

  // Sprite sheets
  generateSpriteSheetBackground: (options: unknown) =>
    invoke('generate-sprite-sheet-background', options),
  getSpriteSheetProgress: (jobId: string) => invoke('get-sprite-sheet-progress', jobId),
  cancelSpriteSheetJob: (jobId: string) => invoke('cancel-sprite-sheet-job', jobId),
  onSpriteSheetJobCompleted: (cb: AnyFn) => on('sprite-sheet-job-completed', cb),
  onSpriteSheetJobError: (cb: AnyFn) => on('sprite-sheet-job-error', cb),
  onSpriteSheetSheetReady: (cb: AnyFn) => on('sprite-sheet-sheet-ready', cb),
  removeSpriteSheetListeners: () => {
    removeAllListeners('sprite-sheet-job-completed');
    removeAllListeners('sprite-sheet-job-error');
    removeAllListeners('sprite-sheet-sheet-ready');
  },

  // FFmpeg diagnostics / hardware
  getFFmpegStatus: () => invoke('ffmpeg:status'),
  generateProxy: (inputPath: string) => invoke('generate-proxy', inputPath),
  getHardwareCapabilities: () => invoke('get-hardware-capabilities'),

  // FFmpeg with progress — desktop attaches IPC listeners then invokes. Same here,
  // but the events arrive over the WS stream, demuxed by channel.
  runFfmpegWithProgress: (
    job: unknown,
    handlers?: {
      onProgress?: AnyFn;
      onStatus?: AnyFn;
      onLog?: AnyFn;
      onComplete?: AnyFn;
    },
  ) => {
    const cleanup = () => {
      removeAllListeners('ffmpeg-progress');
      removeAllListeners('ffmpeg-status');
      removeAllListeners('ffmpeg-log');
      removeAllListeners('ffmpeg-complete');
    };
    if (handlers) {
      cleanup();
      if (handlers.onProgress) on('ffmpeg-progress', (p) => handlers.onProgress?.(p));
      if (handlers.onStatus) on('ffmpeg-status', (s) => handlers.onStatus?.(s));
      if (handlers.onLog) on('ffmpeg-log', (l) => handlers.onLog?.(l));
      if (handlers.onComplete)
        on('ffmpeg-complete', (r) => {
          handlers.onComplete?.(r);
          cleanup();
        });
    }
    return invoke('run-ffmpeg-with-progress', job);
  },
  cancelFfmpeg: () => invoke('cancel-ffmpeg'),

  // Subtitles / files
  writeSubtitleFile: (options: unknown) => invoke('write-subtitle-file', options),
  deleteFile: (filePath: string) => invoke('delete-file', filePath),

  // yt-dlp downloads
  initDownloadDir: () => invoke('media:initDownloadDir'),
  downloadFromUrl: (payload: unknown) => invoke('media:downloadFromUrl', payload),
  cancelDownload: (jobId: string) => invoke('media:cancelDownload', jobId),

  // Whisper transcription
  whisperTranscribe: (audioPath: string, options?: unknown) =>
    invoke('whisper:transcribe', audioPath, options),
  whisperCancel: () => invoke('whisper:cancel'),
  whisperStatus: () => invoke('whisper:status'),
  onWhisperProgress: (cb: AnyFn) => on('whisper:progress', cb),
  removeWhisperProgressListener: () => removeAllListeners('whisper:progress'),

  // Media tools (noise reduction)
  mediaToolsNoiseReduce: (inputPath: string, outputPath: string, options?: unknown) =>
    invoke('media-tools:noise-reduce', inputPath, outputPath, options),
  mediaToolsCancel: () => invoke('media-tools:cancel'),
  mediaToolsStatus: () => invoke('media-tools:status'),
  onMediaToolsProgress: (cb: AnyFn) => on('media-tools:progress', cb),
  removeMediaToolsProgressListener: () => removeAllListeners('media-tools:progress'),
  mediaHasAudio: (filePath: string) => invoke('media:has-audio', filePath),

  // Noise reduction cache
  noiseReductionGetOutputPath: (inputPath: string, engine?: string) =>
    invoke('noise-reduction:get-output-path', inputPath, engine),
  noiseReductionCleanupFiles: (filePaths: string[]) =>
    invoke('noise-reduction:cleanup-files', filePaths),
  noiseReductionCreatePreviewUrl: (filePath: string) =>
    invoke('noise-reduction:create-preview-url', filePath),

  // Runtime download — on mobile the runtime lives on the server, so these
  // report "installed" but remain wired for parity.
  runtimeStatus: () => invoke('runtime:status'),
  runtimeDownload: () => invoke('runtime:download'),
  runtimeCancelDownload: () => invoke('runtime:cancel-download'),
  runtimeVerify: () => invoke('runtime:verify'),
  runtimeRemove: () => invoke('runtime:remove'),
  onRuntimeDownloadProgress: (cb: AnyFn) => on('runtime:download-progress', cb),
  removeRuntimeDownloadProgressListener: () => removeAllListeners('runtime:download-progress'),

  // Transcode
  transcodeRequiresTranscoding: (filePath: string) =>
    invoke('transcode:requires-transcoding', filePath),
  transcodeStart: (options: unknown) => invoke('transcode:start', options),
  transcodeStatus: (jobId: string) => invoke('transcode:status', jobId),
  transcodeCancel: (jobId: string) => invoke('transcode:cancel', jobId),
  transcodeCancelForMedia: (mediaId: string) => invoke('transcode:cancel-for-media', mediaId),
  transcodeGetActiveJobs: () => invoke('transcode:get-active-jobs'),
  transcodeCleanup: (maxAgeMs?: number) => invoke('transcode:cleanup', maxAgeMs),
  onTranscodeProgress: (cb: AnyFn) => on('transcode:progress', cb),
  onTranscodeCompleted: (cb: AnyFn) => on('transcode:completed', cb),
  removeTranscodeListeners: () => {
    removeAllListeners('transcode:progress');
    removeAllListeners('transcode:completed');
  },
};

export type ElectronAPI = typeof electronAPI;
