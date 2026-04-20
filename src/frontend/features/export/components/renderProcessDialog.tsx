import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/frontend/components/ui/alert-dialog';
import { Button } from '@/frontend/components/ui/button';
import type { RenderEtaState } from '@/frontend/features/editor/stores/videoEditor/types/render.types';
import { CheckCircle2, FolderOpen, Loader2, XCircle } from 'lucide-react';
import React from 'react';

export type RenderState = 'rendering' | 'completed' | 'failed' | 'cancelled';

interface RenderProcessDialogProps {
  isOpen: boolean;
  state: RenderState;
  progress: number;
  status: string;
  elapsedSeconds?: number;
  etaSeconds?: number;
  etaState: RenderEtaState;
  errorMessage?: string;
  outputFilePath?: string;
  onCancel: () => void;
  onClose: () => void;
  onRetry?: () => void;
}

export const RenderProcessDialog: React.FC<RenderProcessDialogProps> = ({
  isOpen,
  state,
  progress,
  status,
  elapsedSeconds,
  etaSeconds,
  etaState,
  errorMessage,
  outputFilePath,
  onCancel,
  onClose,
  onRetry,
}) => {
  const formatClock = (seconds?: number): string => {
    if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) {
      return '00:00:00';
    }
    const safeSeconds = Math.max(0, Math.floor(seconds));
    const hours = Math.floor(safeSeconds / 3600);
    const minutes = Math.floor((safeSeconds % 3600) / 60);
    const remainingSeconds = safeSeconds % 60;
    return `${hours.toString().padStart(2, '0')}:${minutes
      .toString()
      .padStart(2, '0')}:${remainingSeconds.toString().padStart(2, '0')}`;
  };

  const safeProgress = Number.isFinite(progress)
    ? Math.max(0, Math.min(100, progress))
    : 0;
  const elapsedLabel = formatClock(elapsedSeconds);
  const remainingLabel =
    etaState === 'ready' && Number.isFinite(etaSeconds)
      ? formatClock(etaSeconds)
      : 'Calculating...';

  // Lock the state when user dismisses to prevent flashing
  const [lockedState, setLockedState] = React.useState<RenderState>(state);
  const [isClosing, setIsClosing] = React.useState(false);

  // Update locked state only when dialog is open and not closing
  React.useEffect(() => {
    if (isOpen && !isClosing) {
      setLockedState(state);
    }
  }, [state, isOpen, isClosing]);

  // Reset closing flag when dialog opens
  React.useEffect(() => {
    if (isOpen) {
      setIsClosing(false);
    }
  }, [isOpen]);

  // Prevent closing during active render
  const handleOpenChange = (open: boolean) => {
    if (!open && lockedState === 'rendering') {
      return; // Block closing during render
    }
    if (!open) {
      setIsClosing(true);
      onClose();
    }
  };

  const handleClose = () => {
    setIsClosing(true);
    onClose();
  };

  const handleGoToFile = async () => {
    if (!outputFilePath) {
      console.error('[RenderProcessDialog] No output file path available');
      return;
    }

    try {
      const result = await window.electronAPI.showItemInFolder(outputFilePath);
      if (!result.success) {
        console.error(
          '[RenderProcessDialog] Failed to open file location',
          result.error,
        );
        alert(`Failed to open file location: ${result.error}`);
      }
    } catch (error) {
      console.error('[RenderProcessDialog] Error opening file location', error);
      alert('Failed to open file location');
    }
  };

  const renderContent = () => {
    switch (lockedState) {
      case 'rendering':
        return (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle className="flex items-center gap-2">
                <Loader2 className="size-5 animate-spin text-secondary" />
                Rendering Video
              </AlertDialogTitle>
              <AlertDialogDescription className="space-y-4 pt-2">
                {/* Progress Bar */}
                <div className="space-y-2">
                  <div className="flex justify-between items-center">
                    {/* Status Message */}
                    <p className="text-xs text-muted-foreground">
                      {status || 'Preparing render...'}
                    </p>
                    <div className="text-xs font-mono text-muted-foreground">
                      {safeProgress.toFixed(1)}%
                    </div>
                  </div>
                  <div className="w-full h-2 bg-muted rounded-full overflow-hidden">
                    <div
                      className="h-full bg-secondary transition-all duration-300 ease-out"
                      style={{
                        width: `${safeProgress}%`,
                      }}
                    />
                  </div>
                  <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2 pt-1 text-xs font-mono text-muted-foreground">
                    <div className="flex items-center justify-between bg-muted/40 rounded px-2 py-1">
                      <span>Elapsed</span>
                      <span>{elapsedLabel}</span>
                    </div>
                    <span>/</span>
                    <div className="flex items-center justify-between bg-muted/40 rounded px-2 py-1">
                      <span>Remaining</span>
                      <span>{remainingLabel}</span>
                    </div>
                  </div>
                </div>
              </AlertDialogDescription>
            </AlertDialogHeader>

            <AlertDialogFooter>
              <Button variant="destructive" size="sm" onClick={onCancel}>
                Cancel Render
              </Button>
            </AlertDialogFooter>
          </>
        );

      case 'completed':
        return (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle className="flex items-center gap-2">
                <CheckCircle2 className="size-5 text-green-500" />
                Render Complete
              </AlertDialogTitle>
              <AlertDialogDescription className="space-y-2 pt-2">
                <p className="text-sm">
                  Your video has been successfully exported.
                </p>
                <div className="text-xs text-muted-foreground font-mono bg-muted p-2 rounded">
                  Render Time: {elapsedLabel}
                </div>
                {outputFilePath && (
                  <div className="text-xs text-muted-foreground bg-muted/50 p-2 rounded break-all">
                    <span className="font-semibold">Location: </span>
                    {outputFilePath}
                  </div>
                )}
              </AlertDialogDescription>
            </AlertDialogHeader>

            <AlertDialogFooter className="gap-2">
              {outputFilePath && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={handleGoToFile}
                  className="gap-1.5"
                >
                  <FolderOpen className="size-4" />
                  Go to File
                </Button>
              )}
              <Button variant="default" size="sm" onClick={handleClose}>
                Close
              </Button>
            </AlertDialogFooter>
          </>
        );

      case 'failed':
        return (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle className="flex items-center gap-2">
                <XCircle className="size-5 text-red-500" />
                Render Failed
              </AlertDialogTitle>
              <AlertDialogDescription className="space-y-3 pt-2">
                <p className="text-sm">
                  An error occurred during the render process.
                </p>
                {errorMessage && (
                  <div className="text-xs text-red-400 bg-red-950/20 border border-red-900/50 p-3 rounded font-mono">
                    {errorMessage}
                  </div>
                )}
              </AlertDialogDescription>
            </AlertDialogHeader>

            <AlertDialogFooter className="gap-2">
              {onRetry && (
                <Button variant="secondary" size="sm" onClick={onRetry}>
                  Retry
                </Button>
              )}
              <Button variant="default" size="sm" onClick={handleClose}>
                Close
              </Button>
            </AlertDialogFooter>
          </>
        );

      case 'cancelled':
        return (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle className="flex items-center gap-2">
                <XCircle className="size-5 text-yellow-500" />
                Render Cancelled
              </AlertDialogTitle>
              <AlertDialogDescription className="pt-2">
                <p className="text-sm">
                  The render process was cancelled by the user.
                </p>
              </AlertDialogDescription>
            </AlertDialogHeader>

            <AlertDialogFooter>
              <Button variant="default" size="sm" onClick={handleClose}>
                Close
              </Button>
            </AlertDialogFooter>
          </>
        );

      default:
        return null;
    }
  };

  return (
    <AlertDialog open={isOpen} onOpenChange={handleOpenChange}>
      <AlertDialogContent className="sm:max-w-md max-h-[90vh] overflow-y-auto">
        {renderContent()}
      </AlertDialogContent>
    </AlertDialog>
  );
};
