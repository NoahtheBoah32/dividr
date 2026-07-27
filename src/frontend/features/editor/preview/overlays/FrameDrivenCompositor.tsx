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
import { useVideoEditorStore } from '../../stores/videoEditor/index';
import {
  FrameRequest,
  getVideoSource,
  hasVisibleClipsAtFrame,
  resolveFrameRequests,
  resolveDipOverlay,
} from '../services/FrameResolver';
import { isRampActive, rampSpeedAtOutput } from '../services/speedRampCache';
import { effectiveRamp } from '../services/speedRampLive';
import { applyCSSColorGrade, GRADE_FILTER_ID, removeGrainOverlay, removeVignetteOverlay } from '../utils/colorGradeUtils';
import { gradeCompare } from '../utils/gradeCompareState';
import { kenBurnsWindow, type KenBurnsState } from '../utils/kenBurnsUtils';
import {
  getStabilizationOffset,
  getStabilizationZoom,
} from '../services/stabilizationCache';

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

/**
 * Speed-ramp playback drive.
 *
 * A ramped clip is played, not seeked. Seeking it once per timeline frame looks
 * obvious but does not work: a seek on a long-GOP 4K source takes far longer
 * than a frame, so the next frame retargets before the last one lands, the
 * element never leaves `seeking`, and drawVideoFrame falls back to the same
 * cached bitmap forever — a frozen picture. Paused it is worse: the element
 * snaps currentTime to the presented frame after each seek, which re-arms the
 * "not close enough" test and loops seek→seeked→seek forever.
 *
 * So the element runs continuously at `playbackRate = the curve's instantaneous
 * speed`, which is what makes the acceleration smooth — the decoder is never
 * interrupted — and a seek is only used to correct drift, never while one is
 * already in flight.
 */
const MIN_ELEMENT_RATE = 0.0625;
const MAX_ELEMENT_RATE = 16;
/**
 * Drift control.
 *
 * A ramped element drifts because the decoder cannot always sustain the rate the
 * curve asks for. Correcting that with a seek is what a first pass does, and it
 * produces exactly the artefact a ramp exists to avoid: the seek costs ~200ms on
 * a 4K source, the timeline runs on while it lands, and the correction arrives
 * as a visible lurch — measured at 1.8 SECONDS of source in a single presented
 * frame, against a 0.13s stride either side of it.
 *
 * So drift is absorbed into the RATE instead, the way a media player syncs to an
 * audio clock: run slightly faster while behind, slightly slower while ahead.
 * The decoder is never interrupted and the correction is invisible. A hard seek
 * is kept only for the hopeless case — above MAX_ELEMENT_RATE the element
 * physically cannot catch up, and jumping is the only thing left.
 */
const RAMP_SYNC_GAIN = 1.5;
const RAMP_SYNC_CLAMP = 0.3;
const RAMP_RESYNC_SECONDS = 0.8;
/**
 * Where the rate drive hands over to the step drive.
 *
 * Set just under MAX_ELEMENT_RATE, with room for the sync trim on top
 * (12 * 1.3 < 16), because that is exactly where the rate drive stops being
 * able to represent the curve at all: above the clamp the element runs at its
 * ceiling no matter what is asked, falls behind, and gets yanked.
 *
 * Measured on 720p, worst single step: rate drive gives 0.30s at 3x and 0.83s
 * at 8x (ideal ~0.32) but 3.3s at 25x; step drive gives 1.7s at 25x. Below the
 * clamp continuous playback wins — handing over at 3x made 3x visibly worse
 * (eight held frames where the rate drive had none), which is what set this.
 */
/**
 * Highest curve speed still driven by playing the element.
 *
 * Measured on 720p30: asked for 15x, the decoder delivered 10x and the resync
 * yanked the rest, which is what left whole source seconds with no picture. At
 * 8x the same clip played clean with no repeated frames, so that is where the
 * stepped drive takes over.
 */
const RAMP_RATE_CEILING = 8;

/**
 * New pictures per second the stepped drive aims for.
 *
 * A seek on a long-GOP source costs tens of milliseconds because the decoder
 * has to run from the previous keyframe, so asking for much more than this just
 * queues seeks and the strides go ragged again. Twelve evenly spaced pictures a
 * second reads as fast motion; the frame blend below fills the gaps.
 */
const STEP_PICTURES_PER_SEC = 12;

/**
 * Frame blending through a ramp.
 *
 * Playing the element at the right rate fixes the TIMING, not the look. At 25x
 * two consecutive output frames show moments 0.8s apart in the scene, so however
 * perfect the curve is, the result strobes — the eye reads a series of cuts.
 * This is not a bug in the drive, it is what speeding footage up does, and every
 * NLE answers it the same way: Premiere calls it Frame Blending, Resolve calls
 * it Frame Blend. Blending the previous composited frame under the current one
 * turns each hard step into a dissolve, which is what makes a sped-up drone shot
 * read as flow instead of stutter.
 *
 * The ghost already holds the previous BLENDED result, so this is an exponential
 * trail rather than a single ghost — weights decay 0.4, 0.24, 0.14, ... over
 * about four frames at full strength. Capped below 0.7 so the live frame always
 * dominates; past that it turns to mush.
 */
const RAMP_BLEND_MAX = 0.68;
/** Below this much speed change there is nothing to hide, so stay out of the way. */
const RAMP_BLEND_KNEE = 0.32; // log2(1.25x)
const RAMP_BLEND_FALLOFF = 1.8;

function rampBlendAlpha(speed: number, mode: string | undefined): number {
  if (!mode || mode === 'off') return 0;
  const mag = Math.abs(Math.log2(Math.max(0.02, speed)));
  if (mag <= RAMP_BLEND_KNEE) return 0;
  return (
    RAMP_BLEND_MAX * (1 - Math.exp(-(mag - RAMP_BLEND_KNEE) / RAMP_BLEND_FALLOFF))
  );
}

