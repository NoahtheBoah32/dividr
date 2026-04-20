import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/frontend/components/ui/alert-dialog';
import { Button } from '@/frontend/components/ui/button';

interface NavigationBlockerDialogProps {
  isOpen: boolean;
  onCancel: () => void;
  isSaving: boolean;
  mode?: 'navigation' | 'exit';
  onConfirm?: () => void;
  onSaveAndExit?: () => void;
  onExitWithoutSaving?: () => void;
  onSaveAndContinue?: () => void;
  onContinueWithoutSaving?: () => void;
  isSubmitting?: boolean;
  errorMessage?: string | null;
}

export const NavigationBlockerDialog = ({
  isOpen,
  onCancel,
  isSaving,
  mode = 'navigation',
  onConfirm,
  onSaveAndExit,
  onExitWithoutSaving,
  onSaveAndContinue,
  onContinueWithoutSaving,
  isSubmitting = false,
  errorMessage = null,
}: NavigationBlockerDialogProps) => {
  const isExitMode = mode === 'exit';

  const title = 'You have unsaved changes.';

  const description = isExitMode
    ? 'Save before exiting, or exit without saving your latest edits.'
    : 'Save before leaving, or continue without saving your latest edits.';

  const handleSecondaryAction = isExitMode
    ? onExitWithoutSaving
    : (onContinueWithoutSaving ?? onConfirm);
  const handlePrimaryAction = isExitMode ? onSaveAndExit : onSaveAndContinue;
  const secondaryLabel = isExitMode
    ? 'Exit Without Saving'
    : 'Continue Without Saving';
  const primaryLabel = isExitMode ? 'Save & Exit' : 'Save & Continue';

  return (
    <AlertDialog open={isOpen} onOpenChange={(open) => !open && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
          {errorMessage && (
            <p className="text-sm font-medium text-destructive">
              {errorMessage}
            </p>
          )}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onCancel}>Cancel</AlertDialogCancel>
          <Button
            type="button"
            variant="destructive"
            onClick={handleSecondaryAction}
            disabled={isSubmitting}
          >
            {secondaryLabel}
          </Button>
          <Button
            type="button"
            onClick={handlePrimaryAction}
            disabled={isSubmitting || isSaving}
          >
            {isSubmitting || isSaving ? 'Saving...' : primaryLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};
