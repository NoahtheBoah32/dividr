import { cn } from '@/frontend/utils/utils';
import { Film, Sparkles } from 'lucide-react';
import React, { useCallback, useRef, useState } from 'react';
import {
  importMediaFromDialogUnified,
  importMediaUnified,
} from '../../../services/mediaImportService';
import { useVideoEditorStore } from '../../../stores/videoEditor/index';
import { MediaLibraryItem } from '../../../stores/videoEditor/types';
import { BasePanel } from '../basePanel';
import { CustomPanelProps } from '../panelRegistry';

function ReferenceCard({
  item,
  onRemove,
}: {
  item: MediaLibraryItem;
  onRemove: (id: string) => void;
}) {
  const analyzed = !!item.referenceAnalysis;

  return (
    <div className="relative rounded-md overflow-hidden border border-white/[0.08] bg-white/[0.02] group cursor-default">
      <div className="aspect-video w-full bg-zinc-900 flex items-center justify-center overflow-hidden">
        {item.thumbnail ? (
          <img src={item.thumbnail} className="w-full h-full object-cover" />
        ) : (
          <Film className="size-5 text-zinc-600" />
        )}
      </div>
      <div className="px-2 py-1.5 flex items-center gap-1">
        <p className="text-[11px] text-zinc-300 truncate flex-1">{item.name}</p>
        {analyzed && (
          <Sparkles className="size-3 text-accent flex-shrink-0" title="Style analyzed" />
        )}
      </div>
      <button
        onClick={() => onRemove(item.id)}
        className="absolute top-1 right-1 w-4 h-4 rounded-full bg-black/70 text-zinc-500 hover:text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity text-xs leading-none"
      >
        ×
      </button>
    </div>
  );
}

export const ReferencesPanel: React.FC<CustomPanelProps> = ({ className }) => {
  const [dragActive, setDragActive] = useState(false);
  const dragCounter = useRef(0);

  const mediaLibrary = useVideoEditorStore((state) => state.mediaLibrary);
  const importMediaFromDialog = useVideoEditorStore(
    (state) => state.importMediaFromDialog,
  );
  const importMediaFromDrop = useVideoEditorStore(
    (state) => state.importMediaFromDrop,
  );
  const importMediaToTimeline = useVideoEditorStore(
    (state) => state.importMediaToTimeline,
  );
  const addTrackFromMediaLibrary = useVideoEditorStore(
    (state) => state.addTrackFromMediaLibrary,
  );
  const updateMediaLibraryItem = useVideoEditorStore(
    (state) => state.updateMediaLibraryItem,
  );
  const removeFromMediaLibrary = useVideoEditorStore(
    (state) => state.removeFromMediaLibrary,
  );

  const referenceItems = mediaLibrary.filter(
    (item) => item.category === 'reference',
  );

  const tagNewItems = useCallback(
    (beforeIds: Set<string>) => {
      const after = useVideoEditorStore.getState().mediaLibrary;
      after
        .filter((i) => !beforeIds.has(i.id))
        .forEach((i) =>
          updateMediaLibraryItem(i.id, { category: 'reference' }),
        );
    },
    [updateMediaLibraryItem],
  );

  const handleImportReference = useCallback(async () => {
    const beforeIds = new Set(
      useVideoEditorStore.getState().mediaLibrary.map((i) => i.id),
    );
    await importMediaFromDialogUnified(
      importMediaFromDialog,
      { importMediaFromDrop, importMediaToTimeline, addTrackFromMediaLibrary },
      { addToTimeline: false, showToasts: true },
    );
    tagNewItems(beforeIds);
  }, [
    importMediaFromDialog,
    importMediaFromDrop,
    importMediaToTimeline,
    addTrackFromMediaLibrary,
    tagNewItems,
  ]);

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      dragCounter.current = 0;
      setDragActive(false);
      if (!e.dataTransfer.files || e.dataTransfer.files.length === 0) return;
      const files = Array.from(e.dataTransfer.files);
      const beforeIds = new Set(
        useVideoEditorStore.getState().mediaLibrary.map((i) => i.id),
      );
      await importMediaUnified(
        files,
        'library-drop',
        { importMediaFromDrop, importMediaToTimeline, addTrackFromMediaLibrary },
        { addToTimeline: false, showToasts: true },
      );
      tagNewItems(beforeIds);
    },
    [
      importMediaFromDrop,
      importMediaToTimeline,
      addTrackFromMediaLibrary,
      tagNewItems,
    ],
  );

  const handleDragIn = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current++;
    if (e.dataTransfer.types.includes('Files')) setDragActive(true);
  }, []);

  const handleDragOut = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current--;
    if (dragCounter.current === 0) setDragActive(false);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  return (
    <>
      <BasePanel
        title="References"
        description="Style sources for EDITH"
        className={className}
      >
        <div
          className="flex flex-col flex-1 min-h-0 gap-3"
          onDragEnter={handleDragIn}
          onDragLeave={handleDragOut}
          onDragOver={handleDragOver}
          onDrop={handleDrop}
        >
          <button
            onClick={handleImportReference}
            className="w-full bg-accent text-accent-foreground hover:bg-accent/80 font-normal text-sm rounded py-2 transition-colors flex items-center justify-center gap-2"
          >
            Add reference
            <Film className="size-4" />
          </button>

          {referenceItems.length === 0 ? (
            <div
              className={cn(
                'flex-1 flex flex-col items-center justify-center rounded-lg border border-dashed border-white/[0.08] py-8 px-4 text-center transition-colors',
                dragActive && 'border-accent/50 bg-accent/5',
              )}
            >
              <Film className="size-7 text-zinc-700 mb-3" />
              <p className="text-xs text-zinc-300 mb-1">No references yet</p>
              <p className="text-[11px] text-zinc-600 leading-relaxed max-w-[180px]">
                Upload a Reel so EDITH can match its pacing, cuts, and captions.
              </p>
            </div>
          ) : (
            <div className="flex-1 overflow-y-auto">
              <div className="grid grid-cols-2 gap-3">
                {referenceItems.map((item) => (
                  <ReferenceCard
                    key={item.id}
                    item={item}
                    onRemove={(id) => removeFromMediaLibrary(id, true)}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      </BasePanel>
    </>
  );
};
