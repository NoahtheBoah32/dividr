import {
  SpriteSheet,
  SpriteSheetThumbnail,
} from '@/backend/frontend_use/videoSpriteSheetGenerator';
import { Loader2 } from 'lucide-react';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useSpriteSheetProgress } from '../../editor/hooks/useMediaReadiness';
import { useVideoEditorStore, VideoTrack } from '../stores/videoEditor/index';
import { getDisplayFps } from '../stores/videoEditor/types/timeline.types';

interface VideoSpriteSheetStripProps {
  track: VideoTrack;
  frameWidth: number;
  width: number;
  height: number;
  zoomLevel: number;
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
  startX: number;
  endX: number;
  tileStartX: number; // Where this specific tile starts
  tileWidth: number; // Width of this specific tile
  repeatIndex: number; // Which repeat of the thumbnail this is
  clipOffset: number; // How much to offset the background for partial tiles
}

// Placeholder for tiles from sprite sheets not yet generated (progressive loading)
const PlaceholderTile: React.FC<{
  tileStartX: number;
  tileWidth: number;
  height: number;
  viewportOffset: number;
}> = React.memo(({ tileStartX, tileWidth, height, viewportOffset }) => (
  <div
    className="absolute top-0 bg-gray-700/40"
    style={{
      transform: `translate3d(${tileStartX - viewportOffset}px, 0, 0)`,
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
  viewportOffset: number;
}> = React.memo(
  ({ tile, spriteSheet, height, viewportOffset }) => {
    const { thumbnail, tileStartX, tileWidth, clipOffset } = tile;

    // Calculate display metrics
    const scale = height / thumbnail.height;
    const spriteWidth = spriteSheet.width * scale;
    const spriteHeight = spriteSheet.height * scale;
    const thumbnailWidth = thumbnail.width * scale;
    const bgY = thumbnail.y * scale;

    // Use transform for positioning (GPU accelerated)
    const transform = `translate3d(${tileStartX - viewportOffset}px, 0, 0)`;

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
        <div
          className="absolute"
          style={{
            width: `${thumbnailWidth}px`,
            height: `${height}px`,
            left: `-${clipOffset}px`,
            backgroundImage: `url(${spriteSheet.url})`,
            backgroundSize: `${spriteWidth}px ${spriteHeight}px`,
            backgroundPosition: `-${thumbnail.x * scale}px -${bgY}px`,
            imageRendering: 'auto',
          }}
        />
      </div>
    );
  },
  (prev, next) => {
    // Only re-render if actual visual changes
    return (
      prev.tile.id === next.tile.id &&
      Math.abs(prev.tile.tileStartX - next.tile.tileStartX) < 1 &&
      Math.abs(prev.tile.tileWidth - next.tile.tileWidth) < 1 &&
      Math.abs(prev.viewportOffset - next.viewportOffset) < 1 &&
      prev.height === next.height
    );
  },
);

export const VideoSpriteSheetStrip: React.FC<VideoSpriteSheetStripProps> =
  React.memo(
    ({ track, frameWidth, width, height, zoomLevel }) => {
      const containerRef = useRef<HTMLDivElement>(null);
      const [state, setState] = useState<SpriteSheetStripState>({
        spriteSheets: [],
        isLoading: false,
        error: null,
      });

      // Viewport state for culling
      const [viewportBounds, setViewportBounds] = useState({
        start: 0,
        end: width,
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
        }),
        [
          track.startFrame,
          track.endFrame,
          track.sourceStartTime,
          displayFps,
          frameWidth,
        ],
      );

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

      // Hybrid tile generation - pixel-position based for correct zoom behavior
      // Key insight: iterate by PIXEL POSITION at native tile width intervals,
      // then pick the appropriate thumbnail for each position.
      // This ensures:
      // - Zoom-out: Frame-skipping (fewer tiles, each at proper aspect ratio)
      // - Zoom-in: Frame-repeating (same thumbnail repeated to fill space)
      const hybridTiles = useMemo(() => {
        const { spriteSheets } = state;
        if (spriteSheets.length === 0) return [];

        const tiles: HybridTile[] = [];

        const allThumbnails = spriteSheets.flatMap((sheet) => sheet.thumbnails);

        if (allThumbnails.length === 0) return [];

        const { trackStartTime, durationSeconds, pixelsPerSecond } =
          trackMetrics;

        // Get first thumbnail to calculate native display width
        const firstThumb = allThumbnails[0];
        const aspectRatio = firstThumb.width / firstThumb.height;
        const nativeDisplayWidth = aspectRatio * height;

        // Total pixel width of the track
        const totalPixels = durationSeconds * pixelsPerSecond;

        // Iterate by pixel position at native tile width intervals
        // This is the key change: we step through by display width, not by thumbnails
        let tileIndex = 0;
        let currentPixelX = 0;

        while (currentPixelX < totalPixels) {
          // Calculate the time position for this tile
          const currentTimeInTrack = currentPixelX / pixelsPerSecond;
          const currentTimeAbsolute = trackStartTime + currentTimeInTrack;

          // Find the thumbnail that covers this time position
          // Binary search for efficiency with large thumbnail arrays
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

          // Calculate tile width (may be partial at the end)
          const tileWidth = Math.min(
            nativeDisplayWidth,
            totalPixels - currentPixelX,
          );

          // Only add tiles with meaningful width
          if (tileWidth > 0.5) {
            tiles.push({
              id: `tile-${tileIndex}-${closestThumbnail.id}`,
              thumbnail: closestThumbnail,
              startX: currentPixelX,
              endX: currentPixelX + tileWidth,
              tileStartX: currentPixelX,
              tileWidth,
              repeatIndex: tileIndex,
              clipOffset: 0,
            });
          }

          currentPixelX += nativeDisplayWidth;
          tileIndex++;
        }

        return tiles;
      }, [state.spriteSheets, trackMetrics, height]);

      // High-performance viewport culling with buffer zone
      const visibleTiles = useMemo(() => {
        // Increase buffer significantly for fast scrolling/zooming
        const buffer = width * 1.5; // 150% buffer for smooth continuous scrolling
        const leftBound = Math.max(0, viewportBounds.start - buffer);
        const rightBound = viewportBounds.end + buffer;

        // If no tiles, return empty array
        if (hybridTiles.length === 0) return [];

        // Binary search for first visible tile
        let left = 0;
        let right = hybridTiles.length - 1;
        let firstVisible = 0;

        while (left <= right) {
          const mid = Math.floor((left + right) / 2);
          const tile = hybridTiles[mid];
          if (tile.tileStartX + tile.tileWidth < leftBound) {
            left = mid + 1;
          } else {
            firstVisible = mid;
            right = mid - 1;
          }
        }

        // Collect visible tiles with safety margin
        const visible: HybridTile[] = [];
        for (
          let i = Math.max(0, firstVisible - 1);
          i < hybridTiles.length;
          i++
        ) {
          const tile = hybridTiles[i];
          // Include tiles that are even partially visible
          if (tile.tileStartX > rightBound) break;
          if (tile.tileStartX + tile.tileWidth >= leftBound) {
            visible.push(tile);
          }
        }

        return visible;
      }, [hybridTiles, viewportBounds, width]);

      // Update viewport bounds on scroll/zoom - more responsive for continuous scrolling
      useEffect(() => {
        const updateViewport = () => {
          if (containerRef.current) {
            const parent = containerRef.current.parentElement;
            if (parent) {
              const scrollLeft = parent.scrollLeft || 0;
              setViewportBounds({
                start: scrollLeft,
                end: scrollLeft + parent.clientWidth,
              });
            }
          }
        };

        // Use direct updates for scroll (no RAF throttling) to be more responsive
        const handleScroll = () => {
          updateViewport();
        };

        const parent = containerRef.current?.parentElement;
        if (parent) {
          parent.addEventListener('scroll', handleScroll, { passive: true });
          updateViewport(); // Initial update
        }

        return () => {
          if (parent) parent.removeEventListener('scroll', handleScroll);
          if (rafRef.current) cancelAnimationFrame(rafRef.current);
        };
      }, []);

      // Update viewport when width changes (zoom level changes)
      useEffect(() => {
        const updateViewport = () => {
          if (containerRef.current) {
            const parent = containerRef.current.parentElement;
            if (parent) {
              const scrollLeft = parent.scrollLeft || 0;
              setViewportBounds({
                start: scrollLeft,
                end: scrollLeft + parent.clientWidth,
              });
            }
          }
        };
        updateViewport();
      }, [width, zoomLevel]);

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
          className="absolute top-0 left-0 overflow-hidden"
          style={{
            width,
            height,
            transform: 'translateZ(0)', // Force GPU layer
            willChange: 'transform',
          }}
        >
          {/* Status indicators - progressive loading */}
          {/* Show progress indicator during sprite generation */}
          {!isComplete && state.isLoading && totalSheets > 0 && (
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
                    viewportOffset={viewportBounds.start}
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
                    viewportOffset={viewportBounds.start}
                  />
                );
              }
            })}
          </div>

          {/* Track name overlay */}
          <div
            className="absolute bottom-1 left-2 text-white text-xs font-medium pointer-events-none whitespace-nowrap overflow-hidden"
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
