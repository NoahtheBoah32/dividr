/**
 * FrameResolver - Pure function service for deterministic frame resolution.
 *
 * Determines which clips are visible at any timeline frame and calculates
 * source positions. Core formula: sourceFrame = timelineFrame - startFrame + inFrame
 */

import type { VideoTrack } from '../../stores/videoEditor/index';
import type { Transition, TransitionType } from '../../stores/videoEditor/types/timeline.types';
import {
  transitionFx,
  dipOverlay,
  type ClipTransitionFx,
  type DipOverlayFx,
} from '@/shared/transitions';

/**
 * Convert decibels to linear gain.
 * Formula: linear = 10^(dB/20)
 * - 0 dB = 1.0 (unity gain)
 * - -6 dB ≈ 0.5
 * - -Infinity dB = 0.0 (silence)
 * - +12 dB ≈ 3.98 (max boost)
 */
export const dbToLinear = (db: number): number => {
  if (db === -Infinity || db <= -60) return 0;
  return Math.pow(10, db / 20);
};

export interface Transform {
  x: number;
  y: number;
  scale: number;
  rotation: number;
  width: number;
  height: number;
}

export interface FrameRequest {
  clipId: string;
  sourceId: string;
  sourceUrl: string;
  sourceFrame: number;
  sourceTime: number;
  trackRowIndex: number;
  layer: number;
  opacity: number;
  transform: Transform;
  visible: boolean;
  filter?: string;
  track: VideoTrack;
  /** Transition render adjustment for this clip at this frame (opacity/transform/wipe). */
  tfx?: ClipTransitionFx;
}

export interface AudioFrameRequest {
  clipId: string;
  sourceId: string;
  sourceUrl: string;
  sourceTime: number;
  volume: number;
  muted: boolean;
  trackRowIndex: number;
  track: VideoTrack;
}

export interface ClipMetadata {
  clipId: string;
  sourceId: string;
  sourceUrl: string;
  inFrame: number;
  outFrame: number;
  timelineStartFrame: number;
  timelineEndFrame: number;
  trackRowIndex: number;
  layer: number;
  visible: boolean;
  opacity: number;
  transform: Transform;
  track: VideoTrack;
}

export const normalizeSourceId = (url: string | undefined | null): string => {
  if (!url) return '';
  try {
    if (url.startsWith('blob:')) return url;
    const parsed = new URL(url, window.location.origin);
    return decodeURIComponent(parsed.pathname);
  } catch {
    return url;
  }
};

export const getVideoSource = (
  track: VideoTrack | undefined,
): string | undefined => {
  if (!track) return undefined;
  if (track.previewUrl?.trim()) return track.previewUrl;
  if (track.source?.trim()) {
    const src = track.source.trim();
    if (src.startsWith('http://') || src.startsWith('https://')) return src;
    return `http://localhost:3001/${encodeURIComponent(src)}`;
  }
  return undefined;
};

export const extractClipMetadata = (
  track: VideoTrack,
  fps: number,
): ClipMetadata | null => {
  const sourceUrl = getVideoSource(track);
  if (!sourceUrl) return null;

  const sourceId = normalizeSourceId(sourceUrl);
  const durationFrames = track.endFrame - track.startFrame;
  const inFrame = Math.floor((track.sourceStartTime || 0) * fps);
  const outFrame = inFrame + durationFrames;

  const transform: Transform = track.textTransform || {
    x: 0,
    y: 0,
    scale: 1,
    rotation: 0,
    width: track.width || 1920,
    height: track.height || 1080,
  };

  const opacity =
    track.textStyle?.opacity !== undefined ? track.textStyle.opacity / 100 : 1;

  return {
    clipId: track.id,
    sourceId,
    sourceUrl,
    inFrame,
    outFrame,
    timelineStartFrame: track.startFrame,
    timelineEndFrame: track.endFrame,
    trackRowIndex: track.trackRowIndex ?? 0,
    layer: track.layer ?? 0,
    visible: track.visible,
    opacity,
    transform,
    track,
  };
};

export const calculateSourceFrame = (
  timelineFrame: number,
  clip: ClipMetadata,
): number => {
  const relativeFrame = timelineFrame - clip.timelineStartFrame;
  // Non-destructive reverse: play backward. The first timeline frame of the clip maps to the
  // LAST source frame, the last maps to the first. No re-encode — purely a read-order flip.
  if (clip.track?.reversed) {
    return Math.max(clip.inFrame, clip.outFrame - 1 - relativeFrame);
  }
  return clip.inFrame + relativeFrame;
};

export const calculateSourceTime = (
  timelineFrame: number,
  clip: ClipMetadata,
  fps: number,
): number => {
  const sourceFrame = calculateSourceFrame(timelineFrame, clip);
  return sourceFrame / fps;
};

export const isClipVisibleAtFrame = (
  timelineFrame: number,
  clip: ClipMetadata,
): boolean => {
  return (
    clip.visible &&
    timelineFrame >= clip.timelineStartFrame &&
    timelineFrame < clip.timelineEndFrame
  );
};

