/**
 * Media Limitations Utility
 *
 * Handles validation and toast notifications for known media constraints:
 * - 4K video imports longer than 5 minutes
 * - Regular video imports longer than 40 minutes
 * - Export limitations for long/4K content
 */

import { toast } from 'sonner';

// Limitation thresholds
export const LIMITATION_THRESHOLDS = {
  /** 4K width threshold (videos wider than this are considered 4K) */
  WIDTH_4K: 3840,
  /** 4K height threshold (videos taller than this are considered 4K in portrait) */
  HEIGHT_4K: 2160,
  /** Duration threshold for 4K videos (in seconds) - 5 minutes */
  DURATION_4K_SECONDS: 5 * 60,
  /** Duration threshold for regular videos (in seconds) - 40 minutes */
  DURATION_REGULAR_SECONDS: 40 * 60,
  /** Long export reminder threshold (in milliseconds) - 3 minutes */
  LONG_EXPORT_REMINDER_MS: 3 * 60 * 1000,
} as const;

// Toast messages
export const LIMITATION_MESSAGES = {
  IMPORT_4K_LONG: {
    title: '4K video detected',
    description:
      'Videos in 4K resolution longer than 5 minutes may experience slower playback and longer export times.',
  },
  IMPORT_LONG_DURATION: {
    title: 'Long video detected',
    description:
      'Videos longer than 40 minutes may result in slower processing and extended export times.',
  },
  EXPORT_4K_LONG: {
    title: 'Exporting 4K content',
    description:
      'Your project contains 4K video longer than 5 minutes. Export may take significantly longer.',
  },
  EXPORT_LONG_DURATION: {
    title: 'Exporting long project',
    description:
      'Your project exceeds 40 minutes. Export time will depend on video length and applied effects.',
  },
  EXPORT_LONG_RUNNING: {
    title: 'Export in progress',
    description:
      'Export may take a while depending on video length, resolution, and effects applied.',
  },
} as const;

/** Session-level tracking to prevent toast spam for the same media */
const shownImportLimitations = new Set<string>();

/** Tracking for export reminder to prevent excessive reminders */
let lastExportReminderTime = 0;
const EXPORT_REMINDER_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes between reminders

/**
 * Check if a video is 4K resolution
 */
export function is4KVideo(width?: number, height?: number): boolean {
  if (!width || !height) return false;
  return (
    width >= LIMITATION_THRESHOLDS.WIDTH_4K ||
    height >= LIMITATION_THRESHOLDS.HEIGHT_4K
  );
}

/**
 * Check if a video exceeds the duration threshold for 4K content
 */
export function exceeds4KDurationLimit(durationSeconds: number): boolean {
  return durationSeconds > LIMITATION_THRESHOLDS.DURATION_4K_SECONDS;
}

/**
 * Check if a video exceeds the regular duration threshold
 */
export function exceedsRegularDurationLimit(durationSeconds: number): boolean {
  return durationSeconds > LIMITATION_THRESHOLDS.DURATION_REGULAR_SECONDS;
}

export type ImportLimitationType = '4k_long' | 'long_duration' | null;

/**
 * Determine which import limitation applies to a video
 */
export function getImportLimitationType(
  width?: number,
  height?: number,
  durationSeconds?: number,
): ImportLimitationType {
  if (!durationSeconds) return null;

  // Check 4K + long duration first (more specific)
  if (is4KVideo(width, height) && exceeds4KDurationLimit(durationSeconds)) {
    return '4k_long';
  }

  // Check regular long duration
  if (exceedsRegularDurationLimit(durationSeconds)) {
    return 'long_duration';
  }

  return null;
}

/**
 * Generate a unique key for tracking shown limitations per media
 */
function getMediaLimitationKey(
  source: string,
  limitationType: ImportLimitationType,
): string {
  return `${source}:${limitationType}`;
}

/**
 * Check if an import limitation toast has already been shown for this media
 */
export function hasShownImportLimitation(
  source: string,
  limitationType: ImportLimitationType,
): boolean {
  if (!limitationType) return true; // No limitation = effectively "shown"
  return shownImportLimitations.has(
    getMediaLimitationKey(source, limitationType),
  );
}

/**
 * Mark an import limitation as shown for this media
 */
export function markImportLimitationShown(
  source: string,
  limitationType: ImportLimitationType,
): void {
  if (!limitationType) return;
  shownImportLimitations.add(getMediaLimitationKey(source, limitationType));
}

