/**
 * Scene-detection helpers shared by the main process (FFmpeg output parsing) and the
 * renderer (mapping absolute timestamps to clip-relative markers). Pure functions only —
 * no Electron/DOM deps — so they're unit-testable in node.
 */

/**
 * Extract scene-cut timestamps (in seconds) from FFmpeg `showinfo` stderr output.
 * The scene filter prints lines containing `pts_time:<seconds>` for each detected cut.
 * Returns a de-duplicated, ascending list.
 */
export function parseSceneTimestamps(ffmpegOutput: string): number[] {
  const found: number[] = [];
  const re = /pts_time:([0-9]+(?:\.[0-9]+)?)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(ffmpegOutput)) !== null) {
    const t = parseFloat(m[1]);
    if (Number.isFinite(t) && t >= 0) found.push(t);
  }
  return Array.from(new Set(found)).sort((a, b) => a - b);
}

export interface SceneMarker {
  /** Absolute timestamp in the SOURCE file (seconds). */
  atSeconds: number;
  /** Position within the clip's visible window, 0..1 (for rendering). */
  fraction: number;
}

/**
 * Map absolute source-time scene cuts to clip-relative markers, keeping only those that
 * fall strictly inside the clip's visible window [clipStartSec, clipEndSec]. A small margin
 * drops cuts hugging the very start/end (not useful as split points).
 */
export function sceneTimesToMarkers(
  scenes: number[],
  clipStartSec: number,
  clipEndSec: number,
  marginSec = 0.05,
): SceneMarker[] {
  const dur = clipEndSec - clipStartSec;
  if (!(dur > 0)) return [];
  // Cap the edge margin so it never consumes more than ~1% of the clip on each side. A fixed
  // 0.05s margin on a very short clip (<0.1s) would otherwise invert the valid range and drop
  // every cut.
  const margin = Math.min(marginSec, dur * 0.01);
  return scenes
    .filter((s) => s > clipStartSec + margin && s < clipEndSec - margin)
    .map((s) => ({ atSeconds: s, fraction: (s - clipStartSec) / dur }))
    .sort((a, b) => a.fraction - b.fraction);
}
