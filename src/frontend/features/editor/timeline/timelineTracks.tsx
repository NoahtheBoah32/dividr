/* eslint-disable @typescript-eslint/no-unused-vars */
import { Skeleton } from '@/frontend/components/ui/skeleton';
import { Slider } from '@/frontend/components/ui/slider';
import { cn } from '@/frontend/utils/utils';
import { Film } from 'lucide-react';
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { KaraokeConfirmationDialog } from '../components/dialogs/karaokeConfirmationDialog';
import {
  importMediaFromDialogUnified,
  importMediaUnified,
} from '../services/mediaImportService';
import { useVideoEditorStore, VideoTrack } from '../stores/videoEditor/index';
import { getDisplayFps } from '../stores/videoEditor/types/timeline.types';
import { toast } from 'sonner';
import { AudioWaveform } from './audioWaveform';
import { ImageTrackStrip } from './imageTrackStrip';
import { TrackContextMenu } from './trackContextMenu';
import {
  checkSnapPosition,
  findAllSnapPoints,
} from './utils/collisionDetection';
import {
  calculateRowBoundsWithPlaceholders,
  detectInsertionPoint,
  generateDynamicRows,
  getNextAvailableRowIndex,
  getTrackRowId,
  migrateTracksWithRowIndex,
  parseRowId,
  TrackRowDefinition,
} from './utils/dynamicTrackRows';
import {
  getRowHeight,
  getRowHeightClasses,
  getTrackItemHeight,
  getTrackItemHeightClasses,
  SPRITE_SHEET_SKIP_DURATION_SECONDS,
} from './utils/timelineConstants';
import { VideoSpriteSheetStrip } from './videoSpriteSheetStrip';

const DRAG_ACTIVATION_THRESHOLD = 5;

/**
 * Calculate grid interval that matches the ruler's tick interval exactly.
 * This ensures grid lines align with the ruler ticks.
 * Uses the same logic as timelineRuler.tsx tickInterval calculation.
 */
const getGridInterval = (frameWidth: number, fps: number): number => {
  const pixelsPerSecond = frameWidth * fps;

  // MUST match timelineRuler.tsx tickInterval logic exactly
  if (pixelsPerSecond >= 200) return 1; // Per-frame ticks
  if (pixelsPerSecond >= 100) return fps / 4; // 0.25 second intervals
  if (pixelsPerSecond >= 50) return fps / 2; // 0.5 second intervals
  if (pixelsPerSecond >= 25) return fps; // 1 second intervals
  if (pixelsPerSecond >= 10) return fps * 2; // 2 second intervals
  if (pixelsPerSecond >= 5) return fps * 5; // 5 second intervals
  if (pixelsPerSecond >= 2) return fps * 10; // 10 second intervals
  if (pixelsPerSecond >= 1) return fps * 30; // 30 second intervals
  return fps * 60; // 1 minute intervals
};

type MediaDragPayload = {
  mediaId: string;
  mediaIds?: string[]; // Support for multiple media items (future multi-selection)
  type?: VideoTrack['type'];
  duration?: number;
  mimeType?: string;
  thumbnail?: string;
  waveform?: string;
};

const parseMediaDragPayload = (
  dataTransfer: DataTransfer,
): MediaDragPayload | null => {
  const jsonPayload = dataTransfer.getData('application/json');
  if (jsonPayload) {
    try {
      const parsed = JSON.parse(jsonPayload);
      // Support both single mediaId and array of mediaIds
      if (parsed?.mediaId || parsed?.mediaIds) {
        return {
          ...parsed,
          // Ensure mediaId is always set (use first from array if only array provided)
          mediaId: parsed.mediaId || parsed.mediaIds?.[0],
        };
      }
    } catch (error) {
      console.warn('Failed to parse drag payload', error);
    }
  }

  const mediaId = dataTransfer.getData('text/plain');
  if (mediaId) {
    return { mediaId };
  }

  return null;
};

interface TimelineTracksProps {
  tracks: VideoTrack[];
  frameWidth: number;
  timelineWidth: number;
  scrollX: number;
  zoomLevel: number;
  selectedTrackIds: string[];
  onTrackSelect: (trackIds: string[]) => void;
  isSplitModeActive: boolean;
}

interface TrackItemProps {
  track: VideoTrack;
  frameWidth: number;
  zoomLevel: number;
  isSelected: boolean;
  onSelect: (multiSelect?: boolean) => void;
  onMove: (newStartFrame: number) => void;
  onResize: (newStartFrame?: number, newEndFrame?: number) => void;
  isSplitModeActive: boolean;
}

// Amber #FFB800 (HSL) — DiviDr's PiP accent. In-palette, distinct from the green selection.
const CHAPTER_HSL = '43 100% 50%';

