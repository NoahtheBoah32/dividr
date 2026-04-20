import {
  SpriteSheet,
  SpriteSheetThumbnail,
} from '@/backend/frontend_use/videoSpriteSheetGenerator';
import { cn } from '@/frontend/utils/utils';
import { Loader2 } from 'lucide-react';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useSpriteSheetProgress } from '../../editor/hooks/useMediaReadiness';
import { useVideoEditorStore, VideoTrack } from '../stores/videoEditor/index';
import { getDisplayFps } from '../stores/videoEditor/types/timeline.types';
import { SPRITE_SHEET_SKIP_DURATION_SECONDS } from './utils/timelineConstants';

interface VideoSpriteSheetStripProps {
  track: VideoTrack;
  frameWidth: number;
  width: number;
  height: number;
  zoomLevel: number;
  /** Render full strip without timeline viewport culling (used by drag ghost). */
  renderWithoutViewportCulling?: boolean;
}

interface SpriteSheetStripState {
  spriteSheets: SpriteSheet[];
  isLoading: boolean;
  error: string | null;
}

// Hybrid tile structure - maintains tiling concept but optimized for rendering
interface HybridTile {
  id: string;
  thumbnail: SpriteSheetThumbnail;
  tileStartX: number; // Where this specific tile starts
  tileWidth: number; // Width of this specific tile
  repeatIndex: number; // Which repeat of the thumbnail this is
  clipOffset: number; // How much to offset the background for partial tiles
}

// LOD presets tuned for timeline zoom levels (pixels per second)
const SPRITE_LOD_PRESETS = [
  { maxPixelsPerSecond: 12, strideFactor: 3, maxTiles: 24 }, // zoomed out
  { maxPixelsPerSecond: 30, strideFactor: 2, maxTiles: 36 }, // medium
  { maxPixelsPerSecond: 90, strideFactor: 1, maxTiles: 48 }, // zoomed in
  { maxPixelsPerSecond: Infinity, strideFactor: 1, maxTiles: 60 }, // extreme
];

const HARD_MAX_TILES = 60;
const MIN_TILES_TARGET = 20;
const VIEWPORT_BUFFER_MULTIPLIER = 0.5;

const getSpriteLodConfig = (pixelsPerSecond: number) => {
  for (const preset of SPRITE_LOD_PRESETS) {
    if (pixelsPerSecond <= preset.maxPixelsPerSecond) {
      return preset;
    }
  }
  return SPRITE_LOD_PRESETS[SPRITE_LOD_PRESETS.length - 1];
};

// Placeholder for tiles from sprite sheets not yet generated (progressive loading)
const PlaceholderTile: React.FC<{
  tileStartX: number;
  tileWidth: number;
  height: number;
}> = React.memo(({ tileStartX, tileWidth, height }) => (
  <div
    className="absolute top-0 bg-gray-700/40"
    style={{
      transform: `translate3d(${tileStartX}px, 0, 0)`,
      width: tileWidth,
      height,
      willChange: 'transform',
    }}
  />
));
PlaceholderTile.displayName = 'PlaceholderTile';

