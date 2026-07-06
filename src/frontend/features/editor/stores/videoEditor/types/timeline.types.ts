import React from 'react';
import { useVideoEditorStore } from '../index';

// Get display FPS from source video tracks (dynamic but static once determined)
// This ensures timeline tracks, video length, and playback remain stable
// regardless of export FPS changes (CapCut-like behavior)
// Falls back to 30 if no video tracks exist
export const getDisplayFps = (
  tracks: Array<{ type: string; sourceFps?: number }>,
): number => {
  const videoTracks = tracks.filter((track) => track.type === 'video');
  if (videoTracks.length === 0) return 30; // Default fallback

  // Use the first video track's source FPS
  const firstVideoTrack = videoTracks[0];
  return firstVideoTrack.sourceFps || 30; // Fallback to 30 if sourceFps not available
};

// Hook to get display FPS from store tracks
export const useDisplayFps = () => {
  const tracks = useVideoEditorStore((state) => state.tracks);
  return React.useMemo(() => getDisplayFps(tracks), [tracks]);
};

/** Transition type applied where two same-row clips overlap. */
export type TransitionType =
  | 'dissolve'
  | 'dip'
  | 'wipe'
  | 'push'
  | 'slide'
  | 'zoom'
  | 'whip';

/**
 * A transition between two adjacent same-row clips. Duration/position are DERIVED live from
 * the clips' actual overlap on the timeline — only the type and params are stored. Keyed by
 * the ordered pair (fromClipId = earlier clip, toClipId = later clip).
 */
export interface Transition {
  id: string;
  fromClipId: string;
  toClipId: string;
  type: TransitionType;
  /** Transition length in frames. Rendered in place at the cut using the incoming clip's
   * source pre-roll handle — the clips do NOT move, so no content or audio is lost. */
  durationFrames: number;
  /** dip color ('black' | 'white' | hex); wipe/push/slide direction. */
  params?: {
    direction?: 'left' | 'right' | 'up' | 'down';
    color?: string;
  };
}

export interface TimelineState {
  currentFrame: number;
  totalFrames: number;
  fps: number; // Export FPS - only used for backend processing/export, not frontend rendering
  zoom: number;
  scrollX: number;
  inPoint?: number;
  outPoint?: number;
  selectedTrackIds: string[];
  playheadVisible: boolean;
  snapEnabled: boolean;
  /** Show source chapter markers (e.g. from YouTube) as an overlay on clips that have them. */
  showChapters: boolean;
  /** Show detected scene-cut markers (amber ticks) on clips that have them. */
  showSceneMarkers: boolean;
  isSplitModeActive: boolean;
  visibleTrackRows: string[]; // Track row IDs that are visible (e.g., ['video', 'audio', 'subtitle', 'image'])
  /** Transitions between overlapping same-row clips. Type/params only — duration derives from overlap. */
  transitions?: Transition[];
  /** Match-cut alignment aid: ghosts a target clip's frame over the preview so the user can
   * scrub the main clip until the two visually rhyme, then cut. Manual, no AI. */
  matchCut?: {
    enabled: boolean;
    targetClipId: string;
    targetSourceTime: number;
    opacity?: number;
  } | null;
}

export interface SnapPoint {
  frame: number;
  type: 'playhead' | 'track-start' | 'track-end' | 'in-point' | 'out-point';
  trackId?: string;
}