const fmtChapterTime = (s: number) =>
  `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/**
 * Chapter strip pinned to the top of a video clip: amber segments with a left divider and
 * a "timestamp · title" label per chapter, with clean video below. The clip is never split —
 * positions are derived from each chapter's source timestamp against the track's trim window,
 * so the strip moves and trims with the clip. Chapters resolve from the track, falling back to
 * the matching media-library item so the strip shows even if the track copy was missed.
 */
const ChapterMarkers: React.FC<{ track: VideoTrack; width: number }> = React.memo(
  ({ track, width }) => {
    const showChapters = useVideoEditorStore((s) => s.timeline.showChapters);
    const timelineFps = useVideoEditorStore((s) => s.timeline.fps);
    const mediaLibrary = useVideoEditorStore((s) => s.mediaLibrary);

    if (track.type !== 'video' || showChapters === false) return null;

    let chapters = (track as any).chapters as
      | Array<{ start: number; title: string }>
      | undefined;
    if (!chapters?.length) {
      const m = (mediaLibrary as any[] | undefined)?.find(
        (mi) => mi.source === track.source || (track.mediaId && mi.id === track.mediaId),
      );
      chapters = m?.chapters;
    }
    if (!chapters?.length) return null;

    // Frames may be in the source-fps domain (drag-drop import sets sourceFps) or the
    // timeline-fps domain (EDITH insertClip leaves sourceFps unset). Pick the matching fps
    // so source-second chapter timestamps map to the correct on-screen fraction.
    const fps = track.sourceFps || timelineFps || 30;
    const clipDurSec = Math.max(0.001, (track.endFrame - track.startFrame) / fps);
    const srcStart = track.sourceStartTime ?? 0;

    const marks = chapters
      .map((c) => ({ title: c.title, start: c.start, frac: (c.start - srcStart) / clipDurSec }))
      .filter((c) => c.frac < 0.999)
      .map((c) => ({ ...c, frac: Math.max(0, c.frac) }));
    if (!marks.length) return null;

    const clipH = getTrackItemHeight(track.type);
    const bandH = Math.max(13, Math.min(20, Math.round(clipH * 0.45)));

    return (
      <div
        className="absolute left-0 right-0 top-0 pointer-events-none"
        style={{ height: bandH, zIndex: 8, borderBottom: `1px solid hsl(${CHAPTER_HSL} / 0.45)` }}
      >
        {marks.map((m, i) => {
          const nextFrac = i < marks.length - 1 ? marks[i + 1].frac : 1;
          const leftPx = m.frac * width;
          const segPx = Math.max(2, (nextFrac - m.frac) * width);
          const showLabel = segPx > 54;
          return (
            <div
              key={i}
              className="absolute top-0 flex items-center overflow-hidden"
              style={{
                left: leftPx,
                width: segPx,
                height: bandH,
                background: `hsl(${CHAPTER_HSL} / 0.16)`,
                borderLeft: `2px solid hsl(${CHAPTER_HSL})`,
                borderTopLeftRadius: i === 0 ? 3 : 0,
              }}
              title={`${fmtChapterTime(m.start)} · ${m.title}`}
            >
              {showLabel ? (
                <span
                  style={{
                    fontSize: 10,
                    fontWeight: 700,
                    color: `hsl(${CHAPTER_HSL})`,
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    padding: '0 5px',
                    textShadow: '0 1px 2px rgba(0,0,0,0.85)',
                  }}
                >
                  <span style={{ opacity: 0.7, marginRight: 5, fontSize: 9 }}>
                    {fmtChapterTime(m.start)}
                  </span>
                  {m.title}
                </span>
              ) : (
                <span
                  style={{
                    fontSize: 9,
                    fontWeight: 800,
                    color: `hsl(${CHAPTER_HSL})`,
                    padding: '0 3px',
                  }}
                >
                  {i + 1}
                </span>
              )}
            </div>
          );
        })}
      </div>
    );
  },
);

const TrackItemWrapper: React.FC<{
  track: VideoTrack;
  frameWidth: number;
  isSelected: boolean;
  isDragging: boolean;
  isResizing: 'left' | 'right' | false;
  isSplitModeActive: boolean;
  isDuplicationFeedback: boolean;
  isProxyProcessing: boolean;
  isTranscoding: boolean;
  reverseArmed?: boolean;
  children: React.ReactNode;
  onClick: (e: React.MouseEvent) => void;
  onMouseDown: (e: React.MouseEvent) => void;
  onContextMenu?: () => void;
}> = React.memo(
  ({
    track,
    frameWidth,
    isSelected,
    isDragging,
    isResizing,
    isSplitModeActive,
    isDuplicationFeedback,
    isProxyProcessing,
    isTranscoding,
    reverseArmed,
    children,
    onClick,
    onMouseDown,
    onContextMenu,
  }) => {
    const left = track.startFrame * frameWidth;
    const width = Math.max(1, (track.endFrame - track.startFrame) * frameWidth);

    const dragGhost = useVideoEditorStore((state) => state.playback.dragGhost);

    const isBeingDragged =
      dragGhost?.isActive &&
      dragGhost.selectedTrackIds &&
      dragGhost.selectedTrackIds.includes(track.id);

    const getTrackGradient = (type: VideoTrack['type']) => {
      switch (type) {
        case 'text':
          return 'hsl(0, 0%, 35%)';
        case 'subtitle':
          return 'hsl(0, 0%, 35%)';
        case 'video':
          return 'transparent';
        case 'audio':
          return 'hsl(var(--secondary) / 0.01)';
        case 'image':
          return 'transparent';
        default:
          return 'linear-gradient(135deg, #34495e, #7f8c8d)';
      }
    };

    const getCursorClass = () => {
      if (isTranscoding) return 'cursor-not-allowed';
      if (isResizing) return 'cursor-trim';
      if (isSplitModeActive) return 'cursor-split';
      if (track.locked || isProxyProcessing) return 'cursor-not-allowed';
      if (isDragging) return 'cursor-grabbing';
      return 'cursor-grab';
    };

    return (
      <div
        data-edith-target={`track-body:${track.id}`}
        className={cn(
          'absolute rounded flex items-center select-none transition-opacity duration-150',
          getTrackItemHeightClasses(track.type),
          isDuplicationFeedback ? 'overflow-visible' : 'overflow-hidden',
          isSelected ? 'border-2 border-secondary' : '',
          getCursorClass(),
          track.visible ? 'opacity-100' : 'opacity-50',
          isDuplicationFeedback ? 'track-duplicate-feedback z-50' : 'z-10',
          isBeingDragged ? 'opacity-0' : '',
          isTranscoding ? 'opacity-50 grayscale' : '',
        )}
        style={{
          transform: `translate3d(${left}px, 0, 0)`,
          width: `${width}px`,
          background: getTrackGradient(track.type),
          willChange: isDragging ? 'transform' : 'auto',
          // While armed for reverse, hide the (trimmed-to-sliver) forward clip so the only
          // thing visible is the growing reverse bar — no leftover tiny segment.
          ...(reverseArmed ? { opacity: 0 } : {}),
        }}
        onClick={onClick}
        onMouseDown={onMouseDown}
        onContextMenu={onContextMenu}
      >
        {children}
        {/* Reverse-playback marker(s): light ochre band over the reversed region.
            Position is a fraction of the clip; the clip itself does not move. */}
        {((track as any).reverseSegments ?? []).map((seg: any, i: number) => (
          <div
            key={`rev-${i}`}
            className="absolute top-0 bottom-0 pointer-events-none"
            style={{
              left: `${(seg.startFrac ?? 0) * 100}%`,
              width: `${Math.max(0, (seg.endFrac ?? 1) - (seg.startFrac ?? 0)) * 100}%`,
              border: '1.5px dashed hsl(141 76% 48%)',
              background: 'hsl(141 76% 48% / 0.14)',
              borderRadius: '3px',
              boxSizing: 'border-box',
              zIndex: 6,
            }}
            title="Reversed playback"
          />
        ))}
        {/* Scene-detection markers: reviewable amber ticks at detected cut points.
            Non-destructive — click a tick to split the clip there. */}
        <SceneMarkers track={track} />
      </div>
    );
  },
);

/**
 * Scene-cut markers (amber ticks). Positions are computed LIVE from each marker's absolute
 * source time against the clip's current trim window — so when a clip is split or trimmed,
 * each part shows only its own cuts at the right spots (no duplication). Gated by the
 * showSceneMarkers toggle. Click a tick to split there.
 */
const SceneMarkers: React.FC<{ track: VideoTrack }> = React.memo(({ track }) => {
  const show = useVideoEditorStore((s) => s.timeline.showSceneMarkers !== false);
  const timelineFps = useVideoEditorStore((s) => s.timeline.fps);
  const markers = (track as any).sceneMarkers as
    | Array<{ atSeconds: number }>
    | undefined;
  if (!show || track.type !== 'video' || !markers?.length) return null;

  const fps = track.sourceFps || timelineFps || 30;
  const clipDurSec = Math.max(0.001, (track.endFrame - track.startFrame) / fps);
  const srcStart = track.sourceStartTime ?? 0;

  const visible = markers
    .map((m) => ({ atSeconds: m.atSeconds, frac: (m.atSeconds - srcStart) / clipDurSec }))
    .filter((m) => m.frac > 0.002 && m.frac < 0.998);
  if (!visible.length) return null;

  return (
    <>
      {visible.map((m, i) => (
        <div
          key={`scene-${i}`}
          className="absolute top-0 bottom-0 pointer-events-auto cursor-pointer"
          style={{
            left: `${m.frac * 100}%`,
            width: '2px',
            background: 'hsl(29 98% 58%)',
            boxShadow: '0 0 4px hsl(29 98% 58% / 0.7)',
            transform: 'translateX(-1px)',
            zIndex: 7,
          }}
          title={`Scene cut at ${fmtChapterTime(m.atSeconds)} — click to split`}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            const st = useVideoEditorStore.getState();
            // Use the SAME fps domain as the marker positioning above, so the split lands
            // exactly on the cut (a 24fps source in a 30fps timeline would otherwise be off).
            const f = track.sourceFps || st.timeline?.fps || 30;
            const frame = Math.round(track.startFrame + (m.atSeconds - srcStart) * f);
            if (frame > track.startFrame && frame < track.endFrame) {
              st.splitTrack(track.id, frame);
              window.dispatchEvent(new CustomEvent('dividr:forceRender'));
            }
          }}
        />
      ))}
    </>
  );
});

export const TrackItem: React.FC<TrackItemProps> = React.memo(
  ({
    track,
    frameWidth,
    zoomLevel,
    isSelected,
    onSelect,
    onMove,
    onResize,
    isSplitModeActive,
  }) => {
    const [isResizing, setIsResizing] = useState<'left' | 'right' | false>(
      false,
    );
    const [isDragging, setIsDragging] = useState(false);
    const [dragStart, setDragStart] = useState({
      x: 0,
      y: 0,
      startFrame: 0,
      endFrame: 0,
    });
    const rafRef = useRef<number | null>(null);
    const hasAutoSelectedRef = useRef(false);
    const dragThresholdMetRef = useRef(false);
    const dragOffsetRef = useRef({ offsetX: 0, offsetY: 0 });
    // Manual reverse-by-drag: slide the LEFT handle past the right edge and a solid reverse
    // bar grows rightward from the edge (like the prototype). `reverseArmed` mounts the bar
    // (one state flip — no lag); its WIDTH is updated imperatively via the ref each mousemove,
    // so the growth is butter-smooth and never re-renders.
    const [reverseArmed, setReverseArmed] = useState(false);
    const reverseArmedRef = useRef(false);
    const revFramesRef = useRef(0);
    const reverseBarRef = useRef<HTMLDivElement | null>(null);
    // Clip (and linked audio) bounds captured at drag start, so a reverse commit can restore
    // the FULL clip synchronously (the handle trims it on the way to the edge) before flipping.
    type ClipBounds = {
      id: string;
      startFrame: number;
      endFrame: number;
      sourceStartTime: number;
      duration: number;
    };
    const originalClipRef = useRef<{
      video: ClipBounds;
      linked: ClipBounds | null;
    } | null>(null);

    const isDuplicationFeedback = useVideoEditorStore((state) =>
      state.duplicationFeedbackTrackIds.has(track.id),
    );

    const dragGhostForHandles = useVideoEditorStore(
      (state) => state.playback.dragGhost,
    );

    // Check if proxy generation is in progress for this track's media (for 4K videos)
    const mediaLibrary = useVideoEditorStore((state) => state.mediaLibrary);
    const mediaItem = useMemo(() => {
      return mediaLibrary.find(
        (m) =>
          m.source === track.source ||
          (track.mediaId && m.id === track.mediaId),
      );
    }, [mediaLibrary, track.source, track.mediaId]);

    const isProxyProcessing = useMemo(() => {
      if (track.type !== 'video') return false;
      return mediaItem?.proxy?.status === 'processing';
    }, [mediaItem, track.type]);

    // Check if transcoding is in progress (for AVI videos or other incompatible formats)
    const isTranscoding = useMemo(() => {
      return (
        mediaItem?.transcoding?.status === 'pending' ||
        mediaItem?.transcoding?.status === 'processing'
      );
    }, [mediaItem]);

    const spriteSheetDisabled = useMemo(() => {
      if (track.type !== 'video') return false;
      return !!mediaItem?.spriteSheetDisabled;
    }, [mediaItem, track.type]);
    const isLongVideo = useMemo(() => {
      if (track.type !== 'video') return false;
      if (mediaItem?.duration == null) return false;
      return mediaItem.duration >= SPRITE_SHEET_SKIP_DURATION_SECONDS;
    }, [mediaItem?.duration, track.type]);

    // Tool mode subscriptions for resetting text-edit mode on track interaction
    const previewInteractionMode = useVideoEditorStore(
      (state) => state.preview.interactionMode,
    );
    const setPreviewInteractionMode = useVideoEditorStore(
      (state) => state.setPreviewInteractionMode,
    );
    const isThisOrLinkedTrackBeingDragged =
      dragGhostForHandles?.isActive &&
      dragGhostForHandles.selectedTrackIds &&
      dragGhostForHandles.selectedTrackIds.includes(track.id);

    useEffect(() => {
      if (isResizing) {
        const isDark = document.documentElement.classList.contains('dark');
        const svgColor = isDark ? '%23ffffff' : '%23000';
        const fillColor = isDark ? '%23000' : '%23ffffff';
        document.body.style.cursor = `url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="${fillColor}" stroke="${svgColor}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v18"/><path d="m16 16 4-4-4-4"/><path d="m8 8-4 4 4 4"/></svg>') 12 12, ew-resize`;
        document.body.style.userSelect = 'none';
        return () => {
          document.body.style.cursor = '';
          document.body.style.userSelect = '';
        };
      } else if (isDragging) {
        document.body.style.cursor = 'grabbing';
        document.body.style.userSelect = 'none';
        return () => {
          document.body.style.cursor = '';
          document.body.style.userSelect = '';
        };
      }
    }, [isResizing, isDragging]);

    const width = Math.max(1, (track.endFrame - track.startFrame) * frameWidth);
    const left = track.startFrame * frameWidth;

    const handleClick = useCallback(
      (e: React.MouseEvent) => {
        if (isTranscoding) return;
        if (isSplitModeActive || e.button === 2) return;

        // Reset text tool mode when selecting tracks
        // This ensures the preview cursor mode doesn't stay stuck in text-edit mode
        if (previewInteractionMode !== 'select') {
          setPreviewInteractionMode('select');
        }

        e.stopPropagation();
        // Support both Shift and Ctrl/Cmd for multi-selection (standard desktop behavior)
        onSelect(e.shiftKey || e.ctrlKey || e.metaKey);
      },
      [
        isSplitModeActive,
        isTranscoding,
        onSelect,
        previewInteractionMode,
        setPreviewInteractionMode,
      ],
    );

    const handleMouseDown = useCallback(
      (e: React.MouseEvent) => {
        if (
          track.locked ||
          isProxyProcessing ||
          isTranscoding ||
          isSplitModeActive ||
          e.button === 2
        )
          return;

        // Reset text tool mode when interacting with tracks
        // This ensures the preview cursor mode doesn't stay stuck in text-edit mode
        if (previewInteractionMode !== 'select') {
          setPreviewInteractionMode('select');
        }

        e.stopPropagation();

        const { startDraggingTrack } = useVideoEditorStore.getState();
        startDraggingTrack(track.startFrame);

        const trackElement = e.currentTarget as HTMLElement;
        const trackRect = trackElement.getBoundingClientRect();
        dragOffsetRef.current = {
          offsetX: e.clientX - trackRect.left,
          offsetY: e.clientY - trackRect.top,
        };

        setIsDragging(true);
        setDragStart({
          x: e.clientX,
          y: e.clientY,
          startFrame: track.startFrame,
          endFrame: track.endFrame,
        });

        dragThresholdMetRef.current = false;
      },
      [
        track.locked,
        track.startFrame,
        track.endFrame,
        track.id,
        track.type,
        isSplitModeActive,
        isProxyProcessing,
        isTranscoding,
        previewInteractionMode,
        setPreviewInteractionMode,
      ],
    );

    const handleResizeMouseDown = useCallback(
      (side: 'left' | 'right', e: React.MouseEvent) => {
        if (isSplitModeActive || isProxyProcessing || isTranscoding) return;
        e.stopPropagation();
        e.preventDefault();

        if (!isSelected) {
          // Support both Shift and Ctrl/Cmd for multi-selection (standard desktop behavior)
          onSelect(e.shiftKey || e.ctrlKey || e.metaKey);
        }

        const { startDraggingTrack } = useVideoEditorStore.getState();
        startDraggingTrack(track.startFrame);

        setIsResizing(side);
        setDragStart({
          x: e.clientX,
          y: e.clientY,
          startFrame: track.startFrame,
          endFrame: track.endFrame,
        });
        const linkedId = (track as any).linkedTrackId as string | undefined;
        const linkedTrack = linkedId
          ? useVideoEditorStore.getState().tracks.find((t) => t.id === linkedId)
          : undefined;
        originalClipRef.current = {
          video: {
            id: track.id,
            startFrame: track.startFrame,
            endFrame: track.endFrame,
            sourceStartTime: (track as any).sourceStartTime ?? 0,
            duration: track.duration,
          },
          linked: linkedTrack
            ? {
                id: linkedTrack.id,
                startFrame: linkedTrack.startFrame,
                endFrame: linkedTrack.endFrame,
                sourceStartTime: (linkedTrack as any).sourceStartTime ?? 0,
                duration: linkedTrack.duration,
              }
            : null,
        };
      },
      [
        track.startFrame,
        track.endFrame,
        track.duration,
        isSplitModeActive,
        isProxyProcessing,
        isTranscoding,
        isSelected,
        onSelect,
      ],
    );

    const handleMouseMove = useCallback(
      (e: MouseEvent) => {
        if (!isResizing && !isDragging) return;

        if (isDragging && !dragThresholdMetRef.current) {
          const deltaX = Math.abs(e.clientX - dragStart.x);
          const deltaY = Math.abs(e.clientY - dragStart.y);
          const totalMovement = Math.sqrt(deltaX * deltaX + deltaY * deltaY);

          if (totalMovement >= DRAG_ACTIVATION_THRESHOLD) {
            dragThresholdMetRef.current = true;

            const { setDragGhost, timeline } = useVideoEditorStore.getState();

            const selectedTrackIds = timeline.selectedTrackIds;
            const isMultiSelectionDrag =
              selectedTrackIds.length > 1 &&
              selectedTrackIds.includes(track.id);

            const allSelectedTrackIds = isMultiSelectionDrag
              ? [...selectedTrackIds]
              : [track.id];

            if (track.isLinked && track.linkedTrackId) {
              if (!allSelectedTrackIds.includes(track.linkedTrackId)) {
                allSelectedTrackIds.push(track.linkedTrackId);
              }
            }

            const isMultiSelection = allSelectedTrackIds.length > 1;

            const scrollContainer = (e.target as HTMLElement).closest(
              '.overflow-auto',
            ) as HTMLElement | null;
            const currentScrollX = scrollContainer?.scrollLeft || 0;
            const scrollContainerRect =
              scrollContainer?.getBoundingClientRect();
            const mouseRelativeX = scrollContainerRect
              ? e.clientX - scrollContainerRect.left
              : e.clientX;

            const targetFrame = Math.max(
              0,
              Math.floor(
                (mouseRelativeX +
                  currentScrollX -
                  dragOffsetRef.current.offsetX) /
                  frameWidth,
              ),
            );

            setDragGhost({
              isActive: true,
              trackId: track.id,
              selectedTrackIds: allSelectedTrackIds,
              mouseX: e.clientX,
              mouseY: e.clientY,
              offsetX: dragOffsetRef.current.offsetX,
              offsetY: dragOffsetRef.current.offsetY,
              targetRow: track.type,
              targetFrame,
              isMultiSelection,
            });
          } else {
            return;
          }
        }

        if (
          isDragging &&
          !isSelected &&
          !hasAutoSelectedRef.current &&
          dragThresholdMetRef.current
        ) {
          // Support both Shift and Ctrl/Cmd for multi-selection (standard desktop behavior)
          onSelect(e.shiftKey || e.ctrlKey || e.metaKey);
          hasAutoSelectedRef.current = true;
        }

        if (rafRef.current) cancelAnimationFrame(rafRef.current);

        rafRef.current = requestAnimationFrame(() => {
          const scrollContainer = (e.target as HTMLElement).closest(
            '.overflow-auto',
          ) as HTMLElement | null;
          const currentScrollX = scrollContainer?.scrollLeft || 0;
          const scrollContainerRect = scrollContainer?.getBoundingClientRect();

          const deltaX = e.clientX - dragStart.x;
          const deltaFrames = Math.round(deltaX / frameWidth);

          if (isResizing === 'left') {
            // CROSSOVER → manual reverse: drag the left handle all the way PAST the right
            // edge to arm "flip in place". Binary — arm once on crossing, disarm once on
            // un-crossing. No ghost, no per-pixel math, so it can't lag or miss the commit.
            const proposedStart = dragStart.startFrame + deltaFrames;
            const rightEdge = dragStart.endFrame;
            if (
              proposedStart >= rightEdge &&
              (track.type === 'video' || track.type === 'audio')
            ) {
              if (!reverseArmedRef.current) {
                reverseArmedRef.current = true;
                setReverseArmed(true);
                useVideoEditorStore.getState().setMagneticSnapFrame(null);
              }
              // Grow the solid reverse bar rightward from the edge, capped at the clip length.
              // Imperative width update — no React state, no re-render, no lag. No clip resize
              // here either, so nothing snaps; the flip + restore happen on release.
              const clipLen = dragStart.endFrame - dragStart.startFrame;
              const rev = Math.max(0, Math.min(clipLen, proposedStart - rightEdge));
              revFramesRef.current = rev;
              const bar = reverseBarRef.current;
              if (bar) {
                bar.style.left = `${rightEdge * frameWidth}px`;
                bar.style.width = `${Math.max(2, rev * frameWidth)}px`;
              }
            } else {
            if (reverseArmedRef.current) {
              reverseArmedRef.current = false;
              revFramesRef.current = 0;
              setReverseArmed(false);
            }
            let newStartFrame = Math.max(
              0,
              Math.min(
                dragStart.endFrame - 1,
                dragStart.startFrame + deltaFrames,
              ),
            );

            const { timeline, tracks: allTracks } =
              useVideoEditorStore.getState();
            const shouldSnap = e.shiftKey || timeline.snapEnabled;

            if (shouldSnap) {
              const excludeIds = [track.id];
              if (track.linkedTrackId) excludeIds.push(track.linkedTrackId);
              timeline.selectedTrackIds.forEach((id: string) => {
                if (!excludeIds.includes(id)) excludeIds.push(id);
              });

              const allSnapPoints = findAllSnapPoints(
                allTracks,
                excludeIds,
                timeline.currentFrame,
              );

              const snapResult = checkSnapPosition(
                newStartFrame,
                allSnapPoints,
                8,
              );
              if (
                snapResult !== null &&
                snapResult >= 0 &&
                snapResult < dragStart.endFrame
              ) {
                newStartFrame = snapResult;
                useVideoEditorStore.getState().setMagneticSnapFrame(snapResult);
              } else {
                useVideoEditorStore.getState().setMagneticSnapFrame(null);
              }
            } else {
              useVideoEditorStore.getState().setMagneticSnapFrame(null);
            }

            onResize(newStartFrame, undefined);
            }
          } else if (isResizing === 'right') {
            let newEndFrame = Math.max(
              dragStart.startFrame + 1,
              dragStart.endFrame + deltaFrames,
            );

            const { timeline, tracks: allTracks } =
              useVideoEditorStore.getState();
            const shouldSnap = e.shiftKey || timeline.snapEnabled;

            if (shouldSnap) {
              const excludeIds = [track.id];
              if (track.linkedTrackId) excludeIds.push(track.linkedTrackId);
              timeline.selectedTrackIds.forEach((id: string) => {
                if (!excludeIds.includes(id)) excludeIds.push(id);
              });

              const allSnapPoints = findAllSnapPoints(
                allTracks,
                excludeIds,
                timeline.currentFrame,
              );

              const snapResult = checkSnapPosition(
                newEndFrame,
                allSnapPoints,
                8,
              );
              if (snapResult !== null && snapResult > dragStart.startFrame) {
                newEndFrame = snapResult;
                useVideoEditorStore.getState().setMagneticSnapFrame(snapResult);
              } else {
                useVideoEditorStore.getState().setMagneticSnapFrame(null);
              }
            } else {
              useVideoEditorStore.getState().setMagneticSnapFrame(null);
            }

            onResize(undefined, newEndFrame);
          } else if (isDragging && dragThresholdMetRef.current) {
            if (!scrollContainerRect) {
              const newStartFrame = Math.max(
                0,
                dragStart.startFrame + deltaFrames,
              );
              onMove(newStartFrame);
              return;
            }

            const mouseRelativeX = e.clientX - scrollContainerRect.left;

            let newStartFrame = Math.max(
              0,
              Math.floor(
                (mouseRelativeX +
                  currentScrollX -
                  dragOffsetRef.current.offsetX) /
                  frameWidth,
              ),
            );

            const duration = dragStart.endFrame - dragStart.startFrame;
            const newEndFrame = newStartFrame + duration;

            const {
              timeline,
              tracks: allTracks,
              updateDragGhostPosition,
            } = useVideoEditorStore.getState();
            const shouldSnap = e.shiftKey || timeline.snapEnabled;

            if (shouldSnap) {
              const excludeIds = [track.id];
              if (track.linkedTrackId) excludeIds.push(track.linkedTrackId);
              timeline.selectedTrackIds.forEach((id: string) => {
                if (!excludeIds.includes(id)) excludeIds.push(id);
              });

              const allSnapPoints = findAllSnapPoints(
                allTracks,
                excludeIds,
                timeline.currentFrame,
              );

              const startSnap = checkSnapPosition(
                newStartFrame,
                allSnapPoints,
                8,
              );
              if (startSnap !== null && startSnap >= 0) {
                newStartFrame = startSnap;
                useVideoEditorStore.getState().setMagneticSnapFrame(startSnap);
              } else {
                const endSnap = checkSnapPosition(
                  newEndFrame,
                  allSnapPoints,
                  8,
                );
                if (endSnap !== null) {
                  newStartFrame = endSnap - duration;
                  if (newStartFrame >= 0) {
                    useVideoEditorStore
                      .getState()
                      .setMagneticSnapFrame(endSnap);
                  } else {
                    newStartFrame = 0;
                    useVideoEditorStore.getState().setMagneticSnapFrame(null);
                  }
                } else {
                  useVideoEditorStore.getState().setMagneticSnapFrame(null);
                }
              }
            } else {
              useVideoEditorStore.getState().setMagneticSnapFrame(null);
            }

            const currentTargetRow =
              useVideoEditorStore.getState().playback.dragGhost?.targetRow ||
              getTrackRowId(track);

            updateDragGhostPosition(
              e.clientX,
              e.clientY,
              currentTargetRow,
              newStartFrame,
            );

            onMove(newStartFrame);
          }
        });
      },
      [
        isResizing,
        isDragging,
        isSelected,
        dragStart,
        frameWidth,
        onResize,
        onMove,
        onSelect,
        track.id,
        track.type,
        track.linkedTrackId,
        track.isLinked,
        track.startFrame,
      ],
    );

    const handleMouseUp = useCallback(() => {
      const state = useVideoEditorStore.getState();
      const { playback, endDraggingTrack, clearDragGhost, moveTrackToRow } =
        state;

      // Manual reverse-by-drag committed: the left handle was dragged past the right edge,
      // so flip the whole clip in place (keeps its timeline position). Same reverse op as EDITH.
      const orig = originalClipRef.current;
      if (reverseArmedRef.current && orig) {
        reverseArmedRef.current = false;
        revFramesRef.current = 0;
        setReverseArmed(false);
        state.setMagneticSnapFrame?.(null);

        // NON-DESTRUCTIVE reverse: flip the clip instantly with no re-encode and no snap-back.
        // Restore the full bounds (the handle trimmed them on the slide) AND set the `reversed`
        // flag in ONE atomic update, so the clip immediately plays backward in the preview and
        // STAYS that way. The real reversed frames/audio are baked at export.
        const liveNow = useVideoEditorStore.getState();
        const cur = liveNow.tracks.find((t: VideoTrack) => t.id === orig.video.id);
        const nextReversed = !((cur as any)?.reversed);
        liveNow.updateTrack(orig.video.id, {
          startFrame: orig.video.startFrame,
          endFrame: orig.video.endFrame,
          sourceStartTime: orig.video.sourceStartTime,
          duration: orig.video.duration,
          reversed: nextReversed,
          reverseSegments: nextReversed ? [{ startFrac: 0, endFrac: 1 }] : [],
        } as any);
        if (orig.linked) {
          liveNow.updateTrack(orig.linked.id, {
            startFrame: orig.linked.startFrame,
            endFrame: orig.linked.endFrame,
            sourceStartTime: orig.linked.sourceStartTime,
            duration: orig.linked.duration,
            reversed: nextReversed,
          } as any);
        }
        toast.success(nextReversed ? 'Reversed' : 'Restored to forward');
        // FULL teardown — without this the timeline stays stuck in "dragging" state and the
        // clip can no longer be selected or moved. (This was the freeze bug.)
        endDraggingTrack();
        clearDragGhost();
        setIsResizing(false);
        setIsDragging(false);
        hasAutoSelectedRef.current = false;
        dragThresholdMetRef.current = false;
        if (rafRef.current) {
          cancelAnimationFrame(rafRef.current);
          rafRef.current = null;
        }
        return;
      }

      if (
        isDragging &&
        dragThresholdMetRef.current &&
        playback.dragGhost?.isActive &&
        playback.dragGhost.targetRow
      ) {
        const targetRowId = playback.dragGhost.targetRow;
        const targetFrame = playback.dragGhost.targetFrame;
        const parsedRow = parseRowId(targetRowId);

        console.log(
          `🎬 DROP: track=${track.type}, currentRow=${track.trackRowIndex ?? 0}, targetRow=${parsedRow ? parsedRow.rowIndex : 'null'}`,
        );

        if (parsedRow) {
          const currentRowIndex = track.trackRowIndex ?? 0;

          if (parsedRow.type !== track.type) {
            console.log(
              `   ❌ INVALID: Cannot drop ${track.type} on ${parsedRow.type} row`,
            );
            endDraggingTrack();
            clearDragGhost();
            setIsResizing(false);
            setIsDragging(false);
            hasAutoSelectedRef.current = false;
            dragThresholdMetRef.current = false;
            return;
          }

          const normalizedTargetIndex = Math.round(parsedRow.rowIndex);
          if (normalizedTargetIndex !== currentRowIndex) {
            moveTrackToRow(
              track.id,
              parsedRow.rowIndex,
              targetFrame !== null && targetFrame !== undefined
                ? targetFrame
                : undefined,
            );
          } else {
            console.log(
              `   ⏸️ No row change (same row ${currentRowIndex}, target was ${parsedRow.rowIndex})`,
            );
          }
        }
      }

      endDraggingTrack();
      clearDragGhost();

      setIsResizing(false);
      setIsDragging(false);
      hasAutoSelectedRef.current = false;
      dragThresholdMetRef.current = false;
      // Safety: never leave the clip armed/hidden if the reverse branch didn't run.
      if (reverseArmedRef.current) {
        reverseArmedRef.current = false;
        revFramesRef.current = 0;
        setReverseArmed(false);
      }

      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    }, [isDragging, track.id, track.type, track.trackRowIndex]);

    useEffect(() => {
      if (isResizing || isDragging) {
        document.addEventListener('mousemove', handleMouseMove);
        document.addEventListener('mouseup', handleMouseUp);
        window.addEventListener('blur', handleMouseUp);
        return () => {
          document.removeEventListener('mousemove', handleMouseMove);
          document.removeEventListener('mouseup', handleMouseUp);
          window.removeEventListener('blur', handleMouseUp);
        };
      }
    }, [isResizing, isDragging, handleMouseMove, handleMouseUp]);

    useEffect(() => {
      return () => {
        const { playback, endDraggingTrack } = useVideoEditorStore.getState();
        if (playback.isDraggingTrack) {
          endDraggingTrack();
        }
      };
    }, []);

    const trackContent = useMemo(() => {
      const contentHeight = getTrackItemHeight(track.type);

      if (track.type === 'video') {
        const isReversed = !!(track as any).reversed;
        const inner = spriteSheetDisabled ? (
          (() => {
            const shouldShowPlaceholder = !isLongVideo;
            return (
              <div className="relative w-full h-full">
                <div className="absolute inset-0 bg-gray-800" />
                {shouldShowPlaceholder &&
                  (mediaItem?.thumbnail ? (
                    <img
                      src={mediaItem.thumbnail}
                      alt={track.name}
                      className="absolute inset-0 h-full w-full object-cover opacity-80"
                      loading="lazy"
                    />
                  ) : (
                    <div className="absolute inset-0 flex items-center justify-center text-muted-foreground">
                      <Film className="h-4 w-4" />
                    </div>
                  ))}
                {shouldShowPlaceholder && (
                  <div className="absolute inset-0 bg-gradient-to-r from-black/30 via-transparent to-black/30" />
                )}
              </div>
            );
          })()
        ) : (
          <VideoSpriteSheetStrip
            track={track}
            frameWidth={frameWidth}
            width={width}
            height={contentHeight}
            zoomLevel={zoomLevel}
          />
        );

        if (!isReversed) return inner;

        // Reversed: mirror the frames so the clip VISIBLY stays reversed in the timeline,
        // with a clear badge. The preview plays it backward (FrameResolver inversion).
        return (
          <div className="relative w-full h-full">
            <div className="w-full h-full" style={{ transform: 'scaleX(-1)' }}>
              {inner}
            </div>
            <div
              className="absolute top-0.5 right-1 z-20 pointer-events-none text-[9px] font-extrabold text-secondary"
              style={{ textShadow: '0 1px 2px rgba(0,0,0,0.85)', letterSpacing: '0.5px' }}
            >
              ◄ REVERSED
            </div>
          </div>
        );
      }

      if (track.type === 'audio') {
        return (
          <div
            className={`w-full h-full ${track.muted ? 'opacity-50 grayscale' : ''}`}
          >
            <AudioWaveform
              track={track}
              frameWidth={frameWidth}
              width={width}
              height={contentHeight}
              zoomLevel={zoomLevel}
            />
          </div>
        );
      }

      if (track.type === 'image') {
        return (
          <ImageTrackStrip
            track={track}
            frameWidth={frameWidth}
            width={width}
            height={contentHeight}
            zoomLevel={zoomLevel}
          />
        );
      }

      return (
        <div className="text-white text-[11px] h-fit whitespace-nowrap overflow-hidden text-ellipsis px-2 py-1">
          {track.type === 'subtitle' && track.subtitleText
            ? track.subtitleText
            : track.type === 'text' && track.textContent
              ? track.textContent
              : track.name}
        </div>
      );
    }, [
      track,
      track.muted,
      frameWidth,
      width,
      zoomLevel,
      spriteSheetDisabled,
      isLongVideo,
      mediaItem?.thumbnail,
    ]);

    return (
      <>
        <TrackContextMenu track={track}>
          <TrackItemWrapper
            track={track}
            frameWidth={frameWidth}
            isSelected={isSelected}
            isDragging={isDragging}
            isResizing={isResizing}
            isSplitModeActive={isSplitModeActive}
            isDuplicationFeedback={isDuplicationFeedback}
            isProxyProcessing={isProxyProcessing}
            isTranscoding={isTranscoding}
            reverseArmed={reverseArmed}
            onClick={handleClick}
            onMouseDown={handleMouseDown}
          >
            {trackContent}

            <ChapterMarkers track={track} width={width} />

            {track.type === 'audio' && track.volume !== undefined && (
              <div className="absolute right-1 top-1 text-[8px] text-foreground z-20">
                {Math.round(track.volume * 100)}%
              </div>
            )}

            {track.locked && (
              <div className="absolute top-0.5 right-0.5 text-[10px] text-foreground/60 z-20">
                🔒
              </div>
            )}

            {track.isLinked && (
              <div
                className="absolute top-0.5 left-0.5 text-[10px] text-blue-400 z-20 animate-pulse"
                title={`Linked to ${track.type === 'video' ? 'audio' : 'video'} track`}
              >
                🔗
              </div>
            )}
          </TrackItemWrapper>
        </TrackContextMenu>

        {!track.locked &&
          isSelected &&
          !isSplitModeActive &&
          !isDragging &&
          !isThisOrLinkedTrackBeingDragged && (
            <>
              <div
                className={cn(
                  'absolute top-1/2 -translate-y-1/2 w-1.5 cursor-trim z-20 rounded-r flex items-center justify-center',
                  track.type === 'text' || track.type === 'subtitle'
                    ? 'sm:h-3 md:h-4 lg:h-4'
                    : 'sm:h-3 md:h-7 lg:h-6',
                  isResizing === 'left' ? 'bg-blue-500' : 'bg-secondary',
                )}
                style={{ left }}
                onMouseDown={(e) => handleResizeMouseDown('left', e)}
              >
                <div className="w-0.5 h-2/3 bg-primary-foreground rounded-full" />
              </div>

              <div
                className={cn(
                  'absolute top-1/2 -translate-y-1/2 w-1.5 cursor-trim z-20 rounded-l flex items-center justify-center',
                  track.type === 'text' || track.type === 'subtitle'
                    ? 'sm:h-3 md:h-4 lg:h-4'
                    : 'sm:h-3 md:h-6 lg:h-6',
                  isResizing === 'right' ? 'bg-blue-500' : 'bg-secondary',
                )}
                style={{ left: left + width - 6 }}
                onMouseDown={(e) => handleResizeMouseDown('right', e)}
              >
                <div className="w-0.5 h-2/3 bg-primary-foreground rounded-full" />
              </div>
            </>
          )}

        {/* Manual reverse: a bar that grows rightward from the clip's right edge as the left
            handle slides past it. It shows the clip's own frame MIRRORED (scaleX(-1)) so it
            reads as the video flipped, not a flat label. Width is set imperatively in the move
            handler — no per-pixel React state, so it never lags. */}
        {reverseArmed && (
          <div
            ref={reverseBarRef}
            className="absolute top-1 bottom-1 pointer-events-none z-30 rounded overflow-hidden"
            style={{
              left: dragStart.endFrame * frameWidth,
              width: Math.max(2, revFramesRef.current * frameWidth),
              border: '2px solid hsl(141 76% 48%)',
              boxSizing: 'border-box',
              background: '#111',
            }}
          >
            {mediaItem?.thumbnail ? (
              <img
                src={mediaItem.thumbnail}
                alt=""
                className="absolute inset-0 h-full w-full object-cover"
                style={{ transform: 'scaleX(-1)', opacity: 0.9 }}
              />
            ) : (
              <div
                className="absolute inset-0"
                style={{
                  background:
                    'repeating-linear-gradient(-45deg, hsl(141 76% 48% / 0.3) 0 6px, transparent 6px 12px)',
                  transform: 'scaleX(-1)',
                }}
              />
            )}
            <div
              className="absolute inset-0 flex items-center justify-center"
              style={{
                background:
                  'linear-gradient(90deg, rgba(0,0,0,0.45), rgba(0,0,0,0.05))',
              }}
            >
              <span
                style={{
                  fontSize: 13,
                  fontWeight: 800,
                  color: '#fff',
                  letterSpacing: '2px',
                  textShadow: '0 1px 3px rgba(0,0,0,0.9)',
                }}
              >
                ◄◄
              </span>
            </div>
          </div>
        )}
      </>
    );
  },
  (prevProps, nextProps) => {
    return (
      prevProps.track.id === nextProps.track.id &&
      prevProps.track.startFrame === nextProps.track.startFrame &&
      prevProps.track.endFrame === nextProps.track.endFrame &&
      prevProps.track.visible === nextProps.track.visible &&
      prevProps.track.locked === nextProps.track.locked &&
      prevProps.track.muted === nextProps.track.muted &&
      prevProps.track.volumeDb === nextProps.track.volumeDb &&
      (prevProps.track as any).reversed === (nextProps.track as any).reversed &&
      (prevProps.track as any).sceneMarkers === (nextProps.track as any).sceneMarkers &&
      prevProps.track.noiseReductionEnabled ===
        nextProps.track.noiseReductionEnabled &&
      prevProps.track.mediaId === nextProps.track.mediaId &&
      prevProps.isSelected === nextProps.isSelected &&
      prevProps.isSplitModeActive === nextProps.isSplitModeActive &&
      prevProps.frameWidth === nextProps.frameWidth &&
      prevProps.zoomLevel === nextProps.zoomLevel
    );
  },
);

