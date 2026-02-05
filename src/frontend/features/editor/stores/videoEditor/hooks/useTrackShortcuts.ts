/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  useShortcutCaptureState,
  useShortcutKeys,
} from '@/frontend/features/editor/shortcuts/shortcutHooks';
import { useMemo } from 'react';
import { useHotkeys } from 'react-hotkeys-hook';
import { useVideoEditorStore } from '../index';
import { createTrackShortcuts } from '../shortcuts/trackShortcuts';

/**
 * Hook for track-level keyboard shortcuts
 * These shortcuts are active when tracks are selected or focused
 */
export const useTrackShortcuts = () => {
  const timeline = useVideoEditorStore((state) => state.timeline);
  const isCapturing = useShortcutCaptureState();

  // Get the store instance for creating shortcuts
  const store = useVideoEditorStore.getState();

  // Create track shortcuts
  const trackShortcuts = useMemo(() => createTrackShortcuts(store), []);

  const sliceKeys = useShortcutKeys(
    'track-slice-playhead',
    trackShortcuts[0].keys,
  );
  const duplicateKeys = useShortcutKeys(
    'track-duplicate',
    trackShortcuts[1].keys,
  );
  const copyKeys = useShortcutKeys('track-copy', trackShortcuts[2].keys);
  const cutKeys = useShortcutKeys('track-cut', trackShortcuts[3].keys);
  const pasteKeys = useShortcutKeys('track-paste', trackShortcuts[4].keys);
  const selectionToolKeys = useShortcutKeys(
    'track-selection-tool',
    trackShortcuts[5].keys,
  );
  const toggleSplitKeys = useShortcutKeys(
    'track-toggle-split-mode',
    trackShortcuts[6].keys,
  );
  const muteKeys = useShortcutKeys('track-toggle-mute', trackShortcuts[7].keys);
  const deleteKeys = useShortcutKeys('track-delete', trackShortcuts[8].keys);
  const deselectKeys = useShortcutKeys(
    'track-deselect',
    trackShortcuts[9].keys,
  );
  const linkKeys = useShortcutKeys('track-link', trackShortcuts[10].keys);
  const unlinkKeys = useShortcutKeys('track-unlink', trackShortcuts[11].keys);

  // Slice at playhead
  useHotkeys(
    sliceKeys,
    trackShortcuts[0].handler,
    {
      ...trackShortcuts[0].options,
      enabled: !isCapturing,
    },
    [timeline.selectedTrackIds, isCapturing],
  );

  // Duplicate track
  useHotkeys(
    duplicateKeys,
    trackShortcuts[1].handler,
    { ...trackShortcuts[1].options, enabled: !isCapturing },
    [timeline.selectedTrackIds, isCapturing],
  );

  // Copy track
  useHotkeys(
    copyKeys,
    trackShortcuts[2].handler,
    { ...trackShortcuts[2].options, enabled: !isCapturing },
    [timeline.selectedTrackIds, isCapturing],
  );

  // Cut track
  useHotkeys(
    cutKeys,
    trackShortcuts[3].handler,
    { ...trackShortcuts[3].options, enabled: !isCapturing },
    [timeline.selectedTrackIds, isCapturing],
  );

  // Paste track
  useHotkeys(
    pasteKeys,
    trackShortcuts[4].handler,
    { ...trackShortcuts[4].options, enabled: !isCapturing },
    [timeline.selectedTrackIds, isCapturing],
  );

  // Selection tool
  useHotkeys(
    selectionToolKeys,
    trackShortcuts[5].handler,
    { ...trackShortcuts[5].options, enabled: !isCapturing },
    [timeline.isSplitModeActive, isCapturing],
  );

  // Toggle split mode
  useHotkeys(
    toggleSplitKeys,
    trackShortcuts[6].handler,
    { ...trackShortcuts[6].options, enabled: !isCapturing },
    [timeline.isSplitModeActive, isCapturing],
  );

  // Toggle mute
  useHotkeys(
    muteKeys,
    trackShortcuts[7].handler,
    { ...trackShortcuts[7].options, enabled: !isCapturing },
    [timeline.selectedTrackIds, isCapturing],
  );

  // Delete tracks
  useHotkeys(
    deleteKeys,
    trackShortcuts[8].handler,
    { ...trackShortcuts[8].options, enabled: !isCapturing },
    [timeline.selectedTrackIds, isCapturing],
  );

  // Deselect all
  useHotkeys(
    deselectKeys,
    trackShortcuts[9].handler,
    { ...trackShortcuts[9].options, enabled: !isCapturing },
    [timeline.selectedTrackIds, isCapturing],
  );

  // Link clips
  useHotkeys(
    linkKeys,
    trackShortcuts[10].handler,
    { ...trackShortcuts[10].options, enabled: !isCapturing },
    [timeline.selectedTrackIds, isCapturing],
  );

  // Unlink clips
  useHotkeys(
    unlinkKeys,
    trackShortcuts[11].handler,
    { ...trackShortcuts[11].options, enabled: !isCapturing },
    [timeline.selectedTrackIds, isCapturing],
  );

  return {
    shortcuts: trackShortcuts,
  };
};