/**
 * Effective transition length in frames, clamped so the window [cut - D, cut) always fits
 * inside BOTH the outgoing and incoming clips. Without this clamp, trimming a clip shorter
 * than a previously-set transition duration would push the window before the outgoing clip's
 * start and render black frames. Mirrors the badge's clamp so UI and render agree.
 */
export const clampTransitionDuration = (
  durationFrames: number | undefined,
  from: VideoTrack,
  to: VideoTrack,
  fps: number,
): number => {
  const requested = durationFrames || Math.round(1.5 * fps);
  const fromDur = from.endFrame - from.startFrame;
  const toDur = to.endFrame - to.startFrame;
  return Math.max(1, Math.min(requested, fromDur - 1, toDur - 1));
};

export const resolveFrameRequests = (
  timelineFrame: number,
  tracks: VideoTrack[],
  fps: number,
  transitions: Transition[] = [],
): FrameRequest[] => {
  const requests: FrameRequest[] = [];
  const videoTracks = tracks.filter((t) => t.type === 'video');

  for (const track of videoTracks) {
    const clip = extractClipMetadata(track, fps);
    if (!clip) continue;
    if (!isClipVisibleAtFrame(timelineFrame, clip)) continue;

    const sourceFrame = calculateSourceFrame(timelineFrame, clip);
    const sourceTime = sourceFrame / fps;

    requests.push({
      clipId: clip.clipId,
      sourceId: clip.sourceId,
      sourceUrl: clip.sourceUrl,
      sourceFrame,
      sourceTime,
      trackRowIndex: clip.trackRowIndex,
      layer: clip.layer,
      opacity: clip.opacity,
      transform: clip.transform,
      visible: clip.visible,
      filter: track.filter,
      track,
    });
  }

  // Sort by z-order: trackRowIndex (lower = behind), then layer
  requests.sort((a, b) => {
    if (a.trackRowIndex !== b.trackRowIndex) {
      return a.trackRowIndex - b.trackRowIndex;
    }
    return a.layer - b.layer;
  });

  // TRANSITIONS (non-destructive): rendered in place at the cut. The clips do NOT overlap or
  // move. During [cut - D, cut) the outgoing clip fades/slides out while the INCOMING clip's
  // source PRE-ROLL handle fades/slides in — so no visible content or audio is consumed.
  const byId = new Map(videoTracks.map((t) => [t.id, t]));
  let addedPreroll = false;
  for (const tr of transitions) {
    const from = byId.get(tr.fromClipId);
    const to = byId.get(tr.toClipId);
    if (!from || !to) continue;
    const cut = to.startFrame; // transition is anchored on the incoming clip's start (the cut)
    // Clamp the window to BOTH clips' real durations so a later trim can never push the
    // window before the outgoing clip's start (which would render black frames).
    const D = clampTransitionDuration(tr.durationFrames, from, to, fps);
    if (timelineFrame < cut - D || timelineFrame >= cut) continue;
    const p = Math.max(0, Math.min(1, (timelineFrame - (cut - D)) / D));

    // Outgoing clip plays its REAL frames (already in `requests`); just apply the fade/slide-out.
    const fromReq = requests.find((r) => r.clipId === from.id);
    if (fromReq) fromReq.tfx = transitionFx('from', tr.type, p, tr.params);

    // Incoming clip isn't in its timeline range yet — synthesize a pre-roll request from its
    // source handle (frames just before its in-point) so it fades/slides in without moving.
    const toMeta = extractClipMetadata(to, fps);
    if (toMeta) {
      const handleSourceFrame = Math.max(0, toMeta.inFrame - (cut - timelineFrame));
      requests.push({
        clipId: to.id,
        sourceId: toMeta.sourceId,
        sourceUrl: toMeta.sourceUrl,
        sourceFrame: handleSourceFrame,
        sourceTime: handleSourceFrame / fps,
        trackRowIndex: toMeta.trackRowIndex,
        layer: (fromReq?.layer ?? toMeta.layer) + 0.5, // draw on top of the outgoing clip
        opacity: toMeta.opacity,
        transform: toMeta.transform,
        visible: true,
        filter: to.filter,
        track: to,
        tfx: transitionFx('to', tr.type, p, tr.params),
      });
      addedPreroll = true;
    }
  }
  if (addedPreroll) {
    requests.sort((a, b) => {
      if (a.trackRowIndex !== b.trackRowIndex) {
        return a.trackRowIndex - b.trackRowIndex;
      }
      return a.layer - b.layer;
    });
  }

  return requests;
};

/**
 * Active dip-to-color overlay at this frame, if a 'dip' transition's window covers it.
 * Drawn as a full-frame flash by the compositor on top of all clips.
 */