interface TrackRowProps {
  rowDef: TrackRowDefinition;
  tracks: VideoTrack[];
  frameWidth: number;
  timelineWidth: number;
  scrollX: number;
  zoomLevel: number;
  selectedTrackIds: string[];
  onTrackSelect: (trackId: string, multiSelect?: boolean) => void;
  onTrackMove: (trackId: string, newStartFrame: number) => void;
  onTrackResize: (
    trackId: string,
    newStartFrame?: number,
    newEndFrame?: number,
  ) => void;
  onDrop: (rowId: string, files: FileList) => void;
  onSubtitleImportAttempt?: (params: {
    mediaId: string;
    mediaName: string;
    targetFrame: number;
    targetRowIndex: number;
  }) => boolean | Promise<boolean>;
  allTracksCount: number;
  onPlaceholderClick?: () => void;
  isSplitModeActive: boolean;
  isEmptyTimeline: boolean;
  hasVideoTracks: boolean;
  isPlaceholder?: boolean;
}

const TRANSITION_CYCLE = ['dissolve', 'dip', 'wipe', 'push', 'slide', 'zoom', 'whip'] as const;

/**
 * Renders a badge over the overlap zone of each transition in this row. The badge shows the
 * transition type and is clickable to cycle the type. Neutral styling so it reads as a
 * connector, distinct from the green selection / amber chapters / orange scene markers.
 */