// GPU-accelerated sprite renderer component
const GPUAcceleratedSprite: React.FC<{
  tile: HybridTile;
  spriteSheet: SpriteSheet;
  height: number;
}> = React.memo(
  ({ tile, spriteSheet, height }) => {
    const { thumbnail, tileStartX, tileWidth, clipOffset } = tile;

    // Calculate display metrics
    const scale = height / thumbnail.height;
    const baseThumbWidth = thumbnail.width * scale;
    const spriteWidth = spriteSheet.width * scale;
    const spriteHeight = spriteSheet.height * scale;
    const bgX = thumbnail.x * scale;
    const bgY = thumbnail.y * scale;
    const repeatCount = Math.max(1, Math.ceil(tileWidth / baseThumbWidth));

    // Use transform for positioning (GPU accelerated)
    const transform = `translate3d(${tileStartX}px, 0, 0)`;

    return (
      <div
        className="absolute top-0"
        style={{
          transform,
          width: `${tileWidth}px`,
          height: `${height}px`,
          willChange: 'transform',
          contain: 'layout style paint',
          overflow: 'hidden',
        }}
      >
        {Array.from({ length: repeatCount }).map((_, index) => {
          const left = index * baseThumbWidth;
          const remainingWidth = tileWidth - left;
          if (remainingWidth <= 0) return null;
          const drawWidth = Math.min(baseThumbWidth, remainingWidth);

          return (
            <div
              key={`${tile.id}-repeat-${index}`}
              className="absolute"
              style={{
                width: `${drawWidth}px`,
                height: `${height}px`,
                left: `${left - clipOffset}px`,
                backgroundImage: `url(${spriteSheet.url})`,
                backgroundSize: `${spriteWidth}px ${spriteHeight}px`,
                backgroundPosition: `-${bgX}px -${bgY}px`,
                imageRendering: 'auto',
              }}
            />
          );
        })}
      </div>
    );
  },
  (prev, next) => {
    // Only re-render if actual visual changes
    return (
      prev.tile.id === next.tile.id &&
      Math.abs(prev.tile.tileStartX - next.tile.tileStartX) < 1 &&
      Math.abs(prev.tile.tileWidth - next.tile.tileWidth) < 1 &&
      prev.height === next.height
    );
  },
);

