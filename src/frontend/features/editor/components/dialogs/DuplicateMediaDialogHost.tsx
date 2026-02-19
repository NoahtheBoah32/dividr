import { useVideoEditorStore } from '@/frontend/features/editor/stores/videoEditor';
import React, { useCallback } from 'react';
import {
  DuplicateChoice,
  DuplicateItem,
} from '../../stores/videoEditor/slices/mediaLibrarySlice';
import { DuplicateMediaDialog } from './batchDuplicateMediaDialog';

export const DuplicateMediaDialogHost: React.FC = () => {
  const batchDuplicateDetection = useVideoEditorStore(
    (state) => state.batchDuplicateDetection,
  );

  const resolveAndClose = useCallback(
    (choices: Map<string, DuplicateChoice>) => {
      const storeState = useVideoEditorStore.getState();
      storeState.batchDuplicateDetection?.pendingResolve?.(choices);
      storeState.hideBatchDuplicateDialog?.();
    },
    [],
  );

  const useExistingForAll = useCallback(() => {
    const storeState = useVideoEditorStore.getState();
    const activeDuplicateState = storeState.batchDuplicateDetection;
    if (!activeDuplicateState) return;

    const fallbackChoices = new Map<string, DuplicateChoice>();
    activeDuplicateState.duplicates.forEach((dup: DuplicateItem) => {
      fallbackChoices.set(dup.id, 'use-existing');
    });

    activeDuplicateState.pendingResolve?.(fallbackChoices);
    storeState.hideBatchDuplicateDialog?.();
  }, []);

  return (
    <DuplicateMediaDialog
      open={batchDuplicateDetection?.show ?? false}
      onOpenChange={(open) => {
        if (!open) {
          useExistingForAll();
        }
      }}
      duplicates={batchDuplicateDetection?.duplicates ?? []}
      onConfirm={resolveAndClose}
    />
  );
};