/** One transition's on-timeline badge: positioned over the pre-roll window [cut-D, cut].
 * Click cycles the type; the × removes it; hovering 1.5s reveals a length/intensity slider. */
const TransitionBadge: React.FC<{
  tr: any;
  from: VideoTrack;
  to: VideoTrack;
  frameWidth: number;
}> = ({ tr, from, to, frameWidth }) => {
  const upsertTransition = useVideoEditorStore((s) => s.upsertTransition);
  const removeTransition = useVideoEditorStore((s) => s.removeTransition);
  const fps = useVideoEditorStore((s) => s.timeline.fps) || 30;
  const [showSlider, setShowSlider] = useState(false);
  const showTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cut = to.startFrame;
  const earlierDur = from.endFrame - from.startFrame;
  const laterDur = to.endFrame - to.startFrame;
  const maxD = Math.max(2, Math.min(earlierDur - 1, laterDur - 1));
  const D = Math.min(tr.durationFrames || Math.round(1.5 * fps), maxD);
  const left = (cut - D) * frameWidth;
  const width = Math.max(10, D * frameWidth);

  // Show after a 1.5s hover; on leave, hide after a short grace period instead of instantly so
  // the cursor can travel up onto the slider popover without it vanishing.
  const onEnter = () => {
    if (hideTimer.current) {
      clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
    if (!showSlider && !showTimer.current) {
      showTimer.current = setTimeout(() => {
        setShowSlider(true);
        showTimer.current = null;
      }, 1500);
    }
  };
  const onLeave = () => {
    if (showTimer.current) {
      clearTimeout(showTimer.current);
      showTimer.current = null;
    }
    hideTimer.current = setTimeout(() => {
      setShowSlider(false);
      hideTimer.current = null;
    }, 220);
  };
  // Clear any pending timers on unmount so they can't fire setState on a gone component.
  useEffect(
    () => () => {
      if (showTimer.current) clearTimeout(showTimer.current);
      if (hideTimer.current) clearTimeout(hideTimer.current);
    },
    [],
  );

  // Slider bounds: the minimum (0.2s) can exceed maxD on a short clip — clamp so min <= max.
  const sliderMin = Math.min(Math.max(2, Math.round(0.2 * fps)), maxD);
  const setDuration = (v: number) =>
    upsertTransition({ ...tr, durationFrames: Math.max(sliderMin, Math.min(maxD, Math.round(v))) });

  return (
    <div
      data-testid="transition-badge"
      className="absolute top-0 bottom-0 z-20 flex cursor-pointer items-center justify-center"
      style={{ left, width }}
      title={`${tr.type} transition — click to change type, hover to adjust length`}
      onMouseDown={(e) => e.stopPropagation()}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      onClick={(e) => {
        e.stopPropagation();
        const i = TRANSITION_CYCLE.indexOf(tr.type);
        const next = TRANSITION_CYCLE[(i + 1) % TRANSITION_CYCLE.length];
        upsertTransition({ ...tr, type: next });
      }}
    >
      <div
        className="absolute inset-0 overflow-hidden rounded-sm"
        style={{
          background:
            'repeating-linear-gradient(45deg, rgba(255,255,255,0.18) 0 5px, rgba(255,255,255,0.06) 5px 10px)',
          borderLeft: '1.5px solid rgba(255,255,255,0.75)',
          borderRight: '1.5px solid rgba(255,255,255,0.75)',
        }}
      />
      <span
        style={{
          position: 'relative',
          fontSize: 9,
          fontWeight: 800,
          letterSpacing: '0.3px',
          color: '#fff',
          textShadow: '0 1px 2px rgba(0,0,0,0.9)',
          pointerEvents: 'none',
          whiteSpace: 'nowrap',
        }}
      >
        {width > 44 ? tr.type.toUpperCase() : '⇄'}
      </span>
      <button
        className="absolute -right-1 -top-1 z-30 flex items-center justify-center rounded-full"
        style={{ width: 14, height: 14, background: 'hsl(0 84% 60%)', color: '#fff', fontSize: 11, lineHeight: 1 }}
        title="Remove transition"
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          removeTransition(tr.fromClipId, tr.toClipId);
        }}
      >
        ×
      </button>
      {showSlider && (
        // Anchored to the badge's RIGHT edge (the cut), which stays fixed as the duration
        // changes — the left edge/width move with duration, so centering here would make the
        // slider drift out from under the cursor while dragging. Right-anchored = stays put.
        // The transparent paddingBottom bridges the gap so the cursor can reach the slider.
        <div
          className="absolute bottom-full right-0 z-40"
          style={{ paddingBottom: 8 }}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          <div
            data-testid="transition-length-popover"
            className="w-44 rounded-md border border-border bg-popover px-3 py-2 shadow-lg"
          >
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/70">
                Length
              </span>
              <span className="text-xs tabular-nums text-foreground">{(D / fps).toFixed(1)}s</span>
            </div>
            <Slider
              min={sliderMin}
              max={maxD}
              step={1}
              value={[D]}
              onValueChange={([v]) => setDuration(v)}
              className="w-full"
            />
          </div>
        </div>
      )}
    </div>
  );
};

