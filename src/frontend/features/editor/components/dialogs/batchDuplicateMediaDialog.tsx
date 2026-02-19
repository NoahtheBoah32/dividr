import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/frontend/components/ui/alert-dialog';
import { buttonVariants } from '@/frontend/components/ui/button';
import { ScrollArea } from '@/frontend/components/ui/scroll-area';
import { cn } from '@/frontend/utils/utils';
import { AlertTriangle, FileCheck } from 'lucide-react';
import React, { useCallback, useMemo, useState } from 'react';
import {
  DuplicateChoice,
  DuplicateItem,
} from '../../stores/videoEditor/slices/mediaLibrarySlice';

interface DuplicateMediaDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  duplicates: DuplicateItem[];
  onConfirm: (choices: Map<string, DuplicateChoice>) => void;
}

export const DuplicateMediaDialog: React.FC<DuplicateMediaDialogProps> = ({
  open,
  onOpenChange,
  duplicates,
  onConfirm,
}) => {
  // Checked = keep both (import-copy), Unchecked = skip (use-existing)
  const [keepItems, setKeepItems] = useState<Set<string>>(new Set());

  // Toggle a single item
  const handleToggleItem = useCallback((id: string) => {
    setKeepItems((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(id)) {
        newSet.delete(id);
      } else {
        newSet.add(id);
      }
      return newSet;
    });
  }, []);

  // Select/deselect all
  const handleSelectAll = useCallback(() => {
    const newSet = new Set<string>();
    duplicates.forEach((dup) => {
      newSet.add(dup.id);
    });
    setKeepItems(newSet);
  }, [duplicates]);

  const handleDeselectAll = useCallback(() => {
    setKeepItems(new Set());
  }, []);

  // Check states for bulk actions
  const allSelected = useMemo(() => {
    return duplicates.length > 0 && keepItems.size === duplicates.length;
  }, [duplicates, keepItems]);

  const noneSelected = useMemo(() => {
    return keepItems.size === 0;
  }, [keepItems]);

  // Build final choices map
  const handleConfirm = useCallback(() => {
    const finalChoices = new Map<string, DuplicateChoice>();
    duplicates.forEach((dup) => {
      // Checked = keep both (import-copy), Unchecked = skip (use-existing)
      finalChoices.set(
        dup.id,
        keepItems.has(dup.id) ? 'import-copy' : 'use-existing',
      );
    });
    onConfirm(finalChoices);
    setKeepItems(new Set());
  }, [duplicates, keepItems, onConfirm]);

  // Reset state when dialog opens
  React.useEffect(() => {
    if (open) {
      setKeepItems(new Set());
    }
  }, [open, duplicates]);

  const isSingleDuplicate = duplicates.length === 1;
  const singleDuplicate = isSingleDuplicate ? duplicates[0] : null;

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent
        className={cn(
          'flex flex-col max-h-[80vh]',
          isSingleDuplicate ? 'max-w-md' : 'max-w-2xl',
        )}
      >
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            {isSingleDuplicate
              ? 'Duplicate Detected'
              : `${duplicates.length} Duplicates Detected`}
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="rounded-md bg-amber-600/10 p-3 flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400" />
              <p className="text-foreground">
                {isSingleDuplicate
                  ? 'This file already exists in your media library.'
                  : 'These files already exist in your media library.'}
              </p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>

        {/* Duplicate list */}
        <div className="flex-1 min-h-0 grid min-w-0">
          {duplicates.length > 1 && (
            <div className="flex items-center justify-between pb-2 mb-2 border-b">
              <span className="text-xs text-muted-foreground">
                Check to keep both, uncheck to skip
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleSelectAll}
                  className={cn(
                    'text-xs px-2 py-1 rounded transition-colors',
                    allSelected
                      ? 'text-secondary bg-secondary/10'
                      : 'text-primary hover:bg-primary/10',
                  )}
                  disabled={allSelected}
                  tabIndex={0}
                  aria-label="Keep both for all duplicates"
                >
                  Keep All
                </button>
                <span className="text-muted-foreground">|</span>
                <button
                  type="button"
                  onClick={handleDeselectAll}
                  className={cn(
                    'text-xs px-2 py-1 rounded transition-colors',
                    noneSelected
                      ? 'text-amber-600 dark:text-amber-400 bg-amber-600/10'
                      : 'text-primary hover:bg-primary/10',
                  )}
                  disabled={noneSelected}
                  tabIndex={0}
                  aria-label="Skip all duplicates"
                >
                  Skip All
                </button>
              </div>
            </div>
          )}

          <ScrollArea
            className={cn(
              '-mx-6 px-6 flex-1 grid min-w-0',
              duplicates.length > 1 ? 'max-h-[40vh]' : '',
            )}
          >
            <div className="space-y-2 grid flex-1 min-w-0 py-1">
              {duplicates.map((dup) => {
                const isChecked = keepItems.has(dup.id);
                return (
                  <label
                    key={dup.id}
                    htmlFor={`dup-${dup.id}`}
                    className={cn(
                      'flex items-center gap-3 p-3 min-w-0 flex-1 rounded-md transition-colors cursor-pointer',
                      isChecked
                        ? 'bg-secondary/5'
                        : 'bg-muted/30 hover:bg-muted/50',
                    )}
                    onClick={() => handleToggleItem(dup.id)}
                  >
                    {/* Thumbnail */}
                    {dup.existingMedia.thumbnail ? (
                      <img
                        src={dup.existingMedia.thumbnail}
                        alt={dup.existingMedia.name}
                        className="w-12 h-9 object-cover rounded flex-shrink-0"
                      />
                    ) : (
                      <div className="w-12 h-9 bg-muted rounded flex items-center justify-center flex-shrink-0">
                        <FileCheck className="h-4 w-4 text-muted-foreground" />
                      </div>
                    )}

                    {/* File info */}
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">
                        {dup.pendingFileName}
                      </p>
                      <p className="text-xs text-muted-foreground truncate">
                        Matches: {dup.existingMedia.name}
                      </p>
                    </div>

                    {/* Status badge */}
                    <span
                      className={cn(
                        'text-xs px-2 py-0.5 rounded-full flex-shrink-0',
                        isChecked
                          ? 'bg-secondary/20 text-secondary'
                          : 'bg-amber-600/10 text-amber-600 dark:text-amber-400',
                      )}
                    >
                      {isChecked ? 'Keep Both' : 'Skip'}
                    </span>
                  </label>
                );
              })}
            </div>
          </ScrollArea>
        </div>

        {/* Summary for multiple items */}
        {duplicates.length > 1 && (
          <div className="flex items-center gap-2 pt-2 border-t text-xs text-muted-foreground">
            <span>
              <span className="text-secondary font-medium">
                {keepItems.size}
              </span>{' '}
              to keep both
            </span>
            <span className="text-border">|</span>
            <span>
              <span className="text-amber-600 dark:text-amber-400 font-medium">
                {duplicates.length - keepItems.size}
              </span>{' '}
              to skip
            </span>
          </div>
        )}

        <AlertDialogFooter>
          {isSingleDuplicate && singleDuplicate ? (
            <>
              <AlertDialogAction
                onClick={() => {
                  // Skip
                  const choices = new Map<string, DuplicateChoice>();
                  choices.set(singleDuplicate.id, 'use-existing');
                  onConfirm(choices);
                  setKeepItems(new Set());
                }}
                className={cn(
                  buttonVariants({ variant: 'outline' }),
                  'text-muted-foreground',
                )}
              >
                Skip
              </AlertDialogAction>
              <AlertDialogAction
                onClick={() => {
                  // Keep Both
                  const choices = new Map<string, DuplicateChoice>();
                  choices.set(singleDuplicate.id, 'import-copy');
                  onConfirm(choices);
                  setKeepItems(new Set());
                }}
              >
                Keep Both
              </AlertDialogAction>
            </>
          ) : (
            <AlertDialogAction onClick={handleConfirm}>
              Confirm
            </AlertDialogAction>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};

// Re-export for backward compatibility
export { DuplicateMediaDialog as BatchDuplicateMediaDialog };