export const VideoSpriteSheetStrip: React.FC<VideoSpriteSheetStripProps> =
  React.memo(
    ({
      track,
      frameWidth,
      width,
      height,
      zoomLevel,
      renderWithoutViewportCulling = false,
    }) => {
      const selectedTrackIds = useVideoEditorStore(
        (state) => state.timeline.selectedTrackIds,
      );
      const isSelected = selectedTrackIds.includes(track.id);
      const containerRef = useRef<HTMLDivElement>(null);
      const [state, setState] = useState<SpriteSheetStripState>({
        spriteSheets: [],
        isLoading: false,
        error: null,
      });

      // Viewport state for culling (timeline scroll container)
      const [viewportBounds, setViewportBounds] = useState({
        scrollLeft: 0,
        viewportWidth: 0,
      });
      const rafRef = useRef<number>(0);

      const getSpriteSheetsBySource = useVideoEditorStore(
        (state) => state.getSpriteSheetsBySource,
      );
      const allTracks = useVideoEditorStore((state) => state.tracks);
      // Get display FPS from source video tracks (dynamic but static once determined)
      const displayFps = useMemo(() => getDisplayFps(allTracks), [allTracks]);

      const trackMetrics = useMemo(
        () => ({
          durationFrames: track.endFrame - track.startFrame,
          durationSeconds: (track.endFrame - track.startFrame) / displayFps,
          trackStartTime: track.sourceStartTime || 0,
          pixelsPerSecond: frameWidth * displayFps,
          trackStartPx: track.startFrame * frameWidth,
        }),
        [
          track.startFrame,
          track.endFrame,
          track.sourceStartTime,
          displayFps,
          frameWidth,
        ],
      );

      const shouldRenderSprites =
        trackMetrics.durationSeconds <= SPRITE_SHEET_SKIP_DURATION_SECONDS;

      // Progressive loading: Track sprite sheet generation progress
      const { completedSheets, totalSheets, isComplete } =
        useSpriteSheetProgress(track.mediaId);

      const mediaLibrary = useVideoEditorStore((state) => state.mediaLibrary);
      const mediaItem = useMemo(() => {
        return mediaLibrary.find(
          (m) =>
            m.source === track.source ||
            (track.mediaId && m.id === track.mediaId),
        );
      }, [mediaLibrary, track.source, track.mediaId]);

      const isTranscoding = useMemo(() => {
        return (
          mediaItem?.transcoding?.status === 'processing' ||
          mediaItem?.transcoding?.status === 'pending'
        );
      }, [mediaItem]);

      const allThumbnails = useMemo(() => {
        if (!shouldRenderSprites) return [];
        const flattened = state.spriteSheets.flatMap(
          (sheet) => sheet.thumbnails,
        );
        if (flattened.length <= 1) return flattened;

        const isSorted = flattened.every((thumb, index) => {
          if (index === 0) return true;
          return flattened[index - 1].timestamp <= thumb.timestamp;
        });

        if (isSorted) return flattened;
        return [...flattened].sort((a, b) => a.timestamp - b.timestamp);
      }, [shouldRenderSprites, state.spriteSheets]);

      // Visible tiles are generated on-demand for the viewport range only.
      const visibleTiles = useMemo(() => {
        if (!shouldRenderSprites) return [];
        if (allThumbnails.length === 0) return [];

        const { trackStartTime, pixelsPerSecond, trackStartPx } = trackMetrics;
        if (pixelsPerSecond <= 0) return [];

        const viewportWidth = renderWithoutViewportCulling
          ? width
          : viewportBounds.viewportWidth;
        if (viewportWidth <= 0) return [];

        const effectiveScrollLeft = renderWithoutViewportCulling
          ? trackStartPx
          : viewportBounds.scrollLeft;
        const viewportStart = effectiveScrollLeft - trackStartPx;
        const viewportEnd = effectiveScrollLeft + viewportWidth - trackStartPx;
        const buffer = viewportWidth * VIEWPORT_BUFFER_MULTIPLIER;

        const visibleStart = Math.max(0, viewportStart - buffer);
        const visibleEnd = Math.min(width, viewportEnd + buffer);

        if (visibleEnd <= 0 || visibleStart >= width) return [];

        // Native thumbnail display width (constant size)
        const firstThumb = allThumbnails[0];
        const aspectRatio = firstThumb.width / firstThumb.height;
        const nativeDisplayWidth = aspectRatio * height;

        // LOD selection based on zoom (pixels per second)
        const lod = getSpriteLodConfig(pixelsPerSecond);
        const maxTiles = Math.min(lod.maxTiles, HARD_MAX_TILES);
        const minTiles = Math.min(MIN_TILES_TARGET, maxTiles);

        const rangeWidth = Math.max(1, visibleEnd - visibleStart);
        const baseStride = nativeDisplayWidth * lod.strideFactor;
        const minStrideForMax = rangeWidth / maxTiles;
        let tileStride = Math.max(baseStride, minStrideForMax, 1);

        // Optional soft lower bound to avoid too few tiles (without overlapping)
        const maxStrideForMin = rangeWidth / minTiles;
        if (
          tileStride > maxStrideForMin &&
          maxStrideForMin >= nativeDisplayWidth
        ) {
          tileStride = maxStrideForMin;
        }

        const startIndex = Math.max(0, Math.floor(visibleStart / tileStride));
        const endIndex = Math.min(
          Math.ceil(visibleEnd / tileStride),
          Math.ceil(width / tileStride),
        );

        const tiles: HybridTile[] = [];
        let tileCount = 0;

        for (let i = startIndex; i <= endIndex; i++) {
          if (tileCount >= maxTiles) break;
          const tileStartX = i * tileStride;
          if (tileStartX >= width) break;

          const currentTimeInTrack = tileStartX / pixelsPerSecond;
          const currentTimeAbsolute = trackStartTime + currentTimeInTrack;

          // Binary search for closest thumbnail at or before current time
          let closestThumbnail = allThumbnails[0];
          let left = 0;
          let right = allThumbnails.length - 1;

          while (left <= right) {
            const mid = Math.floor((left + right) / 2);
            if (allThumbnails[mid].timestamp <= currentTimeAbsolute) {
              closestThumbnail = allThumbnails[mid];
              left = mid + 1;
            } else {
              right = mid - 1;
            }
          }

          const tileWidth = Math.min(tileStride, width - tileStartX);
          if (tileWidth <= 0.5) continue;

          tiles.push({
            id: `tile-${lod.maxTiles}-${i}-${closestThumbnail.id}`,
            thumbnail: closestThumbnail,
            tileStartX,
            tileWidth,
            repeatIndex: i,
            clipOffset: 0,
          });
          tileCount++;
        }

        return tiles;
      }, [
        shouldRenderSprites,
        allThumbnails,
        trackMetrics,
        viewportBounds,
        renderWithoutViewportCulling,
        width,
        height,
      ]);

      // Update viewport bounds on scroll/zoom (rAF-throttled)
      useEffect(() => {
        const scrollContainer = containerRef.current?.closest(
          '.overflow-auto',
        ) as HTMLElement | null;
        if (!scrollContainer) return;

        const updateViewport = () => {
          setViewportBounds({
            scrollLeft: scrollContainer.scrollLeft || 0,
            viewportWidth: scrollContainer.clientWidth || 0,
          });
        };

        const scheduleUpdate = () => {
          if (rafRef.current) cancelAnimationFrame(rafRef.current);
          rafRef.current = requestAnimationFrame(updateViewport);
        };

        scrollContainer.addEventListener('scroll', scheduleUpdate, {
          passive: true,
        });
        updateViewport();

        return () => {
          scrollContainer.removeEventListener('scroll', scheduleUpdate);
          if (rafRef.current) cancelAnimationFrame(rafRef.current);
        };
      }, []);

      // Refresh viewport on zoom/size changes
      useEffect(() => {
        const scrollContainer = containerRef.current?.closest(
          '.overflow-auto',
        ) as HTMLElement | null;
        if (!scrollContainer) return;

        if (rafRef.current) cancelAnimationFrame(rafRef.current);
        rafRef.current = requestAnimationFrame(() => {
          setViewportBounds({
            scrollLeft: scrollContainer.scrollLeft || 0,
            viewportWidth: scrollContainer.clientWidth || 0,
          });
        });
      }, [width, zoomLevel, track.startFrame, frameWidth]);

      // CONSUME-ONLY: Read sprite sheets from store, never trigger generation
      // Generation is handled by mediaLibrarySlice during import
      // CRITICAL: Support progressive loading - don't require success=true
      // Sprite sheets are added progressively as they complete, before success is set
      const storeSpriteSheets = useMemo(() => {
        // First check from store via getSpriteSheetsBySource
        const preloaded = getSpriteSheetsBySource(track.source);
        // Return sprite sheets even during progressive loading (success may be false)
        if (preloaded?.spriteSheets && preloaded.spriteSheets.length > 0) {
          return preloaded.spriteSheets;
        }

        // Fallback to mediaItem.spriteSheets - also support progressive loading
        if (mediaItem?.spriteSheets?.spriteSheets?.length) {
          return mediaItem.spriteSheets.spriteSheets;
        }

        return [];
      }, [getSpriteSheetsBySource, track.source, mediaItem?.spriteSheets]);

      // Sync store sprite sheets to local state for rendering
      useEffect(() => {
        if (storeSpriteSheets.length > 0) {
          setState({
            spriteSheets: storeSpriteSheets,
            isLoading: false,
            error: null,
          });
        }
      }, [storeSpriteSheets]);

      // Track generation status from media library (consume-only, no triggers)
      const isGenerating = useMemo(() => {
        const jobState = mediaItem?.jobStates?.spriteSheet;
        return jobState === 'processing';
      }, [mediaItem?.jobStates?.spriteSheet]);

      // Update loading state based on generation status
      // CRITICAL: Only show loading if we have NO sheets yet
      // Once we have any sheets, hide loading to enable progressive display
      useEffect(() => {
        if (isGenerating && state.spriteSheets.length === 0) {
          setState((prev) => ({ ...prev, isLoading: true }));
        } else if (state.spriteSheets.length > 0 && state.isLoading) {
          // Have sheets now - hide loading regardless of generation status
          setState((prev) => ({ ...prev, isLoading: false }));
        } else if (!isGenerating && state.isLoading) {
          setState((prev) => ({ ...prev, isLoading: false }));
        }
      }, [isGenerating, state.spriteSheets.length, state.isLoading]);

      // Render with GPU acceleration
      return (
        <div
          ref={containerRef}
          className="absolute top-0 left-0 overflow-hidden group"
          style={{
            width,
            height,
            transform: 'translateZ(0)', // Force GPU layer
            willChange: 'transform',
          }}
        >
          {/* Status indicators - progressive loading */}
          {/* Show progress indicator during sprite generation */}
          {shouldRenderSprites &&
            !isComplete &&
            state.isLoading &&
            totalSheets > 0 && (
              <div className="absolute top-0 left-0 px-2 py-0.5 bg-black/60 rounded-br text-xs text-gray-300 z-10 pointer-events-none">
                {completedSheets}/{totalSheets} sheets
              </div>
            )}

          {isTranscoding && !state.isLoading && !track.proxyBlocked && (
            <div className="absolute top-0 left-0 flex items-center space-x-2 px-2 py-1 bg-purple-900/90 backdrop-blur-sm rounded-r border border-purple-700/50 z-10 pointer-events-none">
              <Loader2 className="h-3 w-3 animate-spin text-purple-400" />
              <span className="text-purple-400 text-xs font-medium">
                Optimizing...
              </span>
            </div>
          )}

          {state.error && (
            <div className="absolute top-0 left-0 flex items-center space-x-2 px-2 py-1 bg-red-900/90 backdrop-blur-sm rounded-r border border-red-700/50 z-10 pointer-events-none">
              <div className="w-2 h-2 rounded-full bg-red-400" />
              <span className="text-red-200 text-xs font-medium">
                {state.error.includes('restart')
                  ? 'Restart required'
                  : 'Failed'}
              </span>
            </div>
          )}

          {/* Background */}
          <div className="absolute inset-0 bg-gray-800" />

          {/* GPU-accelerated sprite container - renders progressively */}
          <div
            className="absolute inset-0"
            style={{
              transform: 'translateZ(0)',
              willChange: 'contents',
            }}
          >
            {visibleTiles.map((tile) => {
              const sheet = state.spriteSheets[tile.thumbnail.sheetIndex];
              if (sheet) {
                return (
                  <GPUAcceleratedSprite
                    key={tile.id}
                    tile={tile}
                    spriteSheet={sheet}
                    height={height}
                  />
                );
              } else {
                // Placeholder for tiles from sheets not yet generated
                return (
                  <PlaceholderTile
                    key={tile.id}
                    tileStartX={tile.tileStartX}
                    tileWidth={tile.tileWidth}
                    height={height}
                  />
                );
              }
            })}
          </div>

          {/* Track name overlay */}
          <div
            className={cn(
              'absolute bottom-1 left-2 text-white text-xs font-medium pointer-events-none whitespace-nowrap overflow-hidden group-hover:opacity-100 opacity-0 transition-opacity duration-200',
              isSelected ? 'opacity-100' : 'opacity-0',
            )}
            style={{
              zIndex: 2,
              textShadow: '1px 1px 2px rgba(0,0,0,0.8)',
              maxWidth: `calc(${width}px - 16px)`,
            }}
          >
            {track.name}
          </div>
        </div>
      );
    },
    // Optimized memo comparison
    (prevProps, nextProps) => {
      // Re-render on any significant change
      const significantChange =
        prevProps.track.id !== nextProps.track.id ||
        prevProps.track.source !== nextProps.track.source ||
        prevProps.track.startFrame !== nextProps.track.startFrame ||
        prevProps.track.endFrame !== nextProps.track.endFrame ||
        prevProps.track.sourceStartTime !== nextProps.track.sourceStartTime ||
        prevProps.track.mediaId !== nextProps.track.mediaId ||
        prevProps.frameWidth !== nextProps.frameWidth ||
        prevProps.height !== nextProps.height ||
        prevProps.width !== nextProps.width ||
        prevProps.zoomLevel !== nextProps.zoomLevel;

      return !significantChange;
    },
  );

GPUAcceleratedSprite.displayName = 'GPUAcceleratedSprite';
VideoSpriteSheetStrip.displayName = 'VideoSpriteSheetStrip';

export default VideoSpriteSheetStrip;
