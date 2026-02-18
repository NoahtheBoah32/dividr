import { VideoTrack } from '../types';

/**
 * Returns true only when splitting would produce two valid clip segments.
 */
export const canSplitClip = (
  clip: VideoTrack | null | undefined,
  playheadTime: number,
): boolean => {
  if (!clip) return false;
  if (!Number.isFinite(playheadTime)) return false;
  if (clip.locked || clip.proxyBlocked) return false;
  if (!Number.isFinite(clip.startFrame) || !Number.isFinite(clip.endFrame)) {
    return false;
  }
  if (clip.duration <= 0) return false;
  if (clip.endFrame - clip.startFrame <= 0) return false;

  const firstSegmentDuration = playheadTime - clip.startFrame;
  const secondSegmentDuration = clip.endFrame - playheadTime;

  return firstSegmentDuration > 0 && secondSegmentDuration > 0;
};
