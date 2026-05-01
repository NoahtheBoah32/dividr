/* eslint-disable @typescript-eslint/no-explicit-any */
import AudioWaveformGenerator from '@/backend/frontend_use/audioWaveformGenerator';
import { VideoSpriteSheetGenerator } from '@/backend/frontend_use/videoSpriteSheetGenerator';
import { VideoThumbnailGenerator } from '@/backend/frontend_use/videoThumbnailGenerator';
import { projectService } from '@/backend/services/projectService';
import { ContentSignature } from '@/frontend/utils/contentSignature';
import { toMediaServerUrl } from '@/shared/utils/mediaServer';
import { v4 as uuidv4 } from 'uuid';
import { StateCreator } from 'zustand';
import { MediaLibraryItem } from '../types';

/**
 * Module-level tracking for progressive sprite sheet generation.
 * Maps video source paths to their mediaIds for matching IPC events.
 * This is needed because IPC events don't include mediaId, only jobId/sheetPath.
 */
const activeSpriteSheetJobs = new Map<
  string, // videoPath (source)
  {
    mediaId: string;
    intervalSeconds: number;
    maxThumbnailsPerSheet: number;
    finalTotalThumbnails: number;
    thumbWidth: number;
    thumbHeight: number;
    duration: number;
    fps: number;
  }
>();

/**
 * Global flag to track if the sprite sheet event listener is registered.
 * We only need ONE listener that dispatches to the correct media based on path.
 */
let spriteSheetListenerRegistered = false;

const getContentSignatureKey = (
  mediaItem: MediaLibraryItem,
): string | undefined => {
  const signature = mediaItem.contentSignature;
  if (!signature?.partialHash || !signature?.fileSize) return undefined;
  return `${signature.partialHash}_${signature.fileSize}`;
};

const persistentMediaUpdateKeys = new Set<string>([
  'name',
  'source',
  'tempFilePath',
  'duration',
  'size',
  'mimeType',
  'type',
  'category',
  'spriteSheetDisabled',
  'hasGeneratedKaraoke',
  'cachedKaraokeSubtitles',
  'referenceAnalysis',
]);

const shouldMarkUnsavedChangesForMediaUpdate = (
  updates: Partial<MediaLibraryItem>,
): boolean => {
  if (!updates || Object.keys(updates).length === 0) return false;
  return Object.keys(updates).some((key) => persistentMediaUpdateKeys.has(key));
};

/** Duplicate detection user choice: 'use-existing' (skip) | 'import-copy' (keep both) */
export type DuplicateChoice = 'use-existing' | 'import-copy';

/** Single duplicate item for batch processing */
export interface DuplicateItem {
  id: string;
  pendingFileName: string;
  pendingFilePath?: string;
  existingMedia: MediaLibraryItem;
  signature: ContentSignature;
  choice?: DuplicateChoice;
}

/** Batch duplicate detection state - for handling multiple duplicates at once */
export interface BatchDuplicateDetectionState {
  show: boolean;
  duplicates: DuplicateItem[];
  pendingResolve: ((choices: Map<string, DuplicateChoice>) => void) | null;
}

/** State for duplicate detection dialog (legacy single-file support) */
export interface DuplicateDetectionState {
  show: boolean;
  existingMedia: MediaLibraryItem | null;
  pendingFile: File | null;
  pendingSignature: ContentSignature | null;
  pendingResolve: ((choice: DuplicateChoice) => void) | null;
}

export interface MediaLibrarySlice {
  mediaLibrary: MediaLibraryItem[];
  generatingSpriteSheets: Set<string>;
  generatingWaveforms: Set<string>;
  duplicateDetection: DuplicateDetectionState | null;
  batchDuplicateDetection: BatchDuplicateDetectionState | null;
  transcodingBlockedMedia: MediaLibraryItem | null;
  addToMediaLibrary: (item: Omit<MediaLibraryItem, 'id'>) => string;
  removeFromMediaLibrary: (mediaId: string, force?: boolean) => void;
  updateMediaLibraryItem: (
    mediaId: string,
    updates: Partial<MediaLibraryItem>,
  ) => void;
  getMediaLibraryItem: (mediaId: string) => MediaLibraryItem | undefined;
  clearMediaLibrary: () => void;
  getSpriteSheetsBySource: (
    source: string,
  ) => MediaLibraryItem['spriteSheets'] | undefined;
  isGeneratingSpriteSheet: (mediaId: string) => boolean;
  setGeneratingSpriteSheet: (mediaId: string, isGenerating: boolean) => void;
  generateSpriteSheetForMedia: (mediaId: string) => Promise<boolean>;
  generateThumbnailForMedia: (mediaId: string) => Promise<boolean>;
  updateProjectThumbnailFromTimeline: () => Promise<void>;
  getWaveformBySource: (
    source: string,
  ) => MediaLibraryItem['waveform'] | undefined;
  getWaveformByMediaId: (
    mediaId: string,
  ) => MediaLibraryItem['waveform'] | undefined;
  isGeneratingWaveform: (mediaId: string) => boolean;
  setGeneratingWaveform: (mediaId: string, isGenerating: boolean) => void;
  generateWaveformForMedia: (mediaId: string) => Promise<boolean>;

  // Progressive sprite sheet generation state
  updateSpriteSheetProgress: (
    mediaId: string,
    progress: {
      completedSheets: number;
      totalSheets: number;
      jobId: string;
    },
  ) => void;

  // Progressive sprite sheet addition - adds individual sheets as they complete
  addSpriteSheetProgressively: (
    mediaId: string,
    sheet: {
      id: string;
      url: string;
      width: number;
      height: number;
      thumbnailsPerRow: number;
      thumbnailsPerColumn: number;
      thumbnailWidth: number;
      thumbnailHeight: number;
      thumbnails: Array<{
        id: string;
        timestamp: number;
        frameNumber: number;
        sheetIndex: number;
        x: number;
        y: number;
        width: number;
        height: number;
      }>;
    },
    sheetIndex: number,
    totalSheets: number,
    cacheKey: string,
  ) => void;

  // Duplicate detection (legacy single-file)
  findDuplicateBySignature: (
    signature: ContentSignature,
  ) => MediaLibraryItem | undefined;
  showDuplicateDialog: (
    existingMedia: MediaLibraryItem,
    pendingFile: File,
    pendingSignature: ContentSignature,
    resolve: (choice: DuplicateChoice) => void,
  ) => void;
  hideDuplicateDialog: () => void;

  // Batch duplicate detection (multiple files at once)
  showBatchDuplicateDialog: (
    duplicates: DuplicateItem[],
    resolve: (choices: Map<string, DuplicateChoice>) => void,
  ) => void;
  hideBatchDuplicateDialog: () => void;
  setTranscodingBlockedMedia: (media: MediaLibraryItem | null) => void;

