/**
 * Audio fade in/out — shared math for the preview gain ramp and the panel.
 *
 * The export bakes fades with FFmpeg's `afade` filter (linear curve, applied
 * on the trimmed clip stream before timeline positioning). The preview must
 * sound identical, so the gain here is the same linear ramp:
 *   fade-in : gain 0 → 1 over the first `fadeInSeconds` of the clip
 *   fade-out: gain 1 → 0 over the last `fadeOutSeconds` of the clip
 * When both ramps overlap (short clip, long fades) the gains multiply —
 * exactly what two chained afade filters do.
 */

export const FADE_MIN_SECONDS = 0;
export const FADE_MAX_SECONDS = 5;

/** Clamp a user-entered fade length to the allowed range (0 disables). */
export function clampFadeSeconds(seconds: number): number {
  if (Number.isNaN(seconds) || seconds <= 0) return 0;
  return Math.min(FADE_MAX_SECONDS, Math.max(FADE_MIN_SECONDS, seconds));
}

/**
 * Linear fade gain (0..1) for a timeline frame inside a clip.
 * Frames outside [startFrame, endFrame) return the edge value rather than
 * throwing — callers already cull out-of-range clips.
 */
export function audioFadeGain(
  timelineFrame: number,
  startFrame: number,
  endFrame: number,
  fps: number,
  fadeInSeconds?: number,
  fadeOutSeconds?: number,
): number {
  const fi = fadeInSeconds ?? 0;
  const fo = fadeOutSeconds ?? 0;
  let gain = 1;
  if (fi > 0) {
    const secsIn = (timelineFrame - startFrame) / fps;
    gain *= Math.max(0, Math.min(1, secsIn / fi));
  }
  if (fo > 0) {
    const secsLeft = (endFrame - timelineFrame) / fps;
    gain *= Math.max(0, Math.min(1, secsLeft / fo));
  }
  return gain;
}
