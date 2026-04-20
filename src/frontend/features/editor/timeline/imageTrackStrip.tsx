import { cn } from '@/frontend/utils/utils';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useVideoEditorStore, VideoTrack } from '../stores/videoEditor/index';

interface ImageTrackStripProps {
  track: VideoTrack;
  frameWidth: number;
  width: number;
  height: number;
  zoomLevel: number;
}

interface ImageTile {
  id: string;
  startX: number;
  width: number;
  clipOffset: number; // For partial tiles at edges
  repeatIndex: number;
}

const VIEWPORT_BUFFER_MULTIPLIER = 0.5;

// GPU-accelerated image tile component
const GPUAcceleratedImageTile: React.FC<{
  tile: ImageTile;
  imageUrl: string;
  height: number;
  tileNativeWidth: number;
}> = React.memo(
  ({ tile, imageUrl, height, tileNativeWidth }) => {
    const { startX, width: tileWidth, clipOffset } = tile;

    // Use transform for positioning (GPU accelerated)
    const transform = `translate3d(${startX}px, 0, 0)`;

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
            width: `${tileNativeWidth}px`,
            height: `${height}px`,
            left: `-${clipOffset}px`,
            backgroundImage: `url(${imageUrl})`,
            backgroundSize: 'contain',
            backgroundRepeat: 'no-repeat',
            backgroundPosition: 'left center',
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
      Math.abs(prev.tile.startX - next.tile.startX) < 1 &&
      Math.abs(prev.tile.width - next.tile.width) < 1 &&
      prev.height === next.height &&
      prev.imageUrl === next.imageUrl
    );
  },
);

GPUAcceleratedImageTile.displayName = 'GPUAcceleratedImageTile';

