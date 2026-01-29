import { useVideoEditorStore } from '../stores/videoEditor';

/**
 * Hook to check if a media item is fully ready for timeline display.
 * Implementing "Snap" behavior:
 * - Video: Waits for Transcoding + Sprites + Waveform
 * - Audio: Waits for Waveform
 * - Others: Ready immediately
 *
 * @deprecated Use granular hooks (useWaveformReadiness, useSpriteSheetProgress) for progressive loading
 */
export const useMediaReadiness = (mediaId?: string): boolean => {
  const mediaItem = useVideoEditorStore((state) =>
    mediaId ? state.mediaLibrary.find((m) => m.id === mediaId) : undefined,
  );

  if (!mediaId || !mediaItem) return true; // Non-media tracks or not found are treated as ready (or handled elsewhere)

  // Audio Readiness: Immediate once waveform is ready
  if (mediaItem.type === 'audio') {
    // Ready when waveform is calculated (success or fail)
    return !!mediaItem.waveform;
  }

  // Video Readiness: Coordinated "Snap"
  if (mediaItem.type === 'video') {
    // Check transcoding status
    // Note: If transcoding is undefined, we assume not required (or check hasn't run, but sprites protect us)
    const isTranscoding =
      mediaItem.transcoding?.status === 'processing' ||
      mediaItem.transcoding?.status === 'pending';

    const isWaveformReady = !!mediaItem.waveform;
    const isSpritesReady = !!mediaItem.spriteSheets;

    // Requirement: "Wait until both [sprites and waveform] are ready." and "Transcoding is complete"
    return !isTranscoding && isWaveformReady && isSpritesReady;
  }

  // Image/Subtitle Readiness
  return true;
};

/**
 * Check if waveform is ready independently of sprites.
 * Use this for audio tracks or to show waveform before sprites are ready.
 */
export const useWaveformReadiness = (mediaId?: string): boolean => {
  const mediaItem = useVideoEditorStore((state) =>
    mediaId ? state.mediaLibrary.find((m) => m.id === mediaId) : undefined,
  );

  if (!mediaId || !mediaItem) return true;

  if (mediaItem.type === 'audio') {
    return !!mediaItem.waveform;
  }

  if (mediaItem.type === 'video') {
    const isTranscoding =
      mediaItem.transcoding?.status === 'processing' ||
      mediaItem.transcoding?.status === 'pending';
    return !isTranscoding && !!mediaItem.waveform;
  }

  return true;
};

/**
 * Check sprite sheet progress for progressive rendering.
 * Returns progress information even while sheets are still generating.
 */
export const useSpriteSheetProgress = (
  mediaId?: string,
): {
  hasAnySheets: boolean;
  completedSheets: number;
  totalSheets: number;
  isComplete: boolean;
} => {
  const mediaItem = useVideoEditorStore((state) =>
    mediaId ? state.mediaLibrary.find((m) => m.id === mediaId) : undefined,
  );

  if (!mediaId || !mediaItem || mediaItem.type !== 'video') {
    return {
      hasAnySheets: false,
      completedSheets: 0,
      totalSheets: 0,
      isComplete: true,
    };
  }

  const spriteSheets = mediaItem.spriteSheets?.spriteSheets || [];
  const generation = mediaItem.spriteSheets?.generation;

  return {
    hasAnySheets: spriteSheets.length > 0,
    completedSheets: generation?.completedSheets || spriteSheets.length,
    totalSheets: generation?.totalSheets || spriteSheets.length,
    isComplete: mediaItem.spriteSheets?.success || false,
  };
};
