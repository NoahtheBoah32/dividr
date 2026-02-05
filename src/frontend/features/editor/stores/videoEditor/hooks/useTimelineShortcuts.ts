/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  useShortcutCaptureState,
  useShortcutKeys,
} from '@/frontend/features/editor/shortcuts/shortcutHooks';
import { useMemo } from 'react';
import { useHotkeys } from 'react-hotkeys-hook';
import { useVideoEditorStore } from '../index';
import { createTimelineShortcuts } from '../shortcuts/timelineShortcuts';

/**
 * Hook for timeline-specific keyboard shortcuts
 * These shortcuts are active when the timeline is focused
 */
export const useTimelineShortcutsV2 = () => {
  const timeline = useVideoEditorStore((state) => state.timeline);
  const tracks = useVideoEditorStore((state) => state.tracks);
  const isCapturing = useShortcutCaptureState();

  // Create timeline shortcuts - pass getState so handlers always get fresh state
  const timelineShortcuts = useMemo(
    () => createTimelineShortcuts(useVideoEditorStore.getState()),
    [],
  );

  const zoomInKeys = useShortcutKeys(
    'timeline-zoom-in',
    timelineShortcuts[0].keys,
  );
  const zoomOutKeys = useShortcutKeys(
    'timeline-zoom-out',
    timelineShortcuts[1].keys,
  );
  const zoomResetKeys = useShortcutKeys(
    'timeline-zoom-reset',
    timelineShortcuts[2].keys,
  );
  const toggleSnapKeys = useShortcutKeys(
    'timeline-toggle-snap',
    timelineShortcuts[3].keys,
  );
  const selectAllKeys = useShortcutKeys(
    'timeline-select-all',
    timelineShortcuts[8].keys,
  );

  // Zoom in
  useHotkeys(
    zoomInKeys,
    timelineShortcuts[0].handler,
    { ...timelineShortcuts[0].options, enabled: !isCapturing },
    [timeline.zoom, isCapturing],
  );

  // Zoom out
  useHotkeys(
    zoomOutKeys,
    timelineShortcuts[1].handler,
    { ...timelineShortcuts[1].options, enabled: !isCapturing },
    [timeline.zoom, isCapturing],
  );

  // Zoom reset
  useHotkeys(
    zoomResetKeys,
    timelineShortcuts[2].handler,
    { ...timelineShortcuts[2].options, enabled: !isCapturing },
    [timeline.zoom, isCapturing],
  );

  // Toggle snap
  useHotkeys(
    toggleSnapKeys,
    timelineShortcuts[3].handler,
    { ...timelineShortcuts[3].options, enabled: !isCapturing },
    [timeline.snapEnabled, isCapturing],
  );

  // Note: B, C, V, K tool switching shortcuts are registered in useTrackShortcuts to avoid conflicts
  // Exit split mode is handled there as well via Escape key

  // Select All (Ctrl+A / Cmd+A)
  useHotkeys(
    selectAllKeys,
    timelineShortcuts[8].handler,
    { preventDefault: true, enableOnFormTags: false, enabled: !isCapturing },
    [tracks.length, timeline.selectedTrackIds, isCapturing],
  );

  return {
    shortcuts: timelineShortcuts,
  };
};
