/**
 * Hook for creating project shortcut handlers
 * Connects action functions with React Router navigation and component state
 */

import { hasPendingUnsavedChanges } from '@/frontend/hooks/unsavedChangesState';
import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { useVideoEditorStore } from '../../index';
import {
  closeProjectAction,
  exportVideoAction,
  importMediaAction,
  newProjectAction,
  openProjectAction,
  saveProjectAction,
  saveProjectAsAction,
} from '../actions';
import type { ProjectShortcutHandlers } from '../projectShortcuts';

/**
 * Custom hook to create project shortcut handlers
 * @param showConfirmation - Function to show confirmation dialogs
 * @returns Object containing all project shortcut handlers
 */
export const useProjectShortcutHandlers = (
  showConfirmation: (options: {
    title: string;
    message: string;
    onConfirm: () => void;
    confirmText?: string;
    cancelText?: string;
    secondaryAction?: {
      text: string;
      onClick: () => void;
      variant?: 'default' | 'destructive';
    };
  }) => void,
): ProjectShortcutHandlers => {
  const navigate = useNavigate();
  const importMediaFromDialog = useVideoEditorStore(
    (state) => state.importMediaFromDialog,
  );

  const runProjectSwitchWithUnsavedGuard = useCallback(
    (actionLabel: string, action: () => Promise<void>) => {
      const { hasUnsavedChanges, isSaving, saveProjectData } =
        useVideoEditorStore.getState();

      if (!hasPendingUnsavedChanges(hasUnsavedChanges, isSaving)) {
        void action();
        return;
      }

      showConfirmation({
        title: 'You have unsaved changes.',
        message: `Save your current project before you ${actionLabel}?`,
        confirmText: 'Save & Continue',
        cancelText: 'Cancel',
        onConfirm: () => {
          void (async () => {
            try {
              await saveProjectData();
              await action();
            } catch (error) {
              console.error(
                '[UseProjectShortcutHandlers] Save before switch failed',
                error,
              );
              toast.error('Failed to save project. Please try again.');
            }
          })();
        },
        secondaryAction: {
          text: 'Continue Without Saving',
          variant: 'destructive',
          onClick: () => {
            void action();
          },
        },
      });
    },
    [showConfirmation],
  );

  const onNewProject = useCallback(() => {
    runProjectSwitchWithUnsavedGuard('create a new project', () =>
      newProjectAction(navigate),
    );
  }, [navigate, runProjectSwitchWithUnsavedGuard]);

  const onOpenProject = useCallback(() => {
    runProjectSwitchWithUnsavedGuard('open another project', () =>
      openProjectAction(navigate),
    );
  }, [navigate, runProjectSwitchWithUnsavedGuard]);

  const onSaveProject = useCallback(() => {
    saveProjectAction().catch((error) => {
      console.error('[UseProjectShortcutHandlers] Save Project failed', error);
    });
  }, []);

  const onSaveProjectAs = useCallback(() => {
    saveProjectAsAction().catch((error) => {
      console.error(
        '[UseProjectShortcutHandlers] Save Project As failed',
        error,
      );
    });
  }, []);

  const onImportMedia = useCallback(() => {
    importMediaAction(importMediaFromDialog).catch((error) => {
      console.error('[UseProjectShortcutHandlers] Import Media failed', error);
    });
  }, [importMediaFromDialog]);

  const tracks = useVideoEditorStore((state) => state.tracks);

  const onExportVideo = useCallback(() => {
    exportVideoAction(tracks.length);
  }, [tracks.length]);

  const onCloseProject = useCallback(() => {
    closeProjectAction(navigate, showConfirmation).catch((error) => {
      console.error('[UseProjectShortcutHandlers] Close Project failed', error);
    });
  }, [navigate, showConfirmation]);

  return {
    onNewProject,
    onOpenProject,
    onSaveProject,
    onSaveProjectAs,
    onImportMedia,
    onExportVideo,
    onCloseProject,
  };
};
