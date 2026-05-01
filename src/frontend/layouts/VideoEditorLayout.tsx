import { AppMenuBar } from '@/frontend/components/custom/AppMenuBar';
import { ProjectGuard } from '@/frontend/features/editor/components/projectGuard';
import { VideoEditorHeader } from '@/frontend/features/editor/components/videoEditorHeader';
import { FullscreenPreview } from '@/frontend/features/editor/preview/FullscreenPreview';
import { ToolsPanel } from '@/frontend/features/editor/preview/ToolsPanel';
import { useIsPanelVisible } from '@/frontend/features/editor/stores/PanelStore';
import { useVideoEditorStore } from '@/frontend/features/editor/stores/videoEditor';
import React, { useCallback, useRef, useState } from 'react';
import { Outlet } from 'react-router-dom';
import { Timeline } from '../features/editor/timeline/timeline';
import Toolbar from '../features/editor/Toolbar';
import TitleBar from './Titlebar';

const VideoEditorLayoutComponent = () => {
  const isPanelVisible = useIsPanelVisible();
  const [panelWidth, setPanelWidth] = useState(320);
  const [timelineHeight, setTimelineHeight] = useState(220);
  const startXRef = useRef(0);
  const startYRef = useRef(0);
  const startWidthRef = useRef(320);
  const startHeightRef = useRef(220);
  const isDraggingRef = useRef(false);

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    isDraggingRef.current = true;
    startXRef.current = e.clientX;
    startWidthRef.current = panelWidth;

    const onMove = (ev: MouseEvent) => {
      if (!isDraggingRef.current) return;
      const delta = ev.clientX - startXRef.current;
      setPanelWidth(Math.max(240, Math.min(800, startWidthRef.current + delta)));
    };
    const onUp = () => {
      isDraggingRef.current = false;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [panelWidth]);

  const handleTimelineResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    isDraggingRef.current = true;
    startYRef.current = e.clientY;
    startHeightRef.current = timelineHeight;

    const onMove = (ev: MouseEvent) => {
      if (!isDraggingRef.current) return;
      const delta = startYRef.current - ev.clientY;
      setTimelineHeight(Math.max(160, Math.min(520, startHeightRef.current + delta)));
    };
    const onUp = () => {
      isDraggingRef.current = false;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [timelineHeight]);

  const previewInteractionMode = useVideoEditorStore(
    (state) => state.preview.interactionMode,
  );
  const setPreviewInteractionMode = useVideoEditorStore(
    (state) => state.setPreviewInteractionMode,
  );

  // Reset preview interaction mode when clicking outside the preview canvas
  // This ensures preview cursor modes (text-edit, pan) are scoped to the preview only
  const handleLayoutClick = useCallback(
    (e: React.MouseEvent) => {
      // Only reset if we're in a non-select mode
      if (previewInteractionMode === 'select') return;

      // Check if the click target is within the preview canvas area
      const target = e.target as HTMLElement;
      const isInsidePreviewCanvas =
        target.closest('[data-preview-canvas]') !== null ||
        target.closest('.video-preview-container') !== null ||
        target.closest('.preview-canvas-area') !== null;

      // If clicking outside the preview canvas, reset to select mode
      if (!isInsidePreviewCanvas) {
        setPreviewInteractionMode('select');
      }
    },
    [previewInteractionMode, setPreviewInteractionMode],
  );

  return (
    <ProjectGuard>
      <div
        className="h-screen flex flex-col text-foreground bg-background p-4"
        onMouseDown={handleLayoutClick}
      >
        <TitleBar className="relative z-10 -mx-4 px-4 -mt-4 py-2" />

        <div className="border-b border-border/50 -mx-4 px-4 my-[1.5px]" />

        {/* Header row: menu + editor controls */}
        <div className="grid grid-cols-[auto_1fr] flex-shrink-0" style={{ height: '55px' }}>
          <AppMenuBar />
          <VideoEditorHeader />
        </div>

        {/* Content row: sidebar + main — fills remaining space above timeline */}
        <div className="flex flex-row flex-1 min-h-0 overflow-hidden">
          {/* Left sidebar with toolbar and tools panel */}
          <div className="flex min-h-0 gap-2">
            <Toolbar />
            {isPanelVisible && (
              <>
                <div
                  className="grid overflow-hidden flex-shrink-0 h-full"
                  style={{ width: panelWidth }}
                >
                  <ToolsPanel className="h-full" />
                </div>
                {/* Horizontal resize handle */}
                <div
                  className="w-1 self-stretch cursor-col-resize hover:bg-accent/40 active:bg-accent/60 transition-colors flex-shrink-0 rounded-full"
                  onMouseDown={handleResizeStart}
                />
              </>
            )}
          </div>

          {/* Main content area */}
          <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
            <main className="flex-1 flex overflow-auto">
              <Outlet />
            </main>
          </div>
        </div>

        {/* Vertical resize handle */}
        <div
          className="cursor-row-resize hover:bg-accent/40 active:bg-accent/60 transition-colors flex-shrink-0 -mx-4"
          style={{ height: '4px' }}
          onMouseDown={handleTimelineResizeStart}
        />

        {/* Timeline — fixed height, shrinks/grows via drag */}
        <div
          className="-mx-4 -mb-4 overflow-hidden flex-shrink-0"
          style={{ height: timelineHeight }}
        >
          <Timeline />
        </div>

        {/* Fullscreen Preview Overlay */}
        <FullscreenPreview />
      </div>
    </ProjectGuard>
  );
};

VideoEditorLayoutComponent.displayName = 'VideoEditorLayout';

// Memoize layout to prevent unnecessary re-renders
const VideoEditorLayout = React.memo(VideoEditorLayoutComponent);

export default VideoEditorLayout;
