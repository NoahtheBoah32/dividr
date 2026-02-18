/* eslint-disable @typescript-eslint/no-explicit-any */
import { StateCreator } from 'zustand';
import { MediaLibraryItem, VideoTrack } from '../types';

/**
 * UndoableState - Represents the state that can be undone/redone
 * This includes only the mutable editing state, not UI state like playback or preview
 */
export interface UndoableState {
  tracks: VideoTrack[];
  mediaLibrary: MediaLibraryItem[];
  timeline: {
    currentFrame: number;
    totalFrames: number;
    fps: number;
    inPoint?: number;
    outPoint?: number;
    selectedTrackIds: string[];
  };
  preview: {
    canvasWidth: number;
    canvasHeight: number;
    backgroundColor: string;
  };
  // Text style global controls for subtitle styling (undo/redo support)
  textStyle: {
    activeStyle: string;
    styleApplicationMode: 'all' | 'selected';
    globalControls: {
      fontFamily: string;
      isBold: boolean;
      isItalic: boolean;
      isUnderline: boolean;
      textTransform: 'none' | 'uppercase' | 'lowercase' | 'capitalize';
      textAlign: 'left' | 'center' | 'right' | 'justify';
      fontSize: number;
      fillColor: string;
      strokeColor: string;
      backgroundColor: string;
      hasShadow: boolean;
      letterSpacing: number;
      lineHeight: number;
      hasGlow: boolean;
      opacity: number;
    };
    // Global subtitle position for transform undo/redo support
    globalSubtitlePosition: {
      x: number;
      y: number;
      scale: number;
      width: number;
      height: number;
    };
  };
}

export interface UndoHistoryScope {
  tracks: boolean;
  mediaLibrary: boolean;
  timeline: boolean;
  preview: boolean;
  textStyle: boolean;
}

type UndoHistoryScopeOverride = Partial<UndoHistoryScope>;
type UndoHistorySnapshot = Partial<UndoableState>;

/**
 * HistoryEntry - A single entry in the history stack
 */
export interface HistoryEntry {
  state: UndoHistorySnapshot;
  scope: UndoHistoryScope;
  timestamp: number;
  actionName?: string; // Optional: for debugging/displaying action names
}

export interface UndoRedoSlice {
  // History stacks
  undoStack: HistoryEntry[];
  redoStack: HistoryEntry[];

  // Config
  maxHistorySize: number;
  isRecording: boolean; // Flag to prevent recording during undo/redo

  // Batch transaction grouping
  isGrouping: boolean; // Flag to indicate we're in a grouped transaction
  groupStartState: UndoHistorySnapshot | null; // State at the start of a group
  groupScope: UndoHistoryScope | null; // Scope captured for the current group
  groupActionName: string | null; // Name of the grouped action

  // Actions
  undo: () => void;
  redo: () => void;
  recordAction: (
    actionName?: string,
    scopeOverride?: UndoHistoryScopeOverride,
  ) => void;
  canUndo: () => boolean;
  canRedo: () => boolean;
  clearHistory: () => void;
  setMaxHistorySize: (size: number) => void;

  // Batch transaction grouping
  beginGroup: (
    actionName: string,
    scopeOverride?: UndoHistoryScopeOverride,
  ) => void;
  endGroup: () => void;
  forceEndGroup: () => void; // Emergency cleanup for stuck grouping state

  // Internal helpers
  captureUndoableState: (scope: UndoHistoryScope) => UndoHistorySnapshot;
  restoreUndoableState: (
    state: UndoHistorySnapshot,
    scope: UndoHistoryScope,
  ) => void;
}

const DEFAULT_HISTORY_SCOPE: UndoHistoryScope = {
  tracks: true,
  mediaLibrary: true,
  timeline: true,
  preview: true,
  textStyle: true,
};

const TRACK_TIMELINE_SCOPE: UndoHistoryScope = {
  tracks: true,
  mediaLibrary: false,
  timeline: true,
  preview: false,
  textStyle: false,
};

const TRACK_TIMELINE_TEXT_SCOPE: UndoHistoryScope = {
  tracks: true,
  mediaLibrary: false,
  timeline: true,
  preview: false,
  textStyle: true,
};

