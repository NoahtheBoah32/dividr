/**
 * Ken Burns — the classic documentary push-in: a slow, eased zoom toward a
 * focus point, spanning the entire clip.
 *
 * The whole effect is described by ONE animated source window:
 *   at p=0 the window is the full frame; at p=1 it is a 1/endZoom crop
 *   centred on endCenter (clamped so it never leaves the frame).
 *
 * The preview draws the window by expanding the destination rect
 * (FrameDrivenCompositor.drawLayer) and the export bakes the identical move
 * with zoompan (handleFilterComplex.buildKenBurnsChain) — both MUST stay in
 * lockstep with the math here.
 *
 * Motion: easeInOutSine across the clip — the camera settles in and lands
 * softly, which is Final Cut's default "Ease Both". The classic rate is a
 * 5–15% total push over a 3–15s shot, hence the narrow zoom bounds.
 */

export interface KenBurnsState {
  /** Master on/off. When false the move is kept but not applied. */
  enabled: boolean;
  /** Scale reached at the end of the clip (KB_MIN_ZOOM–KB_MAX_ZOOM). */
  endZoom: number;
  /** Normalized focus centre of the end window in the source frame. */
  endCenter: { x: number; y: number };
  /** Set true once EDITH has applied it — unlocks the manual toggle. */
  appliedByEdith?: boolean;
}

export const KB_MIN_ZOOM = 1.03;
export const KB_MAX_ZOOM = 1.5;
export const KB_DEFAULT_ZOOM = 1.14;

const clamp = (v: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, v));

export const kbClampZoom = (z: number | undefined): number =>
  clamp(
    Number.isFinite(z as number) ? (z as number) : KB_DEFAULT_ZOOM,
    KB_MIN_ZOOM,
    KB_MAX_ZOOM,
  );

/** easeInOutSine — gentle start, gentle landing. */
export const kbEase = (p: number): number =>
  0.5 - 0.5 * Math.cos(Math.PI * clamp(p, 0, 1));

export interface KenBurnsWindow {
  /** Current zoom — the factor the destination rect is expanded by. */
  zoom: number;
  /** Normalized top-left of the source window at this moment. */
  u0: number;
  v0: number;
}

/**
 * Resolve the source window for a timeline frame. Progress runs over the
 * clip's TIMELINE span, so scrubbing, playback and the export bake all land
 * on the identical picture for a given frame.
 */
export function kenBurnsWindow(
  kb: KenBurnsState | undefined,
  timelineFrame: number,
  startFrame: number,
  endFrame: number,
): KenBurnsWindow | null {
  if (!kb?.enabled) return null;
  const span = Math.max(1, endFrame - startFrame);
  const p = kbEase((timelineFrame - startFrame) / span);
  const zoom = 1 + (kbClampZoom(kb.endZoom) - 1) * p;
  const half = 0.5 / zoom;
  const cx = clamp(
    0.5 + ((kb.endCenter?.x ?? 0.5) - 0.5) * p,
    half,
    1 - half,
  );
  const cy = clamp(
    0.5 + ((kb.endCenter?.y ?? 0.5) - 0.5) * p,
    half,
    1 - half,
  );
  return { zoom, u0: cx - half, v0: cy - half };
}