const TransitionBadges: React.FC<{ tracks: VideoTrack[]; frameWidth: number }> = ({
  tracks,
  frameWidth,
}) => {
  const transitions = useVideoEditorStore((s) => s.timeline.transitions);
  const createTransitionBetween = useVideoEditorStore(
    (s) => (s as any).createTransitionBetween,
  );
  const byId = new Map(tracks.map((t) => [t.id, t]));

  // "+" connectors between adjacent same-row video clips that don't yet have a transition.
  const videoClips = tracks
    .filter((t) => t.type === 'video')
    .sort((a, b) => a.startFrame - b.startFrame);
  const connectors: Array<{ key: string; left: number; fromId: string; toId: string }> = [];
  for (let i = 0; i < videoClips.length - 1; i++) {
    const a = videoClips[i];
    const b = videoClips[i + 1];
    if ((a.trackRowIndex ?? 0) !== (b.trackRowIndex ?? 0)) continue;
    const gap = b.startFrame - a.endFrame;
    if (gap < -1 || gap > 15) continue; // touching/near-adjacent clips (incl. small gaps)
    const hasTransition = (transitions ?? []).some(
      (tr) => tr.fromClipId === a.id && tr.toClipId === b.id,
    );
    if (hasTransition) continue;
    connectors.push({ key: `conn-${a.id}-${b.id}`, left: a.endFrame * frameWidth, fromId: a.id, toId: b.id });
  }

  return (
    <>
      {connectors.map((c) => (
        <div
          key={c.key}
          className="absolute top-1/2 z-20 flex -translate-x-1/2 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full opacity-50 transition-opacity hover:opacity-100"
          style={{
            left: c.left,
            width: 18,
            height: 18,
            background: 'rgba(255,255,255,0.9)',
            color: '#111',
            fontSize: 13,
            fontWeight: 800,
            boxShadow: '0 0 0 1px rgba(0,0,0,0.3)',
          }}
          title="Add cross dissolve"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            createTransitionBetween?.(c.fromId, c.toId, 'dissolve', 1.5);
          }}
        >
          ⇄
        </div>
      ))}
      {(transitions ?? []).map((tr) => {
        const from = byId.get(tr.fromClipId);
        const to = byId.get(tr.toClipId);
        if (!from || !to) return null;
        if ((from.trackRowIndex ?? 0) !== (to.trackRowIndex ?? 0)) return null;
        return (
          <TransitionBadge key={tr.id} tr={tr} from={from} to={to} frameWidth={frameWidth} />
        );
      })}
    </>
  );
};

