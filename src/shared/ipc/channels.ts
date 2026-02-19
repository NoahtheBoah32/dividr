export const IPC_CHANNELS = {
  // Dialog and file system
  OPEN_FILE_DIALOG: 'open-file-dialog',
  SHOW_SAVE_DIALOG: 'show-save-dialog',
  GET_DOWNLOADS_DIRECTORY: 'get-downloads-directory',
  SHOW_ITEM_IN_FOLDER: 'show-item-in-folder',
  PROCESS_DROPPED_FILES: 'process-dropped-files',
  CLEANUP_TEMP_FILES: 'cleanup-temp-files',
  READ_FILE: 'read-file',
  READ_FILE_AS_BUFFER: 'read-file-as-buffer',
  WRITE_FILE: 'write-file',
  GET_IO_STATUS: 'get-io-status',
  CANCEL_MEDIA_TASKS: 'cancel-media-tasks',
  GET_MEDIA_CACHE_DIR: 'get-media-cache-dir',
  MEDIA_PATH_EXISTS: 'media-path-exists',

  // Media server and preview
  CREATE_PREVIEW_URL: 'create-preview-url',
  GET_FILE_STREAM: 'get-file-stream',
  MEDIA_ENSURE_SERVER: 'media:ensure-server',

  // FFmpeg and media processing
  RUN_FFMPEG: 'run-ffmpeg',
  RUN_FFMPEG_WITH_PROGRESS: 'run-ffmpeg-with-progress',
  EXTRACT_AUDIO_FROM_VIDEO: 'extract-audio-from-video',
  CLEANUP_EXTRACTED_AUDIO: 'cleanup-extracted-audio',
  RUN_CUSTOM_FFMPEG: 'run-custom-ffmpeg',
  GENERATE_SPRITE_SHEET_BACKGROUND: 'generate-sprite-sheet-background',
  GET_SPRITE_SHEET_PROGRESS: 'get-sprite-sheet-progress',
  CANCEL_SPRITE_SHEET_JOB: 'cancel-sprite-sheet-job',
  FFMPEG_DETECT_FRAME_RATE: 'ffmpeg:detect-frame-rate',
  FFMPEG_GET_DURATION: 'ffmpeg:get-duration',
  GET_VIDEO_DIMENSIONS: 'getVideoDimensions',
  FFMPEG_RUN: 'ffmpegRun',
  FFMPEG_CANCEL_EXPORT: 'ffmpeg:cancel',
  GENERATE_PROXY: 'generate-proxy',
  GET_HARDWARE_CAPABILITIES: 'get-hardware-capabilities',
  FFMPEG_STATUS: 'ffmpeg:status',

  // Whisper and media tools
  WHISPER_TRANSCRIBE: 'whisper:transcribe',
  WHISPER_CANCEL: 'whisper:cancel',
  WHISPER_STATUS: 'whisper:status',
  MEDIA_TOOLS_NOISE_REDUCE: 'media-tools:noise-reduce',
  MEDIA_TOOLS_CANCEL: 'media-tools:cancel',
  MEDIA_TOOLS_STATUS: 'media-tools:status',
  MEDIA_HAS_AUDIO: 'media:has-audio',

  // Noise reduction cache
  NOISE_REDUCTION_GET_OUTPUT_PATH: 'noise-reduction:get-output-path',
  NOISE_REDUCTION_CLEANUP_FILES: 'noise-reduction:cleanup-files',
  NOISE_REDUCTION_CREATE_PREVIEW_URL: 'noise-reduction:create-preview-url',

  // Runtime and release
  RUNTIME_STATUS: 'runtime:status',
  RUNTIME_DOWNLOAD: 'runtime:download',
  RUNTIME_CANCEL_DOWNLOAD: 'runtime:cancel-download',
  RUNTIME_VERIFY: 'runtime:verify',
  RUNTIME_REMOVE: 'runtime:remove',
  RELEASE_CHECK_UPDATES: 'release:check-updates',
  RELEASE_GET_UPDATE_CACHE: 'release:get-update-cache',
  RELEASE_GET_INSTALLED_RELEASE: 'release:get-installed-release',

  // Transcode
  TRANSCODE_REQUIRES_TRANSCODING: 'transcode:requires-transcoding',
  TRANSCODE_START: 'transcode:start',
  TRANSCODE_STATUS: 'transcode:status',
  TRANSCODE_CANCEL: 'transcode:cancel',
  TRANSCODE_CANCEL_FOR_MEDIA: 'transcode:cancel-for-media',
  TRANSCODE_GET_ACTIVE_JOBS: 'transcode:get-active-jobs',
  TRANSCODE_CLEANUP: 'transcode:cleanup',

  // Window and startup controls
  CLOSE_BTN: 'close-btn',
  REQUEST_APP_EXIT: 'request-app-exit',
  APP_EXIT_DECISION: 'app-exit-decision',
  MINIMIZE_BTN: 'minimize-btn',
  MAXIMIZE_BTN: 'maximize-btn',
  GET_MAXIMIZE_STATE: 'get-maximize-state',
  SET_TITLEBAR_OVERLAY: 'set-titlebar-overlay',
  SET_WINDOW_FULLSCREEN: 'set-window-fullscreen',
  STARTUP_MARK: 'startup:mark',
  STARTUP_GET_STATE: 'startup:get-state',

  // App control channels currently exposed
  SHOW_WINDOW: 'show-window',
  HIDE_WINDOW: 'hide-window',
  SET_AUTO_LAUNCH: 'set-auto-launch',
  GET_AUTO_LAUNCH: 'get-auto-launch',
  GET_CLIPBOARD_TEXT: 'get-clipboard-text',
  START_CLIPBOARD_MONITORING: 'start-clipboard-monitoring',
  STOP_CLIPBOARD_MONITORING: 'stop-clipboard-monitoring',
  IS_CLIPBOARD_MONITORING_ACTIVE: 'is-clipboard-monitoring-active',
  IS_WINDOW_FOCUSED: 'is-window-focused',
  CLEAR_LAST_CLIPBOARD_TEXT: 'clear-last-clipboard-text',
  CLEAR_CLIPBOARD: 'clear-clipboard',

  // Misc helpers currently exposed
  WRITE_SUBTITLE_FILE: 'write-subtitle-file',
  DELETE_FILE: 'delete-file',

  // Renderer event channels
  EVENT_FFMPEG_PROGRESS: 'ffmpeg-progress',
  EVENT_FFMPEG_STATUS: 'ffmpeg-status',
  EVENT_FFMPEG_LOG: 'ffmpeg-log',
  EVENT_FFMPEG_COMPLETE: 'ffmpeg-complete',
  EVENT_FFMPEG_RUN_PROGRESS: 'ffmpeg:progress',
  EVENT_PROXY_PROGRESS: 'proxy-progress',
  EVENT_SPRITE_SHEET_JOB_COMPLETED: 'sprite-sheet-job-completed',
  EVENT_SPRITE_SHEET_JOB_ERROR: 'sprite-sheet-job-error',
  EVENT_SPRITE_SHEET_SHEET_READY: 'sprite-sheet-sheet-ready',
  EVENT_WHISPER_PROGRESS: 'whisper:progress',
  EVENT_MEDIA_TOOLS_PROGRESS: 'media-tools:progress',
  EVENT_RUNTIME_DOWNLOAD_PROGRESS: 'runtime:download-progress',
  EVENT_TRANSCODE_PROGRESS: 'transcode:progress',
  EVENT_TRANSCODE_COMPLETED: 'transcode:completed',
  EVENT_WINDOW_MAXIMIZE_CHANGED: 'window-maximize-changed',
  EVENT_OPEN_PROJECT_FILE: 'open-project-file',
  EVENT_APP_EXIT_REQUESTED: 'app-exit-requested',
  EVENT_STARTUP_PHASE: 'startup:phase',
  EVENT_CLIPBOARD_CHANGED: 'clipboard-changed',
} as const;

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];
