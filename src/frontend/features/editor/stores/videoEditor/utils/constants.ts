export const TRACK_COLORS = [
  '#8e44ad',
  '#3498db',
  '#e74c3c',
  '#f39c12',
  '#27ae60',
  '#e67e22',
  '#9b59b6',
  '#34495e',
] as const;

export const SNAP_THRESHOLD = 5; // frames

// Snap tolerances for transform operations (in video pixels)
// These control how close an element needs to be to a snap point before snapping occurs
export const TRANSFORM_SNAP_TOLERANCE = {
  // Default snap tolerance (no modifier) - no snapping
  DEFAULT: 0,
  // Shift key: forgiving/assistive snap - large tolerance for easy alignment acquisition
  // Similar to Figma/CapCut behavior where Shift helps with intentional alignment
  SHIFT: 25,
  // Ctrl/Cmd key: precision/strong snap - smaller tolerance for fine control
  PRECISION: 8,
} as const;

export const SUBTITLE_EXTENSIONS = [
  '.srt',
  '.vtt',
  '.ass',
  '.ssa',
  '.sub',
  '.sbv',
  '.lrc',
] as const;

export const MEDIA_FILE_FILTERS = [
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
      'srt',
      'vtt',
      'ass',
      'ssa',
      'sub',
      'sbv',
      'lrc',
    ],
  },
  { name: 'All Files', extensions: ['*'] },
] as const;

export const DEFAULT_TIMELINE_CONFIG = {
  totalFrames: 3000,
  fps: 30,
  zoom: 1,
  scrollX: 0,
} as const;

export const DEFAULT_PREVIEW_CONFIG = {
  canvasWidth: 800,
  canvasHeight: 540,
  previewScale: 1,
  panX: 0,
  panY: 0,
  interactionMode: 'select' as const,
  backgroundColor: '#000000',
} as const;

export const DEFAULT_PLAYBACK_CONFIG = {
  playbackRate: 1,
  volume: 1,
  muted: false,
} as const;

export const DEFAULT_AUDIO_PROPERTIES = {
  volumeDb: 0, // 0 dB = unity gain
  noiseReductionEnabled: false,
};

// Auto-save configuration
// Implements a smart debounced auto-save similar to Figma/Premiere Pro
export const AUTO_SAVE_CONFIG = {
  // Default debounce delay after the last edit before triggering auto-save
  // This allows rapid edits to be batched without interruption
  DEBOUNCE_DELAY_MS: 3000,

  // Shorter delay used when a transform/drag operation ends
  // Provides quicker feedback that changes are saved after user commits an action
  COMMIT_DELAY_MS: 1000,

  // Minimum time between consecutive saves to prevent overlapping save requests
  MIN_SAVE_INTERVAL_MS: 2000,
} as const;
