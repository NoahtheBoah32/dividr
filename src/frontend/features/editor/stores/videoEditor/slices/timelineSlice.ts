/* eslint-disable @typescript-eslint/no-explicit-any */
// slices/timelineSlice.ts
import { StateCreator } from 'zustand';
import { SnapPoint, TimelineState, VideoTrack } from '../types';

// Snap threshold for timeline snapping
export const SNAP_THRESHOLD = 5; // frames

export interface TimelineSlice {
  timeline: TimelineState;
  tracks: VideoTrack[];
  setCurrentFrame: (frame: number) => void;
  setTotalFrames: (frames: number) => void;
  setFps: (fps: number) => void;
  setZoom: (zoom: number) => void;
  setScrollX: (scrollX: number) => void;
  setInPoint: (frame?: number) => void;
  setOutPoint: (frame?: number) => void;
  setSelectedTracks: (trackIds: string[]) => void;
  toggleSnap: () => void;
  toggleChapters: () => void;
  toggleSceneMarkers: () => void;
  /** Add or replace the transition between an ordered clip pair (fromClipId, toClipId). */
  upsertTransition: (transition: import('../types/timeline.types').Transition) => void;
  /** Remove the transition between a clip pair. */
  removeTransition: (fromClipId: string, toClipId: string) => void;
  /** Create a transition by overlapping two same-row clips and storing the type. */
  createTransitionBetween: (
    fromId: string,
    toId: string,
    type?: import('../types/timeline.types').TransitionType,
    durationSeconds?: number,
  ) => void;
  /** Enable/disable the match-cut ghost overlay (null to clear). */
  setMatchCut: (
    matchCut: import('../types/timeline.types').TimelineState['matchCut'],
  ) => void;

  /** Add a labeled timeline marker (ruler flag). Returns the marker id. */
  addTimelineMarker: (
    frame: number,
    label: string,
    color?: string,
  ) => string;
  /** Remove a timeline marker by id. */
  removeTimelineMarker: (id: string) => void;
  /** Update a timeline marker's fields. */
  updateTimelineMarker: (
    id: string,
    patch: Partial<Omit<import('../types/timeline.types').TimelineMarker, 'id'>>,
  ) => void;
  /** Remove all timeline markers. */
  clearTimelineMarkers: () => void;
  toggleSplitMode: () => void;
  setSplitMode: (active: boolean) => void;

  // Track row visibility management
  addTrackRow: (rowId: string) => void;
  removeTrackRow: (rowId: string) => void;
  ensureTrackRowVisible: (rowId: string) => void;

  // Snap functionality
  findSnapPoints: (
    currentFrame: number,
    excludeTrackId?: string,
  ) => SnapPoint[];
  snapToFrame: (
    targetFrame: number,
    snapPoints: SnapPoint[],
    threshold?: number,
    excludeTrackId?: string,
  ) => number | null;

  // Visual feedback for duplication
  duplicationFeedbackTrackIds: Set<string>;
  triggerDuplicationFeedback: (trackId: string) => void;
  clearDuplicationFeedback: (trackId: string) => void;

  // Cut segment animation (EDITH deleteSegment visual feedback)
  cutAnimation: { fromFrame: number; toFrame: number; phase: 'highlighting' | 'pulse' | 'cutting' | 'closing' } | null;
  clipTransitionsEnabled: boolean;
  setCutAnimation: (anim: { fromFrame: number; toFrame: number; phase: 'highlighting' | 'pulse' | 'cutting' | 'closing' } | null) => void;
  setClipTransitions: (enabled: boolean) => void;

  // Restore segment animation (EDITH trim/restore visual feedback — right-to-left green sweep)
  restoreAnimation: { fromFrame: number; toFrame: number; phase: 'highlighting' | 'pulse' | 'restoring' | 'closing' } | null;
  restoreTransitionsEnabled: boolean;
  setRestoreAnimation: (anim: { fromFrame: number; toFrame: number; phase: 'highlighting' | 'pulse' | 'restoring' | 'closing' } | null) => void;
  setRestoreTransitions: (enabled: boolean) => void;

  // State management helpers
  markUnsavedChanges?: () => void;
}