export const ImageTrackStrip: React.FC<ImageTrackStripProps> = React.memo(
  ({ track, frameWidth, width, height, zoomLevel }) => {
    const selectedTrackIds = useVideoEditorStore(
      (state) => state.timeline.selectedTrackIds,
    );
    const isSelected = selectedTrackIds.includes(track.id);
    const containerRef = useRef<HTMLDivElement>(null);
    const [imageLoaded, setImageLoaded] = useState(false);
    const [imageError, setImageError] = useState<string | null>(null);
    const [imageDimensions, setImageDimensions] = useState<{
      width: number;
      height: number;
    } | null>(null);
    const [staticGifFrameUrl, setStaticGifFrameUrl] = useState<string | null>(
      null,
    );

    // Viewport state for culling (timeline scroll container)
    const [viewportBounds, setViewportBounds] = useState({
      scrollLeft: 0,
      viewportWidth: 0,
    });
    const rafRef = useRef<number>(0);

    // Get the image URL from track
    const imageUrl = useMemo(() => {
      return track.previewUrl || track.source;
    }, [track.previewUrl, track.source]);

    const mediaLibrary = useVideoEditorStore((state) => state.mediaLibrary);
    const mediaItem = useMemo(() => {
      return mediaLibrary.find(
        (item) =>
          (track.mediaId && item.id === track.mediaId) ||
          item.source === track.source,
      );
    }, [mediaLibrary, track.mediaId, track.source]);

    const isGifTrack = useMemo(() => {
      const mimeType = (mediaItem?.mimeType || '').toLowerCase();
      const name = (mediaItem?.name || track.name || '').toLowerCase();
      const source = (track.source || '').toLowerCase();
      const preview = (track.previewUrl || '').toLowerCase();
      return (
        mimeType.includes('image/gif') ||
        name.endsWith('.gif') ||
        source.endsWith('.gif') ||
        preview.endsWith('.gif')
      );
    }, [
      mediaItem?.mimeType,
      mediaItem?.name,
      track.name,
      track.source,
      track.previewUrl,
    ]);

    // Build a static frame for GIF tracks so timeline rendering is cheap.
    useEffect(() => {
      if (!isGifTrack || !imageUrl) {
        setStaticGifFrameUrl(null);
        return;
      }

      let cancelled = false;
      const img = new Image();

      img.onload = () => {
        if (cancelled) return;
        try {
          const canvas = document.createElement('canvas');
          const drawWidth = Math.max(1, img.naturalWidth || 1);
          const drawHeight = Math.max(1, img.naturalHeight || 1);
          canvas.width = drawWidth;
          canvas.height = drawHeight;

          const ctx = canvas.getContext('2d');
          if (!ctx) {
            setStaticGifFrameUrl(null);
            return;
          }

          ctx.drawImage(img, 0, 0, drawWidth, drawHeight);
          const dataUrl = canvas.toDataURL('image/png', 0.9);
          setStaticGifFrameUrl(dataUrl);
        } catch {
          setStaticGifFrameUrl(null);
        }
      };

      img.onerror = () => {
        if (!cancelled) {
          setStaticGifFrameUrl(null);
        }
      };

      img.src = imageUrl;

      return () => {
        cancelled = true;
        img.onload = null;
        img.onerror = null;
      };
    }, [isGifTrack, imageUrl]);

    const timelineImageUrl = useMemo(() => {
      if (!isGifTrack) return imageUrl;
      if (mediaItem?.thumbnail) return mediaItem.thumbnail;
      if (staticGifFrameUrl) return staticGifFrameUrl;
      return imageUrl;
    }, [isGifTrack, imageUrl, mediaItem?.thumbnail, staticGifFrameUrl]);

    const useSingleLayerGifFallback =
      isGifTrack && !mediaItem?.thumbnail && !staticGifFrameUrl;

    // Load image and get dimensions
    useEffect(() => {
      if (!timelineImageUrl) {
        setImageError('No image source');
        return;
      }

      setImageLoaded(false);
      setImageError(null);

      const img = new Image();

      img.onload = () => {
        setImageDimensions({
          width: img.naturalWidth,
          height: img.naturalHeight,
        });
        setImageLoaded(true);
      };

      img.onerror = () => {
        setImageError('Failed to load image');
        setImageLoaded(false);
      };

      img.src = timelineImageUrl;

      return () => {
        img.onload = null;
        img.onerror = null;
      };
    }, [timelineImageUrl]);

    // Calculate native display width based on image aspect ratio
    const tileNativeWidth = useMemo(() => {
      if (!imageDimensions) return height; // Default to square

      const aspectRatio = imageDimensions.width / imageDimensions.height;
      return aspectRatio * height;
    }, [imageDimensions, height]);

    const visibleTiles = useMemo(() => {
      if (!imageLoaded || !imageDimensions || tileNativeWidth <= 0) return [];

      const viewportWidth = viewportBounds.viewportWidth;
      if (viewportWidth <= 0) return [];

      const trackStartPx = track.startFrame * frameWidth;
      const viewportStart = viewportBounds.scrollLeft - trackStartPx;
      const viewportEnd =
        viewportBounds.scrollLeft + viewportWidth - trackStartPx;
      const buffer = viewportWidth * VIEWPORT_BUFFER_MULTIPLIER;

      const visibleStart = Math.max(0, viewportStart - buffer);
      const visibleEnd = Math.min(width, viewportEnd + buffer);

      if (visibleEnd <= 0 || visibleStart >= width) return [];

      const startIndex = Math.max(
        0,
        Math.floor(visibleStart / tileNativeWidth),
      );
      const endIndex = Math.min(
        Math.ceil(visibleEnd / tileNativeWidth),
        Math.ceil(width / tileNativeWidth),
      );

      const tiles: ImageTile[] = [];
      for (let i = startIndex; i <= endIndex; i++) {
        const tileStartX = i * tileNativeWidth;
        if (tileStartX >= width) break;
        const tileWidth = Math.min(tileNativeWidth, width - tileStartX);
        if (tileWidth <= 0.5) continue;

        tiles.push({
          id: `${track.id}-tile-${i}`,
          startX: tileStartX,
          width: tileWidth,
          clipOffset: 0,
          repeatIndex: i,
        });
      }

      return tiles;
    }, [
      imageLoaded,
      imageDimensions,
      tileNativeWidth,
      width,
      track.id,
      track.startFrame,
      frameWidth,
      viewportBounds,
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
        {/* Loading state */}
        {!imageLoaded && !imageError && (
          <div className="absolute inset-0 flex items-center justify-center bg-gray-800">
            <div className="flex items-center space-x-2 px-3 py-1.5 bg-gray-900/90 backdrop-blur-sm rounded border border-gray-700/50">
              <div className="w-2 h-2 rounded-full bg-blue-400 animate-pulse" />
              <span className="text-blue-400 text-xs font-medium">
                Loading image...
              </span>
            </div>
          </div>
        )}

        {/* Error state */}
        {imageError && (
          <div className="absolute inset-0 flex items-center justify-center bg-gray-800">
            <div className="flex items-center space-x-2 px-3 py-1.5 bg-red-900/90 backdrop-blur-sm rounded border border-red-700/50">
              <div className="w-2 h-2 rounded-full bg-red-400" />
              <span className="text-red-200 text-xs font-medium">
                {imageError}
              </span>
            </div>
          </div>
        )}

        {/* Background */}
        <div className="absolute inset-0 bg-gray-800" />

        {/* GPU-accelerated image tile container */}
        {imageLoaded && !useSingleLayerGifFallback && (
          <div
            className="absolute inset-0"
            style={{
              transform: 'translateZ(0)',
              willChange: 'contents',
            }}
          >
            {visibleTiles.map((tile) => (
              <GPUAcceleratedImageTile
                key={tile.id}
                tile={tile}
                imageUrl={timelineImageUrl}
                height={height}
                tileNativeWidth={tileNativeWidth}
              />
            ))}
          </div>
        )}

        {/* Fallback: keep GIF as a single repeated layer if static frame extraction failed */}
        {imageLoaded && useSingleLayerGifFallback && (
          <div
            className="absolute inset-0"
            style={{
              backgroundImage: `url(${timelineImageUrl})`,
              backgroundSize: `${tileNativeWidth}px ${height}px`,
              backgroundRepeat: 'repeat-x',
              backgroundPosition: 'left center',
              imageRendering: 'auto',
            }}
          />
        )}

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
      prevProps.track.previewUrl !== nextProps.track.previewUrl ||
      prevProps.track.startFrame !== nextProps.track.startFrame ||
      prevProps.track.endFrame !== nextProps.track.endFrame ||
      prevProps.frameWidth !== nextProps.frameWidth ||
      prevProps.height !== nextProps.height ||
      prevProps.width !== nextProps.width ||
      prevProps.zoomLevel !== nextProps.zoomLevel;

    return !significantChange;
  },
);

ImageTrackStrip.displayName = 'ImageTrackStrip';

export default ImageTrackStrip;
