/**
 * speedRampCache — memoised source/output time maps for ramped clips.
 *
 * Building a profile integrates the speed curve over 2048 steps. That is far
 * too much to redo inside calculateSourceFrame, which runs for every visible
 * clip on every composited frame, so profiles are cached by the ramp's own
 * content. Dragging a handle changes the key and rebuilds once per commit.
 */

import {
  buildProfile,
  type RampProfile,
  type SpeedRegion,
} from '../utils/speedRampCurve';

export interface TrackSpeedRamp {
  enabled: boolean;
  regions: SpeedRegion[];
  sourceDuration: number;
  blend?: 'off' | 'blend' | 'flow';
  audio?: boolean;
  pitch?: boolean;
  appliedByEdith?: boolean;
}

const cache = new Map<string, RampProfile>();
// Ramps are per-clip and a project holds few of them; this only guards against
// a pathological churn of drag-commits leaking memory over a long session.
const MAX_ENTRIES = 64;

function keyOf(ramp: TrackSpeedRamp): string {
  return (
    ramp.sourceDuration.toFixed(4) +
    '|' +
    ramp.regions
      .map(
        (r) =>
          `${r.a.toFixed(4)},${r.b.toFixed(4)},${r.shape},${r.dir},` +
          `${r.segs.map((s) => s.toFixed(4)).join('/')},` +
          r.bounds
            .map((b) => `${b.t0.toFixed(4)}-${b.t1.toFixed(4)}`)
            .join('/'),
      )
      .join(';')
  );
}

/** Whether this ramp actually changes anything. */
export function isRampActive(ramp?: TrackSpeedRamp | null): boolean {
  return !!(
    ramp &&
    ramp.enabled &&
    ramp.regions?.length &&
    ramp.sourceDuration > 0
  );
}

export function getRampProfile(ramp: TrackSpeedRamp): RampProfile {
  const key = keyOf(ramp);
  const hit = cache.get(key);
  if (hit) return hit;
  const profile = buildProfile(ramp.regions, ramp.sourceDuration);
  if (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, profile);
  return profile;
}

/**
 * Clip-local source seconds for a clip-local OUTPUT second.
 *
 * A region marked `reverse` is reflected inside its own window: the pacing the
 * curve describes is preserved, but the content inside that window plays
 * backward. Reflecting after the time warp (rather than inverting the curve)
 * keeps the two concerns independent — the ramp still eases exactly the same.
 */
export function rampSourceSeconds(
  ramp: TrackSpeedRamp,
  outSeconds: number,
): number {
  const profile = getRampProfile(ramp);
  const t = profile.srcAt(outSeconds);
  for (const r of ramp.regions) {
    if (r.dir === 'reverse' && t >= r.a && t <= r.b) return r.a + (r.b - t);
  }
  return t;
}

/** Output (timeline) duration this ramp produces for the clip. */
export function rampOutputSeconds(ramp: TrackSpeedRamp): number {
  return getRampProfile(ramp).outDuration;
}

/** Instantaneous speed at a clip-local OUTPUT second — used by the readouts. */
export function rampSpeedAtOutput(
  ramp: TrackSpeedRamp,
  outSeconds: number,
): number {
  const profile = getRampProfile(ramp);
  const h = 1 / 240;
  const a = profile.srcAt(Math.max(0, outSeconds - h));
  const b = profile.srcAt(Math.min(profile.outDuration, outSeconds + h));
  const dt =
    Math.min(profile.outDuration, outSeconds + h) - Math.max(0, outSeconds - h);
  return dt > 1e-6 ? (b - a) / dt : 1;
}

export function clearRampCache(): void {
  cache.clear();
}
