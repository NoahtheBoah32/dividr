/**
 * MultiAudioPlayer - Audio playback for timeline tracks.
 *
 * Supports two modes:
 * - Legacy mode: Audio elements keyed by source URL
 * - Frame-driven mode: Audio elements keyed by clip ID (handles same-source overlaps)
 */

import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { VideoTrack } from '../../stores/videoEditor/index';
import { resolveAudioFrameRequests } from '../services/FrameResolver';
import { NoiseReductionCache } from '../services/NoiseReductionCache';
import { SeparationCache } from '../services/SeparationCache';
import { VoiceIsolationEngine } from '../services/VoiceIsolationEngine';
import { USE_FRAME_DRIVEN_PLAYBACK } from './UnifiedOverlayRenderer';

export interface MultiAudioPlayerProps {
  audioTracks: VideoTrack[];
  currentFrame: number;
  fps: number;
  isPlaying: boolean;
  isMuted: boolean;
  volume: number;
  playbackRate: number;
  useSourceRegistry?: boolean;
}

interface AudioElementState {
  element: HTMLAudioElement;
  trackId: string;
  previewUrl: string;
  isPlaying: boolean;
}

const calculateAudioSourceTime = (
  track: VideoTrack,
  currentFrame: number,
  fps: number,
): number => {
  const relativeFrame = Math.max(0, currentFrame - track.startFrame);
  const relativeTime = relativeFrame / fps;
  return (track.sourceStartTime || 0) + relativeTime;
};

