/**
 * FrameDrivenCompositor - Canvas-based video compositor for multi-layer playback.
 *
 * Key features:
 * - One video element per clip (handles same-source overlaps)
 * - Per-layer frame hold prevents black frames during buffering
 * - Continuous compositing during playback via rAF loop
 */

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
} from 'react';
import { VideoTrack } from '../../stores/videoEditor/index';
import {
  FrameRequest,
  getVideoSource,
  hasVisibleClipsAtFrame,
  resolveFrameRequests,
} from '../services/FrameResolver';

export interface FrameDrivenCompositorRef {
  getCanvas: () => HTMLCanvasElement | null;
  forceRender: () => void;
  getStats: () => CompositorStats;
}

export interface CompositorStats {
  lastRenderTime: number;
  framesRendered: number;
  fallbacksUsed: number;
}

export interface FrameDrivenCompositorProps {
  tracks: VideoTrack[];
  currentFrame: number;
  fps: number;
  isPlaying: boolean;
  playbackRate: number;
  width: number;
  height: number;
  baseVideoWidth: number;
  baseVideoHeight: number;
  onFrameRendered?: (frame: number) => void;
  className?: string;
}

const SEEK_TOLERANCE_SCRUBBING = 0.05;
const SEEK_TOLERANCE_PLAYBACK = 0.25;

interface ManagedVideo {
  element: HTMLVideoElement;
  clipId: string;
  sourceUrl: string;
  isReady: boolean;
  lastSeekTime: number;
  lastDrawnFrame: ImageBitmap | null;
}

export const FrameDrivenCompositor = forwardRef<
  FrameDrivenCompositorRef,
  FrameDrivenCompositorProps
