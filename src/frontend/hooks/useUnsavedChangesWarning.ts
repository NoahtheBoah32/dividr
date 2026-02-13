/* eslint-disable @typescript-eslint/no-explicit-any */
import { useVideoEditorStore } from '@/frontend/features/editor/stores/videoEditor';
import { hasPendingUnsavedChanges } from '@/frontend/hooks/unsavedChangesState';
import type {
  AppExitDecision,
  AppExitRequestedEvent,
} from '@/shared/ipc/contracts';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useBlocker } from 'react-router-dom';

const getExitErrorMessage = (error: unknown): string => {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return 'Failed to save project. Please try again before exiting.';
};

const sendAppExitDecision = async (
  requestId: number,
  decision: AppExitDecision,
): Promise<void> => {
  await window.electronAPI.appExitDecision({ requestId, decision });
};

export const useUnsavedChangesWarning = () => {
  const { hasUnsavedChanges, isSaving, saveProjectData } =
    useVideoEditorStore();

  const shouldWarnForUnsavedChanges = useMemo(
    () => hasPendingUnsavedChanges(hasUnsavedChanges, isSaving),
    [hasUnsavedChanges, isSaving],
  );

  const shouldWarnRef = useRef(shouldWarnForUnsavedChanges);
  const activeExitRequestIdRef = useRef<number | null>(null);

  const [isExitDialogOpen, setIsExitDialogOpen] = useState(false);
  const [isExitActionRunning, setIsExitActionRunning] = useState(false);
  const [exitErrorMessage, setExitErrorMessage] = useState<string | null>(null);
  const [isNavigationActionRunning, setIsNavigationActionRunning] =
    useState(false);
  const [navigationErrorMessage, setNavigationErrorMessage] = useState<
    string | null
  >(null);

  useEffect(() => {
    shouldWarnRef.current = shouldWarnForUnsavedChanges;
  }, [shouldWarnForUnsavedChanges]);

  const closeExitDialog = useCallback(() => {
    setIsExitDialogOpen(false);
    setIsExitActionRunning(false);
    setExitErrorMessage(null);
  }, []);

  const handleAppExitRequested = useCallback(
    (payload: AppExitRequestedEvent) => {
      const requestId = Number(payload?.requestId);
      if (!Number.isInteger(requestId)) {
        return;
      }

      activeExitRequestIdRef.current = requestId;

      if (!shouldWarnRef.current) {
        void sendAppExitDecision(requestId, 'allow');
        return;
      }

      closeExitDialog();
      setIsExitDialogOpen(true);
      void sendAppExitDecision(requestId, 'pending');
    },
    [closeExitDialog],
  );

  useEffect(() => {
    window.electronAPI.onAppExitRequested(handleAppExitRequested);
    return () => {
      window.electronAPI.offAppExitRequested();
    };
  }, [handleAppExitRequested]);

  const respondToExitRequest = useCallback(
    async (decision: AppExitDecision) => {
      const requestId = activeExitRequestIdRef.current;
      if (!Number.isInteger(requestId)) {
        return;
      }

      await sendAppExitDecision(requestId, decision);
      if (decision !== 'pending') {
        activeExitRequestIdRef.current = null;
      }
    },
    [],
  );

  const handleCancelExit = useCallback(() => {
    closeExitDialog();
    void respondToExitRequest('cancel');
  }, [closeExitDialog, respondToExitRequest]);

  const handleExitWithoutSaving = useCallback(() => {
    closeExitDialog();
    void respondToExitRequest('allow');
  }, [closeExitDialog, respondToExitRequest]);

  const handleSaveAndExit = useCallback(async () => {
    setIsExitActionRunning(true);
    setExitErrorMessage(null);

    try {
      await saveProjectData();
      closeExitDialog();
      await respondToExitRequest('allow');
    } catch (error) {
      setIsExitDialogOpen(true);
      setIsExitActionRunning(false);
      setExitErrorMessage(getExitErrorMessage(error));
    }
  }, [closeExitDialog, respondToExitRequest, saveProjectData]);

  // React Router navigation blocker
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      shouldWarnForUnsavedChanges &&
      currentLocation.pathname !== nextLocation.pathname,
  );

  useEffect(() => {
    if (blocker.state !== 'blocked') {
      setIsNavigationActionRunning(false);
      setNavigationErrorMessage(null);
    }
  }, [blocker.state]);

  const handleCancelNavigation = useCallback(() => {
    setIsNavigationActionRunning(false);
    setNavigationErrorMessage(null);
    blocker.reset?.();
  }, [blocker]);

  const handleContinueWithoutSaving = useCallback(() => {
    setIsNavigationActionRunning(false);
    setNavigationErrorMessage(null);
    blocker.proceed?.();
  }, [blocker]);

  const handleSaveAndContinue = useCallback(async () => {
    setIsNavigationActionRunning(true);
    setNavigationErrorMessage(null);

    try {
      await saveProjectData();
      blocker.proceed?.();
    } catch (error) {
      setNavigationErrorMessage(getExitErrorMessage(error));
      setIsNavigationActionRunning(false);
    }
  }, [blocker, saveProjectData]);

  return {
    blocker,
    isExitDialogOpen,
    isExitActionRunning,
    exitErrorMessage,
    handleCancelExit,
    handleExitWithoutSaving,
    handleSaveAndExit,
    isNavigationActionRunning,
    navigationErrorMessage,
    handleCancelNavigation,
    handleContinueWithoutSaving,
    handleSaveAndContinue,
  };
};