export const MultiAudioPlayer: React.FC<MultiAudioPlayerProps> = ({
  audioTracks,
  currentFrame,
  fps,
  isPlaying,
  isMuted,
  volume,
  playbackRate,
  useSourceRegistry = USE_FRAME_DRIVEN_PLAYBACK,
}) => {
  const audioElementsRef = useRef<Map<string, AudioElementState>>(new Map());
  const trackToUrlRef = useRef<Map<string, string>>(new Map());
  const activeUrlTrackRef = useRef<Map<string, string>>(new Map());
  const lastActiveSegmentRef = useRef<
    Map<string, { trackId: string; startFrame: number; endFrame: number }>
  >(new Map());
  const prevFrameRef = useRef<number>(currentFrame);
  const prevIsPlayingRef = useRef<boolean>(isPlaying);
  const lastUpdateRef = useRef<number>(0);

  // Compute a signature that changes when any track's volume properties change
  // This is used by the volume-update effect to react to volumeDb/muted changes
  const volumeSignature = useMemo(() => {
    return audioTracks
      .map((t) => `${t.id}:${t.volumeDb ?? 0}:${t.muted ? 1 : 0}`)
      .join('|');
  }, [audioTracks]);

  const getOrCreateAudioElement = useCallback(
    (previewUrl: string, trackId: string): HTMLAudioElement | null => {
      if (!previewUrl) return null;

      const existing = audioElementsRef.current.get(previewUrl);
      if (existing) {
        trackToUrlRef.current.set(trackId, previewUrl);
        return existing.element;
      }

      const audio = new Audio();
      // Voice isolation taps this element with the Web Audio API
      // (createMediaElementSource). The media server is cross-origin
      // (http://localhost:<mediaPort> vs the renderer origin) and sends
      // Access-Control-Allow-Origin: *, so we MUST opt into CORS before
      // setting src — otherwise the tapped source is tainted and Web Audio
      // emits pure silence. Mirrors VideoPreview / FrameDrivenCompositor.
      audio.crossOrigin = 'anonymous';
      audio.preload = 'auto';
      audio.src = previewUrl;

      audioElementsRef.current.set(previewUrl, {
        element: audio,
        trackId,
        previewUrl,
        isPlaying: false,
      });

      trackToUrlRef.current.set(trackId, previewUrl);
      return audio;
    },
    [],
  );

  const stopAllAudio = useCallback(() => {
    audioElementsRef.current.forEach((state) => {
      if (!state.element.paused) {
        state.element.pause();
      }
      state.isPlaying = false;
    });
  }, []);

  // Cleanup unused audio elements
  useEffect(() => {
    const now = Date.now();
    if (now - lastUpdateRef.current < 100) return;
    lastUpdateRef.current = now;

    const activeUrls = new Set<string>();
    audioTracks.forEach((track) => {
      if (track.previewUrl) activeUrls.add(track.previewUrl);
    });

    audioElementsRef.current.forEach((state, url) => {
      if (!activeUrls.has(url)) {
        state.element.pause();
        state.element.src = '';
        state.element.load();
        audioElementsRef.current.delete(url);
      }
    });

    trackToUrlRef.current.forEach((_, trackId) => {
      if (!audioTracks.some((t) => t.id === trackId)) {
        trackToUrlRef.current.delete(trackId);
      }
    });
  }, [audioTracks]);

  // Legacy mode: audio sync by URL
  useEffect(() => {
    if (useSourceRegistry) return;

    const frameDelta = Math.abs(currentFrame - prevFrameRef.current);
    const playStateChanged = isPlaying !== prevIsPlayingRef.current;

    prevFrameRef.current = currentFrame;
    prevIsPlayingRef.current = isPlaying;

    const seekFrameThreshold = Math.max(5, Math.floor(fps * 0.5));
    const isSeekJump = frameDelta > seekFrameThreshold;
    const isPausedScrub = !isPlaying;
    const isSeek = isSeekJump || isPausedScrub;

    if (isSeek && (isPausedScrub || frameDelta > seekFrameThreshold * 2)) {
      stopAllAudio();
    }

    const activeSegmentsByUrl = new Map<string, VideoTrack>();

    audioTracks.forEach((track) => {
      if (!track.previewUrl) return;

      const isActiveAtFrame =
        currentFrame >= track.startFrame && currentFrame < track.endFrame;
      if (!isActiveAtFrame) return;

      const existing = activeSegmentsByUrl.get(track.previewUrl);
      if (!existing) {
        activeSegmentsByUrl.set(track.previewUrl, track);
        return;
      }

      const existingRow = existing.trackRowIndex ?? 0;
      const trackRow = track.trackRowIndex ?? 0;
      if (
        trackRow > existingRow ||
        (trackRow === existingRow && existing.startFrame < track.startFrame)
      ) {
        activeSegmentsByUrl.set(track.previewUrl, track);
      }
    });

    const activeUrls = new Set<string>();

    activeSegmentsByUrl.forEach((track) => {
      if (!track.previewUrl) return;
      activeUrls.add(track.previewUrl);

      const audio = getOrCreateAudioElement(track.previewUrl, track.id);
      if (!audio) return;

      const targetTime = calculateAudioSourceTime(track, currentFrame, fps);

      const lastSegment = lastActiveSegmentRef.current.get(track.previewUrl);
      const isNewSegment =
        !lastSegment ||
        lastSegment.trackId !== track.id ||
        lastSegment.startFrame !== track.startFrame;

      lastActiveSegmentRef.current.set(track.previewUrl, {
        trackId: track.id,
        startFrame: track.startFrame,
        endFrame: track.endFrame,
      });

      if (isNewSegment) {
        audio.pause();
        const state = audioElementsRef.current.get(track.previewUrl);
        if (state) state.isPlaying = false;
        if (audio.readyState >= 1) audio.currentTime = targetTime;
        activeUrlTrackRef.current.set(track.previewUrl, track.id);
      }

      const shouldMute = isMuted || track.muted;
      audio.muted = shouldMute;
      audio.volume = shouldMute ? 0 : Math.min(volume, 1);
      audio.playbackRate = Math.max(0.25, Math.min(playbackRate, 4));

      const diff = Math.abs(audio.currentTime - targetTime);
      const tolerance = isPlaying ? 0.2 : 0.1;

      if ((isSeek || playStateChanged || diff > tolerance) && !isNewSegment) {
        if (diff > tolerance) {
          if (diff > tolerance * 2) {
            audio.pause();
            const state = audioElementsRef.current.get(track.previewUrl);
            if (state) state.isPlaying = false;
          }
          if (audio.readyState >= 1) audio.currentTime = targetTime;
        }
      }

      if (isPlaying) {
        const state = audioElementsRef.current.get(track.previewUrl);
        if (audio.paused && audio.readyState >= 2 && !state?.isPlaying) {
          if (state) state.isPlaying = true;
          audio.play().catch(() => {
            if (state) state.isPlaying = false;
          });
        }
      } else {
        if (!audio.paused) {
          audio.pause();
          const state = audioElementsRef.current.get(track.previewUrl);
          if (state) state.isPlaying = false;
        }
      }
    });

    audioElementsRef.current.forEach((state, url) => {
      if (activeUrls.has(url)) return;
      if (!state.element.paused) state.element.pause();
      state.isPlaying = false;
      activeUrlTrackRef.current.delete(url);
      lastActiveSegmentRef.current.delete(url);
    });
  }, [
    audioTracks,
    currentFrame,
    fps,
    isPlaying,
    isMuted,
    volume,
    playbackRate,
    getOrCreateAudioElement,
    stopAllAudio,
    useSourceRegistry,
  ]);

  // Cleanup on unmount (legacy mode)
  useEffect(() => {
    return () => {
      audioElementsRef.current.forEach((state) => {
        state.element.pause();
        state.element.src = '';
        state.element.load();
      });
      audioElementsRef.current.clear();
      trackToUrlRef.current.clear();
      lastActiveSegmentRef.current.clear();
    };
  }, []);

  // Frame-driven mode: audio elements per SOURCE ID (not clip ID)
  // This enables seamless transitions between same-source segments
  const sourceAudioElementsRef = useRef<Map<string, HTMLAudioElement>>(
    new Map(),
  );
  const sourceAudioStateRef = useRef<
    Map<
      string,
      {
        lastSourceTime: number;
        lastClipId: string;
        expectedNextTime: number;
        isPlaying: boolean;
      }
    >
  >(new Map());

  // Source-separation stem playback: when a source has baked stems and the mix
  // is enabled, we play the VOICE and BACKGROUND stems as two synced <audio>
  // elements instead of the original. The browser sums their outputs, so the
  // mix is just two volume levels (no Web Audio tap needed — fully real-time).
  const stemAudioElementsRef = useRef<
    Map<
      string,
      { voice: HTMLAudioElement; bg: HTMLAudioElement; voiceUrl: string; bgUrl: string }
    >
  >(new Map());

  const teardownStems = useCallback((sourceId: string) => {
    const stems = stemAudioElementsRef.current.get(sourceId);
    if (!stems) return;
    VoiceIsolationEngine.teardownStems(sourceId);
    for (const el of [stems.voice, stems.bg]) {
      el.pause();
      el.src = '';
      el.load();
    }
    stemAudioElementsRef.current.delete(sourceId);
  }, []);

  // Test/debug probe — the audio elements never touch the DOM (new Audio()),
  // so e2e tests read what is actually audible through this window hook.
  // Reports both maps: legacy (per previewUrl) and frame-driven (per sourceId).
  useEffect(() => {
    (window as unknown as { __audioElsProbe?: unknown }).__audioElsProbe =
      () => {
        const rows: Record<string, unknown>[] = [];
        audioElementsRef.current.forEach((s) => {
          rows.push({
            mode: 'legacy',
            key: s.previewUrl,
            trackId: s.trackId,
            paused: s.element.paused,
            currentTime: s.element.currentTime,
            muted: s.element.muted,
            volume: s.element.volume,
          });
        });
        sourceAudioElementsRef.current.forEach((el, sourceId) => {
          rows.push({
            mode: 'source',
            key: sourceId,
            paused: el.paused,
            currentTime: el.currentTime,
            muted: el.muted,
            volume: el.volume,
          });
        });
        return rows;
      };
    return () => {
      delete (window as unknown as { __audioElsProbe?: unknown })
        .__audioElsProbe;
    };
  }, []);

  // Tolerance for detecting continuous playback (prevents unnecessary seeks)
  const CONTINUITY_TOLERANCE = 0.15; // 150ms - covers frame timing variance
  const PLAYBACK_SYNC_TOLERANCE = 0.3; // 300ms during playback

  // Separate effect for volume-only updates (no seeking, no playback changes)
  // This runs whenever volume properties change and immediately updates audio.volume
  useEffect(() => {
    if (!useSourceRegistry) return;

    // Directly update volume on all active audio elements
    sourceAudioElementsRef.current.forEach((audio, sourceId) => {
      // Find the track for this source to get its current volume
      const track = audioTracks.find((t) => {
        const url = t.previewUrl;
        if (!url) return false;
        try {
          if (url.startsWith('blob:')) return url === sourceId;
          const parsed = new URL(url, window.location.origin);
          return decodeURIComponent(parsed.pathname) === sourceId;
        } catch {
          return url === sourceId;
        }
      });

      if (track) {
        const volumeDb = track.volumeDb ?? 0;
        const linearVolume = volumeDb <= -60 ? 0 : Math.pow(10, volumeDb / 20);
        const shouldMute = isMuted || track.muted;
        audio.muted = shouldMute;
        audio.volume = shouldMute ? 0 : Math.min(volume * linearVolume, 1);
      }
    });

    // Mirror track volume/mute onto any active stem elements (pre-graph). The
    // curve's per-stem mix lives in the engine, not here, so this only carries
    // the track's own volume slider.
    stemAudioElementsRef.current.forEach((stems, sourceId) => {
      const track = audioTracks.find((t) => {
        const url = t.previewUrl;
        if (!url) return false;
        try {
          if (url.startsWith('blob:')) return url === sourceId;
          return decodeURIComponent(new URL(url, window.location.origin).pathname) === sourceId;
        } catch {
          return url === sourceId;
        }
      });
      if (!track) return;
      const volumeDb = track.volumeDb ?? 0;
      const linearVolume = volumeDb <= -60 ? 0 : Math.pow(10, volumeDb / 20);
      const shouldMute = isMuted || track.muted;
      const baseVol = shouldMute ? 0 : Math.min(volume * linearVolume, 1);
      stems.voice.muted = shouldMute;
      stems.bg.muted = shouldMute;
      stems.voice.volume = baseVol;
      stems.bg.volume = baseVol;
    });
  }, [audioTracks, volumeSignature, isMuted, volume, useSourceRegistry]);

  useEffect(() => {
    if (!useSourceRegistry) return;

    const frameDelta = Math.abs(currentFrame - prevFrameRef.current);
    const playStateChanged = isPlaying !== prevIsPlayingRef.current;
    const seekFrameThreshold = Math.max(5, Math.floor(fps * 0.5));
    const isLargeSeek = frameDelta > seekFrameThreshold;

    // Time delta since last frame (for continuity check)
    const timeDelta = frameDelta / fps;

    const audioRequests = resolveAudioFrameRequests(
      currentFrame,
      audioTracks,
      fps,
    );

    // Group requests by source for seamless same-source transitions
    const requestsBySource = new Map<string, typeof audioRequests>();
    for (const request of audioRequests) {
      const existing = requestsBySource.get(request.sourceId) || [];
      existing.push(request);
      requestsBySource.set(request.sourceId, existing);
    }

    const activeSourceIds = new Set<string>();

    requestsBySource.forEach((requests, sourceId) => {
      activeSourceIds.add(sourceId);

      // Use highest priority request for this source (highest trackRowIndex)
      const request = requests.reduce((best, curr) =>
        curr.trackRowIndex > best.trackRowIndex ? curr : best,
      );

      // ── Voice isolation via real source separation (two-stem live mix) ──────
      // When EDITH has baked stems for this source AND voice isolation is on,
      // play the VOICE + BACKGROUND stems as two synced elements routed through
      // the isolation engine. The curve drives the mix (its left side = the
      // background stem level, right side = the voice stem level) AND the EQ on
      // the voice stem, so pulling the left side down truly removes background.
      const vi = (request.track as any).voiceIsolation as
        | { enabled?: boolean; nodes?: { x: number; y: number }[] }
        | undefined;
      const sep = (request.track as any).separation as
        | { status?: string }
        | undefined;
      let voiceStemUrl: string | null = null;
      let bgStemUrl: string | null = null;
      if (vi?.enabled && sep?.status === 'cached') {
        voiceStemUrl = SeparationCache.getVoiceUrl(sourceId);
        bgStemUrl = SeparationCache.getBackgroundUrl(sourceId);
      }

      if (voiceStemUrl && bgStemUrl) {
        // Silence the original-mix element while the stems play.
        const primary = sourceAudioElementsRef.current.get(sourceId);
        if (primary && !primary.paused) primary.pause();

        let stems = stemAudioElementsRef.current.get(sourceId);
        if (!stems || stems.voiceUrl !== voiceStemUrl || stems.bgUrl !== bgStemUrl) {
          if (stems) teardownStems(sourceId);
          const voice = new Audio();
          voice.crossOrigin = 'anonymous';
          voice.preload = 'auto';
          voice.src = voiceStemUrl;
          const bg = new Audio();
          bg.crossOrigin = 'anonymous';
          bg.preload = 'auto';
          bg.src = bgStemUrl;
          stems = { voice, bg, voiceUrl: voiceStemUrl, bgUrl: bgStemUrl };
          stemAudioElementsRef.current.set(sourceId, stems);
        }

        // Track volume/mute apply to BOTH stem ELEMENTS (pre-graph); the curve
        // drives the per-stem mix + the voice-stem EQ inside the engine.
        const shouldMute = isMuted || request.muted;
        const baseVol = shouldMute ? 0 : Math.min(volume * request.volume, 1);
        stems.voice.muted = shouldMute;
        stems.bg.muted = shouldMute;
        stems.voice.volume = baseVol;
        stems.bg.volume = baseVol;
        const rate = Math.max(0.25, Math.min(playbackRate, 4));
        stems.voice.playbackRate = rate;
        stems.bg.playbackRate = rate;

        VoiceIsolationEngine.applyStems(
          sourceId,
          stems.voice,
          stems.bg,
          vi?.nodes ?? [],
          !!vi?.enabled,
        );

        // Seek decision — same continuity logic, referenced to the voice stem
        // as the master clock; the background stem is slaved to it.
        const lastState = sourceAudioStateRef.current.get(sourceId);
        const targetSourceTime = request.sourceTime;
        const diff = Math.abs(stems.voice.currentTime - targetSourceTime);
        let shouldSeek = false;
        if (!lastState) shouldSeek = true;
        else if (isLargeSeek) shouldSeek = diff > CONTINUITY_TOLERANCE;
        else if (playStateChanged && !isPlaying) shouldSeek = diff > CONTINUITY_TOLERANCE;
        else if (isPlaying) shouldSeek = diff > PLAYBACK_SYNC_TOLERANCE;
        else shouldSeek = diff > CONTINUITY_TOLERANCE;

        if (shouldSeek && stems.voice.readyState >= 1) {
          stems.voice.currentTime = targetSourceTime;
        }
        if (
          stems.bg.readyState >= 1 &&
          Math.abs(stems.bg.currentTime - stems.voice.currentTime) > CONTINUITY_TOLERANCE
        ) {
          stems.bg.currentTime = stems.voice.currentTime;
        }

        if (isPlaying) {
          for (const el of [stems.voice, stems.bg]) {
            if (el.paused && el.readyState >= 2) el.play().catch(() => {});
          }
        } else {
          for (const el of [stems.voice, stems.bg]) if (!el.paused) el.pause();
        }

        sourceAudioStateRef.current.set(sourceId, {
          lastSourceTime: targetSourceTime,
          lastClipId: request.clipId,
          expectedNextTime: targetSourceTime + 1 / fps,
          isPlaying,
        });
        return; // handled — skip the single-element path
      }

      // Not in stem mode: drop any stem elements left from a previous mix.
      if (stemAudioElementsRef.current.has(sourceId)) teardownStems(sourceId);

      // Determine the audio source URL - use processed version if available
      let resolvedSourceUrl = request.sourceUrl;
      if (request.track.noiseReductionEnabled) {
        // CRITICAL: Use the track's stored engine to retrieve the correct cached audio
        // Without this, DeepFilterNet2 processed audio would be retrieved from the wrong cache key
        const engine = request.track.noiseReductionEngine || 'ffmpeg';
        const processedUrl = NoiseReductionCache.getProcessedUrl(
          sourceId,
          engine,
        );
        if (processedUrl) {
          resolvedSourceUrl = processedUrl;
        }
      }

      let audio = sourceAudioElementsRef.current.get(sourceId);
      if (!audio) {
        audio = new Audio();
        // Opt into CORS BEFORE setting src so the Web Audio voice-isolation
        // tap (createMediaElementSource) gets real samples instead of a
        // tainted-silence source. The cross-origin media server sends
        // Access-Control-Allow-Origin: *; native playback is unaffected.
        audio.crossOrigin = 'anonymous';
        audio.preload = 'auto';
        audio.src = resolvedSourceUrl;
        sourceAudioElementsRef.current.set(sourceId, audio);
      } else if (audio.src !== resolvedSourceUrl) {
        // Source URL changed (original <-> processed, or different source)
        audio.src = resolvedSourceUrl;
        audio.load();
      }

      const shouldMute = isMuted || request.muted;
      audio.muted = shouldMute;
      audio.volume = shouldMute ? 0 : Math.min(volume * request.volume, 1);
      audio.playbackRate = Math.max(0.25, Math.min(playbackRate, 4));

      // Voice isolation EQ fallback (no baked stems yet): tap this element with
      // the Web Audio graph when the effect is enabled, and re-apply the
      // (possibly just-dragged) curve each frame so changes are heard in real
      // time. `vi` was resolved above for the stem branch. volume/mute apply
      // pre-graph, so they keep working. Once tapped we keep applying (flat when
      // disabled) so toggling off is transparent without a reconnect race.
      if (vi?.enabled || VoiceIsolationEngine.isTapped(sourceId)) {
        VoiceIsolationEngine.apply(
          sourceId,
          audio,
          vi?.nodes ?? [],
          !!vi?.enabled,
        );
      }

      // Reverb Processor: live bidirectional reverb (negative strips via the
      // suppressor worklet, positive adds via a ConvolverNode). Applied every
      // frame so slider drags are heard IMMEDIATELY — pure parameter changes,
      // no bake, no reconnect. Only taps when actually non-zero; once the stage
      // is attached we keep applying (transparent at 0) to avoid reconnect races.
      const rp = (request.track as any).reverbProcessor as
        | { amount?: number }
        | undefined;
      const rpAmount = rp?.amount ?? 0;
      if (rpAmount !== 0 || VoiceIsolationEngine.isReverbAttached(sourceId)) {
        VoiceIsolationEngine.applyReverb(sourceId, audio, rpAmount, rpAmount !== 0);
      }

      const lastState = sourceAudioStateRef.current.get(sourceId);
      const currentAudioTime = audio.currentTime;
      const targetSourceTime = request.sourceTime;
      const diff = Math.abs(currentAudioTime - targetSourceTime);

      // Determine if we should seek or let playback continue
      let shouldSeek = false;

      if (!lastState) {
        // First time seeing this source - seek to target
        shouldSeek = true;
      } else if (isLargeSeek) {
        // User performed a large timeline seek - always seek audio
        shouldSeek = diff > CONTINUITY_TOLERANCE;
      } else if (playStateChanged && !isPlaying) {
        // Just paused - seek to exact position
        shouldSeek = diff > CONTINUITY_TOLERANCE;
      } else if (isPlaying) {
        // During playback - check if audio is tracking timeline correctly
        // Only seek if we've drifted significantly
        shouldSeek = diff > PLAYBACK_SYNC_TOLERANCE;

        // CRITICAL: Check for segment transition continuity
        // If the expected source time matches target, this is a seamless transition
        if (lastState.lastClipId !== request.clipId) {
          // Clip changed - check if source time is continuous
          const expectedTime = lastState.lastSourceTime + timeDelta;
          const isContinuous =
            Math.abs(targetSourceTime - expectedTime) < CONTINUITY_TOLERANCE;

          if (isContinuous) {
            // Seamless same-source transition - DON'T seek, let audio continue
            shouldSeek = false;
          } else {
            // Discontinuous transition - seek to new position
            shouldSeek = diff > CONTINUITY_TOLERANCE;
          }
        }
      } else {
        // Paused scrubbing - seek to match timeline
        shouldSeek = diff > CONTINUITY_TOLERANCE;
      }

      if (shouldSeek && audio.readyState >= 1) {
        audio.currentTime = targetSourceTime;
      }

      // Handle play/pause
      if (isPlaying) {
        if (audio.paused && audio.readyState >= 2) {
          audio.play().catch(() => {
            // Ignore autoplay errors
          });
        }
      } else {
        if (!audio.paused) audio.pause();
      }

      // Update state for next frame
      sourceAudioStateRef.current.set(sourceId, {
        lastSourceTime: targetSourceTime,
        lastClipId: request.clipId,
        expectedNextTime: targetSourceTime + 1 / fps,
        isPlaying,
      });
    });

    // Pause audio for sources no longer active
    sourceAudioElementsRef.current.forEach((audio, sourceId) => {
      if (activeSourceIds.has(sourceId)) return;
      if (!audio.paused) audio.pause();
      sourceAudioStateRef.current.delete(sourceId);
    });
    // Pause stem elements for sources no longer active (kept for seamless resume).
    stemAudioElementsRef.current.forEach((stems, sourceId) => {
      if (activeSourceIds.has(sourceId)) return;
      for (const el of [stems.voice, stems.bg]) if (!el.paused) el.pause();
    });

    // Update refs for next frame comparison
    prevFrameRef.current = currentFrame;
    prevIsPlayingRef.current = isPlaying;
  }, [
    audioTracks,
    currentFrame,
    fps,
    isPlaying,
    isMuted,
    volume,
    playbackRate,
    useSourceRegistry,
    // Note: volumeSignature is NOT included here - volume updates are handled
    // by a separate effect to avoid triggering seek logic
  ]);

  // Cleanup source audio when tracks change
  useEffect(() => {
    if (!useSourceRegistry) return;

    // Get all active source IDs from current tracks
    const activeSourceIds = new Set<string>();
    audioTracks.forEach((track) => {
      const sourceUrl = track.previewUrl;
      if (sourceUrl) {
        // Normalize to match how we key in the map
        try {
          if (sourceUrl.startsWith('blob:')) {
            activeSourceIds.add(sourceUrl);
          } else {
            const parsed = new URL(sourceUrl, window.location.origin);
            activeSourceIds.add(decodeURIComponent(parsed.pathname));
          }
        } catch {
          activeSourceIds.add(sourceUrl);
        }
      }
    });

    sourceAudioElementsRef.current.forEach((audio, sourceId) => {
      if (!activeSourceIds.has(sourceId)) {
        VoiceIsolationEngine.teardown(sourceId);
        audio.pause();
        audio.src = '';
        audio.load();
        sourceAudioElementsRef.current.delete(sourceId);
        sourceAudioStateRef.current.delete(sourceId);
      }
    });

    stemAudioElementsRef.current.forEach((_stems, sourceId) => {
      if (!activeSourceIds.has(sourceId)) teardownStems(sourceId);
    });
  }, [audioTracks, useSourceRegistry, teardownStems]);

  // Cleanup on unmount (frame-driven mode)
  useEffect(() => {
    const stemElements = stemAudioElementsRef.current;
    return () => {
      sourceAudioElementsRef.current.forEach((audio, sourceId) => {
        VoiceIsolationEngine.teardown(sourceId);
        audio.pause();
        audio.src = '';
        audio.load();
      });
      sourceAudioElementsRef.current.clear();
      sourceAudioStateRef.current.clear();
      stemElements.forEach((stems) => {
        for (const el of [stems.voice, stems.bg]) {
          el.pause();
          el.src = '';
          el.load();
        }
      });
      stemElements.clear();
    };
  }, []);

  return null;
};

export default MultiAudioPlayer;
