/* eslint-disable @typescript-eslint/no-explicit-any */
import { contextBridge, ipcRenderer } from 'electron';
import { VideoEditJob } from './backend/ffmpeg/schema/ffmpegConfig';
import { IPC_CHANNELS } from './shared/ipc/channels';
import type {
  AppExitDecisionRequest,
  AppExitRequestedEvent,
  FfmpegEventHandlers,
  ProxyProgressEvent,
} from './shared/ipc/contracts';

// Expose FFmpeg API to renderer process
contextBridge.exposeInMainWorld('electronAPI', {
  appExitDecision: (payload: AppExitDecisionRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.APP_EXIT_DECISION, payload),
  onAppExitRequested: (callback: (payload: AppExitRequestedEvent) => void) => {
    ipcRenderer.on(IPC_CHANNELS.EVENT_APP_EXIT_REQUESTED, (_event, payload) =>
      callback(payload),
    );
  },
  offAppExitRequested: () => {
    ipcRenderer.removeAllListeners(IPC_CHANNELS.EVENT_APP_EXIT_REQUESTED);
  },
  onProxyProgress: (callback: (payload: ProxyProgressEvent) => void) => {
    ipcRenderer.on(IPC_CHANNELS.EVENT_PROXY_PROGRESS, (_event, payload) =>
      callback(payload),
    );
  },
  offProxyProgress: () => {
    ipcRenderer.removeAllListeners(IPC_CHANNELS.EVENT_PROXY_PROGRESS);
  },
  onStartupPhase: (
    callback: (payload: {
      phase: string;
      sinceStart: number;
      sinceLast: number;
      meta?: Record<string, unknown> | null;
    }) => void,
  ) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      payload: {
        phase: string;
        sinceStart: number;
        sinceLast: number;
        meta?: Record<string, unknown> | null;
      },
    ) => callback(payload);
    ipcRenderer.on(IPC_CHANNELS.EVENT_STARTUP_PHASE, listener);
    return () =>
      ipcRenderer.removeListener(IPC_CHANNELS.EVENT_STARTUP_PHASE, listener);
  },
  startupGetState: () => ipcRenderer.invoke(IPC_CHANNELS.STARTUP_GET_STATE),

  // File dialog methods
  openFileDialog: (options?: {
    title?: string;
    filters?: Array<{ name: string; extensions: string[] }>;
    properties?: Array<'openFile' | 'openDirectory' | 'multiSelections'>;
  }) => ipcRenderer.invoke(IPC_CHANNELS.OPEN_FILE_DIALOG, options),

  showSaveDialog: (options?: {
    title?: string;
    defaultPath?: string;
    buttonLabel?: string;
    filters?: Array<{ name: string; extensions: string[] }>;
  }) => ipcRenderer.invoke(IPC_CHANNELS.SHOW_SAVE_DIALOG, options),

  getDownloadsDirectory: () =>
    ipcRenderer.invoke(IPC_CHANNELS.GET_DOWNLOADS_DIRECTORY),

  showItemInFolder: (filePath: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.SHOW_ITEM_IN_FOLDER, filePath),

  // File preview methods
  createPreviewUrl: (filePath: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.CREATE_PREVIEW_URL, filePath),
  getFileStream: (filePath: string, start?: number, end?: number) =>
    ipcRenderer.invoke(IPC_CHANNELS.GET_FILE_STREAM, filePath, start, end),
  ensureMediaServer: () => ipcRenderer.invoke(IPC_CHANNELS.MEDIA_ENSURE_SERVER),

  // Media cache helpers
  getMediaCacheDir: () => ipcRenderer.invoke(IPC_CHANNELS.GET_MEDIA_CACHE_DIR),
  mediaPathExists: (pathOrUrl: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.MEDIA_PATH_EXISTS, pathOrUrl),

  // File processing methods
  processDroppedFiles: (
    fileBuffers: Array<{
      name: string;
      type: string;
      size: number;
      buffer: ArrayBuffer;
    }>,
  ) => ipcRenderer.invoke(IPC_CHANNELS.PROCESS_DROPPED_FILES, fileBuffers),
  cleanupTempFiles: (filePaths: string[]) =>
    ipcRenderer.invoke(IPC_CHANNELS.CLEANUP_TEMP_FILES, filePaths),
  readFile: (filePath: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.READ_FILE, filePath),
  readFileAsBuffer: (filePath: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.READ_FILE_AS_BUFFER, filePath),

  // File I/O and background task queue status
  getIOStatus: () => ipcRenderer.invoke(IPC_CHANNELS.GET_IO_STATUS),
  cancelMediaTasks: (mediaId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.CANCEL_MEDIA_TASKS, mediaId),

  // FFmpeg API
  ffmpegRun: (job: VideoEditJob) =>
    ipcRenderer.invoke(IPC_CHANNELS.FFMPEG_RUN, job),
  runFfmpeg: (job: VideoEditJob) =>
    ipcRenderer.invoke(IPC_CHANNELS.RUN_FFMPEG, job),
  detectVideoFrameRate: (videoPath: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.FFMPEG_DETECT_FRAME_RATE, videoPath),
  getDuration: (filePath: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.FFMPEG_GET_DURATION, filePath),
  runCustomFFmpeg: (args: string[], outputDir: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.RUN_CUSTOM_FFMPEG, args, outputDir),
  onFfmpegRunProgress: (
    callback: (payload: { type: 'stdout' | 'stderr'; data: string }) => void,
  ) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      payload: { type: 'stdout' | 'stderr'; data: string },
    ) => callback(payload);
    ipcRenderer.on(IPC_CHANNELS.EVENT_FFMPEG_RUN_PROGRESS, listener);
    return () =>
      ipcRenderer.removeListener(
        IPC_CHANNELS.EVENT_FFMPEG_RUN_PROGRESS,
        listener,
      );
  },

  // Get Dimensions
  getVideoDimensions: (filePath: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.GET_VIDEO_DIMENSIONS, filePath),
  // Audio extraction method
  extractAudioFromVideo: (videoPath: string, outputDir?: string) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.EXTRACT_AUDIO_FROM_VIDEO,
      videoPath,
      outputDir,
    ),

  // Cleanup extracted audio files
  cleanupExtractedAudio: (audioPaths: string[]) =>
    ipcRenderer.invoke(IPC_CHANNELS.CLEANUP_EXTRACTED_AUDIO, audioPaths),

  // Background sprite sheet generation methods
  generateSpriteSheetBackground: (options: {
    jobId: string;
    videoPath: string;
    outputDir: string;
    commands: string[][];
  }) =>
    ipcRenderer.invoke(IPC_CHANNELS.GENERATE_SPRITE_SHEET_BACKGROUND, options),

  getSpriteSheetProgress: (jobId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.GET_SPRITE_SHEET_PROGRESS, jobId),

  cancelSpriteSheetJob: (jobId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.CANCEL_SPRITE_SHEET_JOB, jobId),

  // Sprite sheet event listeners
  onSpriteSheetJobCompleted: (
    callback: (data: {
      jobId: string;
      outputFiles: string[];
      outputDir: string;
    }) => void,
  ) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      data: {
        jobId: string;
        outputFiles: string[];
        outputDir: string;
      },
    ) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.EVENT_SPRITE_SHEET_JOB_COMPLETED, listener);
    return () =>
      ipcRenderer.removeListener(
        IPC_CHANNELS.EVENT_SPRITE_SHEET_JOB_COMPLETED,
        listener,
      );
  },

  onSpriteSheetJobError: (
    callback: (data: { jobId: string; error: string }) => void,
  ) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      data: { jobId: string; error: string },
    ) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.EVENT_SPRITE_SHEET_JOB_ERROR, listener);
    return () =>
      ipcRenderer.removeListener(
        IPC_CHANNELS.EVENT_SPRITE_SHEET_JOB_ERROR,
        listener,
      );
  },

  // Progressive loading: Per-sheet ready event
  onSpriteSheetSheetReady: (
    callback: (data: {
      jobId: string;
      sheetIndex: number;
      totalSheets: number;
      sheetPath: string;
    }) => void,
  ) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      data: {
        jobId: string;
        sheetIndex: number;
        totalSheets: number;
        sheetPath: string;
      },
    ) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.EVENT_SPRITE_SHEET_SHEET_READY, listener);
    return () =>
      ipcRenderer.removeListener(
        IPC_CHANNELS.EVENT_SPRITE_SHEET_SHEET_READY,
        listener,
      );
  },

  removeSpriteSheetListeners: () => {
    ipcRenderer.removeAllListeners(
      IPC_CHANNELS.EVENT_SPRITE_SHEET_JOB_COMPLETED,
    );
    ipcRenderer.removeAllListeners(IPC_CHANNELS.EVENT_SPRITE_SHEET_JOB_ERROR);
    ipcRenderer.removeAllListeners(IPC_CHANNELS.EVENT_SPRITE_SHEET_SHEET_READY);
  },

  // FFmpeg diagnostics
  getFFmpegStatus: () => ipcRenderer.invoke(IPC_CHANNELS.FFMPEG_STATUS),

  // Proxy generation (with hybrid encoder support)
  generateProxy: (inputPath: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.GENERATE_PROXY, inputPath) as Promise<{
      success: boolean;
      proxyPath?: string;
      cached?: boolean;
      encoder?: {
        type: string;
        description: string;
        fallbackUsed: boolean;
        originalEncoder?: string;
      };
      benchmark?: {
        durationMs: number;
        startTime: number;
        endTime: number;
      };
      error?: string;
    }>,

  // Hardware capabilities detection
  getHardwareCapabilities: () =>
    ipcRenderer.invoke(IPC_CHANNELS.GET_HARDWARE_CAPABILITIES) as Promise<{
      success: boolean;
      capabilities?: {
        hasHardwareEncoder: boolean;
        encoderType: string;
        encoderDescription: string;
        cpuCores: number;
        totalRamGB: number;
        freeRamGB: number;
        isLowHardware: boolean;
      };
      error?: string;
    }>,

  // Enhanced API with progress tracking
  runFfmpegWithProgress: (
    job: VideoEditJob,
    handlers?: FfmpegEventHandlers,
  ) => {
    const progressState: {
      frame?: number;
      fps?: number;
      bitrate?: string;
      totalSize?: string;
      outTime?: string;
      speed?: string;
      progress?: string;
    } = {};

    const toTime = (seconds: number) => {
      const total = Math.max(0, seconds);
      const hours = Math.floor(total / 3600);
      const minutes = Math.floor((total % 3600) / 60);
      const secs = total % 60;
      const secsText = secs < 10 ? `0${secs.toFixed(2)}` : secs.toFixed(2);
      return `${hours.toString().padStart(2, '0')}:${minutes
        .toString()
        .padStart(2, '0')}:${secsText}`;
    };

    const runProgressListener = (
      _event: Electron.IpcRendererEvent,
      payload: { type: 'stdout' | 'stderr'; data: string },
    ) => {
      handlers?.onLog?.({ log: payload.data, type: payload.type });
      if (payload.type !== 'stdout') return;

      const lines = payload.data
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);

      for (const line of lines) {
        const separatorIndex = line.indexOf('=');
        if (separatorIndex <= 0) continue;
        const key = line.slice(0, separatorIndex);
        const value = line.slice(separatorIndex + 1);

        switch (key) {
          case 'frame':
            progressState.frame = Number(value) || progressState.frame || 0;
            break;
          case 'fps':
            progressState.fps = Number(value) || progressState.fps || 0;
            break;
          case 'bitrate':
            progressState.bitrate = value;
            break;
          case 'total_size':
            progressState.totalSize = value;
            break;
          case 'out_time':
            progressState.outTime = value;
            break;
          case 'out_time_ms': {
            const millis = Number(value) / 1000;
            if (Number.isFinite(millis)) {
              progressState.outTime = toTime(millis / 1000);
            }
            break;
          }
          case 'speed':
            progressState.speed = value;
            break;
          case 'progress':
            progressState.progress = value;
            handlers?.onStatus?.(
              value === 'end' ? 'Processing complete' : `Rendering... ${value}`,
            );
            break;
        }
      }

      handlers?.onProgress?.({
        frame: progressState.frame || 0,
        fps: progressState.fps || 0,
        bitrate: progressState.bitrate || '',
        totalSize: progressState.totalSize || '',
        outTime: progressState.outTime || '',
        speed: progressState.speed || '',
        progress: progressState.progress || '',
      });
    };

    ipcRenderer.on(IPC_CHANNELS.EVENT_FFMPEG_RUN_PROGRESS, runProgressListener);

    const cleanup = () => {
      ipcRenderer.removeListener(
        IPC_CHANNELS.EVENT_FFMPEG_RUN_PROGRESS,
        runProgressListener,
      );
    };

    return ipcRenderer
      .invoke(IPC_CHANNELS.FFMPEG_RUN, job)
      .then((rawResult) => {
        const response = rawResult?.success
          ? {
              success: true as const,
              result: {
                command: 'ffmpeg-via-ipc',
                logs: rawResult.logs || '',
                cancelled: rawResult.cancelled,
                message: rawResult.message,
              },
            }
          : {
              success: false as const,
              error: rawResult?.error || 'FFmpeg execution failed',
            };
        handlers?.onComplete?.(response);
        return response;
      })
      .catch((error: unknown) => {
        const response = {
          success: false as const,
          error:
            error instanceof Error ? error.message : 'FFmpeg execution failed',
        };
        handlers?.onComplete?.(response);
        return response;
      })
      .finally(() => {
        cleanup();
      });
  },

  // Cancel FFmpeg operation
  cancelFfmpegExport: () =>
    ipcRenderer.invoke(IPC_CHANNELS.FFMPEG_CANCEL_EXPORT),

  // Subtitle file operations
  writeSubtitleFile: (options: {
    content: string;
    filename: string;
    outputPath: string;
  }) => ipcRenderer.invoke(IPC_CHANNELS.WRITE_SUBTITLE_FILE, options),

  deleteFile: (filePath: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.DELETE_FILE, filePath),

  // ============================================================================

  // Python Faster-Whisper API
  // ============================================================================

  // Transcribe audio file (Python Faster-Whisper)
  whisperTranscribe: (
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
      device?: 'cpu' | 'cuda';
      computeType?: 'int8' | 'int16' | 'float16' | 'float32';
      beamSize?: number;
      vad?: boolean;
    },
  ) => ipcRenderer.invoke(IPC_CHANNELS.WHISPER_TRANSCRIBE, audioPath, options),

  // Cancel active transcription
  whisperCancel: () => ipcRenderer.invoke(IPC_CHANNELS.WHISPER_CANCEL),

  // Get Whisper status and available models
  whisperStatus: () => ipcRenderer.invoke(IPC_CHANNELS.WHISPER_STATUS),

  // Listen for transcription progress updates
  onWhisperProgress: (
    callback: (progress: {
      stage: 'loading' | 'processing' | 'complete' | 'error';
      progress: number;
      message?: string;
    }) => void,
  ) =>
    ipcRenderer.on(IPC_CHANNELS.EVENT_WHISPER_PROGRESS, (_, progress) =>
      callback(progress),
    ),

  // Remove progress listener
  removeWhisperProgressListener: () =>
    ipcRenderer.removeAllListeners(IPC_CHANNELS.EVENT_WHISPER_PROGRESS),

  // =========================================================================
  // Media Tools APIs (Noise Reduction)
  // =========================================================================

  // Reduce noise from audio file
  mediaToolsNoiseReduce: (
    inputPath: string,
    outputPath: string,
    options?: {
      stationary?: boolean;
      propDecrease?: number;
      nFft?: number;
      engine?: 'ffmpeg' | 'deepfilter';
    },
  ) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.MEDIA_TOOLS_NOISE_REDUCE,
      inputPath,
      outputPath,
      options,
    ),

  // Cancel active media-tools operation
  mediaToolsCancel: () => ipcRenderer.invoke(IPC_CHANNELS.MEDIA_TOOLS_CANCEL),

  // Get media-tools status
  mediaToolsStatus: () => ipcRenderer.invoke(IPC_CHANNELS.MEDIA_TOOLS_STATUS),

  // Listen for media-tools progress updates
  onMediaToolsProgress: (
    callback: (progress: {
      stage: 'loading' | 'processing' | 'saving' | 'complete' | 'error';
      progress: number;
      message?: string;
    }) => void,
  ) =>
    ipcRenderer.on(IPC_CHANNELS.EVENT_MEDIA_TOOLS_PROGRESS, (_, progress) =>
      callback(progress),
    ),

  // Remove media-tools progress listener
  removeMediaToolsProgressListener: () =>
    ipcRenderer.removeAllListeners(IPC_CHANNELS.EVENT_MEDIA_TOOLS_PROGRESS),

  // Check if media file has audio
  mediaHasAudio: (filePath: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.MEDIA_HAS_AUDIO, filePath),

  // =========================================================================
  // Noise Reduction Cache APIs
  // =========================================================================

  // Get a unique output path for noise reduction
  noiseReductionGetOutputPath: (inputPath: string, engine?: string) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.NOISE_REDUCTION_GET_OUTPUT_PATH,
      inputPath,
      engine,
    ) as Promise<{
      success: boolean;
      outputPath?: string;
      error?: string;
    }>,

  // Cleanup noise reduction temp files
  noiseReductionCleanupFiles: (filePaths: string[]) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.NOISE_REDUCTION_CLEANUP_FILES,
      filePaths,
    ) as Promise<{
      success: boolean;
      cleanedCount?: number;
      error?: string;
    }>,

  // Create preview URL data from processed file
  noiseReductionCreatePreviewUrl: (filePath: string) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.NOISE_REDUCTION_CREATE_PREVIEW_URL,
      filePath,
    ) as Promise<{
      success: boolean;
      base64?: string;
      mimeType?: string;
      error?: string;
    }>,

  // =========================================================================
  // Runtime Download APIs
  // =========================================================================

  // Check runtime installation status
  runtimeStatus: () =>
    ipcRenderer.invoke(IPC_CHANNELS.RUNTIME_STATUS) as Promise<{
      installed: boolean;
      version: string | null;
      path: string | null;
      needsUpdate: boolean;
      requiredVersion: string;
    }>,

  // Start runtime download
  runtimeDownload: () =>
    ipcRenderer.invoke(IPC_CHANNELS.RUNTIME_DOWNLOAD) as Promise<{
      success: boolean;
      error?: string;
    }>,

  // Cancel runtime download
  runtimeCancelDownload: () =>
    ipcRenderer.invoke(IPC_CHANNELS.RUNTIME_CANCEL_DOWNLOAD) as Promise<{
      success: boolean;
    }>,

  // Verify runtime installation
  runtimeVerify: () =>
    ipcRenderer.invoke(IPC_CHANNELS.RUNTIME_VERIFY) as Promise<{
      valid: boolean;
    }>,

  // Remove runtime
  runtimeRemove: () =>
    ipcRenderer.invoke(IPC_CHANNELS.RUNTIME_REMOVE) as Promise<{
      success: boolean;
      error?: string;
    }>,

  // =========================================================================
  // Release Update APIs
  // =========================================================================

  releaseCheckForUpdates: () =>
    ipcRenderer.invoke(IPC_CHANNELS.RELEASE_CHECK_UPDATES) as Promise<{
      success: boolean;
      updateAvailable: boolean;
      installedVersion: string;
      installedTag: string;
      latest?: {
        latestVersion: string;
        latestTag: string;
        latestTitle: string;
        checkedAt: string;
      };
      error?: string;
      errorCode?: 'rate_limited' | 'network' | 'api_error';
      rateLimitResetAt?: string | null;
    }>,

  releaseGetUpdateCache: () =>
    ipcRenderer.invoke(IPC_CHANNELS.RELEASE_GET_UPDATE_CACHE) as Promise<{
      latestVersion: string;
      latestTag: string;
      latestTitle: string;
      checkedAt: string;
    } | null>,

  releaseGetInstalledRelease: () =>
    ipcRenderer.invoke(IPC_CHANNELS.RELEASE_GET_INSTALLED_RELEASE) as Promise<{
      success: boolean;
      release?: {
        tag: string;
        title: string;
        notes: string;
        publishedAt: string | null;
        commit: string | null;
      };
      error?: string;
      errorCode?: 'rate_limited' | 'network' | 'api_error';
      rateLimitResetAt?: string | null;
    }>,

  // Listen for runtime download progress
  onRuntimeDownloadProgress: (
    callback: (progress: {
      stage:
        | 'fetching'
        | 'downloading'
        | 'extracting'
        | 'verifying'
        | 'complete'
        | 'error';
      progress: number;
      bytesDownloaded?: number;
      totalBytes?: number;
      speed?: number;
      message?: string;
      error?: string;
    }) => void,
  ) =>
    ipcRenderer.on(
      IPC_CHANNELS.EVENT_RUNTIME_DOWNLOAD_PROGRESS,
      (_, progress) => callback(progress),
    ),

  // Remove runtime download progress listener
  removeRuntimeDownloadProgressListener: () =>
    ipcRenderer.removeAllListeners(
      IPC_CHANNELS.EVENT_RUNTIME_DOWNLOAD_PROGRESS,
    ),

  // =========================================================================
  // Transcode APIs (AVI to MP4 conversion)
  // =========================================================================

  // Check if a file requires transcoding
  transcodeRequiresTranscoding: (filePath: string) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.TRANSCODE_REQUIRES_TRANSCODING,
      filePath,
    ) as Promise<{
      requiresTranscoding: boolean;
      reason: string;
    }>,

  // Start transcoding a file
  transcodeStart: (options: {
    mediaId: string;
    inputPath: string;
    videoBitrate?: string;
    audioBitrate?: string;
    crf?: number;
  }) =>
    ipcRenderer.invoke(IPC_CHANNELS.TRANSCODE_START, options) as Promise<{
      success: boolean;
      jobId?: string;
      outputPath?: string;
      error?: string;
    }>,

  // Get transcode job status
  transcodeStatus: (jobId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.TRANSCODE_STATUS, jobId) as Promise<{
      success: boolean;
      job?: {
        id: string;
        mediaId: string;
        status: 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled';
        progress: number;
        duration: number;
        currentTime: number;
        error?: string;
      };
      error?: string;
    }>,

  // Cancel a transcode job
  transcodeCancel: (jobId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.TRANSCODE_CANCEL, jobId) as Promise<{
      success: boolean;
      error?: string;
    }>,

  // Cancel all transcode jobs for a media ID
  transcodeCancelForMedia: (mediaId: string) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.TRANSCODE_CANCEL_FOR_MEDIA,
      mediaId,
    ) as Promise<{
      success: boolean;
      cancelled: number;
    }>,

  // Get all active transcode jobs
  transcodeGetActiveJobs: () =>
    ipcRenderer.invoke(IPC_CHANNELS.TRANSCODE_GET_ACTIVE_JOBS) as Promise<{
      success: boolean;
      jobs: Array<{
        id: string;
        mediaId: string;
        status: 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled';
        progress: number;
        duration: number;
        currentTime: number;
      }>;
    }>,

  // Cleanup old transcode files
  transcodeCleanup: (maxAgeMs?: number) =>
    ipcRenderer.invoke(IPC_CHANNELS.TRANSCODE_CLEANUP, maxAgeMs) as Promise<{
      success: boolean;
      cleaned?: number;
      error?: string;
    }>,

  // Listen for transcode progress updates
  onTranscodeProgress: (
    callback: (progress: {
      jobId: string;
      mediaId: string;
      status: 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled';
      progress: number;
      currentTime: number;
      duration: number;
    }) => void,
  ) =>
    ipcRenderer.on(IPC_CHANNELS.EVENT_TRANSCODE_PROGRESS, (_, progress) =>
      callback(progress),
    ),

  // Listen for transcode completion
  onTranscodeCompleted: (
    callback: (result: {
      jobId: string;
      mediaId: string;
      success: boolean;
      outputPath?: string;
      previewUrl?: string;
      error?: string;
    }) => void,
  ) =>
    ipcRenderer.on(IPC_CHANNELS.EVENT_TRANSCODE_COMPLETED, (_, result) =>
      callback(result),
    ),

  // Remove transcode listeners
  removeTranscodeListeners: () => {
    ipcRenderer.removeAllListeners(IPC_CHANNELS.EVENT_TRANSCODE_PROGRESS);
    ipcRenderer.removeAllListeners(IPC_CHANNELS.EVENT_TRANSCODE_COMPLETED);
  },
});