/**
 * Show import limitation toast if applicable
 * Returns true if a toast was shown
 */
export function showImportLimitationToast(
  source: string,
  width?: number,
  height?: number,
  durationSeconds?: number,
): boolean {
  const limitationType = getImportLimitationType(
    width,
    height,
    durationSeconds,
  );

  if (!limitationType) return false;
  if (hasShownImportLimitation(source, limitationType)) return false;

  markImportLimitationShown(source, limitationType);

  const message =
    limitationType === '4k_long'
      ? LIMITATION_MESSAGES.IMPORT_4K_LONG
      : LIMITATION_MESSAGES.IMPORT_LONG_DURATION;

  toast.warning(message.title, {
    description: message.description,
    duration: 6000,
  });

  return true;
}

export type ExportLimitationType =
  | '4k_long'
  | 'long_duration'
  | 'long_running'
  | null;

export interface ProjectExportInfo {
  /** Total project duration in seconds */
  durationSeconds: number;
  /** Whether project contains 4K content */
  has4KContent: boolean;
  /** Duration of 4K content in seconds (if any) */
  duration4KSeconds?: number;
}

/**
 * Determine which export limitation applies to a project
 */
export function getExportLimitationType(
  info: ProjectExportInfo,
): ExportLimitationType {
  // Check 4K + long duration first
  if (
    info.has4KContent &&
    info.duration4KSeconds &&
    exceeds4KDurationLimit(info.duration4KSeconds)
  ) {
    return '4k_long';
  }

  // Check total project duration
  if (exceedsRegularDurationLimit(info.durationSeconds)) {
    return 'long_duration';
  }

  return null;
}

/**
 * Show pre-export limitation toast if applicable
 * Returns true if a toast was shown
 */
export function showPreExportLimitationToast(info: ProjectExportInfo): boolean {
  const limitationType = getExportLimitationType(info);

  if (!limitationType) return false;

  const message =
    limitationType === '4k_long'
      ? LIMITATION_MESSAGES.EXPORT_4K_LONG
      : LIMITATION_MESSAGES.EXPORT_LONG_DURATION;

  toast.warning(message.title, {
    description: message.description,
    duration: 8000,
  });

  return true;
}

/**
 * Show long-running export reminder toast
 * Has a cooldown to prevent excessive reminders
 * Returns true if a toast was shown
 */
export function showLongExportReminderToast(): boolean {
  const now = Date.now();

  if (now - lastExportReminderTime < EXPORT_REMINDER_COOLDOWN_MS) {
    return false;
  }

  lastExportReminderTime = now;

  toast.info(LIMITATION_MESSAGES.EXPORT_LONG_RUNNING.title, {
    description: LIMITATION_MESSAGES.EXPORT_LONG_RUNNING.description,
    duration: 6000,
  });

  return true;
}

/**
 * Reset the export reminder timer (call when export starts)
 */
export function resetExportReminderTimer(): void {
  lastExportReminderTime = 0;
}

/**
 * Clear all session-tracked import limitations
 * Useful for testing or when user explicitly wants to see warnings again
 */
export function clearImportLimitationHistory(): void {
  shownImportLimitations.clear();
}

/**
 * Analyze tracks to determine project export info
 */
export function analyzeProjectForExport(
  tracks: Array<{
    type: string;
    width?: number;
    height?: number;
    duration: number;
    startFrame: number;
    endFrame: number;
  }>,
  fps: number,
): ProjectExportInfo {
  let maxEndFrame = 0;
  let has4KContent = false;
  let max4KDurationFrames = 0;

  for (const track of tracks) {
    // Update max end frame for total duration
    if (track.endFrame > maxEndFrame) {
      maxEndFrame = track.endFrame;
    }

    // Check for 4K content in video tracks
    if (track.type === 'video' && is4KVideo(track.width, track.height)) {
      has4KContent = true;
      const trackDurationFrames = track.endFrame - track.startFrame;
      if (trackDurationFrames > max4KDurationFrames) {
        max4KDurationFrames = trackDurationFrames;
      }
    }
  }

  const durationSeconds = maxEndFrame / fps;
  const duration4KSeconds = has4KContent
    ? max4KDurationFrames / fps
    : undefined;

  return {
    durationSeconds,
    has4KContent,
    duration4KSeconds,
  };
}
