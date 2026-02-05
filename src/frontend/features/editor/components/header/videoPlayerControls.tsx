import { Button } from '@/frontend/components/ui/button';
import { Separator } from '@/frontend/components/ui/separator';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/frontend/components/ui/tooltip';
import { useShortcutKeys } from '@/frontend/features/editor/shortcuts/shortcutHooks';
import {
  formatShortcutCombos,
  normalizeKeyList,
} from '@/frontend/features/editor/shortcuts/shortcutUtils';
import { cn } from '@/frontend/utils/utils';
import { Hand, MousePointer2, Redo2, Type, Undo2 } from 'lucide-react';
import React, { useCallback } from 'react';
import { useVideoEditorStore } from '../../stores/videoEditor';
import { ZoomControls } from './zoomControls';

interface VideoPlayerControlsProps {
  className?: string;
}

/**
 * VideoPlayerControls Component
 * Optimized to prevent re-renders during playback by using selective Zustand selectors
 * Only subscribes to the specific values needed, not entire state objects
 */
export const VideoPlayerControls = React.memo(
  ({ className }: VideoPlayerControlsProps) => {
    // Selective selectors - only subscribe to specific values
    // This prevents re-renders when other preview/playback properties change
    const previewScale = useVideoEditorStore(
      (state) => state.preview.previewScale,
    );
    const interactionMode = useVideoEditorStore(
      (state) => state.preview.interactionMode,
    );

    // Subscribe to undo/redo stack lengths for reactive button states
    const hasUndoHistory = useVideoEditorStore(
      (state) => state.undoStack.length > 0,
    );
    const hasRedoHistory = useVideoEditorStore(
      (state) => state.redoStack.length > 0,
    );

    // Only subscribe to the action functions (these are stable references)
    const setPreviewScale = useVideoEditorStore(
      (state) => state.setPreviewScale,
    );
    const setPreviewInteractionMode = useVideoEditorStore(
      (state) => state.setPreviewInteractionMode,
    );
    const undo = useVideoEditorStore((state) => state.undo);
    const redo = useVideoEditorStore((state) => state.redo);
    const selectionKeys = useShortcutKeys('preview-select-tool', ['v']);
    const handKeys = useShortcutKeys('preview-hand-tool', ['h']);
    const textEditKeys = useShortcutKeys('preview-text-edit-tool', ['t']);
    const undoKeys = useShortcutKeys('undo', ['ctrl+z', 'cmd+z']);
    const redoShiftKeys = useShortcutKeys('redo-shift', [
      'ctrl+shift+z',
      'cmd+shift+z',
    ]);
    const redoAltKeys = useShortcutKeys('redo-y', ['ctrl+y', 'cmd+y']);
    const redoKeys = normalizeKeyList([...redoShiftKeys, ...redoAltKeys]);
    const selectionShortcutText = formatShortcutCombos(selectionKeys);
    const handShortcutText = formatShortcutCombos(handKeys);
    const textEditShortcutText = formatShortcutCombos(textEditKeys);
    const undoShortcutText = formatShortcutCombos(undoKeys);
    const redoShortcutText = formatShortcutCombos(redoKeys);

    // Memoize handlers to prevent unnecessary re-renders of child components
    const handleZoomChange = useCallback(
      (zoomPercent: number) => {
        // Convert percentage (10-800) to scale (0.1-8)
        const scale = zoomPercent / 100;
        setPreviewScale(scale);
      },
      [setPreviewScale],
    );

    const handleSelectMode = useCallback(() => {
      setPreviewInteractionMode('select');
    }, [setPreviewInteractionMode]);

    const handlePanMode = useCallback(() => {
      // Only allow pan mode if zoomed in
      if (previewScale > 1) {
        setPreviewInteractionMode('pan');
      }
    }, [previewScale, setPreviewInteractionMode]);

    const handleTextEditMode = useCallback(() => {
      // Toggle text edit mode - if already in text edit mode, switch back to select mode
      if (interactionMode === 'text-edit') {
        setPreviewInteractionMode('select');
      } else {
        setPreviewInteractionMode('text-edit');
      }
    }, [interactionMode, setPreviewInteractionMode]);

    const isSelectActive = interactionMode === 'select';
    const isPanActive = interactionMode === 'pan';
    const isTextEditActive = interactionMode === 'text-edit';
    const isPanDisabled = previewScale <= 1;

    const handleUndo = useCallback(() => {
      if (hasUndoHistory) {
        undo();
      }
    }, [undo, hasUndoHistory]);

    const handleRedo = useCallback(() => {
      if (hasRedoHistory) {
        redo();
      }
    }, [redo, hasRedoHistory]);

    return (
      <div className={cn('flex items-center h-full gap-3', className)}>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="native"
              size="icon"
              onClick={handleSelectMode}
              className={cn(
                'transition-colors !p-1.5',
                isSelectActive && 'bg-accent',
              )}
            >
              <MousePointer2 />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {selectionShortcutText
              ? `Selection Tool (${selectionShortcutText})`
              : 'Selection Tool'}
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="native"
              size="icon"
              onClick={handlePanMode}
              disabled={isPanDisabled}
              className={cn(
                'transition-colors !p-1.5',
                isPanActive && !isPanDisabled && 'bg-accent',
                isPanDisabled && 'opacity-40 cursor-not-allowed',
              )}
            >
              <Hand />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {isPanDisabled
              ? `Hand Tool (Zoom in to enable)${
                  handShortcutText ? ` (${handShortcutText})` : ''
                }`
              : `Hand Tool - Pan around zoomed preview${
                  handShortcutText ? ` (${handShortcutText})` : ''
                }`}
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="native"
              size="icon"
              onClick={handleTextEditMode}
              className={cn(
                'transition-colors !p-1.5',
                isTextEditActive && 'bg-accent',
              )}
            >
              <Type />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            Text Edit Mode - Click text to edit inline
            {textEditShortcutText ? ` (${textEditShortcutText})` : ''}
          </TooltipContent>
        </Tooltip>
        <ZoomControls
          zoom={previewScale * 100}
          onZoomChange={handleZoomChange}
        />
        <Separator orientation="vertical" className="!h-3/4" />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="native"
              size="icon"
              onClick={handleUndo}
              disabled={!hasUndoHistory}
              className={cn(
                'transition-colors !p-1.5',
                !hasUndoHistory && 'opacity-40',
              )}
            >
              <Undo2 />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {undoShortcutText ? `Undo (${undoShortcutText})` : 'Undo'}
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="native"
              size="icon"
              onClick={handleRedo}
              disabled={!hasRedoHistory}
              className={cn(
                'transition-colors !p-1.5',
                !hasRedoHistory && 'opacity-40',
              )}
            >
              <Redo2 />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {redoShortcutText ? `Redo (${redoShortcutText})` : 'Redo'}
          </TooltipContent>
        </Tooltip>
      </div>
    );
  },
);

// Add display name for better debugging
VideoPlayerControls.displayName = 'VideoPlayerControls';