contextBridge.exposeInMainWorld('appControl', {
  showWindow: () => ipcRenderer.invoke(IPC_CHANNELS.SHOW_WINDOW),
  hideWindow: () => ipcRenderer.invoke(IPC_CHANNELS.HIDE_WINDOW),
  setAutoLaunch: (enabled: boolean) =>
    ipcRenderer.invoke(IPC_CHANNELS.SET_AUTO_LAUNCH, enabled),
  quitApp: () => ipcRenderer.send(IPC_CHANNELS.CLOSE_BTN),
  minimizeApp: () => ipcRenderer.send(IPC_CHANNELS.MINIMIZE_BTN),
  maximizeApp: () => ipcRenderer.send(IPC_CHANNELS.MAXIMIZE_BTN),
  getAutoLaunch: () => ipcRenderer.invoke(IPC_CHANNELS.GET_AUTO_LAUNCH),
  getMaximizeState: () => ipcRenderer.invoke(IPC_CHANNELS.GET_MAXIMIZE_STATE),
  setTitlebarOverlay: (options: {
    color?: string;
    symbolColor?: string;
    height?: number;
  }) => ipcRenderer.invoke(IPC_CHANNELS.SET_TITLEBAR_OVERLAY, options),
  setWindowFullscreen: (isFullscreen: boolean) =>
    ipcRenderer.invoke(IPC_CHANNELS.SET_WINDOW_FULLSCREEN, isFullscreen),
  startupMark: (phase: string, meta?: Record<string, unknown>) =>
    ipcRenderer.invoke(IPC_CHANNELS.STARTUP_MARK, phase, meta),
  onMaximizeChanged: (callback: (isMaximized: boolean) => void) => {
    ipcRenderer.on(
      IPC_CHANNELS.EVENT_WINDOW_MAXIMIZE_CHANGED,
      (_event, isMaximized: boolean) => callback(isMaximized),
    );
  },
  offMaximizeChanged: () => {
    ipcRenderer.removeAllListeners(IPC_CHANNELS.EVENT_WINDOW_MAXIMIZE_CHANGED);
  },

  // Clipboard monitoring
  getClipboardText: () => ipcRenderer.invoke(IPC_CHANNELS.GET_CLIPBOARD_TEXT),
  onClipboardChange: (callback: (text: string) => void) => {
    ipcRenderer.on(
      IPC_CHANNELS.EVENT_CLIPBOARD_CHANGED,
      (_event, text: string) => callback(text),
    );
  },
  offClipboardChange: () => {
    ipcRenderer.removeAllListeners(IPC_CHANNELS.EVENT_CLIPBOARD_CHANGED);
  },
  startClipboardMonitoring: () =>
    ipcRenderer.invoke(IPC_CHANNELS.START_CLIPBOARD_MONITORING),
  stopClipboardMonitoring: () =>
    ipcRenderer.invoke(IPC_CHANNELS.STOP_CLIPBOARD_MONITORING),
  isClipboardMonitoringActive: () =>
    ipcRenderer.invoke(IPC_CHANNELS.IS_CLIPBOARD_MONITORING_ACTIVE),
  isWindowFocused: () => ipcRenderer.invoke(IPC_CHANNELS.IS_WINDOW_FOCUSED),
  clearLastClipboardText: () =>
    ipcRenderer.invoke(IPC_CHANNELS.CLEAR_LAST_CLIPBOARD_TEXT),
  clearClipboard: () => ipcRenderer.invoke(IPC_CHANNELS.CLEAR_CLIPBOARD),

  // File association: Handle .dividr files opened via double-click
  onOpenProjectFile: (callback: (filePath: string) => void) => {
    ipcRenderer.on(
      IPC_CHANNELS.EVENT_OPEN_PROJECT_FILE,
      (_event, filePath: string) => callback(filePath),
    );
  },
  offOpenProjectFile: () => {
    ipcRenderer.removeAllListeners(IPC_CHANNELS.EVENT_OPEN_PROJECT_FILE);
  },
});