const MEDIA_TRACK_TIMELINE_SCOPE: UndoHistoryScope = {
  tracks: true,
  mediaLibrary: true,
  timeline: true,
  preview: false,
  textStyle: false,
};

const TIMELINE_ONLY_SCOPE: UndoHistoryScope = {
  tracks: false,
  mediaLibrary: false,
  timeline: true,
  preview: false,
  textStyle: false,
};

const TEXT_AND_TRACK_SCOPE: UndoHistoryScope = {
  tracks: true,
  mediaLibrary: false,
  timeline: false,
  preview: false,
  textStyle: true,
};

const DEFAULT_TEXT_STYLE_CONTROLS: UndoableState['textStyle']['globalControls'] =
  {
    fontFamily: 'Inter',
    isBold: false,
    isItalic: false,
    isUnderline: false,
    textTransform: 'none',
    textAlign: 'center',
    fontSize: 40,
    fillColor: '#FFFFFF',
    strokeColor: '#000000',
    backgroundColor: 'rgba(0, 0, 0, 0.0)',
    hasShadow: false,
    letterSpacing: 0,
    lineHeight: 1.2,
    hasGlow: false,
    opacity: 100,
  };

const DEFAULT_GLOBAL_SUBTITLE_POSITION =
  {} as UndoableState['textStyle']['globalSubtitlePosition'];
DEFAULT_GLOBAL_SUBTITLE_POSITION.x = 0;
DEFAULT_GLOBAL_SUBTITLE_POSITION.y = 0.7;
DEFAULT_GLOBAL_SUBTITLE_POSITION.scale = 1;
DEFAULT_GLOBAL_SUBTITLE_POSITION.width = 0;
DEFAULT_GLOBAL_SUBTITLE_POSITION.height = 0;

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (Object.prototype.toString.call(value) !== '[object Object]') {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const fallbackDeepClone = <T>(value: T): T => {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => fallbackDeepClone(item)) as unknown as T;
  }
  if (value instanceof Date) {
    return new Date(value.getTime()) as unknown as T;
  }
  if (!isPlainObject(value)) {
    // Keep opaque class instances by reference in fallback mode.
    // History snapshots sanitize File objects ahead of this path.
    return value;
  }

  const cloned: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    cloned[key] = fallbackDeepClone(
      (value as Record<string, unknown>)[key] as unknown,
    );
  }
  return cloned as T;
};

const deepClone = <T>(value: T): T => {
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(value);
    } catch {
      return fallbackDeepClone(value);
    }
  }
  return fallbackDeepClone(value);
};

const deepEqual = (a: unknown, b: unknown): boolean => {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;

  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }

  if (a instanceof Date && b instanceof Date) {
    return a.getTime() === b.getTime();
  }

  if (isPlainObject(a) && isPlainObject(b)) {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) return false;

    for (const key of keysA) {
      if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
      if (!deepEqual(a[key], b[key])) return false;
    }
    return true;
  }

  return false;
};

const inferScopeFromActionName = (actionName?: string): UndoHistoryScope => {
  if (!actionName) return DEFAULT_HISTORY_SCOPE;
  const action = actionName.toLowerCase();

  if (action.includes('media') || action.includes('import media')) {
    return MEDIA_TRACK_TIMELINE_SCOPE;
  }

  if (action.includes('subtitle style') || action.includes('style preset')) {
    return TEXT_AND_TRACK_SCOPE;
  }

  if (action.includes('transform')) {
    return TRACK_TIMELINE_TEXT_SCOPE;
  }

  if (action.includes('timeline')) {
    return TIMELINE_ONLY_SCOPE;
  }

  if (
    action.includes('track') ||
    action.includes('split') ||
    action.includes('link') ||
    action.includes('audio') ||
    action.includes('duplicate') ||
    action.includes('paste')
  ) {
    return TRACK_TIMELINE_SCOPE;
  }

  return DEFAULT_HISTORY_SCOPE;
};

