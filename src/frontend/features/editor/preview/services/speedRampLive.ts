/**
 * speedRampLive — the drag-time channel between the ramp panel and the preview.
 *
 * Dragging a curve handle has to move the picture on the very next composited
 * frame, the same way the motion-blur slider and the voice-isolation curve do.
 * Writing the store on every pointermove would do it, but at 60Hz that
 * re-renders the whole editor and restarts the timeline's playback rAF (its
 * effect depends on `tracks`), so the drag would fight playback.
 *
 * Instead the panel parks the in-progress ramp here, module-level, and both the
 * resolver and the compositor read through `effectiveRamp`. The store is
 * written once on pointer-up, which is also where the clip's new length lands.
 * Same shape as the `__pipDragOverride` the compositor already uses for PiP
 * dragging, and the same live-engine/commit-on-release split as voice isolation.
 */

import type { TrackSpeedRamp } from './speedRampCache';

const live = new Map<string, TrackSpeedRamp>();

/** Park (or with null, drop) the ramp the preview should use for this clip. */
export function setLiveRamp(
  trackId: string,
  ramp: TrackSpeedRamp | null | undefined,
): void {
  if (!trackId) return;
  if (ramp) live.set(trackId, ramp);
  else live.delete(trackId);
}

export function getLiveRamp(trackId: string): TrackSpeedRamp | undefined {
  return live.get(trackId);
}

/**
 * The ramp a clip should actually be rendered with: the drag override while one
 * is parked, otherwise whatever is committed on the track. Every read path goes
 * through this so the two can never disagree.
 */
export function effectiveRamp(
  track: { id?: string; speedRamp?: unknown } | undefined | null,
): TrackSpeedRamp | undefined {
  if (!track) return undefined;
  const id = track.id;
  if (id) {
    const l = live.get(id);
    if (l) return l;
  }
  return (track as { speedRamp?: TrackSpeedRamp }).speedRamp;
}

/** Drop every override — used on teardown so a stale drag can't warp a clip. */
export function clearLiveRamps(): void {
  live.clear();
}