  // Transcoding
  isTranscoding: (mediaId: string) => boolean;
  getTranscodingProgress: (mediaId: string) => number;
  getTranscodedPreviewUrl: (mediaId: string) => string | undefined;
  cancelTranscoding: (mediaId: string) => Promise<void>;

  // State management helpers
  markUnsavedChanges?: () => void;
  updateTrack?: (trackId: string, updates: any) => void;
  removeTrack?: (trackId: string) => void;
}

export const createMediaLibrarySlice: StateCreator<
  MediaLibrarySlice,
  [],
  [],
  MediaLibrarySlice
> = (set, get) => ({
  mediaLibrary: [],
  generatingSpriteSheets: new Set<string>(),
  generatingWaveforms: new Set<string>(),
  duplicateDetection: null,
  batchDuplicateDetection: null,
  transcodingBlockedMedia: null,

  findDuplicateBySignature: (signature: ContentSignature) => {
    const state = get() as any;
    return state.mediaLibrary?.find(
      (item: MediaLibraryItem) =>
        item.contentSignature?.partialHash === signature.partialHash &&
        item.contentSignature?.fileSize === signature.fileSize,
    );
  },

  showDuplicateDialog: (
    existingMedia: MediaLibraryItem,
    pendingFile: File,
    pendingSignature: ContentSignature,
    resolve: (choice: DuplicateChoice) => void,
  ) => {
    set({
      duplicateDetection: {
        show: true,
        existingMedia,
        pendingFile,
        pendingSignature,
        pendingResolve: resolve,
      },
    });
  },

  hideDuplicateDialog: () => {
    set({ duplicateDetection: null });
  },

  showBatchDuplicateDialog: (
    duplicates: DuplicateItem[],
    resolve: (choices: Map<string, DuplicateChoice>) => void,
  ) => {
    set({
      batchDuplicateDetection: {
        show: true,
        duplicates,
        pendingResolve: resolve,
      },
    });
  },

  hideBatchDuplicateDialog: () => {
    set({ batchDuplicateDetection: null });
  },

  setTranscodingBlockedMedia: (media) => {
    set({ transcodingBlockedMedia: media });
  },

  addToMediaLibrary: (itemData) => {
    const id = uuidv4();
    const item: MediaLibraryItem = {
      ...itemData,
      id,
    };

    set((state: any) => ({
      mediaLibrary: [...state.mediaLibrary, item],
    }));

    const state = get() as any;
    state.markUnsavedChanges?.();

    return id;
  },

  removeFromMediaLibrary: (mediaId, force = false) => {
    const state = get() as any;
    const mediaItem = state.mediaLibrary?.find(
      (item: MediaLibraryItem) => item.id === mediaId,
    );

    if (!mediaItem) {
      console.warn(`Media item ${mediaId} not found`);
      return;
    }

    // Cancel any active transcoding for this media
    if (
      mediaItem.transcoding?.status === 'pending' ||
      mediaItem.transcoding?.status === 'processing'
    ) {
      console.log(`🚫 Cancelling transcoding for media: ${mediaItem.name}`);
      // Cancel via IPC - fire and forget
      if (typeof window !== 'undefined' && window.electronAPI) {
        window.electronAPI
          .transcodeCancelForMedia(mediaId)
          .catch((error: Error) => {
            console.warn('Failed to cancel transcoding:', error);
          });
      }
    }

    // Find all tracks that use this media (by source or tempFilePath)
    const affectedTracks = state.tracks?.filter(
      (track: any) =>
        track.source === mediaItem.source ||
        track.source === mediaItem.tempFilePath ||
        (mediaItem.extractedAudio &&
          track.source === mediaItem.extractedAudio.audioPath),
    );

    if (affectedTracks && affectedTracks.length > 0) {
      if (!force) {
        // Prevent deletion and throw error for UI to handle
        console.log(
          `🚫 Cannot delete media "${mediaItem.name}" - it's used by ${affectedTracks.length} track(s) on the timeline`,
        );
        console.log(
          'Affected tracks:',
          affectedTracks.map((t: any) => t.name),
        );

        throw new Error(
          `Cannot delete "${mediaItem.name}" - it's currently used by ${affectedTracks.length} track(s) on the timeline. Please remove the tracks first.`,
        );
      } else {
        // Record undo state before cascade delete (captures media + tracks)
        state.recordAction?.('Delete Media');

        // Force delete: cascade remove all affected tracks
        console.log(
          `⚠️ Force deleting media "${mediaItem.name}" and removing ${affectedTracks.length} track(s) from timeline`,
        );

        affectedTracks.forEach((track: any) => {
          console.log(`  - Removing track: ${track.name}`);
          state.removeTrack?.(track.id);
        });
      }
    } else {
      // Record undo state before delete (no tracks affected)
      state.recordAction?.('Delete Media');
    }

    // Safe to delete - no tracks are using this media (or we force deleted them)
    console.log(`🗑️ Deleting media from library: ${mediaItem.name}`);

    set((state: any) => ({
      mediaLibrary: state.mediaLibrary.filter(
        (item: MediaLibraryItem) => item.id !== mediaId,
      ),
    }));

    state.markUnsavedChanges?.();
  },

  updateMediaLibraryItem: (mediaId, updates) => {
    set((state: any) => ({
      mediaLibrary: state.mediaLibrary.map((item: MediaLibraryItem) =>
        item.id === mediaId ? { ...item, ...updates } : item,
      ),
    }));

    if (updates.extractedAudio) {
      const state = get() as any;
      const mediaItem = state.mediaLibrary.find(
        (item: MediaLibraryItem) => item.id === mediaId,
      );
      if (mediaItem?.type === 'video') {
        console.log(
          `🔄 Extracted audio updated for video: ${mediaItem.name}, checking for linked audio tracks`,
        );

        // Find all audio tracks that are linked to video tracks from this source
        const linkedAudioTracks = state.tracks?.filter(
          (track: any) =>
            track.type === 'audio' &&
            track.isLinked &&
            track.source === mediaItem.source, // Currently using video source
        );

        // Update each linked audio track with the extracted audio source
        linkedAudioTracks?.forEach((audioTrack: any) => {
          console.log(
            `🎵 Updating linked audio track ${audioTrack.id} with extracted audio source`,
          );
          state.updateTrack?.(audioTrack.id, {
            source: updates.extractedAudio.audioPath,
            previewUrl: updates.extractedAudio.previewUrl,
            name: `${mediaItem.name.replace(/\.[^/.]+$/, '')} (Extracted Audio)`,
          });
        });
      }
    }

    // When proxy becomes ready, update all timeline tracks that use this media
    // This ensures tracks switch to proxy URL automatically without reload
    if (updates.proxy?.status === 'ready' && updates.previewUrl) {
      const state = get() as any;
      const mediaItem = state.mediaLibrary.find(
        (item: MediaLibraryItem) => item.id === mediaId,
      );

      if (mediaItem?.type === 'video') {
        console.log(
          `🔄 Proxy ready for video: ${mediaItem.name}, updating timeline tracks with proxy URL`,
        );

        // Find all video tracks that reference this media (by mediaId or source)
        const affectedTracks = state.tracks?.filter(
          (track: any) =>
            track.type === 'video' &&
            (track.mediaId === mediaId || track.source === mediaItem.source),
        );

        // Update each affected track with the proxy URL and remove proxy blocked state
        affectedTracks?.forEach((videoTrack: any) => {
          console.log(
            `📹 Updating video track ${videoTrack.id} with proxy URL`,
          );
          state.updateTrack?.(videoTrack.id, {
            previewUrl: updates.previewUrl,
            proxyBlocked: false,
            proxyBlockedMessage: undefined,
          });
        });

        if (affectedTracks?.length > 0) {
          console.log(
            `✅ Updated ${affectedTracks.length} timeline track(s) with proxy URL for: ${mediaItem.name}`,
          );
        }
      }
    }

    const state = get() as any;
    if (shouldMarkUnsavedChangesForMediaUpdate(updates)) {
      state.markUnsavedChanges?.();
    }
  },

  getMediaLibraryItem: (mediaId) => {
    const state = get() as any;
    return state.mediaLibrary.find(
      (item: MediaLibraryItem) => item.id === mediaId,
    );
  },

  clearMediaLibrary: () => {
    set(() => ({
      mediaLibrary: [],
    }));

    const state = get() as any;
    state.markUnsavedChanges?.();
  },

  getSpriteSheetsBySource: (source) => {
    const state = get() as any;
    const mediaItem = state.mediaLibrary.find(
      (item: MediaLibraryItem) =>
        item.source === source || item.tempFilePath === source,
    );
    if (mediaItem?.spriteSheetDisabled) {
      return undefined;
    }
    return mediaItem?.spriteSheets;
  },

  isGeneratingSpriteSheet: (mediaId) => {
    const state = get() as any;
    return state.generatingSpriteSheets.has(mediaId);
  },

  setGeneratingSpriteSheet: (mediaId: string, isGenerating: boolean) => {
    set((state: MediaLibrarySlice) => {
      const newGeneratingSet = new Set<string>(state.generatingSpriteSheets);
      if (isGenerating) {
        newGeneratingSet.add(mediaId);
      } else {
        newGeneratingSet.delete(mediaId);
      }
      return {
        generatingSpriteSheets: newGeneratingSet,
      };
    });
  },

  getWaveformBySource: (source) => {
    const state = get() as any;
    const mediaItem = state.mediaLibrary.find(
      (item: MediaLibraryItem) => item.source === source,
    );
    return mediaItem?.waveform;
  },

  getWaveformByMediaId: (mediaId) => {
    const state = get() as any;
    const mediaItem = state.mediaLibrary.find(
      (item: MediaLibraryItem) => item.id === mediaId,
    );
    return mediaItem?.waveform;
  },

  isGeneratingWaveform: (mediaId) => {
    const state = get() as any;
    return state.generatingWaveforms.has(mediaId);
  },

  setGeneratingWaveform: (mediaId: string, isGenerating: boolean) => {
    set((state: MediaLibrarySlice) => {
      const newGeneratingSet = new Set<string>(state.generatingWaveforms);
      if (isGenerating) {
        newGeneratingSet.add(mediaId);
      } else {
        newGeneratingSet.delete(mediaId);
      }
      return {
        generatingWaveforms: newGeneratingSet,
      };
    });
  },

  generateWaveformForMedia: async (mediaId: string) => {
    const state = get() as any;
    const mediaItem = state.mediaLibrary.find(
      (item: MediaLibraryItem) => item.id === mediaId,
    );
    if (!mediaItem) {
      console.error('Media item not found:', mediaId);
      return false;
    }

    // Only generate waveforms for audio files or video files with extracted audio
    const isAudioFile = mediaItem.type === 'audio';
    const isVideoFile = mediaItem.type === 'video';
    const isVideoWithExtractedAudio = isVideoFile && mediaItem.extractedAudio;

    // For non-audio/video files (images, subtitles), skip entirely
    if (!isAudioFile && !isVideoFile) {
      console.log(
        `Skipping waveform generation for: ${mediaItem.name} (not audio or video)`,
      );
      return true; // Not an error, just not applicable
    }

    // Cache-first: try content-signature-based cache before any other checks
    const contentSignatureKey = getContentSignatureKey(mediaItem);
    if (contentSignatureKey) {
      const cachedWaveform = AudioWaveformGenerator.getCachedWaveform(
        mediaItem.source,
        mediaItem.duration,
        8000,
        50,
        contentSignatureKey,
      );

      if (cachedWaveform?.success && cachedWaveform.peaks.length > 0) {
        set((state: any) => ({
          mediaLibrary: state.mediaLibrary.map((item: MediaLibraryItem) =>
            item.id === mediaId
              ? {
                  ...item,
                  waveform: {
                    success: cachedWaveform.success,
                    peaks: cachedWaveform.peaks,
                    duration: cachedWaveform.duration,
                    sampleRate: cachedWaveform.sampleRate,
                    cacheKey: cachedWaveform.cacheKey,
                    lodTiers: cachedWaveform.lodTiers,
                    generatedAt: Date.now(),
                  },
                  jobStates: {
                    ...item.jobStates,
                    waveform: 'completed' as const,
                  },
                }
              : item,
          ),
        }));
        const latestState = get() as any;
        latestState.markUnsavedChanges?.();
        console.log(`✅ Waveform cache HIT (signature) for: ${mediaItem.name}`);
        return true;
      }
    }

    // For video files without extracted audio, return false to trigger retry
    // Audio extraction happens asynchronously and may not be complete yet
    if (isVideoFile && !isVideoWithExtractedAudio) {
      console.log(
        `⏳ Audio not yet extracted for video: ${mediaItem.name} (will retry)`,
      );
      return false; // Return false to trigger retry logic
    }

    // Skip if waveform already exists and has valid peaks
    if (mediaItem.waveform?.success && mediaItem.waveform?.peaks?.length > 0) {
      console.log(`Waveform already exists for: ${mediaItem.name}`);
      return true;
    }

    // CRITICAL: Check job state for idempotency
    // Prevents regeneration loops when media is dragged to timeline during active jobs
    const currentJobState = mediaItem.jobStates?.waveform;
    if (currentJobState === 'processing') {
      console.log(
        `⏳ Waveform job already processing for: ${mediaItem.name} (idempotent skip)`,
      );
      return true;
    }
    if (currentJobState === 'completed') {
      console.log(
        `✅ Waveform job already completed for: ${mediaItem.name} (idempotent skip)`,
      );
      return true;
    }

    // Skip if already generating (legacy check - check both store state and active job)
    if (get().isGeneratingWaveform(mediaId)) {
      console.log(`Waveform already generating for: ${mediaItem.name}`);
      return true;
    }

    // Determine audio source - prefer extracted audio for video files
    let audioPath: string;
    if (isVideoWithExtractedAudio && mediaItem.extractedAudio?.previewUrl) {
      audioPath = mediaItem.extractedAudio.previewUrl;
    } else if (isAudioFile && mediaItem.previewUrl) {
      audioPath = mediaItem.previewUrl;
    } else if (isAudioFile) {
      audioPath = mediaItem.source;
    } else if (mediaItem.type === 'video' && !mediaItem.extractedAudio) {
      // Video without extracted audio yet - this is expected during import
      console.log(
        `Audio extraction not complete yet for video: ${mediaItem.name}`,
      );
      return false; // Return false to allow retry logic
    } else {
      console.warn(`No suitable audio source found for: ${mediaItem.name}`);
      return false;
    }

    // Skip blob URLs if they are local file paths (Web Audio API requires proper URLs)
    if (audioPath.startsWith('blob:') && !audioPath.includes('localhost')) {
      console.warn(
        `Skipping waveform generation for blob URL: ${mediaItem.name}`,
      );
      return true; // Skip but don't error
    }

    // Check if waveform generator already has an active job for this path
    if (
      AudioWaveformGenerator.isJobActive(
        audioPath,
        0,
        Infinity,
        contentSignatureKey,
      )
    ) {
      console.log(`Waveform job already active for: ${mediaItem.name}`);
      return true;
    }

    // CRITICAL: Set job state to 'processing' SYNCHRONOUSLY before any async work
    // This prevents race conditions when waveform strip mounts during import
    get().setGeneratingWaveform(mediaId, true);
    set((state: any) => ({
      mediaLibrary: state.mediaLibrary.map((item: MediaLibraryItem) =>
        item.id === mediaId
          ? {
              ...item,
              jobStates: {
                ...item.jobStates,
                waveform: 'processing' as const,
              },
            }
          : item,
      ),
    }));

    console.log(
      `🎵 Generating waveform for media library item: ${mediaItem.name}`,
    );
    console.log(`📊 Audio source: ${audioPath}`);
    console.log(`⏱️ Duration: ${mediaItem.duration}s`);

    try {
      // Use optimized parameters for fast generation
      // 50 peaks/sec provides good visual quality while being fast
      const result = await AudioWaveformGenerator.generateWaveform({
        audioPath,
        duration: mediaItem.duration,
        sampleRate: 8000, // Low sample rate for fast processing
        peaksPerSecond: 50, // Optimized for speed while maintaining quality
        contentSignature: contentSignatureKey,
      });

      if (result.success) {
        // Update media library item with waveform data including LOD tiers AND job state to 'completed'
        set((state: any) => ({
          mediaLibrary: state.mediaLibrary.map((item: MediaLibraryItem) =>
            item.id === mediaId
              ? {
                  ...item,
                  waveform: {
                    success: result.success,
                    peaks: result.peaks,
                    duration: result.duration,
                    sampleRate: result.sampleRate,
                    cacheKey: result.cacheKey,
                    lodTiers: result.lodTiers, // Include LOD tiers for efficient zoom rendering
                    generatedAt: Date.now(),
                  },
                  jobStates: {
                    ...item.jobStates,
                    waveform: 'completed' as const,
                  },
                }
              : item,
          ),
        }));
        const latestState = get() as any;
        latestState.markUnsavedChanges?.();
        console.log(`✅ Waveform generated and cached for: ${mediaItem.name}`);
        console.log(
          `📈 Generated ${result.peaks.length} peaks with ${result.lodTiers?.length || 0} LOD tiers`,
        );
        return true;
      } else {
        // Update job state to 'failed'
        set((state: any) => ({
          mediaLibrary: state.mediaLibrary.map((item: MediaLibraryItem) =>
            item.id === mediaId
              ? {
                  ...item,
                  jobStates: {
                    ...item.jobStates,
                    waveform: 'failed' as const,
                  },
                }
              : item,
          ),
        }));
        console.error(
          `❌ Failed to generate waveform for ${mediaItem.name}:`,
          result.error,
        );
        return false;
      }
    } catch (error) {
      // Update job state to 'failed'
      set((state: any) => ({
        mediaLibrary: state.mediaLibrary.map((item: MediaLibraryItem) =>
          item.id === mediaId
            ? {
                ...item,
                jobStates: {
                  ...item.jobStates,
                  waveform: 'failed' as const,
                },
              }
            : item,
        ),
      }));
      console.error(
        `❌ Error generating waveform for ${mediaItem.name}:`,
        error,
      );
      return false;
    } finally {
      // Clear generating state
      get().setGeneratingWaveform(mediaId, false);
    }
  },

  generateSpriteSheetForMedia: async (mediaId: string) => {
    const state = get() as any;
    const mediaItem = state.mediaLibrary.find(
      (item: MediaLibraryItem) => item.id === mediaId,
    );
    if (!mediaItem) {
      console.error('Media item not found:', mediaId);
      return false;
    }

    // Only generate sprite sheets for video files
    if (mediaItem.type !== 'video') {
      console.log(
        `Skipping sprite sheet generation for non-video: ${mediaItem.name}`,
      );
      return true; // Not an error, just not applicable
    }

    if (mediaItem.spriteSheetDisabled) {
      console.log(
        `⏭️ Sprite sheets disabled for long-form video: ${mediaItem.name}`,
      );
      set((state: any) => ({
        mediaLibrary: state.mediaLibrary.map((item: MediaLibraryItem) =>
          item.id === mediaId
            ? {
                ...item,
                jobStates: {
                  ...item.jobStates,
                  spriteSheet: 'completed' as const,
                },
              }
            : item,
        ),
      }));
      return true;
    }

    // Skip if sprite sheets already exist
    if (mediaItem.spriteSheets?.success) {
      console.log(`Sprite sheets already exist for: ${mediaItem.name}`);
      return true;
    }

    const contentSignatureKey = getContentSignatureKey(mediaItem);

    // Prefer proxy for generation if available to avoid memory issues with 4K sources
    const videoPath =
      mediaItem.proxy?.status === 'ready' && mediaItem.proxy?.path
        ? mediaItem.proxy.path
        : mediaItem.tempFilePath || mediaItem.source;

    // Cache-first: try content-signature-based cache before any other checks
    if (contentSignatureKey) {
      const cachedSpriteSheets =
        await VideoSpriteSheetGenerator.getCachedSpriteSheets({
          videoPath,
          contentSignature: contentSignatureKey,
          duration: mediaItem.duration,
          fps: mediaItem.metadata?.fps || 30,
          thumbWidth: 120,
          thumbHeight: 68,
          maxThumbnailsPerSheet: 100,
        });

      if (
        cachedSpriteSheets?.success &&
        cachedSpriteSheets.spriteSheets.length > 0
      ) {
        set((state: any) => ({
          mediaLibrary: state.mediaLibrary.map((item: MediaLibraryItem) =>
            item.id === mediaId
              ? {
                  ...item,
                  spriteSheets: {
                    success: cachedSpriteSheets.success,
                    spriteSheets: cachedSpriteSheets.spriteSheets,
                    cacheKey: cachedSpriteSheets.cacheKey,
                    generatedAt: Date.now(),
                    generation: {
                      status: 'completed' as const,
                      completedSheets: cachedSpriteSheets.spriteSheets.length,
                      totalSheets: cachedSpriteSheets.spriteSheets.length,
                    },
                  },
                  jobStates: {
                    ...item.jobStates,
                    spriteSheet: 'completed' as const,
                  },
                }
              : item,
          ),
        }));
        console.log(
          `✅ Sprite sheet cache HIT (signature) for: ${mediaItem.name}`,
        );
        return true;
      }
    }

    // CRITICAL: Check job state for idempotency
    // Prevents regeneration loops when media is dragged to timeline during active jobs
    const currentJobState = mediaItem.jobStates?.spriteSheet;
    if (currentJobState === 'processing') {
      console.log(
        `⏳ Sprite sheet job already processing for: ${mediaItem.name} (idempotent skip)`,
      );
      return true;
    }
    if (currentJobState === 'completed') {
      console.log(
        `✅ Sprite sheet job already completed for: ${mediaItem.name} (idempotent skip)`,
      );
      return true;
    }

    // Skip if already generating (legacy check)
    if (get().isGeneratingSpriteSheet(mediaId)) {
      console.log(`Sprite sheets already generating for: ${mediaItem.name}`);
      return true;
    }

    // Defer generation if proxy is currently processing
    // This allows the proxy generation to finish first (preventing resource contention)
    // The generation will be re-triggered when the proxy becomes 'ready'
    if (mediaItem.proxy?.status === 'processing') {
      console.log(
        `⏳ Deferring sprite sheet generation for: ${mediaItem.name} (waiting for proxy)`,
      );
      return true;
    }

    // Skip blob URLs (they won't work with FFmpeg)
    if (videoPath.startsWith('blob:')) {
      console.warn(
        `Cannot generate sprite sheets from blob URL: ${mediaItem.name}`,
      );
      return false;
    }

    // Sprite sheet generation parameters (must match VideoSpriteSheetGenerator)
    const thumbWidth = 120;
    const thumbHeight = 68;
    const maxThumbnailsPerSheet = 100;
    const fps = mediaItem.metadata?.fps || 30;
    const duration = mediaItem.duration;

    // Calculate interval (same logic as VideoSpriteSheetGenerator.calculateOptimalInterval)
    let intervalSeconds: number;
    if (duration <= 5) {
      intervalSeconds = 0.1;
    } else if (duration <= 30) {
      intervalSeconds = 0.25;
    } else if (duration <= 120) {
      intervalSeconds = 0.5;
    } else if (duration <= 300) {
      intervalSeconds = 1.0;
    } else if (duration <= 600) {
      intervalSeconds = 1.0;
    } else if (duration <= 3599) {
      intervalSeconds = duration / 300;
    } else if (duration >= 3600) {
      intervalSeconds = duration / 1200;
    } else {
      intervalSeconds = 2.0;
    }

    // Pre-compute expected sheet count for progressive loading
    const exactThumbnails = Math.floor(duration / intervalSeconds) + 1;
    const maxThumbnails = Math.min(exactThumbnails, 5000);
    const adjustedTotalThumbnails = Math.max(5, maxThumbnails);
    const maxPossibleThumbnails = Math.floor(duration / intervalSeconds) + 1;
    const finalTotalThumbnails = Math.min(
      adjustedTotalThumbnails,
      maxPossibleThumbnails,
    );
    const numberOfSheets = Math.ceil(
      finalTotalThumbnails / maxThumbnailsPerSheet,
    );

    // CRITICAL: Set job state to 'processing' SYNCHRONOUSLY before any async work
    // This prevents race conditions when VideoSpriteSheetStrip mounts during import
    get().setGeneratingSpriteSheet(mediaId, true);
    set((state: any) => ({
      mediaLibrary: state.mediaLibrary.map((item: MediaLibraryItem) =>
        item.id === mediaId
          ? {
              ...item,
              spriteSheets: {
                success: false,
                spriteSheets: [], // Initialize empty array for progressive loading
                cacheKey: '',
                generation: {
                  status: 'generating' as const,
                  completedSheets: 0,
                  totalSheets: numberOfSheets,
                },
              },
              jobStates: {
                ...item.jobStates,
                spriteSheet: 'processing' as const,
              },
            }
          : item,
      ),
    }));

    console.log(
      `🎬 Generating sprite sheets for media library item: ${mediaItem.name}`,
    );
    console.log(
      `📊 Expected ${numberOfSheets} sheets, interval: ${intervalSeconds.toFixed(2)}s`,
    );

    // Track this generation job for progressive loading
    // We use videoPath as the key since it's unique per media item
    activeSpriteSheetJobs.set(videoPath, {
      mediaId,
      intervalSeconds,
      maxThumbnailsPerSheet,
      finalTotalThumbnails,
      thumbWidth,
      thumbHeight,
      duration,
      fps,
    });

    // Set up GLOBAL progressive loading listener (only once)
    // This single listener dispatches to the correct media based on sheetPath
    if (
      typeof window !== 'undefined' &&
      window.electronAPI &&
      !spriteSheetListenerRegistered
    ) {
      spriteSheetListenerRegistered = true;

      const handleSheetReady = (data: {
        jobId: string;
        sheetIndex: number;
        totalSheets: number;
        sheetPath: string;
      }) => {
        // Find the matching job by checking if the sheetPath contains any tracked videoPath info
        // Since we can't match directly, we'll use the store to find the currently generating media
        // and match by checking which media items are in 'processing' state
        const storeState = get() as any;
        const processingMedia = storeState.mediaLibrary.filter(
          (item: MediaLibraryItem) =>
            item.type === 'video' &&
            item.jobStates?.spriteSheet === 'processing',
        );

        if (processingMedia.length === 0) {
          console.warn(
            '⚠️ Received sprite sheet ready event but no media is processing',
          );
          return;
        }

        // For each processing media, check if this event matches
        // We can match by looking at the output directory in the sheetPath
        for (const media of processingMedia) {
          const jobInfo = activeSpriteSheetJobs.get(
            media.tempFilePath || media.source,
          );
          if (!jobInfo) continue;

          const {
            mediaId: targetMediaId,
            intervalSeconds: jobIntervalSeconds,
            maxThumbnailsPerSheet: jobMaxThumbnailsPerSheet,
            finalTotalThumbnails: jobFinalTotalThumbnails,
            thumbWidth: jobThumbWidth,
            thumbHeight: jobThumbHeight,
            duration: jobDuration,
            fps: jobFps,
          } = jobInfo;

          // Build sprite sheet metadata for this individual sheet
          const sheetIndex = data.sheetIndex;
          const startThumbnailIndex = sheetIndex * jobMaxThumbnailsPerSheet;
          const endThumbnailIndex = Math.min(
            startThumbnailIndex + jobMaxThumbnailsPerSheet,
            jobFinalTotalThumbnails,
          );
          const thumbnailsInSheet = endThumbnailIndex - startThumbnailIndex;

          // Calculate grid dimensions
          let cols: number, rows: number;
          if (thumbnailsInSheet <= 50) {
            cols = thumbnailsInSheet;
            rows = 1;
          } else {
            const perfectDivisors: Array<{ cols: number; rows: number }> = [];
            for (let i = 1; i <= Math.sqrt(thumbnailsInSheet); i++) {
              if (thumbnailsInSheet % i === 0) {
                perfectDivisors.push({ cols: i, rows: thumbnailsInSheet / i });
                if (i !== thumbnailsInSheet / i) {
                  perfectDivisors.push({
                    cols: thumbnailsInSheet / i,
                    rows: i,
                  });
                }
              }
            }
            if (perfectDivisors.length > 0) {
              let best = perfectDivisors[0];
              let bestRatio = Math.max(
                best.cols / best.rows,
                best.rows / best.cols,
              );
              for (const d of perfectDivisors) {
                const ratio = Math.max(d.cols / d.rows, d.rows / d.cols);
                if (ratio < bestRatio && ratio <= 10) {
                  bestRatio = ratio;
                  best = d;
                }
              }
              cols = best.cols;
              rows = best.rows;
            } else {
              cols = thumbnailsInSheet;
              rows = 1;
            }
          }

          // Build thumbnails array for this sheet
          const thumbnails: Array<{
            id: string;
            timestamp: number;
            frameNumber: number;
            sheetIndex: number;
            x: number;
            y: number;
            width: number;
            height: number;
          }> = [];

          for (let i = 0; i < thumbnailsInSheet; i++) {
            const globalThumbnailIndex = startThumbnailIndex + i;
            const row = Math.floor(i / cols);
            const col = i % cols;
            const timestamp = globalThumbnailIndex * jobIntervalSeconds;

            if (timestamp <= jobDuration) {
              thumbnails.push({
                id: `${targetMediaId}_${globalThumbnailIndex}`,
                timestamp,
                frameNumber: Math.floor(timestamp * jobFps),
                sheetIndex,
                x: col * jobThumbWidth,
                y: row * jobThumbHeight,
                width: jobThumbWidth,
                height: jobThumbHeight,
              });
            }
          }

          const sheetUrl = toMediaServerUrl(data.sheetPath);

          // Add this sheet progressively to the store
          get().addSpriteSheetProgressively(
            targetMediaId,
            {
              id: `${targetMediaId}_sheet_${sheetIndex}`,
              url: sheetUrl,
              width: cols * jobThumbWidth,
              height: rows * jobThumbHeight,
              thumbnailsPerRow: cols,
              thumbnailsPerColumn: rows,
              thumbnailWidth: jobThumbWidth,
              thumbnailHeight: jobThumbHeight,
              thumbnails,
            },
            sheetIndex,
            data.totalSheets,
            `progressive_${targetMediaId}`,
          );

          // Only process for ONE media item per event
          // (events should only match one job at a time)
          break;
        }
      };

      // Register the global listener
      (window.electronAPI as any).onSpriteSheetSheetReady(handleSheetReady);
    }

    try {
      const result = await VideoSpriteSheetGenerator.generateSpriteSheets({
        videoPath,
        contentSignature: contentSignatureKey,
        duration: mediaItem.duration,
        fps: mediaItem.metadata?.fps || 30,
        thumbWidth: 120,
        thumbHeight: 68,
        maxThumbnailsPerSheet: 100,
      });

      if (result.success) {
        // Final update with complete sprite sheet data (includes cacheKey for persistent caching)
        // This ensures proper URLs and metadata from the generator
        set((state: any) => ({
          mediaLibrary: state.mediaLibrary.map((item: MediaLibraryItem) =>
            item.id === mediaId
              ? {
                  ...item,
                  spriteSheets: {
                    success: result.success,
                    spriteSheets: result.spriteSheets,
                    cacheKey: result.cacheKey,
                    generatedAt: Date.now(),
                    generation: {
                      status: 'completed' as const,
                      completedSheets: result.spriteSheets.length,
                      totalSheets: result.spriteSheets.length,
                    },
                  },
                  jobStates: {
                    ...item.jobStates,
                    spriteSheet: 'completed' as const,
                  },
                }
              : item,
          ),
        }));
        console.log(
          `✅ Sprite sheets generated and cached for: ${mediaItem.name}`,
        );
        return true;
      } else {
        // Update job state to 'failed'
        set((state: any) => ({
          mediaLibrary: state.mediaLibrary.map((item: MediaLibraryItem) =>
            item.id === mediaId
              ? {
                  ...item,
                  jobStates: {
                    ...item.jobStates,
                    spriteSheet: 'failed' as const,
                  },
                }
              : item,
          ),
        }));
        console.error(
          `❌ Failed to generate sprite sheets for ${mediaItem.name}:`,
          result.error,
        );
        return false;
      }
    } catch (error) {
      // Update job state to 'failed'
      set((state: any) => ({
        mediaLibrary: state.mediaLibrary.map((item: MediaLibraryItem) =>
          item.id === mediaId
            ? {
                ...item,
                jobStates: {
                  ...item.jobStates,
                  spriteSheet: 'failed' as const,
                },
              }
            : item,
        ),
      }));
      console.error(
        `❌ Error generating sprite sheets for ${mediaItem.name}:`,
        error,
      );
      return false;
    } finally {
      // Clear generating state and cleanup job tracking
      get().setGeneratingSpriteSheet(mediaId, false);
      activeSpriteSheetJobs.delete(videoPath);
    }
  },

  updateSpriteSheetProgress: (
    mediaId: string,
    progress: {
      completedSheets: number;
      totalSheets: number;
      jobId: string;
    },
  ) => {
    set((state: any) => ({
      mediaLibrary: state.mediaLibrary.map((item: MediaLibraryItem) =>
        item.id === mediaId
          ? {
              ...item,
              spriteSheets: {
                ...item.spriteSheets,
                generation: {
                  status: 'generating' as const,
                  completedSheets: progress.completedSheets,
                  totalSheets: progress.totalSheets,
                  jobId: progress.jobId,
                },
              },
            }
          : item,
      ),
    }));
  },

  // Progressive sprite sheet addition - adds individual sheets as they complete
  // This enables CapCut-style behavior where thumbnails appear immediately
  addSpriteSheetProgressively: (
    mediaId: string,
    sheet: {
      id: string;
      url: string;
      width: number;
      height: number;
      thumbnailsPerRow: number;
      thumbnailsPerColumn: number;
      thumbnailWidth: number;
      thumbnailHeight: number;
      thumbnails: Array<{
        id: string;
        timestamp: number;
        frameNumber: number;
        sheetIndex: number;
        x: number;
        y: number;
        width: number;
        height: number;
      }>;
    },
    sheetIndex: number,
    totalSheets: number,
    cacheKey: string,
  ) => {
    set((state: any) => ({
      mediaLibrary: state.mediaLibrary.map((item: MediaLibraryItem) => {
        if (item.id !== mediaId) return item;

        // Get existing sprite sheets array or create new one
        const existingSheets = item.spriteSheets?.spriteSheets || [];

        // Avoid duplicates - check if this sheet index already exists
        const alreadyExists = existingSheets.some(
          (s: { id: string }) => s.id === sheet.id,
        );
        if (alreadyExists) {
          return item;
        }

        // Add the new sheet to the array
        const updatedSheets = [...existingSheets, sheet];

        // Determine if generation is complete
        const isComplete = updatedSheets.length >= totalSheets;

        return {
          ...item,
          spriteSheets: {
            success: isComplete, // Only mark success when all sheets are ready
            spriteSheets: updatedSheets,
            cacheKey,
            generatedAt: isComplete
              ? Date.now()
              : item.spriteSheets?.generatedAt,
            generation: {
              status: isComplete
                ? ('completed' as const)
                : ('generating' as const),
              completedSheets: updatedSheets.length,
              totalSheets,
              jobId: item.spriteSheets?.generation?.jobId,
            },
          },
          // Update job state when complete
          jobStates: isComplete
            ? {
                ...item.jobStates,
                spriteSheet: 'completed' as const,
              }
            : item.jobStates,
        };
      }),
    }));

    console.log(
      `📸 Progressive sprite sheet ${sheetIndex + 1}/${totalSheets} added for media ${mediaId}`,
    );
  },

  generateThumbnailForMedia: async (mediaId: string) => {
    const state = get() as any;
    const mediaItem = state.mediaLibrary.find(
      (item: MediaLibraryItem) => item.id === mediaId,
    );
    if (!mediaItem) {
      console.error('Media item not found:', mediaId);
      return false;
    }

    // Only generate thumbnails for video files
    if (mediaItem.type !== 'video') {
      console.log(
        `Skipping thumbnail generation for non-video: ${mediaItem.name}`,
      );
      return true; // Not an error, just not applicable
    }

    // Skip if thumbnail already exists
    if (mediaItem.thumbnail) {
      console.log(`Thumbnail already exists for: ${mediaItem.name}`);
      return true;
    }

    const contentSignatureKey = getContentSignatureKey(mediaItem);

    // Prefer proxy for generation if available to avoid memory issues with 4K sources
    const videoPath =
      mediaItem.proxy?.status === 'ready' && mediaItem.proxy?.path
        ? mediaItem.proxy.path
        : mediaItem.tempFilePath || mediaItem.source;

    // Generate a single thumbnail at 1 second (or 10% of duration, whichever is smaller)
    const thumbnailTime = Math.min(1, mediaItem.duration * 0.1);

    // Calculate thumbnail dimensions based on video aspect ratio
    // Target width is 320px, height is calculated to preserve aspect ratio
    const thumbnailWidth = 320;
    let thumbnailHeight = 180; // Default 16:9

    if (mediaItem.metadata?.width && mediaItem.metadata?.height) {
      const aspectRatio = mediaItem.metadata.width / mediaItem.metadata.height;
      thumbnailHeight = Math.round(thumbnailWidth / aspectRatio);
      console.log(
        `📐 Using video aspect ratio: ${mediaItem.metadata.width}x${mediaItem.metadata.height} (${aspectRatio.toFixed(2)}) -> thumbnail: ${thumbnailWidth}x${thumbnailHeight}`,
      );
    }

    // Cache-first: try content-signature-based cache before any other checks
    const cachedEntry = await VideoThumbnailGenerator.getCachedThumbnailEntry({
      videoPath,
      contentSignature: contentSignatureKey,
      duration: 0.1, // Very short duration, just one frame
      fps: 30,
      intervalSeconds: 0.1,
      width: thumbnailWidth,
      height: thumbnailHeight,
      sourceStartTime: thumbnailTime,
      persist: true,
    });

    if (cachedEntry?.thumbnails?.length) {
      const cachedUrl = cachedEntry.thumbnails[0].url;
      const isValid =
        await VideoThumbnailGenerator.validateThumbnailUrl(cachedUrl);
      if (isValid) {
        set((state: any) => ({
          mediaLibrary: state.mediaLibrary.map((item: MediaLibraryItem) =>
            item.id === mediaId
              ? {
                  ...item,
                  thumbnail: cachedUrl,
                  jobStates: {
                    ...item.jobStates,
                    thumbnail: 'completed' as const,
                  },
                }
              : item,
          ),
        }));
        console.log(
          `✅ Thumbnail cache HIT (signature) for: ${mediaItem.name}`,
        );
        return true;
      }

      // Cached entry is stale - remove it so we can regenerate
      VideoThumbnailGenerator.removeCacheEntryByKey(cachedEntry.cacheKey);
    }

    // CRITICAL: Check job state for idempotency
    const currentJobState = mediaItem.jobStates?.thumbnail;
    if (currentJobState === 'processing') {
      console.log(
        `⏳ Thumbnail job already processing for: ${mediaItem.name} (idempotent skip)`,
      );
      return true;
    }
    if (currentJobState === 'completed') {
      console.log(
        `✅ Thumbnail job already completed for: ${mediaItem.name} (idempotent skip)`,
      );
      return true;
    }

    // Defer generation if proxy is currently processing
    if (mediaItem.proxy?.status === 'processing') {
      console.log(
        `⏳ Deferring thumbnail generation for: ${mediaItem.name} (waiting for proxy)`,
      );
      return true;
    }

    // Skip blob URLs (they won't work with FFmpeg)
    if (videoPath.startsWith('blob:')) {
      console.warn(
        `Cannot generate thumbnail from blob URL: ${mediaItem.name}`,
      );
      return false;
    }

    // Mark job state as processing before starting async generation
    set((state: any) => ({
      mediaLibrary: state.mediaLibrary.map((item: MediaLibraryItem) =>
        item.id === mediaId
          ? {
              ...item,
              jobStates: {
                ...item.jobStates,
                thumbnail: 'processing' as const,
              },
            }
          : item,
      ),
    }));

    try {
      console.log(
        `📸 Generating thumbnail for media library item: ${mediaItem.name}`,
      );

      const result = await VideoThumbnailGenerator.generateThumbnails({
        videoPath,
        contentSignature: contentSignatureKey,
        duration: 0.1, // Very short duration, just one frame
        fps: 30,
        intervalSeconds: 0.1,
        width: thumbnailWidth,
        height: thumbnailHeight,
        sourceStartTime: thumbnailTime,
        persist: true,
      });

      if (result.success && result.thumbnails.length > 0) {
        const thumbnailUrl = result.thumbnails[0].url;

        // Use thumbnail URL directly (base64 conversion would need proper electron API)
        const base64Thumbnail = thumbnailUrl;

        // Update the media library item with thumbnail data
        set((state: any) => ({
          mediaLibrary: state.mediaLibrary.map((item: MediaLibraryItem) =>
            item.id === mediaId
              ? {
                  ...item,
                  thumbnail: base64Thumbnail,
                  jobStates: {
                    ...item.jobStates,
                    thumbnail: 'completed' as const,
                  },
                }
              : item,
          ),
        }));
        console.log(`✅ Thumbnail generated and cached for: ${mediaItem.name}`);
        return true;
      } else {
        set((state: any) => ({
          mediaLibrary: state.mediaLibrary.map((item: MediaLibraryItem) =>
            item.id === mediaId
              ? {
                  ...item,
                  jobStates: {
                    ...item.jobStates,
                    thumbnail: 'failed' as const,
                  },
                }
              : item,
          ),
        }));
        console.error(
          `❌ Failed to generate thumbnail for ${mediaItem.name}:`,
          result.error,
        );
        return false;
      }
    } catch (error) {
      set((state: any) => ({
        mediaLibrary: state.mediaLibrary.map((item: MediaLibraryItem) =>
          item.id === mediaId
            ? {
                ...item,
                jobStates: {
                  ...item.jobStates,
                  thumbnail: 'failed' as const,
                },
              }
            : item,
        ),
      }));
      console.error(
        `❌ Error generating thumbnail for ${mediaItem.name}:`,
        error,
      );
      return false;
    }
  },

  updateProjectThumbnailFromTimeline: async () => {
    const state = get() as any;

    // Find the first video track on the timeline
    const firstVideoTrack = state.tracks
      .filter((track: any) => track.type === 'video' && track.visible)
      .sort((a: any, b: any) => a.startFrame - b.startFrame)[0];

    if (!firstVideoTrack) {
      console.log('No video tracks on timeline, clearing project thumbnail');

      // Clear project thumbnail if we have a current project but no video tracks
      if (state.currentProjectId) {
        try {
          const currentProject = await projectService.getProject(
            state.currentProjectId,
          );
          if (currentProject) {
            const updatedProject = {
              ...currentProject,
              metadata: {
                ...currentProject.metadata,
                thumbnail: undefined as string | undefined, // Clear the thumbnail
                updatedAt: new Date().toISOString(),
              },
            };

            await projectService.updateProject(updatedProject);
            const fullState = get() as any;
            fullState.syncWithProjectStore();

            console.log(
              `📸 Cleared project thumbnail (no video tracks remaining)`,
            );
          }
        } catch (error) {
          console.error('Failed to clear project thumbnail:', error);
        }
      }
      return;
    }

    console.log(
      `📸 Updating project thumbnail from track: ${firstVideoTrack.name}`,
    );

    // Find the media library item for this track
    const mediaItem = state.mediaLibrary.find(
      (item: MediaLibraryItem) =>
        item.source === firstVideoTrack.source ||
        item.tempFilePath === firstVideoTrack.source,
    );

    if (!mediaItem) {
      console.error('Media library item not found for first video track');
      return;
    }

    // Generate thumbnail if it doesn't exist
    if (!mediaItem.thumbnail) {
      const success = await get().generateThumbnailForMedia(mediaItem.id);
      if (!success) {
        console.error('Failed to generate thumbnail for project');
        return;
      }
    }

    // Update project thumbnail if we have a current project
    if (state.currentProjectId && mediaItem.thumbnail) {
      try {
        const currentProject = await projectService.getProject(
          state.currentProjectId,
        );
        if (currentProject) {
          const updatedProject = {
            ...currentProject,
            metadata: {
              ...currentProject.metadata,
              thumbnail: mediaItem.thumbnail,
              updatedAt: new Date().toISOString(),
            },
          };

          await projectService.updateProject(updatedProject);
          const fullState = get() as any;
          fullState.syncWithProjectStore();

          console.log(
            `📸 Updated project thumbnail from: ${firstVideoTrack.name}`,
          );
        }
      } catch (error) {
        console.error('Failed to update project thumbnail:', error);
      }
    }
  },

  // Transcoding methods
  isTranscoding: (mediaId: string) => {
    const state = get() as any;
    const mediaItem = state.mediaLibrary.find(
      (item: MediaLibraryItem) => item.id === mediaId,
    );
    return (
      mediaItem?.transcoding?.status === 'pending' ||
      mediaItem?.transcoding?.status === 'processing'
    );
  },

  getTranscodingProgress: (mediaId: string) => {
    const state = get() as any;
    const mediaItem = state.mediaLibrary.find(
      (item: MediaLibraryItem) => item.id === mediaId,
    );
    return mediaItem?.transcoding?.progress ?? 0;
  },

  getTranscodedPreviewUrl: (mediaId: string) => {
    const state = get() as any;
    const mediaItem = state.mediaLibrary.find(
      (item: MediaLibraryItem) => item.id === mediaId,
    );
    // Return transcoded URL if available, otherwise original preview URL
    if (
      mediaItem?.transcoding?.status === 'completed' &&
      mediaItem?.transcoding?.transcodedPreviewUrl
    ) {
      return mediaItem.transcoding.transcodedPreviewUrl;
    }
    return mediaItem?.previewUrl;
  },

  cancelTranscoding: async (mediaId: string) => {
    const state = get() as any;
    const mediaItem = state.mediaLibrary.find(
      (item: MediaLibraryItem) => item.id === mediaId,
    );

    if (mediaItem?.transcoding?.jobId) {
      try {
        await window.electronAPI.transcodeCancel(mediaItem.transcoding.jobId);
        console.log(`🚫 Cancelled transcoding for media: ${mediaId}`);
      } catch (error) {
        console.error(`Failed to cancel transcoding for ${mediaId}:`, error);
      }
    }
  },
});