const resolveScope = (
  actionName?: string,
  override?: UndoHistoryScopeOverride,
): UndoHistoryScope => {
  const inferred = inferScopeFromActionName(actionName);
  if (!override) return inferred;

  return {
    tracks: override.tracks ?? inferred.tracks,
    mediaLibrary: override.mediaLibrary ?? inferred.mediaLibrary,
    timeline: override.timeline ?? inferred.timeline,
    preview: override.preview ?? inferred.preview,
    textStyle: override.textStyle ?? inferred.textStyle,
  };
};

const sanitizeTracksForHistory = (tracks: VideoTrack[]): VideoTrack[] =>
  tracks.map((track) => ({
    ...track,
    originalFile: undefined as VideoTrack['originalFile'],
  }));

const sanitizeMediaLibraryForHistory = (
  mediaLibrary: MediaLibraryItem[],
): MediaLibraryItem[] =>
  mediaLibrary.map((item) => ({
    ...item,
    originalFile: undefined as MediaLibraryItem['originalFile'],
  }));

const pushHistoryEntry = (
  stack: HistoryEntry[],
  entry: HistoryEntry,
  maxHistorySize: number,
): HistoryEntry[] => {
  const nextStack = [...stack, entry];
  if (nextStack.length <= maxHistorySize) return nextStack;
  return nextStack.slice(nextStack.length - maxHistorySize);
};

export const createUndoRedoSlice: StateCreator<
  UndoRedoSlice,
  [],
  [],
  UndoRedoSlice
