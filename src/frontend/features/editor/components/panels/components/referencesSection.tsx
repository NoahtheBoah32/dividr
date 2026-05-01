import { cn } from '@/frontend/utils/utils';
import { ChevronDown, ChevronRight, Film } from 'lucide-react';
import React, { useCallback, useRef, useState } from 'react';
import {
  importMediaFromDialogUnified,
  importMediaUnified,
} from '../../../services/mediaImportService';
import { useVideoEditorStore } from '../../../stores/videoEditor/index';
import { MediaLibraryItem } from '../../../stores/videoEditor/types';

function ReferenceCard({
  item,
  onRemove,
}: {
  item: MediaLibraryItem;
  onRemove: (id: string) => void;
}) {
  return (
    <div className="relative rounded-md overflow-hidden border border-white/[0.08] bg-white/[0.02] group cursor-default">
      <div className="aspect-video w-full bg-zinc-900 flex items-center justify-center overflow-hidden">
        {item.thumbnail ? (
          <img src={item.thumbnail} className="w-full h-full object-cover" />
        ) : (
          <Film className="size-5 text-zinc-600" />
        )}
      </div>
      <div className="px-2 py-1.5">
        <p className="text-[11px] text-zinc-300 truncate">{item.name}</p>
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

export function ReferencesSection() {
  const [expanded, setExpanded] = useState(false);
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

  const handleImportReference = useCallback(
    async (e?: React.MouseEvent) => {
      e?.stopPropagation();
      const beforeIds = new Set(
        useVideoEditorStore.getState().mediaLibrary.map((i) => i.id),
      );
      await importMediaFromDialogUnified(
        importMediaFromDialog,
        { importMediaFromDrop, importMediaToTimeline, addTrackFromMediaLibrary },
        { addToTimeline: false, showToasts: true },
      );
      tagNewItems(beforeIds);
    },
    [
      importMediaFromDialog,
      importMediaFromDrop,
      importMediaToTimeline,
      addTrackFromMediaLibrary,
      tagNewItems,
    ],
  );

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
      setExpanded(true);
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
    if (e.dataTransfer.types.includes('Files')) {
      setDragActive(true);
      setExpanded(true);
    }
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
    <div
      className={cn(
        'rounded-md border border-white/[0.06] transition-colors',
        dragActive && 'border-accent/40 bg-accent/[0.03]',
      )}
      onDragEnter={handleDragIn}
      onDragLeave={handleDragOut}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {/* Header — always visible, acts as the toggle */}
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-white/[0.02] rounded-md transition-colors"
      >
        <Film className="size-3 text-accent flex-shrink-0" />
        <span className="text-xs font-medium text-foreground">References</span>
        {referenceItems.length > 0 && (
          <span className="text-[10px] text-zinc-600 bg-white/[0.04] px-1.5 rounded">
            {referenceItems.length}
          </span>
        )}
        <span className="text-[10px] text-zinc-600 flex-1">
          — style sources for EDITH
        </span>
        {expanded ? (
          <ChevronDown className="size-3 text-zinc-600 flex-shrink-0" />
        ) : (
          <ChevronRight className="size-3 text-zinc-600 flex-shrink-0" />
        )}
      </button>

      {/* Body — only visible when expanded */}
      {expanded && (
        <div className="px-3 pb-3">
          {referenceItems.length === 0 ? (
            <div
              className={cn(
                'rounded border border-dashed border-white/[0.08] py-4 px-3 text-center transition-colors',
                dragActive && 'border-accent/50 bg-accent/5',
              )}
            >
              <p className="text-[11px] text-zinc-500 mb-2">
                Drop a Reel so EDITH can match its pacing and cuts.
              </p>
              <button
                onClick={(e) => handleImportReference(e)}
                className="text-[11px] text-zinc-400 hover:text-zinc-200 border border-white/10 hover:border-white/20 rounded px-3 py-1 transition-colors"
              >
                Upload reference
              </button>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <div className="grid grid-cols-2 gap-2">
                {referenceItems.map((item) => (
                  <ReferenceCard
                    key={item.id}
                    item={item}
                    onRemove={(id) => removeFromMediaLibrary(id, true)}
                  />
                ))}
              </div>
              <button
                onClick={(e) => handleImportReference(e)}
                className="w-full text-[11px] text-zinc-600 hover:text-zinc-300 border border-dashed border-white/[0.06] hover:border-white/20 rounded py-1.5 transition-colors"
              >
                + Add reference
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function ReferencesTabContent() {
  return <ReferencesSection />;
}