const TrackRow: React.FC<TrackRowProps> = React.memo(
  ({
    rowDef,
    tracks,
    frameWidth,
    timelineWidth,
    scrollX,
    zoomLevel,
    selectedTrackIds,
    onTrackSelect,
    onTrackMove,
    onTrackResize,
    onDrop,
    onSubtitleImportAttempt,
    onPlaceholderClick,
    isSplitModeActive,
    isEmptyTimeline,
    hasVideoTracks,
    isPlaceholder = false,
  }) => {
    const [isDragOver, setIsDragOver] = useState(false);

    // Safety cleanup: ensure drag state is cleared when drag ends elsewhere
    useEffect(() => {
      const clearDragState = () => setIsDragOver(false);
      document.addEventListener('dragend', clearDragState, true);
      document.addEventListener('drop', clearDragState, true);
      return () => {
        document.removeEventListener('dragend', clearDragState, true);
        document.removeEventListener('drop', clearDragState, true);
      };
    }, []);

    const transcribingSubtitleRowIndex = useVideoEditorStore(
      (state) => state.transcribingSubtitleRowIndex,
    );
    const isTranscribing = useVideoEditorStore((state) => state.isTranscribing);
    const addTrackFromMediaLibrary = useVideoEditorStore(
      (state) => state.addTrackFromMediaLibrary,
    );

    // Get all tracks from store for FPS calculation
    const allTracks = useVideoEditorStore((state) => state.tracks);
    const displayFps = useMemo(() => getDisplayFps(allTracks), [allTracks]);

    // Calculate grid interval that matches ruler ticks exactly
    const gridInterval = useMemo(
      () => getGridInterval(frameWidth, displayFps),
      [frameWidth, displayFps],
    );

    const parsedRow = useMemo(() => {
      const parsed = parseRowId(rowDef.id);
      if (!parsed) return { type: rowDef.trackTypes[0], rowIndex: 0 };
      return parsed;
    }, [rowDef.id, rowDef.trackTypes]);

    const isSubtitleRowTranscribing =
      rowDef.trackTypes.includes('subtitle') &&
      isTranscribing &&
      transcribingSubtitleRowIndex !== null &&
      parsedRow.rowIndex === transcribingSubtitleRowIndex;

    const hasTracks = tracks.length > 0;
    const isRowSelected = useMemo(
      () => tracks.some((track) => selectedTrackIds.includes(track.id)),
      [tracks, selectedTrackIds],
    );
    const rowBackgroundClass = isDragOver
      ? 'bg-secondary/10'
      : hasTracks
        ? isRowSelected
          ? 'bg-muted/40'
          : 'bg-muted/25'
        : 'bg-transparent';

    const skeletonHeightClass = getTrackItemHeightClasses(rowDef.id);

    const visibleTracks = useMemo(() => {
      if (!window || tracks.length === 0) return tracks;

      const viewportWidth = window.innerWidth;
      const viewportStart = scrollX;
      const viewportEnd = scrollX + viewportWidth;
      const bufferSize = viewportWidth * 0.5;

      return tracks.filter((track) => {
        const trackStart = track.startFrame * frameWidth;
        const trackEnd = track.endFrame * frameWidth;

        return (
          trackEnd >= viewportStart - bufferSize &&
          trackStart <= viewportEnd + bufferSize
        );
      });
    }, [tracks, scrollX, frameWidth, zoomLevel]);

    const handleDragOver = useCallback(
      (e: React.DragEvent) => {
        e.preventDefault();

        // Helper to detect subtitle files by extension
        const isSubtitleFile = (fileName: string): boolean => {
          const subtitleExtensions = [
            '.srt',
            '.vtt',
            '.ass',
            '.ssa',
            '.sub',
            '.sbv',
            '.lrc',
          ];
          return subtitleExtensions.some((ext) =>
            fileName.toLowerCase().endsWith(ext),
          );
        };

        // Check if this is an internal media drag (has application/json or text/plain)
        const hasMediaId = e.dataTransfer.types.includes('text/plain');
        const hasJson = e.dataTransfer.types.includes('application/json');
        const hasFiles = e.dataTransfer.types.includes('Files');

        // For internal drags, always allow (drop handler will validate)
        if (hasMediaId || hasJson) {
          e.dataTransfer.dropEffect = 'copy';
          setIsDragOver(true);
          return;
        }

        // MIXED MEDIA SUPPORT: Accept any valid media file, not just those matching this row
        // Files are routed to their appropriate track types automatically
        if (hasFiles) {
          const items = e.dataTransfer.items;
          let hasValidFile = false;

          for (let i = 0; i < items.length; i++) {
            const item = items[i];
            if (item.kind === 'file') {
              const file = item.getAsFile();
              const mimeType = item.type;

              // Check if file is any valid media type (video, audio, image, subtitle, text)
              if (
                mimeType.startsWith('video/') ||
                mimeType.startsWith('audio/') ||
                mimeType.startsWith('image/')
              ) {
                hasValidFile = true;
                break;
              }
              if (
                file &&
                (isSubtitleFile(file.name) ||
                  mimeType === 'application/x-subrip' ||
                  mimeType === 'text/vtt')
              ) {
                hasValidFile = true;
                break;
              }
              if (mimeType.startsWith('text/')) {
                hasValidFile = true;
                break;
              }
            }
          }

          if (hasValidFile) {
            e.dataTransfer.dropEffect = 'copy';
            setIsDragOver(true);
          } else {
            e.dataTransfer.dropEffect = 'none';
            setIsDragOver(false);
          }
          return;
        }

        // Default: allow drop
        e.dataTransfer.dropEffect = 'copy';
        setIsDragOver(true);
      },
      [rowDef.trackTypes],
    );

    const handleDragLeave = useCallback((e: React.DragEvent) => {
      e.preventDefault();
      setIsDragOver(false);
    }, []);

    const handleDrop = useCallback(
      async (e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        setIsDragOver(false);

        try {
          const payload = parseMediaDragPayload(e.dataTransfer);
          const parsedRow = parseRowId(rowDef.id);

          if (payload) {
            const rect = (
              e.currentTarget as HTMLElement
            ).getBoundingClientRect();
            const cursorX = e.clientX - rect.left + scrollX;
            const targetFrame = Math.max(0, Math.floor(cursorX / frameWidth));

            // Support multiple media items (for future multi-selection support)
            // Process each mediaId, allowing mixed types to be routed to appropriate rows
            const mediaIds = payload.mediaIds || [payload.mediaId];
            const mediaLibrary = useVideoEditorStore.getState().mediaLibrary;

            // Process each media item sequentially to ensure proper row allocation
            for (const mediaId of mediaIds) {
              const mediaItem = mediaLibrary?.find(
                (item: { id: string; type?: string; name?: string }) =>
                  item.id === mediaId,
              );

              if (!mediaItem) continue;

              const isSubtitleDrop =
                mediaItem.type === 'subtitle' ||
                (mediaItem.name || '').toLowerCase().endsWith('.srt') ||
                (mediaItem.name || '').toLowerCase().endsWith('.vtt');

              // Determine target row index based on media type
              // Each type goes to its own appropriate row, not the drop target row
              const targetRowIndex =
                mediaItem.type === parsedRow?.type
                  ? (parsedRow?.rowIndex ?? 0)
                  : undefined; // Let addTrackFromMediaLibrary determine the row

              if (isSubtitleDrop && onSubtitleImportAttempt) {
                const handled = await onSubtitleImportAttempt({
                  mediaId,
                  mediaName: mediaItem.name || 'Subtitles',
                  targetFrame,
                  targetRowIndex: targetRowIndex ?? 0,
                });

                if (handled) {
                  continue; // Skip to next media item
                }
              }

              try {
                await addTrackFromMediaLibrary(
                  mediaId,
                  targetFrame,
                  targetRowIndex,
                );
              } catch (error) {
                console.error(
                  `Failed to add media ${mediaId} to timeline:`,
                  error,
                );
              }
            }
            return;
          }

          if (e.dataTransfer.files) {
            onDrop(rowDef.id, e.dataTransfer.files);
          }
        } catch (error) {
          console.error('Error handling drop:', error);
        }
      },
      [
        rowDef.id,
        rowDef.trackTypes,
        onDrop,
        scrollX,
        frameWidth,
        addTrackFromMediaLibrary,
        onSubtitleImportAttempt,
      ],
    );

    const isBaseVideoRow = rowDef.id === 'video-0';

    // Grid opacity - single consistent value like professional editors
    const gridOpacity = isPlaceholder ? '0.06' : '0.1';

    // Calculate pixel spacing - matches ruler tick spacing exactly
    // MUST be integer to avoid sub-pixel glowing
    const gridSpacing = Math.round(gridInterval * frameWidth);

    // Build single gradient - aligns with ruler ticks
    const gridBackground = useMemo(() => {
      // Always show grid, even when dense (matches ruler behavior)
      if (gridSpacing < 2) return 'none';

      // Single 1px line at exact pixel boundaries
      return `repeating-linear-gradient(
        90deg,
        transparent 0px,
        transparent ${gridSpacing - 1}px,
        hsl(var(--foreground) / ${gridOpacity}) ${gridSpacing - 1}px,
        hsl(var(--foreground) / ${gridOpacity}) ${gridSpacing}px
      )`;
    }, [gridSpacing, gridOpacity]);

    return (
      <div
        className={cn(
          'relative border-l-[3px]',
          isPlaceholder ? 'h-12' : getRowHeightClasses(rowDef.id),
          isDragOver ? 'border-l-secondary' : 'border-l-transparent',
          isPlaceholder && 'border-l-transparent',
        )}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {!isPlaceholder && (hasTracks || isDragOver) && (
          <div
            className={cn(
              'absolute left-0 right-0 top-1/2 -translate-y-1/2 pointer-events-none z-0 rounded-md',
              getTrackItemHeightClasses(rowDef.id),
              rowBackgroundClass,
            )}
          />
        )}

        {/* Grid lines - adaptive based on zoom level */}
        {/* <div
          className="absolute top-0 h-full pointer-events-none"
          style={{
            left: 0,
            width: timelineWidth,
            background: gridBackground,
          }}
        /> */}

        <div className="h-full flex items-center relative z-10">
          {isSubtitleRowTranscribing ? (
            <div className="h-full w-full flex items-center gap-2 px-2">
              <Skeleton
                className={cn(skeletonHeightClass, 'w-[120px] rounded')}
              />
              <Skeleton
                className={cn(skeletonHeightClass, 'w-[80px] rounded')}
              />
              <Skeleton
                className={cn(skeletonHeightClass, 'w-[150px] rounded')}
              />
              <Skeleton
                className={cn(skeletonHeightClass, 'w-[100px] rounded')}
              />
              <Skeleton
                className={cn(skeletonHeightClass, 'w-[90px] rounded')}
              />
              <Skeleton
                className={cn(skeletonHeightClass, 'w-[110px] rounded')}
              />
              <Skeleton
                className={cn(skeletonHeightClass, 'w-[130px] rounded')}
              />
            </div>
          ) : (
            visibleTracks.map((track) => (
              <TrackItem
                key={`${track.id}-${track.source}-${track.name}`}
                track={track}
                frameWidth={frameWidth}
                zoomLevel={zoomLevel}
                isSelected={selectedTrackIds.includes(track.id)}
                onSelect={(multiSelect) => onTrackSelect(track.id, multiSelect)}
                onMove={(newStartFrame) => onTrackMove(track.id, newStartFrame)}
                onResize={(newStartFrame, newEndFrame) =>
                  onTrackResize(track.id, newStartFrame, newEndFrame)
                }
                isSplitModeActive={isSplitModeActive}
              />
            ))
          )}
          <TransitionBadges tracks={tracks} frameWidth={frameWidth} />
        </div>

        {isBaseVideoRow && !hasVideoTracks && (
          <div
            className={cn(
              'absolute inset-0 flex px-4 cursor-pointer transition-all duration-200 rounded-lg border-2 border-dashed',
              isDragOver
                ? 'border-secondary bg-secondary/10 text-secondary'
                : 'border-accent hover:border-secondary hover:bg-secondary/10 bg-accent text-muted-foreground hover:text-foreground',
              hasVideoTracks && 'items-center justify-center',
            )}
            onClick={onPlaceholderClick}
          >
            {isEmptyTimeline ? (
              <div className="flex items-center gap-2 text-xs">
                <Film className="h-4 w-4" />
                <span>Drag and drop your media here</span>
              </div>
            ) : (
              <div className="flex items-center">
                <Film className="h-4 w-4" />
              </div>
            )}
          </div>
        )}
      </div>
    );
  },
  (prevProps, nextProps) => {
    return (
      prevProps.rowDef.id === nextProps.rowDef.id &&
      prevProps.tracks.length === nextProps.tracks.length &&
      prevProps.tracks.every((track, index) => {
        const nextTrack = nextProps.tracks[index];
        return (
          track &&
          nextTrack &&
          track.id === nextTrack.id &&
          track.startFrame === nextTrack.startFrame &&
          track.endFrame === nextTrack.endFrame &&
          track.source === nextTrack.source &&
          track.name === nextTrack.name &&
          track.visible === nextTrack.visible &&
          track.locked === nextTrack.locked &&
          track.muted === nextTrack.muted &&
          track.volumeDb === nextTrack.volumeDb &&
          track.noiseReductionEnabled === nextTrack.noiseReductionEnabled &&
          track.isLinked === nextTrack.isLinked &&
          track.linkedTrackId === nextTrack.linkedTrackId &&
          track.previewUrl === nextTrack.previewUrl &&
          track.trackRowIndex === nextTrack.trackRowIndex &&
          track.mediaId === nextTrack.mediaId
        );
      }) &&
      prevProps.frameWidth === nextProps.frameWidth &&
      prevProps.timelineWidth === nextProps.timelineWidth &&
      prevProps.scrollX === nextProps.scrollX &&
      prevProps.zoomLevel === nextProps.zoomLevel &&
      JSON.stringify(prevProps.selectedTrackIds) ===
        JSON.stringify(nextProps.selectedTrackIds) &&
      prevProps.allTracksCount === nextProps.allTracksCount &&
      prevProps.isSplitModeActive === nextProps.isSplitModeActive &&
      prevProps.isEmptyTimeline === nextProps.isEmptyTimeline &&
      prevProps.hasVideoTracks === nextProps.hasVideoTracks &&
      prevProps.isPlaceholder === nextProps.isPlaceholder
    );
  },
);