export const createTimelineSlice: StateCreator<
  TimelineSlice,
  [],
  [],
  TimelineSlice
> = (set, get) => ({
  tracks: [],
  timeline: {
    currentFrame: 0,
    totalFrames: 3000,
    fps: 30,
    zoom: 1,
    scrollX: 0,
    selectedTrackIds: [],
    playheadVisible: true,
    snapEnabled: true,
    showChapters: true,
    showSceneMarkers: true,
    isSplitModeActive: false,
    visibleTrackRows: ['video', 'audio', 'subtitle', 'text', 'image'],
    timelineMarkers: [],
  },
  duplicationFeedbackTrackIds: new Set(),
  cutAnimation: null,
  clipTransitionsEnabled: false,
  restoreAnimation: null,
  restoreTransitionsEnabled: false,

  setCurrentFrame: (frame) =>
    set((state: any) => {
      // Block playhead movement during render
      if (state.render?.isRendering) return state;

      // When tracks exist, use the maximum track end frame
      // Only use totalFrames as fallback when no tracks exist
      const effectiveEndFrame =
        state.tracks?.length > 0
          ? Math.max(...state.tracks.map((track: any) => track.endFrame))
          : state.timeline.totalFrames;

      const next = Math.max(0, Math.min(frame, effectiveEndFrame));

      // The playback clock calls this from requestAnimationFrame, but the frame
      // number it passes is floored to the timeline fps. On a 165Hz display
      // that is ~161 calls a second carrying ~30 distinct values, and handing
      // back a fresh `timeline` object for the other ~131 re-rendered every
      // subscriber of `state.timeline` for nothing. Measured, that saturated
      // the main thread and held the preview canvas to 13-40 repaints a second.
      if (state.timeline.currentFrame === next) return state;

      return {
        timeline: {
          ...state.timeline,
          currentFrame: next,
        },
      };
    }),

  setTotalFrames: (frames) =>
    set((state) => {
      const newState = {
        timeline: { ...state.timeline, totalFrames: Math.max(1, frames) },
      };
      // Call markUnsavedChanges if available
      setTimeout(() => {
        if (state.markUnsavedChanges) {
          state.markUnsavedChanges();
        }
      }, 0);
      return newState;
    }),

  setFps: (fps) =>
    set((state) => {
      const newState = {
        timeline: { ...state.timeline, fps: Math.max(1, fps) },
      };
      // Call markUnsavedChanges if available
      setTimeout(() => {
        if (state.markUnsavedChanges) {
          state.markUnsavedChanges();
        }
      }, 0);
      return newState;
    }),

  setZoom: (zoom) =>
    set((state) => ({
      timeline: {
        ...state.timeline,
        // Allow zoom from 0.01 (very zoomed out for long timelines) to 10 (very zoomed in)
        zoom: Math.max(0.01, Math.min(zoom, 10)),
      },
    })),

  setScrollX: (scrollX) =>
    set((state) => ({
      timeline: { ...state.timeline, scrollX: Math.max(0, scrollX) },
    })),

  setInPoint: (frame) =>
    set((state) => ({
      timeline: { ...state.timeline, inPoint: frame },
    })),

  setOutPoint: (frame) =>
    set((state) => ({
      timeline: { ...state.timeline, outPoint: frame },
    })),

  setSelectedTracks: (trackIds) =>
    set((state) => ({
      timeline: { ...state.timeline, selectedTrackIds: trackIds },
    })),

  toggleSnap: () =>
    set((state) => ({
      timeline: {
        ...state.timeline,
        snapEnabled: !state.timeline.snapEnabled,
      },
    })),

  toggleChapters: () =>
    set((state) => ({
      timeline: {
        ...state.timeline,
        showChapters: !state.timeline.showChapters,
      },
    })),

  toggleSceneMarkers: () =>
    set((state) => ({
      timeline: {
        ...state.timeline,
        showSceneMarkers: state.timeline.showSceneMarkers === false,
      },
    })),

  upsertTransition: (transition) =>
    set((state) => {
      const existing = state.timeline.transitions ?? [];
      const filtered = existing.filter(
        (t) =>
          !(t.fromClipId === transition.fromClipId && t.toClipId === transition.toClipId),
      );
      return {
        timeline: { ...state.timeline, transitions: [...filtered, transition] },
      };
    }),

  removeTransition: (fromClipId, toClipId) =>
    set((state) => ({
      timeline: {
        ...state.timeline,
        transitions: (state.timeline.transitions ?? []).filter(
          (t) => !(t.fromClipId === fromClipId && t.toClipId === toClipId),
        ),
      },
    })),

  setMatchCut: (matchCut) =>
    set((state) => ({
      timeline: { ...state.timeline, matchCut: matchCut ?? null },
    })),

  addTimelineMarker: (frame, label, color) => {
    const id = `marker-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    (get() as any).recordAction?.('Add Marker');
    set((state) => ({
      timeline: {
        ...state.timeline,
        timelineMarkers: [
          ...(state.timeline.timelineMarkers ?? []),
          { id, frame: Math.max(0, Math.round(frame)), label, color },
        ],
      },
    }));
    (get() as any).markUnsavedChanges?.();
    return id;
  },

  removeTimelineMarker: (id) => {
    (get() as any).recordAction?.('Remove Marker');
    set((state) => ({
      timeline: {
        ...state.timeline,
        timelineMarkers: (state.timeline.timelineMarkers ?? []).filter(
          (m) => m.id !== id,
        ),
      },
    }));
    (get() as any).markUnsavedChanges?.();
  },

  updateTimelineMarker: (id, patch) => {
    (get() as any).recordAction?.('Update Marker');
    set((state) => ({
      timeline: {
        ...state.timeline,
        timelineMarkers: (state.timeline.timelineMarkers ?? []).map((m) =>
          m.id === id ? { ...m, ...patch } : m,
        ),
      },
    }));
    (get() as any).markUnsavedChanges?.();
  },

  clearTimelineMarkers: () => {
    (get() as any).recordAction?.('Clear Markers');
    set((state) => ({
      timeline: { ...state.timeline, timelineMarkers: [] },
    }));
    (get() as any).markUnsavedChanges?.();
  },

  createTransitionBetween: (fromId, toId, type = 'dissolve', durationSeconds = 1.5) => {
    const state = get() as any;
    const a = state.tracks.find((t: VideoTrack) => t.id === fromId);
    const b = state.tracks.find((t: VideoTrack) => t.id === toId);
    if (!a || !b) return;
    if ((a.trackRowIndex ?? 0) !== (b.trackRowIndex ?? 0)) return;
    const earlier = a.startFrame <= b.startFrame ? a : b;
    const later = a.startFrame <= b.startFrame ? b : a;
    const fps = state.timeline?.fps ?? 30;
    // Non-destructive: the clips do NOT move. Clamp the duration so the fade window fits
    // inside the outgoing clip and the incoming clip can supply a pre-roll handle.
    const earlierDur = earlier.endFrame - earlier.startFrame;
    const laterDur = later.endFrame - later.startFrame;
    const durFrames = Math.max(
      2,
      Math.min(Math.round((durationSeconds ?? 1.5) * fps), earlierDur - 1, laterDur - 1),
    );
    (get() as any).upsertTransition({
      id: `tr_${earlier.id}_${later.id}`,
      fromClipId: earlier.id,
      toClipId: later.id,
      type,
      durationFrames: durFrames,
      params: {},
    });
  },

  toggleSplitMode: () =>
    set((state) => ({
      timeline: {
        ...state.timeline,
        isSplitModeActive: !state.timeline.isSplitModeActive,
      },
    })),

  setSplitMode: (active) =>
    set((state) => ({
      timeline: {
        ...state.timeline,
        isSplitModeActive: active,
      },
    })),

  // Track row visibility management
  addTrackRow: (rowId: string) =>
    set((state) => {
      if (state.timeline.visibleTrackRows.includes(rowId)) {
        return state; // Already visible, no change
      }

      // Define the order: video, image, text, subtitle, audio
      const order = ['video', 'image', 'text', 'subtitle', 'audio'];
      const newRows = [...state.timeline.visibleTrackRows, rowId];

      // Sort according to the defined order
      newRows.sort((a, b) => order.indexOf(a) - order.indexOf(b));

      console.log(`✅ Added track row: ${rowId}. Visible rows:`, newRows);
      return {
        timeline: {
          ...state.timeline,
          visibleTrackRows: newRows,
        },
      };
    }),

  removeTrackRow: (rowId: string) =>
    set((state) => {
      // Don't allow removing video or audio rows (they're essential)
      if (rowId === 'video' || rowId === 'audio') {
        console.warn(`⚠️ Cannot remove essential track row: ${rowId}`);
        return state;
      }

      const newRows = state.timeline.visibleTrackRows.filter(
        (id) => id !== rowId,
      );
      console.log(`🗑️ Removed track row: ${rowId}. Visible rows:`, newRows);

      return {
        timeline: {
          ...state.timeline,
          visibleTrackRows: newRows,
        },
      };
    }),

  ensureTrackRowVisible: (rowId: string) => {
    const state = get();
    const visibleRows = state.timeline.visibleTrackRows || ['video', 'audio'];
    if (!visibleRows.includes(rowId)) {
      state.addTrackRow(rowId);
    }
  },

  // Snap functionality
  findSnapPoints: (currentFrame, excludeTrackId) => {
    const state = get() as any;
    const snapPoints: SnapPoint[] = [];
    const { tracks, timeline } = state;

    // Add playhead as snap point
    snapPoints.push({
      frame: currentFrame,
      type: 'playhead',
    });

    // Add in/out points as snap points
    if (timeline.inPoint !== undefined) {
      snapPoints.push({
        frame: timeline.inPoint,
        type: 'in-point',
      });
    }
    if (timeline.outPoint !== undefined) {
      snapPoints.push({
        frame: timeline.outPoint,
        type: 'out-point',
      });
    }

    // Add track start and end points (excluding the current track being dragged)
    tracks.forEach((track: VideoTrack) => {
      if (excludeTrackId && track.id === excludeTrackId) {
        return;
      }

      snapPoints.push({
        frame: track.startFrame,
        type: 'track-start',
        trackId: track.id,
      });

      snapPoints.push({
        frame: track.endFrame,
        type: 'track-end',
        trackId: track.id,
      });
    });

    return snapPoints;
  },

  snapToFrame: (
    targetFrame,
    snapPoints,
    threshold = SNAP_THRESHOLD,
    excludeTrackId,
  ) => {
    let nearestSnapPoint: SnapPoint | null = null;
    let minDistance = threshold + 1;

    for (const snapPoint of snapPoints) {
      // Skip snap points from the same track being dragged
      if (excludeTrackId && snapPoint.trackId === excludeTrackId) {
        continue;
      }

      const distance = Math.abs(snapPoint.frame - targetFrame);
      if (distance <= threshold && distance < minDistance) {
        nearestSnapPoint = snapPoint;
        minDistance = distance;
      }
    }

    return nearestSnapPoint ? nearestSnapPoint.frame : null;
  },

  // Visual feedback for duplication
  triggerDuplicationFeedback: (trackId: string) => {
    console.log(`[Animation] Adding ${trackId} to feedback set`);
    set((state) => {
      const newSet = new Set(state.duplicationFeedbackTrackIds);
      newSet.add(trackId);
      console.log(`[Animation] Feedback set now contains:`, Array.from(newSet));
      return { duplicationFeedbackTrackIds: newSet };
    });

    // Auto-clear after animation duration (600ms)
    setTimeout(() => {
      console.log(`[Animation] Clearing ${trackId} after 600ms`);
      get().clearDuplicationFeedback(trackId);
    }, 600);
  },

  clearDuplicationFeedback: (trackId: string) => {
    console.log(`[Animation] Removing ${trackId} from feedback set`);
    set((state) => {
      const newSet = new Set(state.duplicationFeedbackTrackIds);
      newSet.delete(trackId);
      return { duplicationFeedbackTrackIds: newSet };
    });
  },

  setCutAnimation: (anim) => set({ cutAnimation: anim }),
  setClipTransitions: (enabled) => set({ clipTransitionsEnabled: enabled }),
  setRestoreAnimation: (anim) => set({ restoreAnimation: anim }),
  setRestoreTransitions: (enabled) => set({ restoreTransitionsEnabled: enabled }),
});