/**
 * REVERSE PLAYBACK, served from a forward-decoded cache.
 *
 * No browser plays a video element backwards — playbackRate is clamped positive
 * — so reverse has to seek. Measured on 720p H.264 at 6x reverse: a 2004ms
 * freeze, 26 consecutive fallback repeats, the source time jumping 8.89s → 3.5s
 * in one go. A backward seek makes the decoder restart at the previous keyframe
 * and decode forward to the target; the playhead runs on while it works, so the
 * next target is further back still, and the next seek is more expensive again.
 * It feeds itself.
 *
 * Decoding the region ONCE, forwards, on a second element is sequential and
 * cheap. The frames are then handed out in whatever order the curve asks for,
 * with no seeking at all on the element that is on screen.
 */
/**
 * Frames cached per reverse region.
 *
 * The grid is uniform in SOURCE time, so the pictures-per-second the user
 * actually gets is speed/q — worst at the region's eased edges, where the curve
 * is back near 1x. At 48 frames over an 8s region (q = 0.167s) those edges ran
 * at 6.9 pictures a second and measured a 145ms median gap: the cache was
 * serving perfectly and the picture was still choppy. 96 puts q at 0.083s for
 * the same region, which is 12 pictures a source-second — the same target the
 * forward step drive aims for. Costs ~157MB for an 8s region at REV_CACHE_WIDTH.
 */
const REV_CACHE_MAX = 96;
/**
 * Cached at preview scale rather than source scale. Reverse runs with blend on
 * (it is motion-blurred by the time the user sees it) and full-res bitmaps cost
 * 4x the memory for detail that never survives the composite.
 */
const REV_CACHE_WIDTH = 854;
/**
 * Rate the hidden element runs at while filling.
 *
 * Bounded from above by DENSITY, not by patience: the element can only present
 * about 60 frames a second, so at 8x an 8s region yields ~60 captures where the
 * grid wants 96, and the missing third falls to the seek pass at ~12 frames a
 * second. At 4x the same region takes 2s of wall clock and presents enough to
 * cover the grid outright.
 */
const REV_FILL_RATE = 4;

interface ReverseCache {
  key: string;
  q: number;
  frames: Map<number, ImageBitmap>;
  cancelled: boolean;
  done: boolean;
}

function startReverseFill(
  sourceUrl: string,
  a: number,
  b: number,
  q: number,
  key: string,
): ReverseCache {
  const cache: ReverseCache = {
    key,
    q,
    frames: new Map(),
    cancelled: false,
    done: false,
  };
  const el = document.createElement('video');
  // Must match the display element. Without it the frames this decodes are
  // cross-origin, and drawing one onto the preview canvas TAINTS it — every
  // getImageData in the app (thumbnails, light detection, the relighter, grade
  // compare) then throws SecurityError. Set before src, or it does not apply.
  el.crossOrigin = 'anonymous';
  el.muted = true;
  el.preload = 'auto';
  el.src = sourceUrl;

  const seekTo = (t: number) =>
    new Promise<void>((resolve) => {
      const onSeeked = () => {
        el.removeEventListener('seeked', onSeeked);
        resolve();
      };
      el.addEventListener('seeked', onSeeked);
      el.currentTime = t;
    });

  void (async () => {
    try {
      await new Promise<void>((resolve, reject) => {
        if (el.readyState >= 2) return resolve();
        el.addEventListener('loadeddata', () => resolve(), { once: true });
        el.addEventListener('error', () => reject(new Error('load')), {
          once: true,
        });
      });
      const vw = el.videoWidth || REV_CACHE_WIDTH;
      const vh = el.videoHeight || Math.round((REV_CACHE_WIDTH * 9) / 16);
      const w = Math.min(vw, REV_CACHE_WIDTH);
      const h = Math.max(1, Math.round((w * vh) / vw));
      const grab = async (t: number) => {
        const bmp = await createImageBitmap(el, {
          resizeWidth: w,
          resizeHeight: h,
        });
        if (cache.cancelled) {
          bmp.close();
          return;
        }
        cache.frames.set(Math.round(t / q), bmp);
      };

      // FAST PATH: play the hidden element through the region once and grab on
      // presentation. A seek per grid point is a decoder restart per grid point
      // — measured at ~12 frames a second, so a 49-frame region took 4s and the
      // FIRST pass through it was still ragged. Playing is sequential decode,
      // the one thing the hardware is actually fast at.
      const rvfc = (
        el as HTMLVideoElement & {
          requestVideoFrameCallback?: (
            cb: (now: number, meta: { mediaTime: number }) => void,
          ) => number;
        }
      ).requestVideoFrameCallback;
      if (typeof rvfc === 'function') {
        await seekTo(a);
        el.playbackRate = REV_FILL_RATE;
        let next = Math.round(a / q);
        const last = Math.round(b / q);
        await new Promise<void>((resolve) => {
          let settled = false;
          const finish = () => {
            if (settled) return;
            settled = true;
            el.pause();
            resolve();
          };
          // Whichever comes first: the region is covered, playback ends, or the
          // element stalls. Never leaves the fill hanging.
          const timer = setTimeout(
            finish,
            ((b - a) / REV_FILL_RATE) * 1000 + 4000,
          );
          const onFrame = (_now: number, meta: { mediaTime: number }) => {
            if (cache.cancelled || settled) return;
            while (next <= last && next * q <= meta.mediaTime + q / 2) {
              void grab(next * q);
              next++;
            }
            if (next > last || meta.mediaTime >= b) {
              clearTimeout(timer);
              finish();
              return;
            }
            (
              el as unknown as {
                requestVideoFrameCallback: (
                  cb: (n: number, m: { mediaTime: number }) => void,
                ) => number;
              }
            ).requestVideoFrameCallback(onFrame);
          };
          el.addEventListener('ended', finish, { once: true });
          (
            el as unknown as {
              requestVideoFrameCallback: (
                cb: (n: number, m: { mediaTime: number }) => void,
              ) => number;
            }
          ).requestVideoFrameCallback(onFrame);
          el.play().catch(finish);
        });
      }

      // Anything the fast path missed (a dropped presentation callback, a build
      // without rVFC) is filled in by seeking, so the cache is always complete.
      for (let t = a; t <= b + 1e-6 && !cache.cancelled; t += q) {
        if (cache.frames.has(Math.round(t / q))) continue;
        await seekTo(t);
        if (cache.cancelled) break;
        await grab(t);
      }
    } catch {
      // A region that cannot be pre-decoded falls back to stepping the element.
    } finally {
      cache.done = true;
      el.removeAttribute('src');
      el.load();
    }
  })();

  return cache;
}