export const resolveDipOverlay = (
  timelineFrame: number,
  tracks: VideoTrack[],
  transitions: Transition[] = [],
  fps = 30,
): DipOverlayFx | null => {
  for (const tr of transitions) {
    if (tr.type !== 'dip') continue;
    const to = tracks.find((t) => t.id === tr.toClipId && t.type === 'video');
    const from = tracks.find((t) => t.id === tr.fromClipId && t.type === 'video');
    if (!to) continue;
    const cut = to.startFrame;
    // Same clamp as the video transition so the dip flash lines up exactly with the cut window.
    const D = from
      ? clampTransitionDuration(tr.durationFrames, from, to, fps)
      : Math.max(1, tr.durationFrames || Math.round(1.5 * fps));
    if (timelineFrame < cut - D || timelineFrame >= cut) continue;
    const p = Math.max(0, Math.min(1, (timelineFrame - (cut - D)) / D));
    return dipOverlay('dip', p, tr.params);
  }
  return null;
};

export const resolveAudioFrameRequests = (
  timelineFrame: number,
  tracks: VideoTrack[],
  fps: number,
): AudioFrameRequest[] => {
  const requests: AudioFrameRequest[] = [];
  const audioTracks = tracks.filter((t) => t.type === 'audio');

  for (const track of audioTracks) {
    if (timelineFrame < track.startFrame || timelineFrame >= track.endFrame) {
      continue;
    }

    // Reversed audio can't play backward via HTMLAudioElement — keep it silent in preview.
    // The properly reversed audio is baked at export.
    if (track.reversed) continue;

    const sourceUrl = track.previewUrl || getVideoSource(track);
    if (!sourceUrl) continue;

    const relativeFrame = timelineFrame - track.startFrame;
    const sourceTime = (track.sourceStartTime || 0) + relativeFrame / fps;

    // Convert volumeDb to linear gain for HTMLAudioElement
    // volumeDb is the source of truth (track.volume is deprecated)
    const volumeDb = track.volumeDb ?? 0;
    let linearVolume = dbToLinear(volumeDb);

    // Preview-time audio ducking: apply speech-interval-based gain reduction.
    // If duckingEnabled but no intervals are set, duck for the entire clip.
    if (track.duckingEnabled) {
      const currentSec = timelineFrame / fps;
      const targetDb = track.duckingTargetDb ?? -12;
      const fadeSec = track.duckingFadeDuration ?? 0.3;
      const targetGain = dbToLinear(targetDb);
      const fullGain = linearVolume;

      const intervals: { start: number; end: number }[] =
        track.duckingSpeechIntervals?.length
          ? track.duckingSpeechIntervals
          : [{ start: track.startFrame / fps, end: track.endFrame / fps }];

      let gain = fullGain;
      for (const iv of intervals) {
        const fadeInStart = iv.start - fadeSec;
        const fadeOutEnd = iv.end + fadeSec;
        if (currentSec >= fadeInStart && currentSec < iv.start) {
          const t = (currentSec - fadeInStart) / fadeSec;
          gain = Math.min(gain, fullGain + t * (targetGain - fullGain));
        } else if (currentSec >= iv.start && currentSec <= iv.end) {
          gain = Math.min(gain, targetGain);
        } else if (currentSec > iv.end && currentSec <= fadeOutEnd) {
          const t = (currentSec - iv.end) / fadeSec;
          gain = Math.min(gain, targetGain + t * (fullGain - targetGain));
        }
      }
      linearVolume = gain;
    }

    requests.push({
      clipId: track.id,
      sourceId: normalizeSourceId(sourceUrl),
      sourceUrl,
      sourceTime,
      volume: linearVolume,
      muted: track.muted ?? false,
      trackRowIndex: track.trackRowIndex ?? 0,
      track,
    });
  }

  return requests;
};

export const getPreloadFrames = (
  timelineFrame: number,
  tracks: VideoTrack[],
  fps: number,
  lookaheadFrames = 3,
  transitions: Transition[] = [],
): Map<string, number[]> => {
  const preloadMap = new Map<string, number[]>();

  for (let offset = 1; offset <= lookaheadFrames; offset++) {
    const futureFrame = timelineFrame + offset;
    // Pass transitions so the incoming clip's pre-roll handle frames are preloaded too —
    // otherwise the first frames of a transition decode late and stutter/flash black.
    const requests = resolveFrameRequests(futureFrame, tracks, fps, transitions);

    for (const req of requests) {
      const existing = preloadMap.get(req.sourceId) || [];
      if (!existing.includes(req.sourceFrame)) {
        existing.push(req.sourceFrame);
        preloadMap.set(req.sourceId, existing);
      }
    }
  }

  return preloadMap;
};

export const hasVisibleClipsAtFrame = (
  timelineFrame: number,
  tracks: VideoTrack[],
): boolean => {
  return tracks.some((track) => {
    if (track.type !== 'video') return false;
    if (!track.visible) return false;
    if (!getVideoSource(track)) return false;
    return timelineFrame >= track.startFrame && timelineFrame < track.endFrame;
  });
};

export default {
  resolveFrameRequests,
  resolveAudioFrameRequests,
  calculateSourceFrame,
  calculateSourceTime,
  extractClipMetadata,
  getPreloadFrames,
  hasVisibleClipsAtFrame,
  normalizeSourceId,
  getVideoSource,
  dbToLinear,
};