>(
  (
    {
      tracks,
      currentFrame,
      fps,
      isPlaying,
      playbackRate,
      width,
      height,
      baseVideoWidth,
      baseVideoHeight,
      onFrameRendered,
      className,
    },
    ref,
  ) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const ctxRef = useRef<CanvasRenderingContext2D | null>(null);
    const animationFrameRef = useRef<number | null>(null);
    const lastRenderedFrameRef = useRef<number>(-1);
    const videosRef = useRef<Map<string, ManagedVideo>>(new Map());
    const lastCanvasStateRef = useRef<ImageData | null>(null);
    const statsRef = useRef<CompositorStats>({
      lastRenderTime: 0,
      framesRendered: 0,
      fallbacksUsed: 0,
    });
    const prevIsPlayingRef = useRef<boolean>(isPlaying);
    const prevFrameRef = useRef<number>(currentFrame);

    const videoTracks = useMemo(
      () => tracks.filter((t) => t.type === 'video' && t.visible),
      [tracks],
    );

    // Canvas setup
    useEffect(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;

      canvas.width = width;
      canvas.height = height;
      ctxRef.current = canvas.getContext('2d', {
        alpha: false,
        desynchronized: true,
      });

      return () => {
        ctxRef.current = null;
      };
    }, [width, height]);

    // Video element management
    const getOrCreateVideoForClip = useCallback(
      (clipId: string, sourceUrl: string): ManagedVideo => {
        let managed = videosRef.current.get(clipId);

        if (managed) {
          if (managed.sourceUrl !== sourceUrl) {
            managed.element.src = sourceUrl;
            managed.sourceUrl = sourceUrl;
            managed.isReady = false;
          }
          return managed;
        }

        const video = document.createElement('video');
        video.crossOrigin = 'anonymous';
        video.preload = 'auto';
        video.muted = true;
        video.playsInline = true;
        video.src = sourceUrl;

        managed = {
          element: video,
          clipId,
          sourceUrl,
          isReady: false,
          lastSeekTime: -1,
          lastDrawnFrame: null,
        };

        const onReady = () => {
          const m = videosRef.current.get(clipId);
          if (m) {
            m.isReady = true;
            if (!isPlayingRef.current) {
              compositeFrameRef.current(currentFrameRef.current, false);
            }
          }
        };

        video.addEventListener('canplay', onReady);
        video.addEventListener('loadeddata', onReady);
        video.addEventListener('playing', onReady);
        video.addEventListener('waiting', () => {
          const m = videosRef.current.get(clipId);
          if (m) m.isReady = false;
        });

        videosRef.current.set(clipId, managed);
        return managed;
      },
      [],
    );

    // Sync video elements with tracks
    useEffect(() => {
      const activeClipIds = new Set<string>();

      for (const track of videoTracks) {
        const url = getVideoSource(track);
        if (url) {
          activeClipIds.add(track.id);
          getOrCreateVideoForClip(track.id, url);
        }
      }

      videosRef.current.forEach((managed, clipId) => {
        if (!activeClipIds.has(clipId)) {
          managed.element.pause();
          managed.element.src = '';
          managed.element.load();
          managed.lastDrawnFrame?.close();
          videosRef.current.delete(clipId);
        }
      });
    }, [videoTracks, getOrCreateVideoForClip]);

    // Cleanup on unmount
    useEffect(() => {
      return () => {
        if (animationFrameRef.current) {
          cancelAnimationFrame(animationFrameRef.current);
        }
        videosRef.current.forEach((managed) => {
          managed.element.pause();
          managed.element.src = '';
          managed.element.load();
          managed.lastDrawnFrame?.close();
        });
        videosRef.current.clear();
      };
    }, []);

    // Draw video frame with per-layer fallback
    const drawVideoFrame = useCallback(
      (
        ctx: CanvasRenderingContext2D,
        managed: ManagedVideo,
        request: FrameRequest,
        canvasWidth: number,
        canvasHeight: number,
      ): boolean => {
        const video = managed.element;
        const { transform, opacity, filter } = request;

        const scaleX = canvasWidth / baseVideoWidth;
        const scaleY = canvasHeight / baseVideoHeight;
        const scale = Math.min(scaleX, scaleY);

        // Validate transform values to prevent NaN/Infinity breaking canvas state
        const safeScale = Number.isFinite(transform.scale)
          ? transform.scale
          : 1;
        const safeWidth = Number.isFinite(transform.width)
          ? transform.width
          : baseVideoWidth;
        const safeHeight = Number.isFinite(transform.height)
          ? transform.height
          : baseVideoHeight;
        const safeX = Number.isFinite(transform.x) ? transform.x : 0;
        const safeY = Number.isFinite(transform.y) ? transform.y : 0;
        const safeRotation = Number.isFinite(transform.rotation)
          ? transform.rotation
          : 0;
        const safeOpacity = Number.isFinite(opacity)
          ? Math.max(0, Math.min(1, opacity))
          : 1;

        const drawWidth = safeWidth * scale * safeScale;
        const drawHeight = safeHeight * scale * safeScale;
        const centerX = canvasWidth / 2;
        const centerY = canvasHeight / 2;
        const offsetX = safeX * (canvasWidth / 2);
        const offsetY = safeY * (canvasHeight / 2);
        const drawX = centerX + offsetX - drawWidth / 2;
        const drawY = centerY + offsetY - drawHeight / 2;

        // Letterbox blur — draw blurred cover-scaled background before the main layer
        if (request.track.proxyBlockedMessage === 'letterbox-blur' && video.readyState >= 2) {
          const natW = video.videoWidth || baseVideoWidth;
          const natH = video.videoHeight || baseVideoHeight;
          const coverScaleX = canvasWidth / natW;
          const coverScaleY = canvasHeight / natH;
          const coverS = Math.max(coverScaleX, coverScaleY);
          const bgW = natW * coverS;
          const bgH = natH * coverS;
          const bgX = (canvasWidth - bgW) / 2;
          const bgY = (canvasHeight - bgH) / 2;
          ctx.save();
          ctx.filter = 'blur(24px) brightness(0.65)';
          ctx.drawImage(video, bgX, bgY, bgW, bgH);
          ctx.restore();
        }

        ctx.save();
        ctx.globalAlpha = safeOpacity;
        if (filter) ctx.filter = filter;

        if (safeRotation !== 0) {
          const rotationCenterX = drawX + drawWidth / 2;
          const rotationCenterY = drawY + drawHeight / 2;
          ctx.translate(rotationCenterX, rotationCenterY);
          ctx.rotate((safeRotation * Math.PI) / 180);
          ctx.translate(-rotationCenterX, -rotationCenterY);
        }

        // Try drawing from video
        if (video.readyState >= 2) {
          try {
            ctx.drawImage(video, drawX, drawY, drawWidth, drawHeight);
            ctx.restore();

            // Capture frame for fallback (async, non-blocking)
            createImageBitmap(video)
              .then((bitmap) => {
                managed.lastDrawnFrame?.close();
                managed.lastDrawnFrame = bitmap;
              })
              .catch(() => {
                // Ignore bitmap creation errors
              });

            return true;
          } catch {
            // Fall through to fallback
          }
        }

        // Fallback: use last drawn frame
        if (managed.lastDrawnFrame) {
          try {
            ctx.drawImage(
              managed.lastDrawnFrame,
              drawX,
              drawY,
              drawWidth,
              drawHeight,
            );
            ctx.restore();
            return true;
          } catch {
            // Fallback failed
          }
        }

        ctx.restore();
        return false;
      },
      [baseVideoWidth, baseVideoHeight],
    );

    // Draw the main video as a PiP (Picture-in-Picture) with shape mask and gold border
    const drawPipFrame = useCallback(
      (
        ctx: CanvasRenderingContext2D,
        managed: ManagedVideo,
        request: FrameRequest,
        canvasW: number,
        canvasH: number,
      ): boolean => {
        const video = managed.element;
        if (video.readyState < 2 && !managed.lastDrawnFrame) return false;

        const pip = (request.track as any).pipFrame as {
          style: 'circle' | 'rounded-square' | 'square';
          x: number; y: number; size: number;
          borderColor: string; borderWidth: number;
        };

        const diameter = pip.size * canvasW;
        const radius = diameter / 2;
        const cx = pip.x * canvasW;
        const cy = pip.y * canvasH;
        const bw = Math.max(2, pip.borderWidth * (canvasW / 1080));

        ctx.save();

        // Clip path for the mask shape
        ctx.beginPath();
        if (pip.style === 'circle') {
          ctx.arc(cx, cy, radius - bw / 2, 0, Math.PI * 2);
        } else if (pip.style === 'rounded-square') {
          const half = radius * 0.92;
          const rx = cx - half; const ry = cy - half;
          const rr = half * 0.3; // corner radius
          ctx.roundRect(rx, ry, half * 2, half * 2, rr);
        } else {
          const half = radius * 0.92;
          ctx.rect(cx - half, cy - half, half * 2, half * 2);
        }
        ctx.clip();

        // Draw video inside the clipped region using cover-scaling (preserve aspect ratio)
        const drawSize = diameter - bw;
        const src = video.readyState >= 2 ? video : managed.lastDrawnFrame;
        if (src) {
          const srcW = (src as HTMLVideoElement).videoWidth || (src as ImageBitmap).width || drawSize;
          const srcH = (src as HTMLVideoElement).videoHeight || (src as ImageBitmap).height || drawSize;
          const srcAspect = srcW / srcH;
          // Cover: scale so the shorter side fills the circle, longer side overflows (gets clipped)
          let coverW: number, coverH: number;
          if (srcAspect >= 1) {
            // Wider than tall (16:9 etc) — match height to circle, width overflows
            coverH = drawSize;
            coverW = drawSize * srcAspect;
          } else {
            // Taller than wide — match width to circle, height overflows
            coverW = drawSize;
            coverH = drawSize / srcAspect;
          }
          ctx.drawImage(src as CanvasImageSource, cx - coverW / 2, cy - coverH / 2, coverW, coverH);
        }
        ctx.restore();

        // Draw border stroke on top (outside the clip)
        ctx.save();
        ctx.beginPath();
        if (pip.style === 'circle') {
          ctx.arc(cx, cy, radius - bw / 2, 0, Math.PI * 2);
        } else if (pip.style === 'rounded-square') {
          const half = radius * 0.92;
          const rr = half * 0.3;
          ctx.roundRect(cx - half, cy - half, half * 2, half * 2, rr);
        } else {
          const half = radius * 0.92;
          ctx.rect(cx - half, cy - half, half * 2, half * 2);
        }
        ctx.strokeStyle = pip.borderColor || '#FFB800';
        ctx.lineWidth = bw;
        ctx.lineJoin = 'round';
        ctx.stroke();
        ctx.restore();

        return true;
      },
      [],
    );

    // Main composite function
    const compositeFrame = useCallback(
      (frameNumber: number, forceSync = false): boolean => {
        const ctx = ctxRef.current;
        const canvas = canvasRef.current;
        if (!ctx || !canvas) return false;

        const startTime = performance.now();
        const requests = resolveFrameRequests(frameNumber, tracks, fps);
        const hasClips = hasVisibleClipsAtFrame(frameNumber, tracks);

        if (!hasClips) {
          ctx.fillStyle = '#000000';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          lastCanvasStateRef.current = null;
          return true;
        }

        const seekTolerance = isPlaying
          ? SEEK_TOLERANCE_PLAYBACK
          : SEEK_TOLERANCE_SCRUBBING;

        // Sync video elements
        for (const request of requests) {
          const managed = getOrCreateVideoForClip(
            request.clipId,
            request.sourceUrl,
          );
          const video = managed.element;
          const targetTime = request.sourceTime;
          const diff = Math.abs(video.currentTime - targetTime);

          if ((forceSync || diff > seekTolerance) && video.readyState >= 1) {
            video.currentTime = targetTime;
            managed.lastSeekTime = targetTime;
          }

          if (video.playbackRate !== playbackRate) {
            video.playbackRate = playbackRate;
          }

          if (isPlaying) {
            if (video.paused && video.readyState >= 2) {
              video.play().catch(() => {
                // Ignore autoplay errors
              });
            }
          } else {
            if (!video.paused) {
              video.pause();
            }
          }
        }

        // Pause inactive videos
        videosRef.current.forEach((managed, clipId) => {
          const isActive = requests.some((r) => r.clipId === clipId);
          if (!isActive && !managed.element.paused) {
            managed.element.pause();
          }
        });

        // Detect PiP: main track (layer 0) has pipFrame set, and there's an active overlay
        const overlayRequests = requests.filter(r => ((r.track as any).layer ?? 0) > 0 || ((r.track as any).trackRowIndex ?? 0) > 0);
        const mainRequests = requests.filter(r => ((r.track as any).layer ?? 0) === 0 && ((r.track as any).trackRowIndex ?? 0) === 0);
        const pipMainRequest = mainRequests.find(r => {
          const pf = (r.track as any).pipFrame;
          return pf && pf.style && pf.style !== 'none';
        });
        const pipActive = !!(pipMainRequest && overlayRequests.length > 0);

        // When PiP is active: draw overlays first (they become the background), then main video as PiP on top
        const drawOrder = pipActive
          ? [...overlayRequests, ...mainRequests]
          : requests;

        // Clear and composite
        ctx.fillStyle = '#000000';
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        let renderedAny = false;
        for (const request of drawOrder) {
          const managed = videosRef.current.get(request.clipId);
          if (!managed) continue;

          const isPip = pipActive && request === pipMainRequest;
          let drawn: boolean;
          if (isPip) {
            // Apply window drag override for zero-latency dragging (bypasses React re-render)
            const dragOverride = (window as any).__pipDragOverride;
            const pipRequest = (dragOverride && dragOverride.trackId === (request.track as any).id)
              ? { ...request, track: { ...request.track, pipFrame: {
                  ...(request.track as any).pipFrame,
                  ...(dragOverride.x !== undefined ? { x: dragOverride.x } : {}),
                  ...(dragOverride.y !== undefined ? { y: dragOverride.y } : {}),
                  ...(dragOverride.size !== undefined ? { size: dragOverride.size } : {}),
                } } }
              : request;
            drawn = drawPipFrame(ctx, managed, pipRequest as typeof request, canvas.width, canvas.height);
          } else {
            drawn = drawVideoFrame(ctx, managed, request, canvas.width, canvas.height);
          }
          if (drawn) renderedAny = true;
        }

        // Global fallback
        if (!renderedAny && hasClips && lastCanvasStateRef.current) {
          ctx.putImageData(lastCanvasStateRef.current, 0, 0);
          statsRef.current.fallbacksUsed++;
          return true;
        }

        if (renderedAny) {
          try {
            lastCanvasStateRef.current = ctx.getImageData(
              0,
              0,
              canvas.width,
              canvas.height,
            );
          } catch {
            // Ignore
          }
        }

        statsRef.current.lastRenderTime = performance.now() - startTime;
        statsRef.current.framesRendered++;
        return renderedAny;
      },
      [
        tracks,
        fps,
        isPlaying,
        playbackRate,
        drawVideoFrame,
        getOrCreateVideoForClip,
      ],
    );

    // Refs for rAF closure
    const currentFrameRef = useRef<number>(currentFrame);
    const isPlayingRef = useRef<boolean>(isPlaying);
    const compositeFrameRef = useRef(compositeFrame);

    useEffect(() => {
      currentFrameRef.current = currentFrame;
    }, [currentFrame]);

    useEffect(() => {
      isPlayingRef.current = isPlaying;
    }, [isPlaying]);

    useEffect(() => {
      compositeFrameRef.current = compositeFrame;
    }, [compositeFrame]);

    // Initial render
    const hasInitializedRef = useRef(false);
    useEffect(() => {
      if (hasInitializedRef.current || !ctxRef.current) return;
      hasInitializedRef.current = true;

      const timeout = setTimeout(() => {
        compositeFrameRef.current(currentFrameRef.current, true);
        lastRenderedFrameRef.current = currentFrameRef.current;
      }, 100);

      return () => clearTimeout(timeout);
    }, []);

    // Force re-render when PiP style/position changes while paused
    useEffect(() => {
      const handler = () => {
        compositeFrameRef.current(currentFrameRef.current, true);
      };
      window.addEventListener('dividr:forceRender', handler);
      return () => window.removeEventListener('dividr:forceRender', handler);
    }, []);

    // Re-composite when tracks change (catches pipFrame style/size/position changes).
    // No isPlaying guard — during playback the rAF loop overrides immediately anyway.
    useEffect(() => {
      // Two rAFs: first lets React flush, second lets compositeFrameRef update
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          compositeFrameRef.current(currentFrameRef.current, true);
        });
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [tracks]);

    // Handle play/pause
    useEffect(() => {
      const playStateChanged = isPlaying !== prevIsPlayingRef.current;
      prevIsPlayingRef.current = isPlaying;

      if (playStateChanged) {
        compositeFrame(currentFrame, true);
        lastRenderedFrameRef.current = currentFrame;
      }
    }, [isPlaying, currentFrame, compositeFrame]);

    // Handle scrubbing (frame changes while paused)
    useEffect(() => {
      if (isPlaying) return;

      const frameChanged = currentFrame !== prevFrameRef.current;
      const frameDelta = Math.abs(currentFrame - prevFrameRef.current);
      prevFrameRef.current = currentFrame;

      if (frameChanged) {
        compositeFrame(currentFrame, frameDelta > 1);
        lastRenderedFrameRef.current = currentFrame;
        onFrameRendered?.(currentFrame);
      }
    }, [isPlaying, currentFrame, compositeFrame, onFrameRendered]);

    // Re-render when tracks change (for transform updates)
    // CRITICAL: This must work during BOTH playback AND when paused
    // During playback, track changes (like rotation) must be reflected immediately
    // Without this, Properties Panel rotation updates would not render until playback stops
    const prevTracksRef = useRef(tracks);
    const prevTracksJsonRef = useRef<string>('');
    useEffect(() => {
      // Quick reference check first
      if (prevTracksRef.current === tracks) {
        return;
      }
      prevTracksRef.current = tracks;

      // For transform changes (position, scale, rotation), we need to detect actual changes
      // since the track reference changes on any store update
      // Compare relevant transform properties to detect actual visual changes
      const currentTracksTransformKey = tracks
        .filter((t) => t.type === 'video' && t.visible)
        .map((t) => {
          const transform = t.textTransform;
          const x = transform?.x ?? 0;
          const y = transform?.y ?? 0;
          const scale = transform?.scale ?? 1;
          const rotation = transform?.rotation ?? 0;
          return `${t.id}:${x},${y},${scale},${rotation},${t.filter ?? ''},${t.proxyBlockedMessage ?? ''}`;
        })
        .join('|');

      if (prevTracksJsonRef.current !== currentTracksTransformKey) {
        prevTracksJsonRef.current = currentTracksTransformKey;
        // Force re-composite with the latest tracks
        // This ensures rotation changes from Properties Panel are reflected immediately
        compositeFrame(currentFrame, false);
      }
    }, [tracks, currentFrame, compositeFrame]);

    // Playback render loop
    useEffect(() => {
      if (!isPlaying) {
        if (animationFrameRef.current) {
          cancelAnimationFrame(animationFrameRef.current);
          animationFrameRef.current = null;
        }
        return;
      }

      let running = true;

      const animate = () => {
        if (!running) return;
        compositeFrameRef.current(currentFrameRef.current, false);
        lastRenderedFrameRef.current = currentFrameRef.current;
        animationFrameRef.current = requestAnimationFrame(animate);
      };

      animationFrameRef.current = requestAnimationFrame(animate);

      return () => {
        running = false;
        if (animationFrameRef.current) {
          cancelAnimationFrame(animationFrameRef.current);
          animationFrameRef.current = null;
        }
      };
    }, [isPlaying]);

    useImperativeHandle(
      ref,
      () => ({
        getCanvas: () => canvasRef.current,
        forceRender: () => compositeFrame(currentFrame, true),
        getStats: () => ({ ...statsRef.current }),
      }),
      [currentFrame, compositeFrame],
    );

    return (
      <canvas
        ref={canvasRef}
        className={className}
        data-testid="preview-canvas"
        style={{
          width: '100%',
          height: '100%',
          display: 'block',
          backgroundColor: '#000000',
          pointerEvents: 'none', // Ensure canvas doesn't capture clicks
        }}
        aria-label="Video preview canvas"
      />
    );
  },
);

FrameDrivenCompositor.displayName = 'FrameDrivenCompositor';

export default FrameDrivenCompositor;