function disposeReverseCache(cache: ReverseCache | null | undefined): void {
  if (!cache) return;
  cache.cancelled = true;
  for (const bmp of cache.frames.values()) bmp.close();
  cache.frames.clear();
}

interface ManagedVideo {
  element: HTMLVideoElement;
  clipId: string;
  sourceUrl: string;
  isReady: boolean;
  lastSeekTime: number;
  lastDrawnFrame: ImageBitmap | null;
  /**
   * mediaTime of the frame the element is actually PRESENTING (from
   * requestVideoFrameCallback). During playback video.currentTime runs 1–2
   * frames ahead of the displayed frame — stabilization must index its
   * per-frame offsets by what drawImage will sample, not by the clock.
   */
  presentedMediaTime: number | null;
  /** performance.now() of the last lastDrawnFrame refresh. See BITMAP_MIN_GAP. */
  lastBitmapAt: number;
  /**
   * True while the ramp is driving this element by seeking rather than by
   * playbackRate. The transition back out has to be closed with one exact seek
   * — see the step-drive branch.
   */
  stepping: boolean;
  /** Forward-decoded frames, one cache per reverse region on this clip. */
  revs: Map<string, ReverseCache>;
  /** Grid index the reverse curve is currently asking for, or null when forward. */
  revWant: number | null;
  /** The cache revWant indexes into. */
  revCache: ReverseCache | null;
}

/**
 * lastDrawnFrame exists to cover a SEEK, when the element briefly has nothing
 * safe to sample. Refreshing it on every composite costs a full-frame GPU
 * readback per draw, and measured on 720p30 that alone held the canvas to about
 * 17 repaints per second — half the source rate, before any ramp is involved.
 * A fallback that is at most this stale is indistinguishable in use.
 */
const BITMAP_MIN_GAP = 150;

