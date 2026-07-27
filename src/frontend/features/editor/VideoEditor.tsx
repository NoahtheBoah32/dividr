import { cn } from '@/frontend/utils/utils';
import React, { useCallback } from 'react';
import { PropertiesPanel } from './components/properties-panel';
import { VideoPreviewWrapper } from './preview/VideoPreviewWrapper';
import { useVideoEditorStore } from './stores/videoEditor/index';
import { EdithLiveTracker } from '@/frontend/features/mycelium/components/EdithLiveTracker';
import { EdithCursor } from '@/frontend/features/mycelium/components/EdithCursor';

import { NavigationBlockerDialog } from '@/frontend/components/custom/NavigationAlertDialog';
import { useTranscodeListener } from '@/frontend/hooks/useTranscodeListener';
import { useUnsavedChangesWarning } from '@/frontend/hooks/useUnsavedChangesWarning';

interface VideoEditorProps {
  className?: string;
}

const VideoEditor: React.FC<VideoEditorProps> = ({ className }) => {
  // Narrow selectors, deliberately. Subscribing to the whole store re-rendered
  // this component — the editor ROOT, and therefore the entire tree — on every
  // playhead tick during playback. Measured with a CPU profile, that put 65% of
  // the main thread into React rendering and held the preview canvas to 13-40
  // repaints a second, which is the judder a speed ramp cannot hide.
  const importMediaFromFiles = useVideoEditorStore(
    (s) => s.importMediaFromFiles,
  );
  const isSaving = useVideoEditorStore((s) => s.isSaving);
  const hasSelectedTracks = useVideoEditorStore(
    (s) => s.timeline.selectedTrackIds.length > 0,
  );
  const { blocker } = useUnsavedChangesWarning();

  // Listen for transcode progress and completion events
  useTranscodeListener();

  // Legacy file import for drag & drop (will show warning)
  const handleFileImport = useCallback(
    (files: FileList) => {
      const fileArray = Array.from(files);
      importMediaFromFiles(fileArray);
    },
    [importMediaFromFiles],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      if (e.dataTransfer.files) {
        handleFileImport(e.dataTransfer.files);
      }
    },
    [handleFileImport],
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
  }, []);

  return (
    <>
      <div className="flex flex-1">
        <div
          className={cn('flex flex-col flex-1 bg-accent', className)}
          onDrop={handleDrop}
          onDragOver={handleDragOver}
        >
          <div className="relative flex flex-1 items-center justify-center overflow-hidden">
            {/* Video Preview */}
            <VideoPreviewWrapper
              className="flex-1 w-full h-full max-w-full max-h-full"
              useDirectOptimization={true}
            />
            {/* EDITH live op feed — ghost editor overlay */}
            <EdithLiveTracker />
            {/* EDITH cursor navigation overlay */}
            <EdithCursor />
          </div>
        </div>
        {/* Properties Panel - Dynamically renders based on selected track type */}
        {hasSelectedTracks && <PropertiesPanel className="" />}
      </div>

      <NavigationBlockerDialog
        isOpen={blocker.state === 'blocked'}
        onConfirm={() => blocker.proceed?.()}
        onCancel={() => blocker.reset?.()}
        isSaving={isSaving}
      />
    </>
  );
};

export default VideoEditor;