// Placeholder row definition for empty space
const PLACEHOLDER_ROW_HEIGHT = 48;

interface PlaceholderRowDef {
  id: string;
  type: 'placeholder';
  position: 'above' | 'below';
}

export const TimelineTracks: React.FC<TimelineTracksProps> = React.memo(
  ({
    tracks,
    frameWidth,
    timelineWidth,
    scrollX,
    zoomLevel,
    selectedTrackIds,
    onTrackSelect,
    isSplitModeActive,
  }) => {
    const {
      moveTrack,
      moveSelectedTracks,
      resizeTrack,
      importMediaToTimeline,
      importMediaFromDrop,
      addTrackFromMediaLibrary,
      importMediaFromDialog,
      beginGroup,
      endGroup,
      removeTrack,
    } = useVideoEditorStore();

    const visibleTrackRows = useVideoEditorStore(
      (state) => state.timeline.visibleTrackRows || ['video', 'audio'],
    );
    const transcribingSubtitleRowIndex = useVideoEditorStore(
      (state) => state.transcribingSubtitleRowIndex,
    );

    const isEmptyTimeline = tracks.length === 0;
    const hasVideoTracks = tracks.some((track) => track.type === 'video');

    // Calculate grid interval that matches ruler ticks exactly
    const displayFps = useMemo(() => getDisplayFps(tracks), [tracks]);
    const placeholderGridInterval = useMemo(
      () => getGridInterval(frameWidth, displayFps),
      [frameWidth, displayFps],
    );

    // Calculate pixel spacing - matches ruler tick spacing exactly
    const placeholderGridSpacing = Math.round(
      placeholderGridInterval * frameWidth,
    );

    // Build single gradient for placeholder grids - aligns with ruler ticks
    const placeholderGridBackground = useMemo(() => {
      if (placeholderGridSpacing < 2) return 'none';

      return `repeating-linear-gradient(
        90deg,
        transparent 0px,
        transparent ${placeholderGridSpacing - 1}px,
        hsl(var(--foreground) / 0.06) ${placeholderGridSpacing - 1}px,
        hsl(var(--foreground) / 0.06) ${placeholderGridSpacing}px
      )`;
    }, [placeholderGridSpacing]);

    const migratedTracks = useMemo(
      () => migrateTracksWithRowIndex(tracks),
      [tracks],
    );

    const dynamicRows = useMemo(
      () =>
        generateDynamicRows(migratedTracks, {
          transcribingSubtitleRowIndex,
        }),
      [migratedTracks, transcribingSubtitleRowIndex],
    );

    const [subtitleImportConfirmation, setSubtitleImportConfirmation] =
      useState<{
        show: boolean;
        mediaId: string | null;
        mediaName: string;
        targetFrame: number;
        generatedSubtitleIds: string[];
      }>({
        show: false,
        mediaId: null,
        mediaName: '',
        targetFrame: 0,
        generatedSubtitleIds: [],
      });

    // Calculate placeholder rows needed
    const MAX_PLACEHOLDER_ROWS = 1;

    const { placeholderRowsAbove, placeholderRowsBelow, totalHeight } =
      useMemo(() => {
        // Calculate total height of dynamic rows
        const dynamicRowsHeight = dynamicRows.reduce((sum, row) => {
          const mediaType = row.trackTypes[0];
          return sum + getRowHeight(mediaType);
        }, 0);

        // Calculate how many extra rows we have beyond base (video-0, audio-0)
        const baseRowCount = 2;
        const extraRowsCount = Math.max(0, dynamicRows.length - baseRowCount);
        const remainingPlaceholders = Math.max(
          0,
          MAX_PLACEHOLDER_ROWS - extraRowsCount,
        );

        // Distribute placeholders: 2 above, 1 below (or however many remain)
        const above = Math.min(2, remainingPlaceholders);
        const below = Math.max(0, remainingPlaceholders - 2);

        const placeholderHeight = (above + below) * PLACEHOLDER_ROW_HEIGHT;

        return {
          placeholderRowsAbove: above,
          placeholderRowsBelow: below,
          totalHeight: dynamicRowsHeight + placeholderHeight,
        };
      }, [dynamicRows]);

    const handleTrackSelect = useCallback(
      (trackId: string, multiSelect = false) => {
        const { tracks: allTracks, timeline } = useVideoEditorStore.getState();
        const currentSelectedTrackIds = timeline.selectedTrackIds;
        const selectedTrack = allTracks.find((t) => t.id === trackId);

        const tracksToSelect = [trackId];
        if (selectedTrack?.isLinked && selectedTrack.linkedTrackId) {
          tracksToSelect.push(selectedTrack.linkedTrackId);
          console.log(
            `🔗 Selecting linked track pair: ${trackId} and ${selectedTrack.linkedTrackId}`,
          );
        }

        if (multiSelect) {
          let newSelection = [...currentSelectedTrackIds];

          const isCurrentlySelected = tracksToSelect.some((id) =>
            currentSelectedTrackIds.includes(id),
          );
          if (isCurrentlySelected) {
            newSelection = newSelection.filter(
              (id) => !tracksToSelect.includes(id),
            );
          } else {
            tracksToSelect.forEach((id) => {
              if (!newSelection.includes(id)) {
                newSelection.push(id);
              }
            });
          }
          onTrackSelect(newSelection);
        } else {
          onTrackSelect(tracksToSelect);
        }
      },
      [onTrackSelect],
    );

    const handleSubtitleDialogOpenChange = useCallback((open: boolean) => {
      if (!open) {
        setSubtitleImportConfirmation({
          show: false,
          mediaId: null,
          mediaName: '',
          targetFrame: 0,
          generatedSubtitleIds: [],
        });
      }
    }, []);

    const handleConfirmSubtitleImport = useCallback(
      async (deleteExisting: boolean) => {
        if (!subtitleImportConfirmation.mediaId) {
          handleSubtitleDialogOpenChange(false);
          return;
        }

        const { mediaId, mediaName, targetFrame, generatedSubtitleIds } =
          subtitleImportConfirmation;

        if (deleteExisting) {
          beginGroup?.(`Import Subtitles for ${mediaName}`);
        }

        try {
          if (deleteExisting && generatedSubtitleIds.length > 0) {
            generatedSubtitleIds.forEach((id) => removeTrack(id));
          }

          const latestTracks = (
            useVideoEditorStore.getState() as { tracks: VideoTrack[] }
          ).tracks;
          const subtitleRowIndex = getNextAvailableRowIndex(
            latestTracks,
            'subtitle',
          );

          await addTrackFromMediaLibrary(
            mediaId,
            targetFrame,
            subtitleRowIndex,
          );
        } finally {
          if (deleteExisting) {
            endGroup?.();
          }
          handleSubtitleDialogOpenChange(false);
        }
      },
      [
        subtitleImportConfirmation,
        handleSubtitleDialogOpenChange,
        beginGroup,
        removeTrack,
        addTrackFromMediaLibrary,
        endGroup,
      ],
    );

    const handleSubtitleImportAttempt = useCallback(
      async ({
        mediaId,
        mediaName,
        targetFrame,
      }: {
        mediaId: string;
        mediaName: string;
        targetFrame: number;
        targetRowIndex: number;
      }) => {
        const state = useVideoEditorStore.getState() as {
          tracks: VideoTrack[];
          mediaLibrary?: Array<{ id: string; type?: string; name?: string }>;
        };
        const mediaItem = state.mediaLibrary?.find(
          (item) => item.id === mediaId,
        );

        const isSubtitle =
          mediaItem?.type === 'subtitle' ||
          (mediaItem?.name || '').toLowerCase().endsWith('.srt') ||
          (mediaItem?.name || '').toLowerCase().endsWith('.vtt');

        if (!isSubtitle) {
          return false;
        }

        const generatedSubtitles = (state.tracks as VideoTrack[]).filter(
          (track) =>
            track.type === 'subtitle' && track.subtitleType === 'karaoke',
        );

        if (generatedSubtitles.length === 0) {
          return false;
        }

        setSubtitleImportConfirmation({
          show: true,
          mediaId,
          mediaName,
          targetFrame,
          generatedSubtitleIds: generatedSubtitles.map((t) => t.id),
        });

        return true;
      },
      [],
    );

    const handleTrackMove = useCallback(
      (trackId: string, newStartFrame: number) => {
        const { timeline, playback } = useVideoEditorStore.getState();
        const selectedTrackIds = timeline.selectedTrackIds;
        const dragGhost = playback.dragGhost;

        const tracksBeingDragged =
          dragGhost?.selectedTrackIds || selectedTrackIds;

        if (
          tracksBeingDragged.length > 1 &&
          tracksBeingDragged.includes(trackId)
        ) {
          moveSelectedTracks(trackId, newStartFrame);
        } else {
          moveTrack(trackId, newStartFrame);
        }
      },
      [moveTrack, moveSelectedTracks],
    );

    const handleTrackResize = useCallback(
      (trackId: string, newStartFrame?: number, newEndFrame?: number) => {
        resizeTrack(trackId, newStartFrame, newEndFrame);
      },
      [resizeTrack],
    );

    const handleRowDrop = useCallback(
      async (rowId: string, files: FileList) => {
        const fileArray = Array.from(files);
        const rowDef = dynamicRows.find((row) => row.id === rowId);

        if (!rowDef) return;

        // Helper to detect subtitle files by extension
        const isSubtitleFile = (fileName: string): boolean => {
          const subtitleExtensions = [
            '.srt',
            '.vtt',
            '.ass',
            '.ssa',
            '.sub',
            '.sbv',
            '.lrc',
          ];
          return subtitleExtensions.some((ext) =>
            fileName.toLowerCase().endsWith(ext),
          );
        };

        // Helper to detect file type
        const getFileMediaType = (
          file: File,
        ): 'video' | 'audio' | 'image' | 'subtitle' | 'text' | null => {
          if (file.type.startsWith('video/')) return 'video';
          if (file.type.startsWith('audio/')) return 'audio';
          if (file.type.startsWith('image/')) return 'image';
          if (
            isSubtitleFile(file.name) ||
            file.type === 'application/x-subrip' ||
            file.type === 'text/vtt'
          ) {
            return 'subtitle';
          }
          if (file.type.startsWith('text/')) return 'text';
          return null;
        };

        // MIXED MEDIA SUPPORT: Accept ALL valid media files, not just those matching the target row
        // Files are routed to their appropriate track types automatically by addTrackFromMediaLibrary
        // This enables dropping mixed selections (video + subtitle, etc.) on any row
        const validFiles = fileArray.filter((file) => {
          const mediaType = getFileMediaType(file);
          return mediaType !== null;
        });

        if (validFiles.length > 0) {
          try {
            await importMediaUnified(
              validFiles,
              'timeline-drop',
              {
                importMediaFromDrop,
                importMediaToTimeline,
                addTrackFromMediaLibrary,
              },
              { addToTimeline: true, showToasts: true },
            );
          } catch (error) {
            console.error('Failed to import dropped files:', error);
          }
        }
      },
      [
        importMediaFromDrop,
        importMediaToTimeline,
        addTrackFromMediaLibrary,
        dynamicRows,
      ],
    );

    const handlePlaceholderClick = useCallback(async () => {
      await importMediaFromDialogUnified(
        importMediaFromDialog,
        {
          importMediaFromDrop,
          importMediaToTimeline,
          addTrackFromMediaLibrary,
        },
        { addToTimeline: true, showToasts: true },
      );
    }, [
      importMediaFromDialog,
      importMediaFromDrop,
      importMediaToTimeline,
      addTrackFromMediaLibrary,
    ]);

    // Group tracks by their designated rows
    const tracksByRow = useMemo(() => {
      const grouped: Record<string, VideoTrack[]> = {};

      dynamicRows.forEach((row) => {
        grouped[row.id] = [];
      });

      migratedTracks.forEach((track) => {
        const rowId = getTrackRowId(track);
        if (!grouped[rowId]) {
          grouped[rowId] = [];
        }
        grouped[rowId].push(track);
      });

      dynamicRows.forEach((row) => {
        if (
          row.trackTypes.includes('subtitle') &&
          grouped[row.id] &&
          grouped[row.id].length > 0
        ) {
          grouped[row.id].sort((a, b) => a.startFrame - b.startFrame);
        }
      });

      return grouped;
    }, [migratedTracks, dynamicRows]);

    const memoizedHandlers = useMemo(
      () => ({
        onTrackSelect: (trackId: string, multiSelect?: boolean) =>
          handleTrackSelect(trackId, multiSelect || false),
        onTrackMove: handleTrackMove,
        onTrackResize: handleTrackResize,
        onDrop: handleRowDrop,
        onPlaceholderClick: handlePlaceholderClick,
      }),
      [
        handleTrackSelect,
        handleTrackMove,
        handleTrackResize,
        handleRowDrop,
        handlePlaceholderClick,
      ],
    );

    // Filter dynamic rows to only show visible ones
    const visibleRows = dynamicRows.filter((row) => {
      const mediaType = row.trackTypes[0];
      return visibleTrackRows.includes(mediaType);
    });

    const placeholderRowDefsBelow: PlaceholderRowDef[] = useMemo(() => {
      return Array.from({ length: placeholderRowsBelow }, (_, i) => ({
        id: `placeholder-below-${i}`,
        type: 'placeholder' as const,
        position: 'below' as const,
      }));
    }, [placeholderRowsBelow]);

    const [placeholderHoverId, setPlaceholderHoverId] = useState<string | null>(
      null,
    );

    // Global safety net to clear hover highlight if drag ends elsewhere
    useEffect(() => {
      const clearHover = () => setPlaceholderHoverId(null);
      document.addEventListener('drop', clearHover, true);
      document.addEventListener('dragend', clearHover, true);
      document.addEventListener('dragleave', clearHover, true);
      return () => {
        document.removeEventListener('drop', clearHover, true);
        document.removeEventListener('dragend', clearHover, true);
        document.removeEventListener('dragleave', clearHover, true);
      };
    }, []);

    const handlePlaceholderDrop = () => async (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setPlaceholderHoverId(null);

      try {
        const payload = parseMediaDragPayload(e.dataTransfer);

        if (payload) {
          // Handle media library drops (supports multiple media items)
          const scrollContainer = (e.currentTarget as HTMLElement).closest(
            '.overflow-auto',
          ) as HTMLElement | null;
          const scrollLeft = scrollContainer?.scrollLeft || 0;
          const scrollTop = scrollContainer?.scrollTop || 0;
          const rect =
            scrollContainer?.getBoundingClientRect() ||
            (e.currentTarget as HTMLElement).getBoundingClientRect();

          const cursorX = e.clientX - rect.left + scrollLeft;
          const cursorY = e.clientY - rect.top + scrollTop;

          const targetFrame = Math.max(0, Math.floor(cursorX / frameWidth));

          const rowBounds = calculateRowBoundsWithPlaceholders(
            dynamicRows,
            visibleTrackRows,
            placeholderRowsAbove,
            placeholderRowsBelow,
            PLACEHOLDER_ROW_HEIGHT,
          );

          // Support multiple media items (for future multi-selection support)
          const mediaIds = payload.mediaIds || [payload.mediaId];
          const mediaLibrary = useVideoEditorStore.getState().mediaLibrary;

          // Process each media item sequentially for proper row allocation
          for (const mediaId of mediaIds) {
            const mediaItem = mediaLibrary?.find(
              (item: { id: string; type?: string }) => item.id === mediaId,
            );
            const mediaType =
              (mediaItem?.type as VideoTrack['type']) || 'video';

            const insertion = detectInsertionPoint(
              cursorY,
              rowBounds,
              mediaType,
              tracks,
            );

            let targetRowIndex: number | null = null;
            if (insertion) {
              targetRowIndex =
                insertion.existingRowId &&
                parseRowId(insertion.existingRowId)?.rowIndex !== undefined
                  ? parseRowId(insertion.existingRowId)?.rowIndex || null
                  : insertion.targetRowIndex;
            }

            if (targetRowIndex === null) {
              const fallbackRow = rowBounds.find(
                (row) => row.type === mediaType,
              );
              targetRowIndex = fallbackRow?.rowIndex ?? 0;
            }

            try {
              await addTrackFromMediaLibrary(
                mediaId,
                targetFrame,
                targetRowIndex ?? 0,
              );
            } catch (error) {
              console.error(
                `Failed to add media ${mediaId} to timeline:`,
                error,
              );
            }
          }
          return;
        }

        // Handle external file drops from OS file browser
        const files = e.dataTransfer.files;
        if (files && files.length > 0) {
          const fileArray = Array.from(files);

          // Import all dropped files to timeline using the unified import pipeline
          await importMediaUnified(
            fileArray,
            'timeline-drop',
            {
              importMediaFromDrop,
              importMediaToTimeline,
              addTrackFromMediaLibrary,
            },
            { addToTimeline: true, showToasts: true },
          );
        }
      } catch (error) {
        console.error('Error handling placeholder drop:', error);
      }
    };

    return (
      <div
        className="relative overflow-visible"
        style={{
          width: timelineWidth,
          minWidth: timelineWidth,
          minHeight: `${totalHeight}px`,
        }}
      >
        <div
          className="relative flex flex-col"
          style={{
            width: '100%',
            minHeight: `${totalHeight}px`,
          }}
        >
          {/* Placeholder rows above */}
          {Array.from({ length: placeholderRowsAbove }, (_, i) => {
            const id = `placeholder-above-${i}`;
            const isHover = placeholderHoverId === id;
            return (
              <div
                key={id} // Distinct key prevents confusion
                className={cn(
                  'relative h-12 border-l-[3px] border-l-transparent',
                  isHover ? 'bg-secondary/10' : '',
                )}
                onDragOver={(e) => {
                  e.preventDefault();
                  e.dataTransfer.dropEffect = 'copy';
                  setPlaceholderHoverId(id);
                }}
                onDragLeave={() => {
                  setPlaceholderHoverId((prev) => (prev === id ? null : prev));
                }}
                onDrop={handlePlaceholderDrop}
              >
                {/* Grid lines - adaptive based on zoom level */}
                {/* <div
                  className="absolute top-0 h-full pointer-events-none"
                  style={{
                    left: 0,
                    width: timelineWidth,
                    background: placeholderGridBackground,
                  }}
                /> */}
              </div>
            );
          })}

          {/* Actual track rows */}
          {visibleRows.map((rowDef) => {
            const isVideoZero = rowDef.id === 'video-0';

            return (
              <div
                key={rowDef.id}
              >
                <TrackRow
                  rowDef={rowDef}
                  tracks={tracksByRow[rowDef.id] || []}
                  frameWidth={frameWidth}
                  timelineWidth={timelineWidth}
                  scrollX={scrollX}
                  zoomLevel={zoomLevel}
                  selectedTrackIds={selectedTrackIds}
                  onTrackSelect={memoizedHandlers.onTrackSelect}
                  onTrackMove={memoizedHandlers.onTrackMove}
                  onTrackResize={memoizedHandlers.onTrackResize}
                  onDrop={memoizedHandlers.onDrop}
                  onSubtitleImportAttempt={handleSubtitleImportAttempt}
                  allTracksCount={tracks.length}
                  onPlaceholderClick={memoizedHandlers.onPlaceholderClick}
                  isSplitModeActive={isSplitModeActive}
                  isEmptyTimeline={isEmptyTimeline}
                  hasVideoTracks={hasVideoTracks}
                />
              </div>
            );
          })}

          {/* Placeholder rows below */}
          {placeholderRowDefsBelow.map((placeholder) => {
            const isHover = placeholderHoverId === placeholder.id;
            return (
              <div
                key={placeholder.id}
                className={cn(
                  'relative h-12 border-l-[3px] border-l-transparent',
                  isHover ? 'bg-secondary/10' : '',
                )}
                onDragOver={(e) => {
                  e.preventDefault();
                  e.dataTransfer.dropEffect = 'copy';
                  setPlaceholderHoverId(placeholder.id);
                }}
                onDragLeave={() => {
                  setPlaceholderHoverId((prev) =>
                    prev === placeholder.id ? null : prev,
                  );
                }}
                onDrop={handlePlaceholderDrop}
              >
                {/* Grid lines - adaptive based on zoom level */}
                {/* <div
                  className="absolute top-0 h-full pointer-events-none"
                  style={{
                    left: 0,
                    width: timelineWidth,
                    background: placeholderGridBackground,
                  }}
                /> */}
              </div>
            );
          })}

          <KaraokeConfirmationDialog
            open={subtitleImportConfirmation.show}
            onOpenChange={handleSubtitleDialogOpenChange}
            mediaName={subtitleImportConfirmation.mediaName}
            existingSubtitleCount={
              subtitleImportConfirmation.generatedSubtitleIds.length
            }
            onConfirm={handleConfirmSubtitleImport}
            mode="import"
          />
        </div>
      </div>
    );
  },
  (prevProps, nextProps) => {
    return (
      prevProps.tracks.length === nextProps.tracks.length &&
      prevProps.tracks.every((track, index) => {
        const nextTrack = nextProps.tracks[index];
        return (
          track &&
          nextTrack &&
          track.id === nextTrack.id &&
          track.startFrame === nextTrack.startFrame &&
          track.endFrame === nextTrack.endFrame &&
          track.source === nextTrack.source &&
          track.name === nextTrack.name &&
          track.visible === nextTrack.visible &&
          track.locked === nextTrack.locked &&
          track.muted === nextTrack.muted &&
          track.volumeDb === nextTrack.volumeDb &&
          track.noiseReductionEnabled === nextTrack.noiseReductionEnabled &&
          track.isLinked === nextTrack.isLinked &&
          track.linkedTrackId === nextTrack.linkedTrackId &&
          track.previewUrl === nextTrack.previewUrl &&
          track.trackRowIndex === nextTrack.trackRowIndex &&
          track.mediaId === nextTrack.mediaId
        );
      }) &&
      prevProps.frameWidth === nextProps.frameWidth &&
      prevProps.timelineWidth === nextProps.timelineWidth &&
      prevProps.scrollX === nextProps.scrollX &&
      prevProps.zoomLevel === nextProps.zoomLevel &&
      JSON.stringify(prevProps.selectedTrackIds) ===
        JSON.stringify(nextProps.selectedTrackIds) &&
      prevProps.isSplitModeActive === nextProps.isSplitModeActive
    );
  },
);