> = (set, get) => ({
  undoStack: [],
  redoStack: [],
  maxHistorySize: 50,
  isRecording: true,
  isGrouping: false,
  groupStartState: null,
  groupScope: null,
  groupActionName: null,

  canUndo: () => {
    const state = get() as any;
    return state.undoStack.length > 0;
  },

  canRedo: () => {
    const state = get() as any;
    return state.redoStack.length > 0;
  },

  captureUndoableState: (scope) => {
    const state = get() as any;
    const snapshot: UndoHistorySnapshot = {};

    if (scope.tracks) {
      snapshot.tracks = deepClone(
        sanitizeTracksForHistory(state.tracks || []),
      ) as VideoTrack[];
    }

    if (scope.mediaLibrary) {
      snapshot.mediaLibrary = deepClone(
        sanitizeMediaLibraryForHistory(state.mediaLibrary || []),
      ) as MediaLibraryItem[];
    }

    if (scope.timeline) {
      snapshot.timeline = {
        currentFrame: state.timeline.currentFrame,
        totalFrames: state.timeline.totalFrames,
        fps: state.timeline.fps,
        inPoint: state.timeline.inPoint,
        outPoint: state.timeline.outPoint,
        selectedTrackIds: [...(state.timeline.selectedTrackIds || [])],
      };
    }

    if (scope.preview) {
      snapshot.preview = {
        canvasWidth: state.preview.canvasWidth,
        canvasHeight: state.preview.canvasHeight,
        backgroundColor: state.preview.backgroundColor,
      };
    }

    if (scope.textStyle) {
      snapshot.textStyle = {
        activeStyle: state.textStyle?.activeStyle || 'default',
        styleApplicationMode: state.textStyle?.styleApplicationMode || 'all',
        globalControls: deepClone(
          state.textStyle?.globalControls || DEFAULT_TEXT_STYLE_CONTROLS,
        ),
        globalSubtitlePosition: {
          x:
            state.textStyle?.globalSubtitlePosition?.x ??
            DEFAULT_GLOBAL_SUBTITLE_POSITION.x,
          y:
            state.textStyle?.globalSubtitlePosition?.y ??
            DEFAULT_GLOBAL_SUBTITLE_POSITION.y,
          scale:
            state.textStyle?.globalSubtitlePosition?.scale ??
            DEFAULT_GLOBAL_SUBTITLE_POSITION.scale,
          width:
            state.textStyle?.globalSubtitlePosition?.width ??
            DEFAULT_GLOBAL_SUBTITLE_POSITION.width,
          height:
            state.textStyle?.globalSubtitlePosition?.height ??
            DEFAULT_GLOBAL_SUBTITLE_POSITION.height,
        },
      };
    }

    return snapshot;
  },

  restoreUndoableState: (undoableState, scope) => {
    set((state: any) => {
      const nextState: any = { ...state };

      if (scope.tracks && undoableState.tracks) {
        nextState.tracks = deepClone(undoableState.tracks);
      }

      if (scope.mediaLibrary && undoableState.mediaLibrary) {
        nextState.mediaLibrary = deepClone(undoableState.mediaLibrary);
      }

      if (scope.timeline && undoableState.timeline) {
        nextState.timeline = {
          ...state.timeline,
          currentFrame: undoableState.timeline.currentFrame,
          totalFrames: undoableState.timeline.totalFrames,
          fps: undoableState.timeline.fps,
          inPoint: undoableState.timeline.inPoint,
          outPoint: undoableState.timeline.outPoint,
          selectedTrackIds: [...undoableState.timeline.selectedTrackIds],
        };
      }

      if (scope.preview && undoableState.preview) {
        nextState.preview = {
          ...state.preview,
          canvasWidth: undoableState.preview.canvasWidth,
          canvasHeight: undoableState.preview.canvasHeight,
          backgroundColor: undoableState.preview.backgroundColor,
        };
      }

      if (scope.textStyle && undoableState.textStyle) {
        nextState.textStyle = {
          ...state.textStyle,
          activeStyle: undoableState.textStyle.activeStyle,
          styleApplicationMode: undoableState.textStyle.styleApplicationMode,
          globalControls: deepClone(undoableState.textStyle.globalControls),
          globalSubtitlePosition: {
            x:
              undoableState.textStyle.globalSubtitlePosition?.x ??
              DEFAULT_GLOBAL_SUBTITLE_POSITION.x,
            y:
              undoableState.textStyle.globalSubtitlePosition?.y ??
              DEFAULT_GLOBAL_SUBTITLE_POSITION.y,
            scale:
              undoableState.textStyle.globalSubtitlePosition?.scale ??
              DEFAULT_GLOBAL_SUBTITLE_POSITION.scale,
            width:
              undoableState.textStyle.globalSubtitlePosition?.width ??
              DEFAULT_GLOBAL_SUBTITLE_POSITION.width,
            height:
              undoableState.textStyle.globalSubtitlePosition?.height ??
              DEFAULT_GLOBAL_SUBTITLE_POSITION.height,
          },
        };
      }

      return nextState;
    });
  },

  recordAction: (
    actionName?: string,
    scopeOverride?: UndoHistoryScopeOverride,
  ) => {
    const state = get() as any;

    // Don't record if we're in the middle of undo/redo
    if (!state.isRecording) {
      return;
    }

    // Don't record individual actions if we're in a grouped transaction
    // The group will be recorded when endGroup() is called
    if (state.isGrouping) {
      return;
    }

    const scope = resolveScope(actionName, scopeOverride);
    const currentState = state.captureUndoableState(scope);

    const newEntry: HistoryEntry = {
      state: currentState,
      scope,
      timestamp: Date.now(),
      actionName,
    };

    set((current: any) => ({
      undoStack: pushHistoryEntry(
        current.undoStack,
        newEntry,
        current.maxHistorySize,
      ),
      redoStack: [], // Clear redo stack when new action is recorded
    }));
  },

  beginGroup: (
    actionName: string,
    scopeOverride?: UndoHistoryScopeOverride,
  ) => {
    const state = get() as any;

    // If already grouping, force end the previous group to prevent stuck state
    // This can happen if a component unmounts during a drag operation
    if (state.isGrouping) {
      console.warn(
        `[UndoRedoSlice] Already grouping (${state.groupActionName}), forcing end before starting new group: ${actionName}`,
      );
      // Force end the previous group without recording (cleanup only)
      set({
        isGrouping: false,
        groupStartState: null,
        groupScope: null,
        groupActionName: null,
      });
    }

    // Don't start a group if not recording
    if (!state.isRecording) {
      console.warn('[UndoRedoSlice] Cannot begin group: not recording');
      return;
    }

    const scope = resolveScope(actionName, scopeOverride);
    const startState = state.captureUndoableState(scope);

    set({
      isGrouping: true,
      groupStartState: startState,
      groupScope: scope,
      groupActionName: actionName,
    });
  },

  endGroup: () => {
    const state = get() as any;

    // Don't end a group if we're not in one
    if (!state.isGrouping) {
      console.warn('[UndoRedoSlice] Cannot end group: not currently grouping');
      return;
    }

    const groupScope: UndoHistoryScope =
      state.groupScope || DEFAULT_HISTORY_SCOPE;

    // Capture the final state after all operations in the group
    const finalState = state.captureUndoableState(groupScope);

    // Only record if the state actually changed (no deep serialization)
    const stateChanged = !deepEqual(state.groupStartState, finalState);

    if (stateChanged && state.groupStartState) {
      const newEntry: HistoryEntry = {
        state: state.groupStartState,
        scope: groupScope,
        timestamp: Date.now(),
        actionName: state.groupActionName || 'Grouped Action',
      };

      set((current: any) => ({
        undoStack: pushHistoryEntry(
          current.undoStack,
          newEntry,
          current.maxHistorySize,
        ),
        redoStack: [], // Clear redo stack when new action is recorded
        isGrouping: false,
        groupStartState: null,
        groupScope: null,
        groupActionName: null,
      }));
    } else {
      // State didn't change, just reset the grouping flags
      set({
        isGrouping: false,
        groupStartState: null,
        groupScope: null,
        groupActionName: null,
      });
    }
  },

  forceEndGroup: () => {
    const state = get() as any;

    if (!state.isGrouping) {
      return; // Nothing to clean up
    }

    console.warn(
      `[UndoRedoSlice] Force ending group${state.groupActionName} (cleanup from stuck state)`,
    );

    set({
      isGrouping: false,
      groupStartState: null,
      groupScope: null,
      groupActionName: null,
    });
  },

  undo: () => {
    const state = get() as any;

    if (state.undoStack.length === 0) {
      return;
    }

    // Disable recording during undo
    set({ isRecording: false });

    // Pop from undo stack
    const undoStack = [...state.undoStack];
    const previousEntry = undoStack.pop();

    if (!previousEntry) {
      set({ isRecording: true });
      return;
    }

    // Capture current scoped state for redo
    const currentState = state.captureUndoableState(previousEntry.scope);
    const currentEntry: HistoryEntry = {
      state: currentState,
      scope: previousEntry.scope,
      timestamp: Date.now(),
      actionName: previousEntry.actionName,
    };

    // Restore previous state
    state.restoreUndoableState(previousEntry.state, previousEntry.scope);

    // Update stacks
    set((current: any) => ({
      undoStack,
      redoStack: pushHistoryEntry(
        current.redoStack,
        currentEntry,
        current.maxHistorySize,
      ),
      isRecording: true,
    }));

    // Mark as unsaved
    const currentState2 = get() as any;
    currentState2.markUnsavedChanges?.();
  },

  redo: () => {
    const state = get() as any;

    if (state.redoStack.length === 0) {
      return;
    }

    // Disable recording during redo
    set({ isRecording: false });

    // Pop from redo stack
    const redoStack = [...state.redoStack];
    const nextEntry = redoStack.pop();

    if (!nextEntry) {
      set({ isRecording: true });
      return;
    }

    // Capture current scoped state for undo
    const currentState = state.captureUndoableState(nextEntry.scope);
    const currentEntry: HistoryEntry = {
      state: currentState,
      scope: nextEntry.scope,
      timestamp: Date.now(),
      actionName: nextEntry.actionName,
    };

    // Restore next state
    state.restoreUndoableState(nextEntry.state, nextEntry.scope);

    // Update stacks
    set((current: any) => ({
      undoStack: pushHistoryEntry(
        current.undoStack,
        currentEntry,
        current.maxHistorySize,
      ),
      redoStack,
      isRecording: true,
    }));

    // Mark as unsaved
    const currentState2 = get() as any;
    currentState2.markUnsavedChanges?.();
  },

  clearHistory: () => {
    set({
      undoStack: [],
      redoStack: [],
    });
  },

  setMaxHistorySize: (size: number) => {
    set({ maxHistorySize: Math.max(1, size) });
  },
});