/** Longest a whole-canvas fallback snapshot may go unrefreshed while playing. */
const CANVAS_SNAPSHOT_GAP = 250;

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
    /**
     * performance.now() of the last whole-canvas snapshot.
     *
     * lastCanvasStateRef is a FALLBACK, restored only on the frames where no
     * clip managed to draw. Refreshing it costs a synchronous full-canvas
     * GPU->CPU readback, and taking that readback on every composite pinned the
     * whole renderer to ~20Hz during playback — measured with an independent
     * requestAnimationFrame counter, which collapsed from 161Hz to 20Hz the
     * moment playback started. A snapshot up to CANVAS_SNAPSHOT_GAP old serves
     * the fallback identically.
     */
    const lastCanvasCaptureAtRef = useRef(0);
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

    // Apply color grade as a CSS SVG filter on the canvas — fires once per grade change, not per frame
    const mainGrade = useMemo(() => {
      const main = videoTracks.find(
        (t) => (t as any).trackRowIndex === 0 || videoTracks.indexOf(t) === 0,
      );
      return (main as any)?.colorGrade ?? null;
    }, [videoTracks]);

    useEffect(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;

      const applyFilter = () => {
        if (gradeCompare.enabled) {
          // Keep the SVG filter alive — compare mode draws the graded half via ctx.filter
          canvas.style.filter = '';
          removeVignetteOverlay();
          removeGrainOverlay();
        } else {
          applyCSSColorGrade(canvas, mainGrade);
        }
      };

      applyFilter();
      window.addEventListener('dividr:gradeCompare', applyFilter);
      return () => {
        canvas.style.filter = '';
        removeVignetteOverlay();
        removeGrainOverlay();
        window.removeEventListener('dividr:gradeCompare', applyFilter);
      };
    }, [mainGrade]);

    const mainMotionBlur = useMemo(() => {
      const main = videoTracks.find(
        (t) => (t as any).trackRowIndex === 0 || videoTracks.indexOf(t) === 0,
      );
      return (main as any)?.motionBlur ?? 0;
    }, [videoTracks]);

    const motionBlurRef = useRef<number>(0);

    useEffect(() => {
      motionBlurRef.current = mainMotionBlur;
    }, [mainMotionBlur]);

    // Ghost canvas for motion blur — holds the previous composited frame.
    // Separate from the main canvas so canvas-to-canvas copy is always reliable.
    const ghostCanvasRef = useRef<HTMLCanvasElement | null>(null);
    const ghostCtxRef = useRef<CanvasRenderingContext2D | null>(null);

    // Temp canvas for compare mode — captures ungraded pixels before grade is drawn on left side
    const tmpCanvasRef = useRef<HTMLCanvasElement | null>(null);
    const tmpCtxRef = useRef<CanvasRenderingContext2D | null>(null);

    // Canvas setup
    useEffect(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;

      canvas.width = width;
      canvas.height = height;
      ctxRef.current = canvas.getContext('2d', { alpha: false });

      // Ghost canvas: same size, no desync — canvas-to-canvas copy must be synchronous
      const ghost = document.createElement('canvas');
      ghost.width = width;
      ghost.height = height;
      ghostCanvasRef.current = ghost;
      ghostCtxRef.current = ghost.getContext('2d', { alpha: false }) as CanvasRenderingContext2D;

      // Temp canvas for compare mode pixel capture
      const tmp = document.createElement('canvas');
      tmp.width = width;
      tmp.height = height;
      tmpCanvasRef.current = tmp;
      tmpCtxRef.current = tmp.getContext('2d', { alpha: false }) as CanvasRenderingContext2D;

      // Setting canvas.width/height WIPES the bitmap. While paused nothing else
      // repaints, so any resize (properties panel mounting on clip select /
      // unmounting on Esc) left the preview solid black until the next frame
      // change. Recomposite as soon as the new surface exists.
      const raf = requestAnimationFrame(() => {
        compositeFrameRef.current(currentFrameRef.current, true);
      });

      return () => {
        cancelAnimationFrame(raf);
        ctxRef.current = null;
        ghostCanvasRef.current = null;
        ghostCtxRef.current = null;
        tmpCtxRef.current = null;
      };
    }, [width, height]);

    // Force re-render when compare split changes so the canvas updates immediately
    useEffect(() => {
      const handler = () => {
        if (!isPlayingRef.current) {
          compositeFrameRef.current(currentFrameRef.current, false);
        }
      };
      window.addEventListener('dividr:gradeCompare', handler);
      return () => window.removeEventListener('dividr:gradeCompare', handler);
    }, []);

    // Video element management
    const getOrCreateVideoForClip = useCallback(
      (clipId: string, sourceUrl: string): ManagedVideo => {
        let managed = videosRef.current.get(clipId);

        if (managed) {
          if (managed.sourceUrl !== sourceUrl) {
            managed.element.src = sourceUrl;
            managed.sourceUrl = sourceUrl;
            managed.isReady = false;
            managed.lastDrawnFrame?.close();
            managed.lastDrawnFrame = null;
            managed.revs.forEach(disposeReverseCache);
            managed.revs.clear();
            managed.revWant = null;
            managed.revCache = null;
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
          presentedMediaTime: null,
          lastBitmapAt: 0,
          stepping: false,
          revs: new Map(),
          revWant: null,
          revCache: null,
        };

        // Self-rechaining presentation callback: keeps presentedMediaTime on
        // the frame drawImage will actually sample (see ManagedVideo docs).
        if (typeof (video as any).requestVideoFrameCallback === 'function') {
          const onPresented = (_now: number, meta: any) => {
            const m = videosRef.current.get(clipId);
            if (m) m.presentedMediaTime = meta?.mediaTime ?? null;
            // Test hook: a LOSSLESS presentation trace. Polling this value from
            // outside always misses frames, and every miss reads as a doubled
            // stride — judder that isn't there. Only the callback sees them all.
            const tr = (window as any).__srTrace;
            if (Array.isArray(tr)) tr.push([_now, meta?.mediaTime ?? null]);
            (video as any).requestVideoFrameCallback(onPresented);
          };
          (video as any).requestVideoFrameCallback(onPresented);
        }

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
        // A paused seek fires NO canplay/loadeddata — without this the composite that
        // ran at seek-START (often a black frame on 4K hardware decode) is the one
        // that sticks. Recomposite when the seeked frame is actually presentable:
        // requestVideoFrameCallback lands exactly on frame presentation; the timeout
        // fallback covers browsers/elements where rVFC never fires while paused.
        video.addEventListener('seeked', () => {
          if (isPlayingRef.current) return;
          const recomposite = () =>
            compositeFrameRef.current(currentFrameRef.current, false);
          if (typeof (video as any).requestVideoFrameCallback === 'function') {
            (video as any).requestVideoFrameCallback(() => recomposite());
            setTimeout(recomposite, 160); // belt-and-braces: rVFC can starve when paused
          } else {
            setTimeout(recomposite, 60);
          }
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
          managed.revs.forEach(disposeReverseCache);
          videosRef.current.delete(clipId);
        }
      });
    }, [videoTracks, getOrCreateVideoForClip]);

    // Test bridge. The managed elements are created detached and never appended
    // to the document, so nothing outside this component can see them — which
    // means a test can only check the drive by asking here. Read-only, and it
    // mirrors how __voiceIsolationEngine is exposed.
    useEffect(() => {
      (window as any).__dividrCompositor = {
        videos: () =>
          [...videosRef.current.values()].map((m) => ({
            clipId: m.clipId,
            currentTime: m.element.currentTime,
            // The frame actually on screen. currentTime runs ahead of it and
            // ticks at the media clock's own granularity, so it aliases badly
            // when sampled — this is the honest signal for judder.
            presentedMediaTime: m.presentedMediaTime,
            playbackRate: m.element.playbackRate,
            paused: m.element.paused,
            seeking: m.element.seeking,
            readyState: m.element.readyState,
            // Reverse drive: which grid frame the curve is asking for and how
            // much of the forward-decoded region is available to answer it.
            stepping: m.stepping,
            revWant: m.revWant,
            revCaches: [...m.revs.values()].map((c) => ({
              frames: c.frames.size,
              done: c.done,
              q: c.q,
            })),
          })),
      };
      return () => {
        delete (window as any).__dividrCompositor;
      };
    }, []);

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
          managed.revs.forEach(disposeReverseCache);
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
        timelineFrame?: number,
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
        // Transition fx (dissolve opacity / zoom scale / push-slide translate / wipe reveal).
        // Identity when no transition is active on this clip at this frame.
        const tfx = request.tfx;
        const tScaleMul = tfx?.scaleMul ?? 1;
        const tOpacity = tfx?.opacity ?? 1;

        const safeOpacity =
          (Number.isFinite(opacity) ? Math.max(0, Math.min(1, opacity)) : 1) *
          Math.max(0, Math.min(1, tOpacity));

        const drawWidth = safeWidth * scale * safeScale * tScaleMul;
        const drawHeight = safeHeight * scale * safeScale * tScaleMul;
        const centerX = canvasWidth / 2;
        const centerY = canvasHeight / 2;
        const offsetX =
          safeX * (canvasWidth / 2) + (tfx?.translateXFrac ?? 0) * canvasWidth;
        const offsetY =
          safeY * (canvasHeight / 2) + (tfx?.translateYFrac ?? 0) * canvasHeight;
        const drawX = centerX + offsetX - drawWidth / 2;
        const drawY = centerY + offsetY - drawHeight / 2;

        // Stabilization: the frame RECT stays put — the content inside it is
        // counter-moved (rotate about center + translate) and covered by the
        // clip's constant auto-zoom, exactly like the export bake. Offsets are
        // indexed by the PRESENTED frame's mediaTime, because currentTime runs
        // ahead of the displayed frame during playback and a late correction
        // adds wobble instead of cancelling it.
        const stab = (request.track as any).stabilization;
        let stabFx: { dx: number; dy: number; da: number; zoom: number } | null =
          null;
        if (stab?.enabled && stab.offsetsPath) {
          const srcT =
            !video.paused && managed.presentedMediaTime != null
              ? managed.presentedMediaTime
              : video.currentTime;
          const off = getStabilizationOffset(stab.offsetsPath, srcT);
          if (off) {
            const zoom = getStabilizationZoom(stab.offsetsPath);
            const pxScaleX = drawWidth / (video.videoWidth || safeWidth || 1);
            const pxScaleY = drawHeight / (video.videoHeight || safeHeight || 1);
            // The zoom applies on EVERY frame (it is constant — varying it
            // would breathe), so stabFx is live even at a zero offset.
            stabFx = {
              dx: off[0] * pxScaleX,
              dy: off[1] * pxScaleY,
              da: off[2],
              zoom,
            };
            if ((import.meta as any).env?.DEV) {
              (window as any).__stabApplied = {
                path: stab.offsetsPath,
                t: srcT,
                dx: off[0],
                dy: off[1],
                da: off[2],
                zoom,
                at: performance.now(),
              };
            }
          }
        }

        // Ken Burns — the drawn source window shrinks toward the focus point
        // as the playhead crosses the clip. Resolved per frame from the
        // TIMELINE position (never the media clock), so scrubbing, playback
        // and the export bake all land on the identical picture. Identity
        // (zoom 1, centred) at the clip's first frame.
        const kbTrack = request.track as unknown as {
          kenBurns?: KenBurnsState;
          startFrame?: number;
          endFrame?: number;
        };
        const kbWin =
          timelineFrame !== undefined
            ? kenBurnsWindow(
                kbTrack.kenBurns,
                timelineFrame,
                kbTrack.startFrame ?? 0,
                kbTrack.endFrame ?? (kbTrack.startFrame ?? 0) + 1,
              )
            : null;

        // Draw a source into the fixed rect, applying the stabilization
        // correction INSIDE it: p' = center + zoom * (R(p - center) + t) —
        // byte-identical to the bake's warpAffine matrix. The zoom guarantees
        // the corrected frame covers the rect, so nothing is ever revealed.
        //
        // The Ken Burns window rides the same call via drawImage's SOURCE
        // rect: the current window (fractional source px — drawImage samples
        // subpixel) fills the same fixed dest rect. Constant dest work, fewer
        // source pixels read as the zoom tightens, no clip needed — measured
        // cheaper than expanding the dest rect and clipping it.
        const drawLayer = (src: CanvasImageSource) => {
          let kbSrc: { sx: number; sy: number; sw: number; sh: number } | null =
            null;
          if (kbWin) {
            const el = src as { videoWidth?: number; width?: number; videoHeight?: number; height?: number };
            const iw = el.videoWidth || (el.width as number) || 0;
            const ih = el.videoHeight || (el.height as number) || 0;
            if (iw > 0 && ih > 0) {
              kbSrc = {
                sx: kbWin.u0 * iw,
                sy: kbWin.v0 * ih,
                sw: iw / kbWin.zoom,
                sh: ih / kbWin.zoom,
              };
            }
            // Test hook: one row per Ken Burns draw — lossless zoom trace.
            const tr = (window as never as { __kbTrace?: unknown[] }).__kbTrace;
            if (Array.isArray(tr))
              tr.push([performance.now(), timelineFrame, kbWin.zoom, kbWin.u0, kbWin.v0]);
          }
          if (!stabFx) {
            if (kbSrc) {
              ctx.drawImage(src, kbSrc.sx, kbSrc.sy, kbSrc.sw, kbSrc.sh, drawX, drawY, drawWidth, drawHeight);
            } else {
              ctx.drawImage(src, drawX, drawY, drawWidth, drawHeight);
            }
            return;
          }
          ctx.save();
          ctx.beginPath();
          ctx.rect(drawX, drawY, drawWidth, drawHeight);
          ctx.clip();
          const scx = drawX + drawWidth / 2;
          const scy = drawY + drawHeight / 2;
          ctx.translate(scx, scy);
          ctx.scale(stabFx.zoom, stabFx.zoom);
          ctx.translate(stabFx.dx, stabFx.dy);
          ctx.rotate(stabFx.da);
          ctx.translate(-scx, -scy);
          if (kbSrc) {
            ctx.drawImage(src, kbSrc.sx, kbSrc.sy, kbSrc.sw, kbSrc.sh, drawX, drawY, drawWidth, drawHeight);
          } else {
            ctx.drawImage(src, drawX, drawY, drawWidth, drawHeight);
          }
          ctx.restore();
        };

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

        // Wipe transition: clip the incoming clip to a growing region from one edge.
        if (tfx?.wipe) {
          const { direction, revealFrac } = tfx.wipe;
          const r = Math.max(0, Math.min(1, revealFrac));
          ctx.beginPath();
          if (direction === 'right') {
            ctx.rect(0, 0, canvasWidth * r, canvasHeight);
          } else if (direction === 'left') {
            ctx.rect(canvasWidth * (1 - r), 0, canvasWidth * r, canvasHeight);
          } else if (direction === 'down') {
            ctx.rect(0, 0, canvasWidth, canvasHeight * r);
          } else {
            ctx.rect(0, canvasHeight * (1 - r), canvasWidth, canvasHeight * r);
          }
          ctx.clip();
        }

        if (safeRotation !== 0) {
          const rotationCenterX = drawX + drawWidth / 2;
          const rotationCenterY = drawY + drawHeight / 2;
          ctx.translate(rotationCenterX, rotationCenterY);
          ctx.rotate((safeRotation * Math.PI) / 180);
          ctx.translate(-rotationCenterX, -rotationCenterY);
        }

        // Flip / mirror (standard editor transform) — reflect around the draw centre.
        // Identity when unset, so untouched clips render exactly as before.
        const flipH = (request.track as any).flipH ? -1 : 1;
        const flipV = (request.track as any).flipV ? -1 : 1;
        if (flipH !== 1 || flipV !== 1) {
          const fcx = drawX + drawWidth / 2;
          const fcy = drawY + drawHeight / 2;
          ctx.translate(fcx, fcy);
          ctx.scale(flipH, flipV);
          ctx.translate(-fcx, -fcy);
        }

        // Try drawing from video. A MID-SEEK element is treated as not-ready: on 4K
        // hardware decode, drawImage during a seek yields a BLACK frame, which then
        // sticks on the canvas (and poisons anything that samples it — the relighter,
        // light detection, thumbnails). The last-good-frame fallback below covers the
        // gap, and the 'seeked' recomposite repaints the real frame when it's ready.
        // A reverse region hands its picture over from the forward-decoded
        // cache. The element itself is parked, so readyState/seeking below
        // would send this straight to the last-good-frame fallback — a freeze.
        if (managed.revWant !== null && managed.revCache) {
          const cached = managed.revCache.frames.get(managed.revWant);
          if (cached) {
            try {
              drawLayer(cached);
              const dtr = (window as never as { __srDraw?: unknown[] }).__srDraw;
              if (Array.isArray(dtr))
                dtr.push([
                  performance.now(),
                  managed.revWant * managed.revCache.q,
                  managed.revWant,
                ]);
              ctx.restore();
              return true;
            } catch {
              // Fall through to the element.
            }
          }
        }

        if (video.readyState >= 2 && !video.seeking) {
          try {
            drawLayer(video);
            // Ground truth for the ramp probes: one row per PICTURE the user
            // actually gets. currentTime is recorded alongside the presented
            // mediaTime because a dropped requestVideoFrameCallback chain
            // freezes the latter and is indistinguishable from a real stall.
            const dtr = (window as never as { __srDraw?: unknown[] }).__srDraw;
            if (Array.isArray(dtr))
              dtr.push([
                performance.now(),
                video.currentTime,
                managed.presentedMediaTime,
              ]);
            ctx.restore();

            // Capture current frame for fallback (async, non-blocking), but
            // not on every composite — see BITMAP_MIN_GAP. While paused the
            // cost is free and the fallback should match exactly.
            // Keyed off isPlaying, NOT video.paused: the stepped drive parks
            // the element while playback is running, and `video.paused` there
            // would take a full-frame readback on every composited frame.
            const nowMs = performance.now();
            if (
              !isPlayingRef.current ||
              nowMs - managed.lastBitmapAt > BITMAP_MIN_GAP
            ) {
              managed.lastBitmapAt = nowMs;
              createImageBitmap(video)
                .then((bitmap) => {
                  managed.lastDrawnFrame?.close();
                  managed.lastDrawnFrame = bitmap;
                })
                .catch(() => {
                  // Ignore bitmap creation errors
                });
            }

            return true;
          } catch {
            // Fall through to fallback
          }
        }

        // Fallback: use last drawn frame
        if (managed.lastDrawnFrame) {
          try {
            drawLayer(managed.lastDrawnFrame);
            // -1 marks a REPEAT: the element was not ready, so the user is
            // looking at the previous picture again. This is what a freeze is.
            const dtr = (window as never as { __srDraw?: unknown[] }).__srDraw;
            if (Array.isArray(dtr)) dtr.push([performance.now(), -1, -1]);
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
        // Same mid-seek guard as drawVideoFrame: a seeking 4K element draws black.
        const src = video.readyState >= 2 && !video.seeking ? video : managed.lastDrawnFrame;
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
        // Canvas not sized yet (mount race / hidden panel). drawImage with a 0x0 source or
        // target throws a DOMException that crashes the whole editor subtree via the error
        // boundary — which also kills the EDITH panel. Skip this frame; it re-runs once sized.
        if (!canvas.width || !canvas.height) return false;

        const startTime = performance.now();
        // Probe hook: one row per compositeFrame CALL, which separates "the
        // draw loop stopped" from "the loop ran but had nothing to draw".
        const calls = (window as never as { __srCalls?: unknown[] }).__srCalls;
        if (Array.isArray(calls)) calls.push(startTime);
        const transitions =
          useVideoEditorStore.getState().timeline?.transitions ?? [];
        const requests = resolveFrameRequests(frameNumber, tracks, fps, transitions);
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

        // Strongest frame blending any ramped clip is asking for this frame.
        let rampBlend = 0;

        // Sync video elements
        for (const request of requests) {
          const managed = getOrCreateVideoForClip(
            request.clipId,
            request.sourceUrl,
          );
          const video = managed.element;
          const targetTime = request.sourceTime;
          const diff = Math.abs(video.currentTime - targetTime);
          // Reversed clips can't be driven by native play() (it runs forward). We advance them
          // by seeking to the resolved (decreasing) sourceTime EVERY frame, and keep the element
          // paused so play() never pushes them forward.
          const isReversed = !!(request.track as any)?.reversed;
          // Reverse wins if both are set — it already owns the read order.
          const ramp = isReversed ? undefined : effectiveRamp(request.track);
          const isRamped = isRampActive(ramp);

          if (isRamped) {
            // Rate-driven (see MIN_ELEMENT_RATE above). The curve's speed at
            // this output moment IS the element's playback rate, so the picture
            // accelerates by decoding faster rather than by jumping.
            const relOut =
              (frameNumber - (request.track.startFrame ?? 0)) / fps;
            const curveSpeed = rampSpeedAtOutput(ramp!, Math.max(0, relOut));
            rampBlend = Math.max(
              rampBlend,
              rampBlendAlpha(curveSpeed, (ramp as any).blend),
            );
            const wanted = curveSpeed * playbackRate;
            // Positive error = the element is behind where the curve says it
            // should be, so it needs to run a little faster to close the gap.
            const err = isPlaying ? targetTime - video.currentTime : 0;
            const trim = Math.max(
              -RAMP_SYNC_CLAMP,
              Math.min(RAMP_SYNC_CLAMP, err * RAMP_SYNC_GAIN),
            );
            const rate = Math.min(
              MAX_ELEMENT_RATE,
              Math.max(MIN_ELEMENT_RATE, wanted * (1 + trim)),
            );
            if (Math.abs(video.playbackRate - rate) > 1e-3) {
              try {
                video.playbackRate = rate;
              } catch {
                // Rate outside what this build supports — the resync below
                // still carries the clip, just less smoothly.
              }
            }

            // A region marked `reverse` reads its window backwards, and no
            // browser plays a video element backwards — playbackRate is clamped
            // positive. So reverse ALWAYS steps, at any speed. Driving it with
            // play() meant the element ran forward while the curve asked for
            // decreasing times, and the two fought each other every frame.
            const revRegions = (ramp!.regions ?? []).filter(
              (r) => (r as { dir?: string }).dir === 'reverse',
            ) as { a: number; b: number }[];

            // The cache is built for EVERY reverse region on the clip, not just
            // the one the playhead is inside. The fill runs forwards (a → b)
            // because that is the direction a decoder is cheap in, but reverse
            // consumes from b downwards — so the frames needed FIRST are filled
            // LAST, and a fill started on entry is useless until it completes.
            // Starting it as soon as the region exists means it is ready.
            //
            // q is fixed by the region's geometry alone. Deriving it from the
            // instantaneous curve speed rebuilt the key on every frame (measured
            // q churning 0.167 → 0.366), so the fill was cancelled and restarted
            // continuously and never got past two frames.
            const revKeys = new Set<string>();
            for (const r of revRegions) {
              const span = Math.max(1 / fps, r.b - r.a);
              const q = Math.max(1 / fps, span / REV_CACHE_MAX);
              const key = `${managed.sourceUrl}|${r.a.toFixed(3)}|${r.b.toFixed(3)}|${q.toFixed(4)}`;
              revKeys.add(key);
              if (!managed.revs.has(key))
                managed.revs.set(
                  key,
                  startReverseFill(managed.sourceUrl, r.a, r.b, q, key),
                );
            }
            for (const [key, cache] of managed.revs) {
              if (!revKeys.has(key)) {
                disposeReverseCache(cache);
                managed.revs.delete(key);
              }
            }

            const revRegion = revRegions.find(
              (r) => targetTime >= r.a && targetTime <= r.b,
            );
            const inReverse = !!revRegion;

            // Inside a reverse region the element is never seeked at all — the
            // frames come from the cache. Every backward seek the display
            // element would have made is what froze the picture.
            managed.revWant = null;
            managed.revCache = null;
            if (isPlaying && revRegion) {
              const span = Math.max(1 / fps, revRegion.b - revRegion.a);
              const q = Math.max(1 / fps, span / REV_CACHE_MAX);
              const key = `${managed.sourceUrl}|${revRegion.a.toFixed(3)}|${revRegion.b.toFixed(3)}|${q.toFixed(4)}`;
              const cache = managed.revs.get(key);
              const want = Math.round(targetTime / q);
              if (cache?.frames.has(want)) {
                managed.revWant = want;
                managed.revCache = cache;
                if (!video.paused) video.pause();
                managed.stepping = true;
                continue;
              }
              // Still filling: keep stepping so the picture keeps moving, and
              // hand over the moment the frame it wants exists.
            }

            if (isPlaying && (inReverse || curveSpeed > RAMP_RATE_CEILING)) {
              // STEP DRIVE. Past a few times normal the decoder cannot sustain
              // the rate however politely it is asked, so it stops being worth
              // asking. Measured on 720p: rate-driving 25x produced 3.3-SECOND
              // jumps, because the element ran at its ceiling, fell behind, and
              // was yanked forward by the resync — the lurch reads as a cut.
              //
              // The element is parked and seeked instead, one seek at a time,
              // never retargeting mid-seek (retargeting is what froze v1).
              //
              // The target is SNAPPED TO A GRID. Seeking to the exact playhead
              // meant each completed seek was immediately followed by another
              // to wherever the playhead had run to while the first was
              // working, so the stride was whatever that seek happened to cost
              // — measured as whole source seconds with no picture at all, then
              // a jump. On a grid the picture advances by a constant amount
              // each time. Even decimation reads as fast motion; uneven
              // decimation reads as broken.
              if (!video.paused) video.pause();
              managed.stepping = true;
              const q = Math.max(
                1 / fps,
                Math.abs(curveSpeed) / STEP_PICTURES_PER_SEC,
              );
              const snapped = Math.round(targetTime / q) * q;
              if (
                !video.seeking &&
                video.readyState >= 1 &&
                Math.abs(managed.lastSeekTime - snapped) > q * 0.5
              ) {
                video.currentTime = snapped;
                managed.lastSeekTime = snapped;
              }
            } else if (isPlaying) {
              // LEAVING STEP DRIVE. The element is parked on the last grid
              // point, up to half a step from the playhead, and handing it
              // straight to play() let it resume from there — the resync gate
              // below (diff > RAMP_RESYNC_SECONDS) is far too coarse to catch
              // it. Measured just past the ramp's exit: a 1598ms hole in the
              // picture, on a stretch running at 1x. One exact seek to close
              // the gap, and no play() until it lands, costs a single frame.
              if (managed.stepping) {
                if (video.seeking) continue;
                managed.stepping = false;
                if (video.readyState >= 1) {
                  video.currentTime = targetTime;
                  managed.lastSeekTime = targetTime;
                  continue;
                }
              }
              if (video.paused && video.readyState >= 2 && !video.seeking) {
                video.play().catch(() => {
                  // Ignore autoplay errors
                });
              }
              // Only when the rate trim cannot win. Never retarget mid-seek —
              // that is what starved the decoder into a frozen picture.
              if (
                !video.seeking &&
                diff > RAMP_RESYNC_SECONDS &&
                video.readyState >= 1
              ) {
                video.currentTime = targetTime;
                managed.lastSeekTime = targetTime;
              }
            } else {
              if (!video.paused) video.pause();
              // Compare against what was last REQUESTED, not against
              // video.currentTime. After a seek the element reports a time of
              // its own choosing (browsers differ on whether it snaps to the
              // decoded frame), and testing that reading re-arms the seek that
              // just finished — seek → seeked → seek, forever, with the picture
              // stuck on the last frame that made it to the canvas. The request
              // is unambiguous: if it hasn't moved, there is nothing to do.
              const halfFrame = 0.5 / Math.max(1, fps);
              if (
                !video.seeking &&
                video.readyState >= 1 &&
                Math.abs(managed.lastSeekTime - targetTime) > halfFrame
              ) {
                video.currentTime = targetTime;
                managed.lastSeekTime = targetTime;
              }
            }
            continue;
          }

          const effectiveTolerance = isReversed ? 0 : seekTolerance;

          if ((forceSync || diff > effectiveTolerance) && video.readyState >= 1) {
            video.currentTime = targetTime;
            managed.lastSeekTime = targetTime;
          }

          if (video.playbackRate !== playbackRate) {
            video.playbackRate = playbackRate;
          }

          if (isPlaying && !isReversed) {
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
            drawn = drawVideoFrame(ctx, managed, request, canvas.width, canvas.height, frameNumber);
          }
          if (drawn) renderedAny = true;
        }

        // Dip-to-color transition: full-frame flash peaking at the overlap midpoint.
        const dip = resolveDipOverlay(frameNumber, tracks, transitions, fps);
        if (dip && dip.alpha > 0) {
          ctx.save();
          ctx.globalAlpha = Math.max(0, Math.min(1, dip.alpha));
          ctx.fillStyle = dip.color;
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.restore();
        }

        // Motion blur preview — draw the previous composited frame (ghostCanvas) on top
        // of the current frame at reduced opacity. No async capture needed: ghost canvas
        // is updated synchronously at the end of each compositeFrame call.
        // Static scenes: ghost ≈ current → blend is invisible.
        // Moving scenes: ghost is spatially offset → visible directional smear.
        // A speed ramp asks for the same trail on its own account (see
        // rampBlendAlpha) — whichever wants more smear wins, so the two never
        // stack into mush.
        const blurAlpha = Math.max(
          motionBlurRef.current > 0 ? 0.4 + (motionBlurRef.current / 100) * 0.4 : 0,
          rampBlend,
        );
        if (renderedAny && isPlaying && blurAlpha > 0 && ghostCanvasRef.current
            && ghostCanvasRef.current.width > 0 && ghostCanvasRef.current.height > 0) {
          const ghostAlpha = blurAlpha;
          ctx.globalAlpha = ghostAlpha;
          ctx.drawImage(ghostCanvasRef.current, 0, 0, canvas.width, canvas.height);
          ctx.globalAlpha = 1;
        }

        // Capture this frame into the ghost canvas for use in the next frame
        if (ghostCtxRef.current) {
          ghostCtxRef.current.drawImage(canvas, 0, 0);
        }

        // Compare mode: draw graded left half + ungraded right half + split line on canvas
        if (gradeCompare.enabled && tmpCtxRef.current && tmpCanvasRef.current) {
          const tmp = tmpCanvasRef.current;
          const tmpCtx = tmpCtxRef.current;
          const splitX = Math.round(gradeCompare.split * canvas.width);

          // Capture the current ungraded frame
          tmpCtx.drawImage(canvas, 0, 0);

          // Draw the graded left portion using ctx.filter (SVG filter already in DOM)
          try {
            ctx.save();
            ctx.filter = `url(#${GRADE_FILTER_ID})`;
            ctx.beginPath();
            ctx.rect(0, 0, splitX, canvas.height);
            ctx.clip();
            ctx.drawImage(tmp, 0, 0);
            ctx.restore();
          } catch {
            // ctx.filter unsupported — skip grade on left half
          }

          // Draw split line
          ctx.save();
          ctx.strokeStyle = 'rgba(255,255,255,0.85)';
          ctx.lineWidth = 2;
          ctx.shadowColor = 'rgba(0,0,0,0.5)';
          ctx.shadowBlur = 6;
          ctx.beginPath();
          ctx.moveTo(splitX, 0);
          ctx.lineTo(splitX, canvas.height);
          ctx.stroke();
          ctx.restore();
        }

        // Global fallback
        if (!renderedAny && hasClips && lastCanvasStateRef.current) {
          ctx.putImageData(lastCanvasStateRef.current, 0, 0);
          statsRef.current.fallbacksUsed++;
          return true;
        }

        if (renderedAny) {
          // Never capture the fallback snapshot while a video is mid-seek: the frame
          // just drawn may be decoder black, and a poisoned snapshot makes every
          // later fallback restore black instead of the last real picture.
          const anySeeking = requests.some(
            (r) => videosRef.current.get(r.clipId)?.element.seeking,
          );
          try {
            const nowMs = performance.now();
            const stale =
              !isPlaying ||
              nowMs - lastCanvasCaptureAtRef.current > CANVAS_SNAPSHOT_GAP;
            if (!anySeeking && stale) {
              lastCanvasCaptureAtRef.current = nowMs;
              lastCanvasStateRef.current = ctx.getImageData(
                0,
                0,
                canvas.width,
                canvas.height,
              );
            }
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
      // Two rAFs: first lets React flush, second lets compositeFrameRef update.
      // Cancel both on unmount so the closure can't run after teardown.
      let r1 = 0;
      let r2 = 0;
      r1 = requestAnimationFrame(() => {
        r2 = requestAnimationFrame(() => {
          compositeFrameRef.current(currentFrameRef.current, true);
        });
      });
      return () => {
        cancelAnimationFrame(r1);
        if (r2) cancelAnimationFrame(r2);
      };
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
          const cg = t.colorGrade;
          const gradeKey = cg
            ? `${cg.temperature ?? 0},${cg.tint ?? 0},${cg.hue ?? 0},${cg.shadows ?? 0},${cg.midtones ?? 0},${cg.highlights ?? 0},${cg.vignette ?? 0},${cg.sharpen ?? 0},${cg.blur ?? 0},${cg.curves ? '1' : '0'}`
            : '';
          // A ramp changes which source frame this output frame shows, so a
          // committed ramp edit has to repaint a paused preview just like a
          // transform does. Drag-time changes come through forceRender instead.
          const sr = (t as any).speedRamp;
          const rampKey = sr?.enabled
            ? `${sr.regions?.length ?? 0}:${(sr.regions ?? [])
                .map(
                  (r: any) =>
                    `${r.a},${r.b},${r.shape},${r.dir},${(r.segs ?? []).join('/')},${(r.bounds ?? []).map((b: any) => `${b.t0}-${b.t1}`).join('/')}`,
                )
                .join(';')}`
            : '';
          return `${t.id}:${x},${y},${scale},${rotation},${t.filter ?? ''},${t.proxyBlockedMessage ?? ''},${gradeKey},${(t as any).motionBlur ?? 0},${(t as any).flipH ? 1 : 0}${(t as any).flipV ? 1 : 0},${rampKey}`;
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
          pointerEvents: 'none',
        }}
        aria-label="Video preview canvas"
      />
    );
  },
);

FrameDrivenCompositor.displayName = 'FrameDrivenCompositor';

export default FrameDrivenCompositor;
