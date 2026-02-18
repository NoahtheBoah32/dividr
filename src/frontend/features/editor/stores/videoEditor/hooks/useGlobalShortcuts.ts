/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  useShortcutCaptureState,
  useShortcutKeys,
} from '@/frontend/features/editor/shortcuts/shortcutHooks';
import { useMemo } from 'react';
import { useHotkeys } from 'react-hotkeys-hook';
import { useShallow } from 'zustand/react/shallow';
import { useVideoEditorStore } from '../index';
import { createGlobalShortcuts } from '../shortcuts/globalShortcuts';
import { useProjectShortcutDialog } from '../shortcuts/hooks/useProjectShortcutDialog';
import { useProjectShortcutHandlers } from '../shortcuts/hooks/useProjectShortcutHandlers';

/**
 * Hook for global keyboard shortcuts
 * These shortcuts are always active regardless of focus state
 */
export const useGlobalShortcuts = () => {
  const totalFrames = useVideoEditorStore(
    (state) => state.timeline.totalFrames,
  );
  const timelineFps = useVideoEditorStore((state) => state.timeline.fps);
  const trackEndFrames = useVideoEditorStore(
    useShallow((state) => state.tracks.map((track) => track.endFrame)),
  );
  const isCapturing = useShortcutCaptureState();

  // Setup project shortcut dialog
  const { showConfirmation, ConfirmationDialog } = useProjectShortcutDialog();

  // Setup project shortcut handlers
  const projectHandlers = useProjectShortcutHandlers(showConfirmation);

  // Calculate effective end frame
  const effectiveEndFrame = useMemo(() => {
    // When tracks exist, use the maximum track end frame
    // Only use totalFrames as fallback when no tracks exist
    return trackEndFrames.length > 0
      ? Math.max(...trackEndFrames)
      : totalFrames;
  }, [trackEndFrames, totalFrames]);

  // Create global shortcuts with a getter function to always access fresh state
  const globalShortcuts = useMemo(
    () =>
      createGlobalShortcuts(
        useVideoEditorStore.getState,
        effectiveEndFrame,
        projectHandlers,
      ),
    [effectiveEndFrame, projectHandlers],
  );

  const playbackKeys = useShortcutKeys(
    'playback-toggle',
    globalShortcuts[7].keys,
  );
  const prevFrameKeys = useShortcutKeys(
    'navigate-frame-prev',
    globalShortcuts[8].keys,
  );
  const nextFrameKeys = useShortcutKeys(
    'navigate-frame-next',
    globalShortcuts[9].keys,
  );
  const prevFrameFastKeys = useShortcutKeys(
    'navigate-frame-prev-fast',
    globalShortcuts[10].keys,
  );
  const nextFrameFastKeys = useShortcutKeys(
    'navigate-frame-next-fast',
    globalShortcuts[11].keys,
  );
  const nextEditPointKeys = useShortcutKeys(
    'navigate-next-edit-point',
    globalShortcuts[12].keys,
  );
  const prevEditPointKeys = useShortcutKeys(
    'navigate-prev-edit-point',
    globalShortcuts[13].keys,
  );
  const fullscreenKeys = useShortcutKeys(
    'preview-toggle-fullscreen',
    globalShortcuts[14].keys,
  );

  const projectNewKeys = useShortcutKeys(
    'project-new',
    globalShortcuts[0].keys,
  );
  const projectOpenKeys = useShortcutKeys(
    'project-open',
    globalShortcuts[1].keys,
  );
  const projectSaveKeys = useShortcutKeys(
    'project-save',
    globalShortcuts[2].keys,
  );
  const projectSaveAsKeys = useShortcutKeys(
    'project-save-as',
    globalShortcuts[3].keys,
  );
  const projectImportKeys = useShortcutKeys(
    'project-import',
    globalShortcuts[4].keys,
  );
  const projectExportKeys = useShortcutKeys(
    'project-export',
    globalShortcuts[5].keys,
  );
  const projectCloseKeys = useShortcutKeys(
    'project-close',
    globalShortcuts[6].keys,
  );

  // Playback toggle
  useHotkeys(
    playbackKeys,
    globalShortcuts[7].handler,
    { ...globalShortcuts[7].options, enabled: !isCapturing },
    [effectiveEndFrame, isCapturing],
  );

  // Navigate frame prev
  useHotkeys(
    prevFrameKeys,
    globalShortcuts[8].handler,
    { ...globalShortcuts[8].options, enabled: !isCapturing },
    [effectiveEndFrame, isCapturing],
  );

  // Navigate frame next
  useHotkeys(
    nextFrameKeys,
    globalShortcuts[9].handler,
    { ...globalShortcuts[9].options, enabled: !isCapturing },
    [effectiveEndFrame, isCapturing],
  );

  // Navigate frame prev fast (Shift+Left)
  useHotkeys(
    prevFrameFastKeys,
    globalShortcuts[10].handler,
    { ...globalShortcuts[10].options, enabled: !isCapturing },
    [effectiveEndFrame, timelineFps, isCapturing],
  );

  // Navigate frame next fast (Shift+Right)
  useHotkeys(
    nextFrameFastKeys,
    globalShortcuts[11].handler,
    { ...globalShortcuts[11].options, enabled: !isCapturing },
    [effectiveEndFrame, timelineFps, isCapturing],
  );

  // Navigate to next edit point (Down)
  useHotkeys(
    nextEditPointKeys,
    globalShortcuts[12].handler,
    { ...globalShortcuts[12].options, enabled: !isCapturing },
    [effectiveEndFrame, isCapturing],
  );

  // Navigate to previous edit point (Up)
  useHotkeys(
    prevEditPointKeys,
    globalShortcuts[13].handler,
    { ...globalShortcuts[13].options, enabled: !isCapturing },
    [effectiveEndFrame, isCapturing],
  );

  // Toggle Fullscreen (F)
  useHotkeys(
    fullscreenKeys,
    globalShortcuts[14].handler,
    { ...globalShortcuts[14].options, enabled: !isCapturing },
    [isCapturing],
  );

  // Project shortcuts
  useHotkeys(
    projectNewKeys,
    globalShortcuts[0].handler,
    { preventDefault: true, enableOnFormTags: false, enabled: !isCapturing },
    [isCapturing],
  );

  useHotkeys(
    projectOpenKeys,
    globalShortcuts[1].handler,
    { preventDefault: true, enableOnFormTags: false, enabled: !isCapturing },
    [isCapturing],
  );

  useHotkeys(
    projectSaveKeys,
    globalShortcuts[2].handler,
    { preventDefault: true, enableOnFormTags: false, enabled: !isCapturing },
    [isCapturing],
  );

  useHotkeys(
    projectSaveAsKeys,
    globalShortcuts[3].handler,
    { preventDefault: true, enableOnFormTags: false, enabled: !isCapturing },
    [isCapturing],
  );

  useHotkeys(
    projectImportKeys,
    globalShortcuts[4].handler,
    { preventDefault: true, enableOnFormTags: false, enabled: !isCapturing },
    [isCapturing],
  );

  useHotkeys(
    projectExportKeys,
    globalShortcuts[5].handler,
    { preventDefault: true, enableOnFormTags: false, enabled: !isCapturing },
    [isCapturing],
  );

  useHotkeys(
    projectCloseKeys,
    globalShortcuts[6].handler,
    { preventDefault: true, enableOnFormTags: false, enabled: !isCapturing },
    [isCapturing],
  );

  return {
    shortcuts: globalShortcuts,
    effectiveEndFrame,
    ConfirmationDialog,
  };
};
