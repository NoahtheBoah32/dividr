/**
 * ExportButton Component (Updated with RenderProcessDialog)
 * A clean, focused button component for triggering video exports
 * All heavy logic is delegated to specialized hooks and utilities
 */
import { Button } from '@/frontend/components/ui/button';
import { useProjectStore } from '@/frontend/features/projects/store/projectStore';
import { cn } from '@/frontend/utils/utils';
import React, { useCallback, useState } from 'react';
import { useVideoEditorStore } from '../../editor/stores/videoEditor/index';
import { ExportModal } from '../../export/ExportModal';
import { RenderProcessDialog } from '../components/renderProcessDialog';
import { useExportHandler } from '../hooks/useExportHandler';
import { useExportJob } from '../hooks/useExportJob';

interface ExportButtonProps {
  className?: string;
  variant?:
    | 'default'
    | 'destructive'
    | 'outline'
    | 'secondary'
    | 'ghost'
    | 'link';
  disabled?: boolean;
}

const ExportButton: React.FC<ExportButtonProps> = ({
  className = '',
  variant = 'secondary',
  disabled = false,
}) => {
  const tracks = useVideoEditorStore((state) => state.tracks);
  const render = useVideoEditorStore((state) => state.render);
  const { currentProject } = useProjectStore();

  const [isExportModalOpen, setIsExportModalOpen] = useState<boolean>(false);

  // Use specialized hooks for heavy logic
  const { createFFmpegJob } = useExportJob();
  const {
    executeExport,
    isRenderDialogOpen,
    renderDialogState,
    renderError,
    outputFilePath,
    handleCancelRender,
    handleCloseDialog,
  } = useExportHandler();

  // Store last export config for retry functionality
  const [lastExportConfig, setLastExportConfig] = useState<{
    filename: string;
    format: string;
    outputPath: string;
  } | null>(null);

  // Handle opening the export modal
  const handleOpenModal = useCallback(() => {
    if (tracks.length === 0) {
      alert('No tracks to render');
      return;
    }
    setIsExportModalOpen(true);
  }, [tracks.length]);

  // Handle export confirmation from modal
  const handleExportConfirm = useCallback(
    async (config: {
      filename: string;
      format: string;
      outputPath: string;
    }) => {
      setIsExportModalOpen(false);

      if (tracks.length === 0) {
        alert('No tracks to render');
        return;
      }

      // Store config for potential retry
      setLastExportConfig(config);

      // Build the FFmpeg job
      const job = createFFmpegJob(config.filename, config.outputPath);

      // Execute the export (this will open the render dialog)
      await executeExport(job);
    },
    [tracks.length, createFFmpegJob, executeExport],
  );

  // Handle retry from failed state
  const handleRetry = useCallback(async () => {
    if (!lastExportConfig) return;

    const job = createFFmpegJob(
      lastExportConfig.filename,
      lastExportConfig.outputPath,
    );
    await executeExport(job);
  }, [lastExportConfig, createFFmpegJob, executeExport]);

  const isButtonDisabled =
    disabled || render.isRendering || tracks.length === 0;

  return (
    <>
      <Button
        variant={variant}
        onClick={handleOpenModal}
        disabled={isButtonDisabled}
        className={cn(className, 'rounded text-base font-bold w-[140px] h-9')}
        size="sm"
        data-export-button
      >
        {render.isRendering ? 'Exporting...' : 'Export'}
      </Button>

      <ExportModal
        isOpen={isExportModalOpen}
        onClose={() => setIsExportModalOpen(false)}
        onExport={handleExportConfirm}
        defaultFilename={
          currentProject?.metadata?.title?.trim() || 'Untitled_Project'
        }
      />

      <RenderProcessDialog
        isOpen={isRenderDialogOpen}
        state={renderDialogState}
        progress={render.progress}
        status={render.status}
        elapsedSeconds={render.metrics?.elapsedSeconds}
        etaState={render.metrics?.etaState || 'calculating'}
        etaSeconds={render.metrics?.etaSeconds}
        errorMessage={renderError}
        outputFilePath={outputFilePath}
        onCancel={handleCancelRender}
        onClose={handleCloseDialog}
        onRetry={lastExportConfig ? handleRetry : undefined}
      />
    </>
  );
};

export { ExportButton };
