/**
 * In-memory cache of stabilization offset curves, keyed by their sidecar JSON
 * path. The compositor reads offsets synchronously every drawn frame, so the
 * curve must be resident; loading is lazy (fire-and-forget IPC) for the
 * project-reload case where a track carries an offsetsPath the renderer has
 * never seen. `setStabilizationOffsets` seeds the cache directly from the
 * analyze IPC result so the first enable compensates on the very next frame.
 */

interface StabCurve {
  /** Per-frame [dx, dy, da] — source px, source px, radians. v1 sidecars carried [dx, dy]. */
  offsets: number[][];
  fps: number;
  /** Constant auto-zoom (scale about center) that keeps the corrected frame covering the viewport. */
  zoom: number;
}

const curves = new Map<string, StabCurve>();
const loading = new Set<string>();

export function setStabilizationOffsets(
  offsetsPath: string,
  offsets: number[][],
  fps: number,
  zoom?: number,
): void {
  if (!offsetsPath || !Array.isArray(offsets) || !offsets.length) return;
  curves.set(offsetsPath, { offsets, fps: fps || 30, zoom: zoom && zoom > 1 ? zoom : 1 });
}

/** The clip's constant auto-zoom, or 1 when the curve isn't resident. */
export function getStabilizationZoom(offsetsPath: string): number {
  return curves.get(offsetsPath)?.zoom ?? 1;
}

/**
 * Correction [dx, dy, da] (source px / radians) for a source-time position, or
 * null when the curve isn't resident yet. A null triggers a background load;
 * the compositor simply draws uncompensated until it lands (one-time,
 * sub-second).
 */
export function getStabilizationOffset(
  offsetsPath: string,
  sourceTimeSec: number,
): [number, number, number] | null {
  const curve = curves.get(offsetsPath);
  if (!curve) {
    ensureStabilizationLoaded(offsetsPath);
    return null;
  }
  const idx = Math.max(
    0,
    Math.min(curve.offsets.length - 1, Math.round(sourceTimeSec * curve.fps)),
  );
  const o = curve.offsets[idx];
  return [o[0] || 0, o[1] || 0, o[2] || 0];
}

export function ensureStabilizationLoaded(offsetsPath: string): void {
  if (!offsetsPath || curves.has(offsetsPath) || loading.has(offsetsPath)) return;
  loading.add(offsetsPath);
  (window as any).electronAPI
    ?.invoke?.('media:stabilizeLoadOffsets', { offsetsPath })
    .then((r: any) => {
      if (r?.success && Array.isArray(r.offsets)) {
        curves.set(offsetsPath, {
          offsets: r.offsets,
          fps: r.fps || 30,
          zoom: r.zoom && r.zoom > 1 ? r.zoom : 1,
        });
      }
    })
    .catch(() => {
      /* stays unloaded; a later call may retry after the flag clears */
    })
    .finally(() => loading.delete(offsetsPath));
}

export function hasStabilizationCurve(offsetsPath: string): boolean {
  return curves.has(offsetsPath);
}
