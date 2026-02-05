/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  useShortcutCaptureState,
  useShortcutKeys,
} from '@/frontend/features/editor/shortcuts/shortcutHooks';
import { useMemo } from 'react';
import { useHotkeys } from 'react-hotkeys-hook';
import { useVideoEditorStore } from '../index';
import { createPreviewShortcuts } from '../shortcuts/previewShortcuts';

/**
 * Hook for preview keyboard shortcuts
 * These shortcuts are active only when the preview area has focus
 *
 * @param enabled - Whether the shortcuts should be active (preview is focused)
 */
export const usePreviewShortcuts = (enabled = true) => {
  const preview = useVideoEditorStore((state) => state.preview);
  const isCapturing = useShortcutCaptureState();

  // Create preview shortcuts with a getter function to always access fresh state
  const previewShortcuts = useMemo(
    () => createPreviewShortcuts(useVideoEditorStore.getState),
    [],
  );

  const selectToolKeys = useShortcutKeys(
    'preview-select-tool',
    previewShortcuts[0].keys,
  );
  const handToolKeys = useShortcutKeys(
    'preview-hand-tool',
    previewShortcuts[1].keys,
  );
  const textToolKeys = useShortcutKeys(
    'preview-text-edit-tool',
    previewShortcuts[2].keys,
  );
  const zoom25Keys = useShortcutKeys(
    'preview-zoom-25',
    previewShortcuts[3].keys,
  );
  const zoom50Keys = useShortcutKeys(
    'preview-zoom-50',
    previewShortcuts[4].keys,
  );
  const zoomFitKeys = useShortcutKeys(
    'preview-zoom-fit',
    previewShortcuts[5].keys,
  );
  const zoom200Keys = useShortcutKeys(
    'preview-zoom-200',
    previewShortcuts[6].keys,
  );
  const zoom400Keys = useShortcutKeys(
    'preview-zoom-400',
    previewShortcuts[7].keys,
  );
  const zoomInKeys = useShortcutKeys(
    'preview-zoom-in',
    previewShortcuts[8].keys,
  );
  const zoomOutKeys = useShortcutKeys(
    'preview-zoom-out',
    previewShortcuts[9].keys,
  );
  const zoomResetKeys = useShortcutKeys(
    'preview-zoom-reset',
    previewShortcuts[10].keys,
  );

  const isEnabled = enabled && !isCapturing;

  // Preview Tools
  useHotkeys(
    selectToolKeys,
    previewShortcuts[0].handler,
    {
      ...previewShortcuts[0].options,
      enabled: isEnabled,
      enableOnFormTags: false,
      preventDefault: true,
    },
    [preview.interactionMode, enabled, isCapturing],
  );

  useHotkeys(
    handToolKeys,
    previewShortcuts[1].handler,
    {
      ...previewShortcuts[1].options,
      enabled: isEnabled,
      enableOnFormTags: false,
      preventDefault: true,
    },
    [preview.interactionMode, preview.previewScale, enabled, isCapturing],
  );

  useHotkeys(
    textToolKeys,
    previewShortcuts[2].handler,
    {
      ...previewShortcuts[2].options,
      enabled: isEnabled,
      enableOnFormTags: false,
      preventDefault: true,
    },
    [preview.interactionMode, enabled, isCapturing],
  );

  // Preview Zoom Shortcuts
  useHotkeys(
    zoom25Keys,
    previewShortcuts[3].handler,
    {
      ...previewShortcuts[3].options,
      enabled: isEnabled,
      enableOnFormTags: false,
      preventDefault: true,
    },
    [preview.previewScale, enabled, isCapturing],
  );

  useHotkeys(
    zoom50Keys,
    previewShortcuts[4].handler,
    {
      ...previewShortcuts[4].options,
      enabled: isEnabled,
      enableOnFormTags: false,
      preventDefault: true,
    },
    [preview.previewScale, enabled, isCapturing],
  );

  useHotkeys(
    zoomFitKeys,
    previewShortcuts[5].handler,
    {
      ...previewShortcuts[5].options,
      enabled: isEnabled,
      enableOnFormTags: false,
      preventDefault: true,
    },
    [preview.previewScale, preview.panX, preview.panY, enabled, isCapturing],
  );

  useHotkeys(
    zoom200Keys,
    previewShortcuts[6].handler,
    {
      ...previewShortcuts[6].options,
      enabled: isEnabled,
      enableOnFormTags: false,
      preventDefault: true,
    },
    [preview.previewScale, enabled, isCapturing],
  );

  useHotkeys(
    zoom400Keys,
    previewShortcuts[7].handler,
    {
      ...previewShortcuts[7].options,
      enabled: isEnabled,
      enableOnFormTags: false,
      preventDefault: true,
    },
    [preview.previewScale, enabled, isCapturing],
  );

  useHotkeys(
    zoomInKeys,
    previewShortcuts[8].handler,
    {
      ...previewShortcuts[8].options,
      enabled: isEnabled,
      enableOnFormTags: false,
      preventDefault: true,
    },
    [preview.previewScale, enabled, isCapturing],
  );

  useHotkeys(
    zoomOutKeys,
    previewShortcuts[9].handler,
    {
      ...previewShortcuts[9].options,
      enabled: isEnabled,
      enableOnFormTags: false,
      preventDefault: true,
    },
    [preview.previewScale, enabled, isCapturing],
  );

  useHotkeys(
    zoomResetKeys,
    previewShortcuts[10].handler,
    {
      ...previewShortcuts[10].options,
      enabled: isEnabled,
      enableOnFormTags: false,
      preventDefault: true,
    },
    [preview.previewScale, preview.panX, preview.panY, enabled, isCapturing],
  );

  return {
    shortcuts: previewShortcuts,
  };
};
